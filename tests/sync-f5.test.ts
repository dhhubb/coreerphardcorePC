import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { one, sql } from './support/db';
import { createTenant, tenantToken, type Tenant } from './support/fixtures';
import { testDatabaseUrl } from '../src/core/env';
import { pushOnce } from '../src/sync/push';
import { GET as backupGet, POST as backupPost } from '../src/app/api/backup/route';
import { POST as conflictsPost } from '../src/app/api/sync/conflicts/route';
import type { SyncOutboxEvent } from '../src/sync/types';

/**
 * F5 — the sync engine completion slice. Tests 131–135, continuing from F4's 130 (ADR-0010).
 *
 * H2 already shipped the outbox, the idempotent cloud ingest, the pull, the retry policy and the
 * encrypted backup (tests 53–63). F5 completes the parts of the brief H2 left out. Everything runs
 * against the real local Postgres: the branch side through a pool that carries `app.branch_mode=branch`
 * (the outbox triggers only fire in branch mode), the cloud side through a plain pool. No database is
 * mocked.
 */

const branchPool = new Pool({
  connectionString: testDatabaseUrl(),
  options: '-c app.branch_mode=branch',
  max: 8,
});

afterAll(async () => {
  await branchPool.end();
});

async function withBranch<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await branchPool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withCloud<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await new Pool({ connectionString: testDatabaseUrl(), max: 1 }).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

interface BranchFixture {
  tenant: Tenant;
  warehouseId: string;
  productId: string;
  variantId: string;
  shiftId: string;
  invoiceId: string;
}

/** A branch with stock, a shift and one invoice, ready to ring a sale or close a shift. */
async function branchFixture(name: string): Promise<BranchFixture> {
  const tenant = await createTenant(name);
  const warehouse = await one<{ id: string }>(
    `insert into public.warehouses (org_id, branch_id, code, name)
     values ($1, $2, 'W1', 'W1') returning id`,
    [tenant.orgId, tenant.branchId],
  );
  const product = await one<{ id: string }>(
    `insert into public.products (org_id, sku, name)
     values ($1, app.next_number($1, 'SKU'), 'F5 widget') returning id`,
    [tenant.orgId],
  );
  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name, barcode)
     values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
    [tenant.orgId, product!.id, `BC-${Math.random().toString(36).slice(2, 10)}`],
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
  const contact = await one<{ id: string }>(
    `insert into public.contacts (org_id, kind, name)
     values ($1, 'customer', 'F5 contact') returning id`,
    [tenant.orgId],
  );
  const invoice = await one<{ id: string }>(
    `insert into public.invoices
       (org_id, branch_id, contact_id, invoice_no, invoice_date, subtotal, tax_total, total)
     values ($1, $2, $3, $4, current_date, 5, 0, 5) returning id`,
    [tenant.orgId, tenant.branchId, contact!.id, `F5-INV-${randomUUID().slice(0, 8)}`],
  );
  return {
    tenant,
    warehouseId: warehouse!.id,
    productId: product!.id,
    variantId: variant!.id,
    shiftId: shift!.id,
    invoiceId: invoice!.id,
  };
}

async function ringSale(fx: BranchFixture, client: PoolClient, clientSaleId: string): Promise<string> {
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
}

async function outboxEvents(
  client: PoolClient,
  orgId: string,
  branchId: string,
): Promise<SyncOutboxEvent[]> {
  const result = await client.query<{ b: SyncOutboxEvent[] }>(
    'select app.sync_outbox_batch($1, $2, 500) as b',
    [orgId, branchId],
  );
  return result.rows[0]!.b;
}

function request(path: string, token: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

describe('F5 sync engine completion', () => {
  it('131. A rejected event does not block the rest of the batch, and the outbox still drains', async () => {
    const fx = await branchFixture('F5 nonblocking');
    await withBranch(async (client) => {
      await ringSale(fx, client, randomUUID());
      await ringSale(fx, client, randomUUID());
      await ringSale(fx, client, randomUUID());
    });

    const events = await withBranch((client) =>
      outboxEvents(client, fx.tenant.orgId, fx.tenant.branchId),
    );
    expect(events).toHaveLength(3);
    const [first, second, third] = events;
    // Make the middle event malformed: the cloud cannot replay a sale with no lines.
    const bad: SyncOutboxEvent = {
      seq: second!.seq,
      event_id: randomUUID(),
      event_type: 'sale',
      payload: { client_sale_id: randomUUID() },
      created_at: new Date().toISOString(),
    };

    const result = await withCloud((client) =>
      client.query<{ r: { applied: number; highest_seq: string; rejects: Array<{ event_id: string }> } }>(
        'select app.sync_push_result($1, $2, $3::jsonb) as r',
        [fx.tenant.orgId, fx.tenant.branchId, JSON.stringify([first, bad, third])],
      ),
    );

    // The two good events still applied; only the malformed one was rejected. H2 returned early and
    // would have applied only the first event.
    expect(result.rows[0]!.r.applied).toBe(2);
    expect(result.rows[0]!.r.rejects).toHaveLength(1);
    expect(result.rows[0]!.r.rejects[0]!.event_id).toBe(bad.event_id);
    // highest_seq is the highest sequence PROCESSED, so the branch can ack past the rejection.
    expect(result.rows[0]!.r.highest_seq).toBe(third!.seq);

    // The branch acks up to that highest sequence, so the outbox drains: no event is re-pushed
    // forever. The rejection itself is the durable record (a conflict), not a stuck outbox row.
    await withBranch((client) =>
      client.query('select app.sync_outbox_ack($1, $2, $3)', [
        fx.tenant.orgId,
        fx.tenant.branchId,
        result.rows[0]!.r.highest_seq,
      ]),
    );
    const pending = await one<{ n: string }>(
      'select app.sync_outbox_size($1, $2)::text as n',
      [fx.tenant.orgId, fx.tenant.branchId],
    );
    expect(pending!.n).toBe('0');
  });

  it('132. A conflict records both versions, and retry re-queues the local event for another push', async () => {
    const fx = await branchFixture('F5 conflict');
    await withBranch((client) => ringSale(fx, client, randomUUID()));

    // The cloud refuses the event; the worker records a durable conflict carrying both versions.
    const outcome = await withBranch((client) =>
      pushOnce({
        client,
        orgId: fx.tenant.orgId,
        branchId: fx.tenant.branchId,
        deliver: async (batch) => ({
          highest_seq: batch[batch.length - 1]!.seq,
          applied: 0,
          duplicates: 0,
          rejects: [{ event_id: batch[0]!.event_id, reason: 'cloud said the sale is invalid' }],
        }),
      }),
    );
    expect(outcome.rejected).toHaveLength(1);

    const conflict = await one<{ id: string; both_versions: { local: { payload: unknown }; cloud: { reason: string } } }>(
      'select id, both_versions from public.sync_conflicts where org_id = $1',
      [fx.tenant.orgId],
    );
    // Both versions are present: what the branch sent and what the cloud answered.
    expect(conflict!.both_versions.local.payload).toBeTruthy();
    expect(conflict!.both_versions.cloud.reason).toBe('cloud said the sale is invalid');

    // The status page's data carries the conflict with both versions.
    const status = await withBranch((client) =>
      client.query<{ status: { conflicts: number; pending_count: number } }>(
        'select app.sync_status($1, $2) as status',
        [fx.tenant.orgId, fx.tenant.branchId],
      ),
    );
    expect(status.rows[0]!.status.conflicts).toBe(1);

    // "Retry failed" re-queues the local event: a new outbox row appears, so the branch pushes again.
    const token = tenantToken(fx.tenant);
    const response = await conflictsPost(
      request('/api/sync/conflicts', token, {
        method: 'POST',
        body: JSON.stringify({ conflict_id: conflict!.id }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { requeued_seq: string };
    expect(BigInt(body.requeued_seq)).toBeGreaterThan(0n);

    const pending = await one<{ n: string }>(
      'select app.sync_outbox_size($1, $2)::text as n',
      [fx.tenant.orgId, fx.tenant.branchId],
    );
    expect(pending!.n).toBe('1'); // the re-queued event is waiting to be pushed
  });

  it('133. Closing a shift emits a z_report event and an FDMS outcome emits a fiscal_result event', async () => {
    const fx = await branchFixture('F5 facts');

    await withBranch(async (client) => {
      // A closed shift writes an immutable z_reports row; the new trigger records the fact.
      await client.query(
        `insert into public.z_reports
           (org_id, branch_id, shift_id, z_no, opened_at, closed_at, opening_float, sale_count,
            void_count, gross_sales, tax_total, by_method, by_currency, vat_by_rate)
         values ($1, $2, $3, $4, now() - interval '1 hour', now(), 0, 3, 0, 15, 0, '{}', '{}', '{}')`,
        [fx.tenant.orgId, fx.tenant.branchId, fx.shiftId, `Z-${randomUUID().slice(0, 8)}`],
      );

      // An FDMS outcome moves the fiscal row to 'sent'; the new trigger records the result.
      const fiscal = await client.query<{ id: string }>(
        `insert into public.fiscal_invoices (org_id, branch_id, invoice_id, fdms_payload, status)
         values ($1, $2, $3, '{"seed": true}'::jsonb, 'pending') returning id`,
        [fx.tenant.orgId, fx.tenant.branchId, fx.invoiceId],
      );
      await client.query(`update public.fiscal_invoices set status = 'sent', sent_at = now() where id = $1`, [
        fiscal.rows[0]!.id,
      ]);
    });

    const events = await withBranch((client) =>
      outboxEvents(client, fx.tenant.orgId, fx.tenant.branchId),
    );
    const types = events.map((event) => event.event_type).sort();
    expect(types).toContain('z_report');
    expect(types).toContain('fiscal_result');

    const zEvent = events.find((event) => event.event_type === 'z_report')!;
    // JSONB numerics come back through the driver as JS numbers.
    expect(zEvent.payload).toMatchObject({ sale_count: 3, gross_sales: 15 });
    const fiscalEvent = events.find((event) => event.event_type === 'fiscal_result')!;
    expect(fiscalEvent.payload).toMatchObject({ status: 'sent', invoice_id: fx.invoiceId });
  });

  it('134. A sale line keeps the price version it charged, so a later pull cannot rewrite it', async () => {
    const fx = await branchFixture('F5 price version');

    // The branch's mirror holds the price the till read, at version 7.
    await sql(
      `insert into public.branch_master_data
         (org_id, branch_id, entity_type, entity_id, payload, price_version, change_seq)
       values ($1, $2, 'price_list_item', $3, $4::jsonb, 7, 7)`,
      [fx.tenant.orgId, fx.tenant.branchId, fx.variantId, JSON.stringify({ price: '5.0000' })],
    );

    const saleId = await withBranch((client) => ringSale(fx, client, randomUUID()));

    const recorded = await one<{ price_version: string; unit_price: string; line_no: number }>(
      `select price_version::text, unit_price::text, line_no
         from public.pos_sale_price_versions
        where org_id = $1 and sale_id = $2`,
      [fx.tenant.orgId, saleId],
    );
    expect(recorded!.price_version).toBe('7');
    expect(recorded!.unit_price).toBe('5.0000');

    // A later pull bumps the mirror's version. The recorded sale line does not change: it keeps the
    // version it charged.
    await sql(
      `update public.branch_master_data set price_version = 9, payload = '{"price": "6.0000"}'::jsonb
        where org_id = $1 and branch_id = $2 and entity_id = $3`,
      [fx.tenant.orgId, fx.tenant.branchId, fx.variantId],
    );
    const after = await one<{ price_version: string }>(
      `select price_version::text from public.pos_sale_price_versions where org_id = $1 and sale_id = $2`,
      [fx.tenant.orgId, saleId],
    );
    expect(after!.price_version).toBe('7');
  });

  it('135. POST /api/backup records the run and updates the branch last-backup time', async () => {
    const fx = await branchFixture('F5 backup');
    const token = tenantToken(fx.tenant);

    const response = await backupPost(
      request('/api/backup', token, {
        method: 'POST',
        body: JSON.stringify({
          status: 'uploaded',
          object_key: `branches/${fx.tenant.orgId}/${fx.tenant.branchId}/backup.dump.enc`,
          byte_size: 2048,
          checksum: 'abc123',
        }),
      }),
    );
    expect(response.status).toBe(200);

    const row = await one<{ status: string; checksum: string; byte_size: string }>(
      'select status, checksum, byte_size from public.sync_backups where org_id = $1',
      [fx.tenant.orgId],
    );
    expect(row!.status).toBe('uploaded');
    expect(row!.checksum).toBe('abc123');
    expect(row!.byte_size).toBe('2048');

    // The backup trigger set the branch's last-backup time, visible on the sync status.
    const status = await withBranch((client) =>
      client.query<{ status: { last_backup_at: string | null } }>(
        'select app.sync_status($1, $2) as status',
        [fx.tenant.orgId, fx.tenant.branchId],
      ),
    );
    expect(status.rows[0]!.status.last_backup_at).not.toBeNull();

    // GET /api/backup lists the run.
    const listed = await backupGet(request('/api/backup', token));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { backups: Array<{ status: string; checksum: string }> };
    expect(body.backups).toHaveLength(1);
    expect(body.backups[0]!.checksum).toBe('abc123');
  });
});
