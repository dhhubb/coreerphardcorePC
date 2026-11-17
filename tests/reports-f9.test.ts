import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { one, sql, tx } from './support/db';
import {
  addProduct,
  addWarehouse,
  createTenant,
  postReceipt,
  tenantToken,
  type Tenant,
} from './support/fixtures';
import { GET as todayRoute } from '../src/app/api/reports/today/route';
import { GET as zDetailRoute } from '../src/app/api/reports/z-reports/[id]/route';
import {
  lastSync,
  profitByProduct,
  syncAgeLabel,
  todayFigures,
  zReportDetail,
  zReports,
} from '../src/verticals/reports';

/**
 * F9 — reports and the owner console completion. Tests 151–160, continuing from F8's 150
 * (ADR-0076).
 *
 * Everything runs against the real local Postgres. The figures come from the same SQL functions the
 * routes call, so the branch console and the cloud owner console cannot drift (ADR-0049). Today is
 * read live from pos_sales / pos_payments bounded by the branch's (org_id, branch_id, created_at)
 * index; a closed day is read from the immutable daily_product_sales facts (ADR-0046).
 */

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

interface ReportFixture {
  tenant: Tenant;
  warehouseId: string;
  productId: string;
  variantId: string;
  barcode: string;
  shiftId: string;
  unitPrice: string;
}

/** A tenant with a warehouse, a barcoded variant, a retail price and stock on hand. */
async function reportFixture(
  name: string,
  options: { qty?: number; unitCost?: number; unitPrice?: string } = {},
): Promise<ReportFixture> {
  const tenant = await createTenant(name);
  const warehouseId = await addWarehouse(tenant, 'W1');
  const productId = await addProduct(tenant, `${name} product`);

  const barcode = `BC-${Math.random().toString(36).slice(2, 10)}`;
  const variant = await one<{ id: string }>(
    `insert into public.product_variants (org_id, product_id, sku, name, barcode)
     values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
    [tenant.orgId, productId, barcode],
  );
  const variantId = variant!.id;

  const unitPrice = options.unitPrice ?? '10.0000';
  const priceList = await one<{ id: string }>(
    `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
    [tenant.orgId],
  );
  await sql(
    `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
     values ($1, $2, $3, $4)`,
    [tenant.orgId, priceList!.id, variantId, unitPrice],
  );

  await postReceipt(
    tenant,
    warehouseId,
    productId,
    options.qty ?? 100,
    options.unitCost ?? 4,
    TODAY,
    variantId,
  );

  const shift = await one<{ id: string }>(
    `insert into public.shifts (org_id, branch_id, till_id, opening_float)
     values ($1, $2, 'T1', 0) returning id`,
    [tenant.orgId, tenant.branchId],
  );

  return { tenant, warehouseId, productId, variantId, barcode, shiftId: shift!.id, unitPrice };
}

/** Ring a sale through app.post_pos_sale, exactly as the thin route handler does. */
async function postSale(
  fixture: ReportFixture,
  input: {
    qty: string | number;
    currency?: string;
    amountTendered?: string;
    saleDate?: string;
  },
): Promise<Record<string, unknown>> {
  const row = await one<{ app: Record<string, unknown> }>(
    `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, null, $8::date) as app`,
    [
      fixture.tenant.orgId,
      fixture.tenant.branchId,
      fixture.warehouseId,
      fixture.shiftId,
      randomUUID(),
      JSON.stringify([
        { barcode: fixture.barcode, qty: input.qty, unit_price: fixture.unitPrice },
      ]),
      JSON.stringify([
        {
          method: 'cash',
          currency: input.currency ?? 'USD',
          amount_tendered: input.amountTendered ?? '1000',
        },
      ]),
      input.saleDate ?? TODAY,
    ],
  );
  return row!.app;
}

/** Close a shift, writing its Z-report and its immutable daily facts. */
async function closeShift(fixture: ReportFixture): Promise<string> {
  const row = await one<{ app: string }>(`select app.close_shift($1, $2, $3) as app`, [
    fixture.tenant.orgId,
    fixture.shiftId,
    fixture.tenant.userId,
  ]);
  return row!.app;
}

/** A ZWG exchange rate, so a ZWG tender can be taken. */
async function addZwgRate(tenant: Tenant, rate = '30.0000000000'): Promise<void> {
  await sql(
    `insert into public.exchange_rates (org_id, currency, rate, effective_from)
     values ($1, 'ZWG', $2, date '2020-01-01')`,
    [tenant.orgId, rate],
  );
}

describe('F9 reports and the owner console completion', () => {
  it('151. report_today shows today’s takings by currency and by till, and the base total', async () => {
    const fixture = await reportFixture('F9 test 151', { unitPrice: '10.0000' });
    await addZwgRate(fixture.tenant);

    // Two USD sales (2 x 10 + 15% VAT = 23 each) and one ZWG sale (5 x 10 = 50 + VAT = 57.50 at 30).
    await postSale(fixture, { qty: 2 });
    await postSale(fixture, { qty: 2 });
    await postSale(fixture, { qty: 5, currency: 'ZWG', amountTendered: '3000' });

    await tx(async (client) => {
      const today = await todayFigures(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
      });

      expect(today.saleCount).toBe(3);
      // Gross is the sum of the invoices' subtotals (exclusive of VAT): 20 + 20 + 50 = 90.
      expect(today.grossSales.toFixed(4)).toBe('90.0000');

      // By currency: the ZWG tender's applied amount is 57.50 / 30 = 1.9167 ZWG; USD is 23 + 23.
      expect(today.byCurrency['USD']!.toFixed(4)).toBe('46.0000');
      expect(today.byCurrency['ZWG']!.toFixed(4)).toBe('1.9167');

      // Base (USD): 23 + 23 + 57.50 = 103.50.
      expect(today.salesBase.toFixed(4)).toBe('103.5000');

      // By till: all three rang on T1.
      expect(today.byTill).toHaveLength(1);
      expect(today.byTill[0]!.tillId).toBe('T1');
      expect(today.byTill[0]!.saleCount).toBe(3);
      expect(today.byTill[0]!.gross.toFixed(4)).toBe('90.0000');
    });
  });

  it('152. Today is read live; a closed-day fact and a yesterday sale are not counted', async () => {
    const fixture = await reportFixture('F9 test 152', { unitPrice: '10.0000' });
    await postSale(fixture, { qty: 2 });

    // A sale row dated yesterday, on the same invoice, must not count as today's (the today read is
    // bounded by created_at >= current_date).
    const invoice = await one<{ invoice_id: string }>(
      `select invoice_id from public.pos_sales where org_id = $1 limit 1`,
      [fixture.tenant.orgId],
    );
    await sql(
      `insert into public.pos_sales
         (id, org_id, branch_id, shift_id, invoice_id, client_sale_id, status, created_at)
       values ($1, $2, $3, $4, $5, $6, 'completed', now() - interval '1 day')`,
      [
        randomUUID(),
        fixture.tenant.orgId,
        fixture.tenant.branchId,
        fixture.shiftId,
        invoice!.invoice_id,
        randomUUID(),
      ],
    );

    // A closed-day fact for yesterday, inserted directly (the fact table is written by close_shift).
    await sql(
      `insert into public.daily_product_sales
         (org_id, branch_id, business_date, shift_id, product_id, qty, gross, tax, cogs)
       values ($1, $2, current_date - 1, $3, $4, 9, 90, 13.5, 36)`,
      [fixture.tenant.orgId, fixture.tenant.branchId, fixture.shiftId, fixture.productId],
    );

    await tx(async (client) => {
      const today = await todayFigures(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
      });
      // One sale today, whatever else exists: the yesterday sale and the fact are excluded.
      expect(today.saleCount).toBe(1);
      expect(today.grossSales.toFixed(4)).toBe('20.0000');

      // The closed day is read from the facts, not the live tables.
      const yesterday = await profitByProduct(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
        period: { from: YESTERDAY, to: YESTERDAY },
      });
      expect(yesterday.rows).toHaveLength(1);
      expect(yesterday.rows[0]!.qty.toFixed(4)).toBe('9.0000');
    });
  });

  it('153. report_today lists low stock (on-hand below five) and nothing above it', async () => {
    const fixture = await reportFixture('F9 test 153', { unitPrice: '10.0000' });
    // A second product with only three on hand.
    const lowProduct = await addProduct(fixture.tenant, 'F9 low stock');
    const lowVariant = await one<{ id: string }>(
      `insert into public.product_variants (org_id, product_id, sku, name, barcode)
       values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
      [fixture.tenant.orgId, lowProduct, `BC-${randomUUID().slice(0, 8)}`],
    );
    await postReceipt(fixture.tenant, fixture.warehouseId, lowProduct, 3, 2, TODAY, lowVariant!.id);

    await tx(async (client) => {
      const today = await todayFigures(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
      });
      const ids = today.lowStock.map((row) => row.productId);
      expect(ids).toContain(lowProduct);
      // The fixture product holds 100, so it is not low.
      expect(ids).not.toContain(fixture.productId);
      const low = today.lowStock.find((row) => row.productId === lowProduct)!;
      expect(low.qty.toFixed(4)).toBe('3.0000');
      expect(low.sku).toBeTruthy();
    });
  });

  it('154. report_today lists only open laybys that have reached their due date', async () => {
    const fixture = await reportFixture('F9 test 154', { unitPrice: '10.0000', qty: 100 });
    const contact = await one<{ id: string }>(
      `insert into public.contacts (org_id, kind, name)
       values ($1, 'customer', 'F9 customer') returning id`,
      [fixture.tenant.orgId],
    );

    const layby = async (dueDate: string): Promise<string> => {
      const row = await one<{ app: Record<string, unknown> }>(
        `select app.create_layby($1, $2, $3, $4, $5::date, $6::jsonb, 5, 'USD', 'VAT15', $7::date) as app`,
        [
          fixture.tenant.orgId,
          fixture.tenant.branchId,
          contact!.id,
          fixture.warehouseId,
          dueDate,
          JSON.stringify([
            {
              product_id: fixture.productId,
              variant_id: fixture.variantId,
              qty: 1,
              unit_price: '10.0000',
            },
          ]),
          TODAY,
        ],
      );
      return String(row!.app['layby_id']);
    };

    const dueNow = await layby(TODAY);
    const dueLater = await layby('2027-06-30');

    await tx(async (client) => {
      const today = await todayFigures(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
      });
      const ids = today.laybysDue.map((row) => row.id);
      expect(ids).toContain(dueNow);
      expect(ids).not.toContain(dueLater);
      const row = today.laybysDue.find((r) => r.id === dueNow)!;
      expect(row.customer).toBe('F9 customer');
      expect(row.total.toFixed(4)).toBe('11.5000');
    });
  });

  it('155. report_today counts the fiscal queue by state and sums the failed amount', async () => {
    const fixture = await reportFixture('F9 test 155', { unitPrice: '10.0000' });
    // Three invoices today (three sales), so three fiscal queue rows.
    await postSale(fixture, { qty: 2 });
    await postSale(fixture, { qty: 2 });
    await postSale(fixture, { qty: 2 });

    const invoices = await sql<{ invoice_id: string }>(
      `select invoice_id from public.pos_sales where org_id = $1 order by created_at`,
      [fixture.tenant.orgId],
    );
    expect(invoices).toHaveLength(3);
    const statuses = ['pending', 'sent', 'failed'] as const;
    for (let i = 0; i < invoices.length; i += 1) {
      await sql(
        `insert into public.fiscal_invoices (org_id, branch_id, invoice_id, status, sent_at)
         values ($1, $2, $3, $4, case when $4 = 'sent' then now() else null end)`,
        [fixture.tenant.orgId, fixture.tenant.branchId, invoices[i]!.invoice_id, statuses[i]],
      );
    }

    await tx(async (client) => {
      const today = await todayFigures(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
      });
      expect(today.fiscal.pending).toBe(1);
      expect(today.fiscal.sent).toBe(1);
      expect(today.fiscal.failed).toBe(1);
      // The failed invoice totals 23 (20 net + 15% VAT).
      expect(today.fiscal.failedAmount.toFixed(4)).toBe('23.0000');
    });
  });

  it('156. report_today carries the same sync status as report_last_sync', async () => {
    const fixture = await reportFixture('F9 test 156');

    await tx(async (client) => {
      const today = await todayFigures(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
      });
      const sync = await lastSync(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
      });
      // The dashboard and the console read one source, so they cannot disagree (ADR-0049).
      expect(today.sync.outboxSize).toBe(sync.outboxSize);
      expect(today.sync.lastCloudContactAt).toBe(sync.lastCloudContactAt);
      expect(today.sync.lastIngestAt).toBe(sync.lastIngestAt);
    });

    // The label the console shows is well-formed for every age, including never and clock skew.
    expect(syncAgeLabel(null)).toBe('Last sync: never');
    expect(syncAgeLabel(new Date().toISOString())).toBe('Last sync: just now');
    expect(syncAgeLabel(new Date(Date.now() - 120_000).toISOString())).toBe('Last sync: 2 min ago');
    // A future timestamp (clock skew) reads as "just now", never a negative age.
    expect(syncAgeLabel(new Date(Date.now() + 60_000).toISOString())).toBe('Last sync: just now');
  });

  it('157. A Z-report detail carries the same fiscal totals the list carries', async () => {
    const fixture = await reportFixture('F9 test 157', { unitPrice: '10.0000' });
    await postSale(fixture, { qty: 2 });
    await closeShift(fixture);

    // The fiscal row is created by the branch worker, after the close: the totals must reflect it.
    await sql(
      `insert into public.fiscal_invoices (org_id, branch_id, invoice_id, status, sent_at)
       select $1, $2, ps.invoice_id, 'sent', now()
         from public.pos_sales ps
        where ps.org_id = $1 and ps.shift_id = $3`,
      [fixture.tenant.orgId, fixture.tenant.branchId, fixture.shiftId],
    );

    await tx(async (client) => {
      const page = await zReports(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
      });
      expect(page.rows).toHaveLength(1);
      const listed = page.rows[0]!;

      const detail = await zReportDetail(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
        zReportId: listed.id,
      });
      expect(detail).not.toBeNull();
      expect(detail!.zNo).toBe(listed.zNo);
      expect(detail!.grossSales.toFixed(4)).toBe(listed.grossSales.toFixed(4));
      expect(detail!.taxTotal.toFixed(4)).toBe(listed.taxTotal.toFixed(4));
      // The fiscal totals are computed at read time, so the detail agrees with the list.
      expect(detail!.fiscal.sent.count).toBe(listed.fiscal.sent.count);
      expect(detail!.fiscal.sent.amount.toFixed(4)).toBe(listed.fiscal.sent.amount.toFixed(4));
      expect(detail!.fiscal.sent.count).toBe(1);
      expect(detail!.fiscal.sent.amount.toFixed(4)).toBe('23.0000');
      // The VAT-by-rate split is carried through for the ZIMRA return.
      expect(detail!.vatByRate['0.150000']!.toFixed(4)).toBe('3.0000');
    });
  });

  it('158. A Z-report detail for an unknown id is not found', async () => {
    const fixture = await reportFixture('F9 test 158');
    await tx(async (client) => {
      const missing = await zReportDetail(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
        zReportId: randomUUID(),
      });
      expect(missing).toBeNull();
    });
  });

  it('159. The today and Z-report detail routes answer with a real token and scope the branch', async () => {
    const fixture = await reportFixture('F9 test 159', { unitPrice: '10.0000' });
    await postSale(fixture, { qty: 2 });
    await closeShift(fixture);
    const token = tenantToken(fixture.tenant);

    const request = (path: string): Request =>
      new Request(`http://localhost${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });

    const today = await todayRoute(request('/api/reports/today'));
    expect(today.status).toBe(200);
    const todayBody = (await today.json()) as { sale_count: number; gross_sales: string };
    expect(todayBody.sale_count).toBe(1);
    expect(todayBody.gross_sales).toBe('20.0000');

    // A branch the token does not scope is refused.
    const outOfScope = await todayRoute(request(`/api/reports/today?branch_id=${randomUUID()}`));
    expect(outOfScope.status).toBe(403);

    // The Z-report detail route: found, then not found.
    const listed = await tx((client) =>
      zReports(client, { orgId: fixture.tenant.orgId, branchId: fixture.tenant.branchId }),
    );
    const found = await zDetailRoute(
      request(`/api/reports/z-reports/${listed.rows[0]!.id}`),
      { params: { id: listed.rows[0]!.id } },
    );
    expect(found.status).toBe(200);
    const foundBody = (await found.json()) as { id: string; fiscal: { sent: { count: number } } };
    expect(foundBody.id).toBe(listed.rows[0]!.id);

    const unknownId = randomUUID();
    const notFound = await zDetailRoute(request(`/api/reports/z-reports/${unknownId}`), {
      params: { id: unknownId },
    });
    expect(notFound.status).toBe(404);
  });

  it('160. report_today reads today through the branch index', async () => {
    // The today read is bounded by the branch's (org_id, branch_id, created_at) index (ADR-0046).
    // The index must exist on the two live tables the dashboard reads.
    const indexes = await sql<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename in ('pos_sales', 'pos_payments')`,
    );
    const defs = indexes.map((row) => row.indexdef).join('\n');
    expect(defs).toMatch(/pos_sales_org_branch_created_idx/);
    expect(defs).toMatch(/pos_payments_org_branch_created_idx/);

    // A branch with a day's sales: the today query returns the live rows and is a plain indexed read.
    const fixture = await reportFixture('F9 test 160', { unitPrice: '10.0000' });
    await postSale(fixture, { qty: 2 });
    await tx(async (client) => {
      const today = await todayFigures(client, {
        orgId: fixture.tenant.orgId,
        branchId: fixture.tenant.branchId,
      });
      expect(today.saleCount).toBe(1);
    });
  });
});
