import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { one, sql } from './support/db';
import { createTenant, type Tenant } from './support/fixtures';
import { testDatabaseUrl } from '../src/core/env';
import { withToxiproxy, type Toxiproxy } from './support/toxiproxy';
import {
  authenticateDevice,
  createDeviceCode,
  listDeviceRegistrations,
  registerDevice,
} from '../src/branch/device';
import { listBranchCashiers, setCashierPin } from '../src/branch/pin';
import { signInWithPin } from '../src/branch/session';
import { branchHealth } from '../src/branch/health';
import { badgeState } from '../src/branch/badge';
import { branchHealthPollMs } from '../src/branch/config';

/**
 * F4 — the branch server UI/behaviour completion slice. Tests 128–130, continuing from F3's 127
 * (ADR-0010, ADR-0071).
 *
 * The F4 brief numbers these 16–18, which collide with R4's 14–18 and H1's 49–52. ADR-0010 forbids
 * renumbering: a new run continues from the highest number actually present. The mapping is in
 * ADR-0071. This file also carries supporting tests for the surface F4 adds (the 6-digit code, the
 * device list, the cashier list, the health keys and the badge), because the brief asks for exactly
 * three behaviour tests and a reader needs those pieces covered by the run that added them.
 *
 * Everything runs against the real local Postgres and, where the brief calls for it, a real
 * Toxiproxy. The database is never mocked.
 */

/** A real pool client for the TS wrappers. */
async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: testDatabaseUrl(), max: 2 });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * A branch-mode client: every connection carries `app.branch_mode=branch`, the GUC the outbox
 * triggers read (ADR-0025). A sale rung on the branch writes its outbox event only in branch mode.
 */
async function withBranchClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = new Pool({
    connectionString: testDatabaseUrl(),
    max: 2,
    options: '-c app.branch_mode=branch',
  });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

/** Give a cashier a PIN (the admin path), creating the auth user first. */
async function givePin(tenant: Tenant, cashierId: string, pin: string, isManager = true): Promise<void> {
  await sql('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [
    cashierId,
    `cashier-${cashierId.slice(0, 8)}@example.test`,
  ]);
  await sql('select app.set_cashier_pin($1, $2, $3, $4, $5)', [
    tenant.orgId,
    tenant.branchId,
    cashierId,
    pin,
    isManager,
  ]);
}

/** A branch with stock and an open shift, ready to ring a sale. */
interface SaleFixture {
  tenant: Tenant;
  warehouseId: string;
  productId: string;
  variantId: string;
  shiftId: string;
}

async function saleFixture(name: string): Promise<SaleFixture> {
  const tenant = await createTenant(name);
  const warehouse = await one<{ id: string }>(
    `insert into public.warehouses (org_id, branch_id, code, name)
     values ($1, $2, 'W1', 'W1') returning id`,
    [tenant.orgId, tenant.branchId],
  );
  const product = await one<{ id: string }>(
    `insert into public.products (org_id, sku, name)
     values ($1, app.next_number($1, 'SKU'), 'F4 widget') returning id`,
    [tenant.orgId],
  );
  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name, barcode)
     values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
    [tenant.orgId, product!.id, `BC-${randomUUID().slice(0, 8)}`],
  );
  const priceList = await one<{ id: string }>(
    `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
    [tenant.orgId],
  );
  await sql(
    `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
     values ($1, $2, $3, 5.0000)`,
    [tenant.orgId, priceList!.id, variant!.id],
  );
  await sql(`select app.post_receipt($1, $2, $3, $4, $5, 100, 2, '2026-06-15'::date)`, [
    tenant.orgId,
    tenant.branchId,
    warehouse!.id,
    product!.id,
    variant!.id,
  ]);
  const shift = await one<{ id: string }>(
    `insert into public.shifts (org_id, branch_id, till_id, opening_float)
     values ($1, $2, 'T1', 0) returning id`,
    [tenant.orgId, tenant.branchId],
  );
  return {
    tenant,
    warehouseId: warehouse!.id,
    productId: product!.id,
    variantId: variant!.id,
    shiftId: shift!.id,
  };
}

/** Ring one sale on the branch. The sale posts to the branch's own database, not to the cloud. */
async function ringSale(fx: SaleFixture, clientSaleId: string): Promise<string> {
  return withBranchClient(async (client) => {
    const result = await client.query<{ r: { sale_id: string } }>(
      `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) as r`,
      [
        fx.tenant.orgId,
        fx.tenant.branchId,
        fx.warehouseId,
        fx.shiftId,
        clientSaleId,
        JSON.stringify([{ variant_id: fx.variantId, qty: 1, unit_price: '5.0000' }]),
        JSON.stringify([{ method: 'cash', currency: 'USD', amount_tendered: '5' }]),
      ],
    );
    return result.rows[0]!.r.sale_id;
  });
}
describe('F4 branch server completion', () => {
  it('128. A branch sale completes with the cloud unreachable (Toxiproxy cuts the cloud)', async () => {
    const fx = await saleFixture('F4 offline sale');

    // The "cloud" is a throwaway HTTP server reachable only through Toxiproxy. Cutting the proxy's
    // link makes the cloud genuinely unreachable, not merely slow: the branch's own health probe
    // then reports it offline, while the sale still posts to the branch's database.
    const cloud = await startFakeCloud();
    const previousCloud = process.env.CLOUD_URL;
    await withToxiproxy(cloud.upstream, async (proxy: Toxiproxy) => {
      // The branch probes the cloud through the proxy, so cutting the proxy makes it unreachable.
      process.env.CLOUD_URL = proxy.cloudUrl;
      try {
        const health = await withClient((client) =>
          branchHealth(client, {
            probe: true,
            orgId: fx.tenant.orgId,
            branchId: fx.tenant.branchId,
          }),
        );
        // With the link up, the branch reaches the cloud through the proxy.
        expect(health.cloud_url).toBe(proxy.cloudUrl);
        if (proxy.live) expect(health.cloud_status).toBe('online');

        await proxy.cutCloud();

        // A sale commits on the branch with the cloud cut. This is the whole point: the cloud being
        // down cannot block a sale.
        const saleId = await ringSale(fx, randomUUID());
        expect(saleId).toMatch(/[0-9a-f-]{36}/);

        const count = await one<{ n: number }>(
          'select count(*)::int as n from public.pos_sales where org_id = $1',
          [fx.tenant.orgId],
        );
        expect(count!.n).toBe(1);

        // The sale wrote exactly one outbox event to push when the cloud returns.
        const outbox = await one<{ n: number }>(
          'select count(*)::int as n from public.sync_outbox where org_id = $1 and branch_id = $2',
          [fx.tenant.orgId, fx.tenant.branchId],
        );
        expect(outbox!.n).toBe(1);

        // And a probe through the cut proxy reports the cloud offline while the branch is up.
        const offline = await withClient((client) =>
          branchHealth(client, {
            probe: true,
            orgId: fx.tenant.orgId,
            branchId: fx.tenant.branchId,
          }),
        );
        expect(offline.cloud_online).toBe(false);
        expect(offline.branch_online).toBe(true);
        expect(offline.outbox_size).toBe(1);
      } finally {
        if (previousCloud === undefined) delete process.env.CLOUD_URL;
        else process.env.CLOUD_URL = previousCloud;
      }
    });
    await cloud.stop();
  });

  it('129. A cashier signs in with a PIN with the internet off (no cloud call)', async () => {
    const tenant = await createTenant('F4 pin offline');
    const cashierId = randomUUID();
    await givePin(tenant, cashierId, '4321');

    // The internet is off: the cloud URL is a refused connection. Sign-in must not touch it.
    const previousCloud = process.env.CLOUD_URL;
    process.env.CLOUD_URL = 'http://127.0.0.1:9';
    try {
      const { result, session } = await withClient((client) =>
        signInWithPin(client, {
          orgId: tenant.orgId,
          branchId: tenant.branchId,
          cashierId,
          pin: '4321',
        }),
      );
      expect(result.ok).toBe(true);
      expect(session).not.toBeNull();
      expect(session!.token.split('.')).toHaveLength(3);
      expect(session!.orgId).toBe(tenant.orgId);
      expect(session!.branchId).toBe(tenant.branchId);

      // A wrong PIN is still refused locally, with no token.
      const wrong = await withClient((client) =>
        signInWithPin(client, {
          orgId: tenant.orgId,
          branchId: tenant.branchId,
          cashierId,
          pin: '0000',
        }),
      );
      expect(wrong.result.ok).toBe(false);
      expect(wrong.session).toBeNull();
    } finally {
      if (previousCloud === undefined) delete process.env.CLOUD_URL;
      else process.env.CLOUD_URL = previousCloud;
    }
  });

  it('130. The till badge reports green/yellow/red, and the app shell is the cached one offline', async () => {
    // The badge decision is a pure function of the health the branch reports. It is the same
    // function the POS page renders, so this asserts the real behaviour without a browser.
    expect(badgeState({ cloudStatus: 'online', databaseUp: true, branchReachable: true, protocolVersion: 1, cloudProtocolVersion: 1, pushBlocked: false, outboxSize: 0 })).toMatchObject({ tone: 'green', status: 'online' });
    expect(badgeState({ cloudStatus: 'offline', databaseUp: true, branchReachable: true, protocolVersion: 1, cloudProtocolVersion: null, pushBlocked: false, outboxSize: 7 })).toMatchObject({ tone: 'yellow', status: 'offline' });
    expect(badgeState({ cloudStatus: null, databaseUp: null, branchReachable: false, protocolVersion: null, cloudProtocolVersion: null, pushBlocked: false, outboxSize: null })).toMatchObject({ tone: 'red', status: 'branch-down' });

    // The outbox depth is shown to the cashier when the cloud is offline.
    const yellow = badgeState({ cloudStatus: 'offline', databaseUp: true, branchReachable: true, protocolVersion: 1, cloudProtocolVersion: null, pushBlocked: false, outboxSize: 7 });
    expect(yellow.label).toContain('7 queued');

    // The service worker precaches the app shell (/_next/static, /pos, /login, /admin) and never
    // caches the API, so a reload with the network cut renders the till but never a stale sale.
    const fs = await import('node:fs/promises');
    const sw = await fs.readFile('public/sw.js', 'utf8');
    expect(sw).toContain('/_next/static/');
    expect(sw).toContain("'/pos'");
    expect(sw).toContain("'/login'");
    expect(sw).toContain("startsWith('/admin')");
    expect(sw).toContain("startsWith('/api/')");

    // The brief's cadence: the till polls health every five seconds.
    const previousPoll = process.env.BRANCH_HEALTH_POLL_MS;
    delete process.env.BRANCH_HEALTH_POLL_MS;
    expect(branchHealthPollMs()).toBe(5_000);
    process.env.BRANCH_HEALTH_POLL_MS = '250';
    expect(branchHealthPollMs()).toBe(250);
    if (previousPoll === undefined) delete process.env.BRANCH_HEALTH_POLL_MS;
    else process.env.BRANCH_HEALTH_POLL_MS = previousPoll;
  });

  it('F4-a. The device code is 6 digits, single use, expires, and only its hash is stored', async () => {
    const tenant = await createTenant('F4 device code');

    const code = await withClient((client) =>
      createDeviceCode(client, { orgId: tenant.orgId, branchId: tenant.branchId, tillId: 'TILL-7' }),
    );
    expect(code).toMatch(/^[0-9]{6}$/);

    // Only the hash is stored: the raw code never appears in the table.
    const stored = await sql<{ code_hash: string }>(
      'select code_hash from public.device_registrations where org_id = $1 and branch_id = $2',
      [tenant.orgId, tenant.branchId],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.code_hash).not.toBe(code);

    // The code redeems once, and a device token comes back.
    const token = await withClient((client) =>
      registerDevice(client, { orgId: tenant.orgId, branchId: tenant.branchId, code, label: 'Front' }),
    );
    expect(token.length).toBeGreaterThan(20);

    // A second redemption of the same code fails.
    await expect(
      withClient((client) =>
        registerDevice(client, { orgId: tenant.orgId, branchId: tenant.branchId, code, label: null }),
      ),
    ).rejects.toThrow();

    // The token verifies, and the list returns the device without any hash.
    const registrationId = await withClient((client) =>
      authenticateDevice(client, { orgId: tenant.orgId, branchId: tenant.branchId, token }),
    );
    expect(registrationId).toMatch(/[0-9a-f-]{36}/);

    const devices = await withClient((client) =>
      listDeviceRegistrations(client, { orgId: tenant.orgId, branchId: tenant.branchId }),
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]!.till_id).toBe('TILL-7');
    expect(JSON.stringify(devices)).not.toContain('code_hash');
    expect(JSON.stringify(devices)).not.toContain(token);
  });

  it('F4-b. The cashier list returns a label and never a hash, scoped to the branch', async () => {
    const tenant = await createTenant('F4 cashiers');
    const cashierId = randomUUID();
    await givePin(tenant, cashierId, '1234', true);

    const cashiers = await withClient((client) =>
      listBranchCashiers(client, { orgId: tenant.orgId, branchId: tenant.branchId }),
    );
    expect(cashiers).toHaveLength(1);
    expect(cashiers[0]!.cashier_id).toBe(cashierId);
    expect(cashiers[0]!.is_manager).toBe(true);
    expect(cashiers[0]!.label).toContain('@example.test');
    // No hash ever leaves the function.
    expect(JSON.stringify(cashiers)).not.toContain('pin_hash');
    expect(JSON.stringify(cashiers)).not.toContain('$2');

    // Another branch sees nothing.
    const other = await createTenant('F4 cashiers other');
    const otherCashiers = await withClient((client) =>
      listBranchCashiers(client, { orgId: other.orgId, branchId: other.branchId }),
    );
    expect(otherCashiers).toHaveLength(0);
  });

  it('F4-c. Branch health reports branch_online, cloud_online and the outbox depth', async () => {
    const fx = await saleFixture('F4 health');
    await ringSale(fx, randomUUID());

    const health = await withClient((client) =>
      branchHealth(client, { orgId: fx.tenant.orgId, branchId: fx.tenant.branchId }),
    );
    expect(health.branch_online).toBe(true);
    expect(health.branch_up).toBe(true);
    expect(health.outbox_size).toBe(1);
    expect(health.cloud_online).toBe(false);
    expect(health.protocol_version).toBe(1);
  });
});

/**
 * A tiny stand-in for the cloud's health endpoint. Toxiproxy fronts it so the link can be cut.
 * It is not a mock of the branch: the branch path under test is entirely real.
 */
async function startFakeCloud(): Promise<{ upstream: string; stop: () => Promise<void> }> {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mode: 'cloud', branch_up: true, protocol_version: 1 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    // The proxy runs in a container, so it reaches the host via host.docker.internal.
    upstream: `host.docker.internal:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
