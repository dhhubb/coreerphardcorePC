import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { expectError, one, sql } from './support/db';
import { createTenant, tenantToken, type Tenant } from './support/fixtures';
import { testDatabaseUrl } from '../src/core/env';
import { MockFdmsClient, MockFDMS, RealFDMS, type FdmsClient, type FdmsSubmission } from '../src/fiscal/fdms';
import { runFiscalPassOn } from '../src/fiscal/queue';
import { ensureNextBlock, issueNumberBlock, storeNumberBlock } from '../src/fiscal/numberBlocks';
import { GET as blocksNextGet } from '../src/app/api/blocks/next/route';
import { POST as fiscalRetryPost } from '../src/app/api/fiscal/retry/route';
import { POST as claimPost } from '../src/app/api/branch/numbers/claim/route';

/**
 * F6 — the fiscal-and-numbering completion slice. Tests 136–140, continuing from F5's 135 (ADR-0010).
 *
 * H3 already shipped the FDMS queue, the worker, the FdmsClient interface, cloud-issued number
 * blocks, the receipt's fiscal block and the /settings/fiscal page (tests 64–68). F6 closes the parts
 * of the brief H3 left out: the queue row carries the invoice number, the brief's named queue index,
 * the brief's number-block vocabulary, the brief's exact exhaustion message, the named
 * GET /api/blocks/next and POST /api/fiscal/retry routes, and a mock device that can delay.
 *
 * Everything runs against the real local Postgres. The branch side is exercised through a pool that
 * carries `app.branch_mode=branch` (the fiscal enqueue is a branch responsibility). The FDMS device
 * is the in-memory mock from `src/fiscal/fdms.ts` — a real object with real state. No database is
 * mocked. Test 139 drives GET /api/blocks/next through a real HTTP call to a small fake cloud that
 * delegates to the real cloud claim route, so the branch and cloud really talk over the wire.
 */

const branchPool = new Pool({
  connectionString: testDatabaseUrl(),
  options: '-c app.branch_mode=branch',
  max: 12,
});

afterAll(async () => {
  await branchPool.end();
});

async function withBranch<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await branchPool.connect();
  try {
    return await fn(client);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** One fiscal pass on its own connection and transaction, as the branch worker runs it. */
async function pass(
  client: PoolClient,
  fdms: FdmsClient,
  orgId: string,
  branchId: string,
  limit?: number,
): Promise<Awaited<ReturnType<typeof runFiscalPassOn>>> {
  await client.query('begin');
  try {
    const result = await runFiscalPassOn(client, fdms, {
      orgId,
      branchId,
      ...(limit !== undefined ? { limit } : {}),
    });
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function makeDue(orgId: string): Promise<void> {
  await sql(`update public.fiscal_invoices set next_attempt_at = now() where org_id = $1`, [orgId]);
}

interface F6Fixture {
  tenant: Tenant;
  warehouseId: string;
  productId: string;
  variantId: string;
  barcode: string;
  shiftId: string;
}

/** A branch with stock, a price, a barcode and an open shift. */
async function f6Fixture(name: string, qty = 1000): Promise<F6Fixture> {
  const tenant = await createTenant(name);
  const warehouse = await one<{ id: string }>(
    `insert into public.warehouses (org_id, branch_id, code, name)
     values ($1, $2, 'W1', 'W1') returning id`,
    [tenant.orgId, tenant.branchId],
  );
  const product = await one<{ id: string }>(
    `insert into public.products (org_id, sku, name)
     values ($1, app.next_number($1, 'SKU'), $2) returning id`,
    [tenant.orgId, `${name} product`],
  );
  const barcode = `BC-${Math.random().toString(36).slice(2, 10)}`;
  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name, barcode)
     values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
    [tenant.orgId, product!.id, barcode],
  );
  const priceList = await one<{ id: string }>(
    `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
    [tenant.orgId],
  );
  await sql(
    `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
     values ($1, $2, $3, '5.0000')`,
    [tenant.orgId, priceList!.id, variant!.id],
  );
  await sql(`select app.post_receipt($1, $2, $3, $4, $5, $6, 2, '2026-06-15'::date)`, [
    tenant.orgId,
    tenant.branchId,
    warehouse!.id,
    product!.id,
    variant!.id,
    qty,
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
    barcode,
    shiftId: shift!.id,
  };
}

/** Ring one sale through app.post_pos_sale on a branch-mode connection. */
async function ringSale(fx: F6Fixture, client: PoolClient, clientSaleId = randomUUID()): Promise<void> {
  await client.query(`select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) as app`, [
    fx.tenant.orgId,
    fx.tenant.branchId,
    fx.warehouseId,
    fx.shiftId,
    clientSaleId,
    JSON.stringify([{ barcode: fx.barcode, qty: 1 }]),
    JSON.stringify([{ method: 'cash', currency: 'USD', amount_tendered: '10' }]),
  ]);
}

/** Post a bare invoice through app.create_invoice and return its id and number. */
async function createInvoice(
  fx: F6Fixture,
  client: PoolClient,
): Promise<{ invoiceId: string; invoiceNo: string }> {
  const result = await client.query<{ app: { invoice_id: string; invoice_no: string } }>(
    `select app.create_invoice($1, $2, null, '2026-06-15'::date, $3::jsonb) as app`,
    [
      fx.tenant.orgId,
      fx.tenant.branchId,
      JSON.stringify([
        {
          product_id: fx.productId,
          variant_id: fx.variantId,
          warehouse_id: fx.warehouseId,
          qty: '1',
          unit_price: '5.0000',
        },
      ]),
    ],
  );
  return { invoiceId: result.rows[0]!.app.invoice_id, invoiceNo: result.rows[0]!.app.invoice_no };
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

/** A fake cloud that delegates to the REAL claim route, but issues a small block (size 5) so a test
 * can exhaust it quickly. It answers the branch over real HTTP; the database is not mocked. */
function startFakeCloud(token: string, size = 5): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const incoming = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
      const claim = await claimPost(
        new Request('http://cloud/api/branch/numbers/claim', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...incoming, size }),
        }),
      );
      const text = await claim.text();
      res.writeHead(claim.status, { 'content-type': 'application/json' });
      res.end(text);
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

let fakeCloud: { server: Server; url: string } | null = null;

afterEach(async () => {
  delete process.env.CLOUD_URL;
  delete process.env.BRANCH_SYNC_TOKEN;
  if (fakeCloud) {
    await new Promise<void>((resolve) => fakeCloud!.server.close(() => resolve()));
    fakeCloud = null;
  }
});

describe('F6 fiscal and numbering completion', () => {
  it('136. A sale inserts a pending fiscal row with its invoice number, and the named queue index exists', async () => {
    const fx = await f6Fixture('F6 136');

    await withBranch(async (client) => {
      await client.query('begin');
      await ringSale(fx, client);
      await client.query('commit');
    });

    const row = await one<{ status: string; attempts: number; invoice_number: string | null; invoice_id: string }>(
      `select status, attempts, invoice_number, invoice_id
         from public.fiscal_invoices where org_id = $1`,
      [fx.tenant.orgId],
    );
    expect(row).toBeTruthy();
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(0);

    // The new column carries the number the invoice used, snapshotted on the queue row.
    const invoice = await one<{ invoice_no: string }>(
      `select invoice_no from public.invoices where id = $1`,
      [row!.invoice_id],
    );
    expect(row!.invoice_number).toBe(invoice!.invoice_no);

    // A rolled-back sale leaves no fiscal row (the enqueue is in the sale's own transaction).
    const rolled = await expectError(() =>
      withBranch(async (client) => {
        await client.query('begin');
        await ringSale(fx, client);
        await client.query('rollback');
        throw new Error('rollback on purpose');
      }),
    );
    expect(rolled.message).toContain('rollback on purpose');
    const count = await one<{ n: string }>(
      `select count(*)::text as n from public.fiscal_invoices where org_id = $1`,
      [fx.tenant.orgId],
    );
    expect(count!.n).toBe('1');

    // The brief's named queue index exists with the right columns.
    const index = await one<{ cols: string }>(
      `select string_agg(a.attname, ',' order by k.ord) as cols
         from pg_index i
         join pg_class c on c.oid = i.indexrelid
         join unnest(i.indkey) with ordinality as k(attnum, ord) on true
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
        where c.relname = 'fiscal_invoices_org_branch_status_created_idx'`,
    );
    expect(index?.cols).toBe('org_id,branch_id,status,created_at');
  });

  it('137. A real FDMS rejection retries with backoff, and 5 rejections move the row to failed', async () => {
    const fx = await f6Fixture('F6 137');
    await withBranch((client) => createInvoice(fx, client));

    // The brief's MockFDMS alias, with a delay so a submission is a real awaited call.
    const rejecting = new MockFDMS({ rejections: 100, delayMs: 1 });
    expect(rejecting).toBeInstanceOf(MockFdmsClient);

    await withBranch((client) => pass(client, rejecting, fx.tenant.orgId, fx.tenant.branchId));
    const afterOne = await one<{ status: string; attempts: number }>(
      `select status, attempts from public.fiscal_invoices where org_id = $1`,
      [fx.tenant.orgId],
    );
    expect(afterOne!.status).toBe('pending');
    expect(afterOne!.attempts).toBe(1);

    const backoff = await one<{ future: boolean }>(
      `select (next_attempt_at > now()) as future from public.fiscal_invoices where org_id = $1`,
      [fx.tenant.orgId],
    );
    expect(backoff!.future).toBe(true);

    const tooSoon = await withBranch((client) =>
      pass(client, rejecting, fx.tenant.orgId, fx.tenant.branchId),
    );
    expect(tooSoon.claimed).toBe(0);

    for (let i = 0; i < 4; i += 1) {
      await makeDue(fx.tenant.orgId);
      await withBranch((client) => pass(client, rejecting, fx.tenant.orgId, fx.tenant.branchId));
    }
    const failed = await one<{ status: string; attempts: number }>(
      `select status, attempts from public.fiscal_invoices where org_id = $1`,
      [fx.tenant.orgId],
    );
    expect(failed!.status).toBe('failed');
    expect(failed!.attempts).toBe(5);

    // A failed row is no longer claimed. The admin retry route re-arms it as pending.
    await makeDue(fx.tenant.orgId);
    const after = await withBranch((client) =>
      pass(client, rejecting, fx.tenant.orgId, fx.tenant.branchId),
    );
    expect(after.claimed).toBe(0);

    const fiscalId = await one<{ id: string }>(
      `select id from public.fiscal_invoices where org_id = $1`,
      [fx.tenant.orgId],
    );
    const retried = await fiscalRetryPost(
      request('/api/fiscal/retry', tenantToken(fx.tenant), {
        method: 'POST',
        body: JSON.stringify({ fiscal_invoice_id: fiscalId!.id }),
      }),
    );
    expect(retried.status).toBe(200);
    const rearmed = await one<{ status: string; attempts: number }>(
      `select status, attempts from public.fiscal_invoices where org_id = $1`,
      [fx.tenant.orgId],
    );
    expect(rearmed!.status).toBe('pending');
    expect(rearmed!.attempts).toBe(0);

    // The HTTP client is exported under the brief's name too.
    expect(typeof RealFDMS).toBe('function');
  });

  it('138. With FDMS down 10 sales queue 10 fiscal invoices; when it returns all 10 submit exactly once', async () => {
    const fx = await f6Fixture('F6 138', 5000);

    const fdms = new MockFDMS({ online: false });

    await withBranch(async (client) => {
      for (let i = 0; i < 10; i += 1) {
        await client.query('begin');
        await ringSale(fx, client);
        await client.query('commit');
      }
    });

    const queued = await one<{ n: string }>(
      `select count(*)::text as n from public.fiscal_invoices
        where org_id = $1 and status = 'pending' and invoice_number is not null`,
      [fx.tenant.orgId],
    );
    expect(queued!.n).toBe('10');

    // A pass while still down: nothing sent, no attempt counted.
    await withBranch((client) => pass(client, fdms, fx.tenant.orgId, fx.tenant.branchId));
    const stillPending = await one<{ n: string }>(
      `select count(*)::text as n from public.fiscal_invoices
        where org_id = $1 and status = 'pending' and attempts = 0`,
      [fx.tenant.orgId],
    );
    expect(stillPending!.n).toBe('10');

    fdms.restore();
    await makeDue(fx.tenant.orgId);
    const result = await withBranch((client) =>
      pass(client, fdms, fx.tenant.orgId, fx.tenant.branchId),
    );
    expect(result.sent).toBe(10);

    expect(fdms.accepted).toHaveLength(10);
    expect(new Set(fdms.accepted).size).toBe(10);

    const again = await withBranch((client) =>
      pass(client, fdms, fx.tenant.orgId, fx.tenant.branchId),
    );
    expect(again.claimed).toBe(0);
    expect(fdms.accepted).toHaveLength(10);
  });

  it('139. GET /api/blocks/next tops up before the current block runs out; offline exhaustion fails clearly and reuses no number', async () => {
    const fx = await f6Fixture('F6 139', 5000);
    const token = tenantToken(fx.tenant);

    // A real HTTP fake cloud that delegates to the real claim route and issues a 5-number block.
    fakeCloud = await startFakeCloud(token, 5);
    process.env.CLOUD_URL = fakeCloud.url;
    process.env.BRANCH_SYNC_TOKEN = token;

    // No block yet: the branch asks and receives its first block.
    const first = await blocksNextGet(request('/api/blocks/next', token));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      status: { remaining: number; exhausted: boolean };
      requested: boolean;
    };
    expect(firstBody.requested).toBe(true);
    expect(firstBody.status.exhausted).toBe(false);
    expect(firstBody.status.remaining).toBe(5);

    const sell = () =>
      withBranch(async (client) => {
        await client.query('begin');
        const invoice = await createInvoice(fx, client);
        await client.query('commit');
        return invoice;
      });

    // Three sales leave two of the five numbers: above the 20% low-water mark (1), so no top-up.
    await sell();
    await sell();
    await sell();
    const above = await blocksNextGet(request('/api/blocks/next', token));
    const aboveBody = (await above.json()) as { requested: boolean };
    expect(aboveBody.requested).toBe(false);

    // One more sale leaves a single number: at the low-water mark, so the branch tops up.
    await sell();
    const topUp = await blocksNextGet(request('/api/blocks/next', token));
    const topUpBody = (await topUp.json()) as { requested: boolean; status: { remaining: number } };
    expect(topUpBody.requested).toBe(true);
    expect(topUpBody.status.remaining).toBe(6); // the one left + the new five

    // The cloud goes offline. The branch sells the rest of its numbers, then the next sale fails.
    await new Promise<void>((resolve) => fakeCloud!.server.close(() => resolve()));
    fakeCloud = null;

    await sell(); // the last of block 1
    await sell();
    await sell();
    await sell();
    await sell();
    await sell(); // the last of block 2

    const failure = await expectError(sell);
    expect(failure.message).toMatch(
      /Invoice numbers exhausted - connect to cloud to get new block/,
    );

    // Every number used is unique and gapless; the failed sale reused nothing.
    const numbers = await sql<{ invoice_no: string }>(
      `select invoice_no from public.invoices where org_id = $1 order by invoice_no`,
      [fx.tenant.orgId],
    );
    expect(numbers.map((r) => r.invoice_no)).toEqual([
      '000001', '000002', '000003', '000004', '000005',
      '000006', '000007', '000008', '000009', '000010',
    ]);
    const distinct = await one<{ n: string }>(
      `select count(distinct invoice_no)::text as n from public.invoices where org_id = $1`,
      [fx.tenant.orgId],
    );
    expect(distinct!.n).toBe('10');
  });

  it('140. Two fiscal workers running at once never submit the same invoice twice (SKIP LOCKED)', async () => {
    const fx = await f6Fixture('F6 140', 5000);
    const orgId = fx.tenant.orgId;
    const branchId = fx.tenant.branchId;

    await withBranch(async (client) => {
      for (let i = 0; i < 20; i += 1) {
        await client.query('begin');
        await createInvoice(fx, client);
        await client.query('commit');
      }
    });

    // A slow device (the mock's new delay) so the two workers really overlap.
    const slow = new MockFDMS({ delayMs: 15 });

    const clientA = await branchPool.connect();
    const clientB = await branchPool.connect();
    try {
      const a = pass(clientA, slow, orgId, branchId, 10);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const b = pass(clientB, slow, orgId, branchId, 10);
      const [resultA, resultB] = await Promise.all([a, b]);

      expect(resultA.claimed + resultB.claimed).toBe(20);
      expect(new Set(slow.submissions.map((s) => s.invoiceId)).size).toBe(slow.submissions.length);
      expect(new Set(slow.accepted).size).toBe(slow.accepted.length);
    } finally {
      clientA.release();
      clientB.release();
    }

    // Drain anything left and confirm exactly-once across the whole run. Both workers together
    // claimed all 20, so the drain normally finds nothing left; if a pass had failed mid-way it
    // would pick up the remainder. Either way every invoice is sent exactly once.
    for (let i = 0; i < 5; i += 1) {
      await makeDue(orgId);
      const result = await withBranch((client) => pass(client, slow, orgId, branchId));
      if (result.claimed === 0) break;
    }
    const accepted = await one<{ n: string }>(
      `select count(*)::text as n from public.fiscal_invoices where org_id = $1 and status = 'sent'`,
      [orgId],
    );
    expect(accepted!.n).toBe('20');
    expect(slow.accepted).toHaveLength(20);
    expect(new Set(slow.accepted).size).toBe(20);
  });
});
