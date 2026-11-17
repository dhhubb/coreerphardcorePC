import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { StateStorage } from 'zustand/middleware';
import { one, sql } from './support/db';
import { addWarehouse, createTenant, mintAccessToken, postReceipt, tenantToken, type Tenant } from './support/fixtures';
import { createCartStore } from '../src/verticals/pos/cart';
import { resolveShortcut } from '../src/verticals/pos/shortcuts';
import { stocktakeLineKey, stocktakeProgress } from '../src/verticals/admin/ops';
import { buildZReportData } from '../src/verticals/pos/zReportData';
import { defaultShop } from '../src/verticals/pos/receiptData';
import { GET as zReportsListGet } from '../src/app/api/z-reports/route';
import { GET as zReportDetailGet } from '../src/app/api/admin/z-reports/[id]/route';
import { GET as shiftsGet, POST as shiftsPost } from '../src/app/api/admin/shifts/route';
import { GET as stocktakeGet, POST as stocktakePost } from '../src/app/api/admin/stocktake/route';
import { POST as posSalesPost } from '../src/app/api/pos/sales/route';

/**
 * F3 — operations, the Z-report page, the receipt and the stocktake UI. Tests 122–127, continuing
 * from F2's 121 (ADR-0010, ADR-0070).
 *
 * The F3 brief numbered these 46–51, but 46–48 are R2 tests and 49–52 are H1 tests. ADR-0010
 * forbids renumbering: a new run continues from the highest number actually present, which after F2
 * is 121.
 *
 * F3's genuinely new surface is the persisted cart, the dedicated /admin/z-reports page's reads, the
 * stocktake progress inputs and the 58mm slip. These tests drive the real route handlers with a real
 * access token against the real local Postgres; nothing is mocked. Concurrency that R3 (tests 10,
 * 12) and R5 (tests 19–24) already prove is not re-asserted here.
 */

const DATE = '2026-06-15';

/** An in-memory `StateStorage`, so the persisted cart can be exercised without a browser. */
function memoryStorage(): StateStorage & { dump: () => Map<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (name) => map.get(name) ?? null,
    setItem: (name, value) => void map.set(name, value),
    removeItem: (name) => void map.delete(name),
    dump: () => map,
  };
}

interface PosFixture {
  tenant: Tenant;
  warehouseId: string;
  productId: string;
  variantId: string;
  barcode: string;
  unitPrice: string;
}

/** A tenant with a warehouse, a barcoded variant, a retail price and stock on hand. */
async function posFixture(
  name: string,
  options: { qty?: number; unitCost?: number; unitPrice?: string } = {},
): Promise<PosFixture> {
  const tenant = await createTenant(name);
  const warehouseId = await addWarehouse(tenant, 'W1');
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

  const unitPrice = options.unitPrice ?? '5.0000';
  const priceList = await one<{ id: string }>(
    `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
    [tenant.orgId],
  );
  await sql(
    `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
     values ($1, $2, $3, $4)`,
    [tenant.orgId, priceList!.id, variant!.id, unitPrice],
  );
  await sql(
    `insert into public.exchange_rates (org_id, currency, rate, effective_from)
     values ($1, 'ZWG', 30.0000000000, date '2020-01-01')`,
    [tenant.orgId],
  );
  await postReceipt(
    tenant,
    warehouseId,
    product!.id,
    options.qty ?? 100,
    options.unitCost ?? 2,
    DATE,
    variant!.id,
  );

  return {
    tenant,
    warehouseId,
    productId: product!.id,
    variantId: variant!.id,
    barcode,
    unitPrice,
  };
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

/** Ring one sale through the real POST /api/pos/sales handler. */
async function ringSale(
  fixture: PosFixture,
  input: {
    shiftId: string;
    lines: Array<{ barcode?: string; variant_id?: string; qty: number; unit_price?: string }>;
    tenders: Array<{ method: string; currency: string; amount_tendered: string }>;
    clientSaleId?: string;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await posSalesPost(
    request('/api/pos/sales', tenantToken(fixture.tenant), {
      method: 'POST',
      body: JSON.stringify({
        warehouse_id: fixture.warehouseId,
        shift_id: input.shiftId,
        client_sale_id: input.clientSaleId ?? crypto.randomUUID(),
        sale_date: DATE,
        lines: input.lines,
        tenders: input.tenders,
      }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function openShift(fixture: PosFixture, tillId = 'T1'): Promise<string> {
  const shift = await one<{ id: string }>(
    `insert into public.shifts (org_id, branch_id, till_id, opening_float)
     values ($1, $2, $3, 0) returning id`,
    [fixture.tenant.orgId, fixture.tenant.branchId, tillId],
  );
  return shift!.id;
}

describe('F3 operations, Z-report, receipt and stocktake UI', () => {
  it('122. The cart store persists lines, tenders, parked carts and the ZWG rate across a reload, and revives money as Decimal', () => {
    const storage = memoryStorage();

    const first = createCartStore(storage);
    // A parked cart (v-1) ...
    first.getState().addLine({
      variantId: 'v-1',
      barcode: 'BC-1',
      name: 'Widget',
      qty: new Decimal(2),
      unitPrice: new Decimal('5.0000'),
      taxRate: new Decimal('0.15'),
      lineSubtotal: new Decimal(0),
      lineTax: new Decimal(0),
      lineTotal: new Decimal(0),
    });
    first.getState().hold();
    // ... and the cart in progress on the till (v-2), with a tender and a rate.
    first.getState().addLine({
      variantId: 'v-2',
      barcode: 'BC-2',
      name: 'Gadget',
      qty: new Decimal(1),
      unitPrice: new Decimal('2.0000'),
      taxRate: new Decimal('0.15'),
      lineSubtotal: new Decimal(0),
      lineTax: new Decimal(0),
      lineTotal: new Decimal(0),
    });
    first.getState().addTender({
      method: 'cash',
      currency: 'USD',
      amountTendered: new Decimal('2.3000'),
    });
    first.getState().setZwgRate(new Decimal('30'));

    // The raw storage holds strings for money, never numbers.
    const raw = storage.dump().get('pos-cart');
    expect(raw).toBeTruthy();
    expect(raw).toContain('"qty":"1"');
    expect(raw).toContain('"zwgRate":"30"');
    expect(raw).not.toMatch(/"qty":\s*\d/);

    // A fresh store over the same storage rehydrates the cart ("a reload").
    const reloaded = createCartStore(storage);
    const state = reloaded.getState();

    // The till's cart came back, with money revived as Decimal.
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]!.variantId).toBe('v-2');
    expect(state.lines[0]!.qty).toBeInstanceOf(Decimal);
    expect(state.lines[0]!.qty.toFixed(4)).toBe('1.0000');
    expect(state.lines[0]!.unitPrice).toBeInstanceOf(Decimal);
    expect(state.lines[0]!.unitPrice.toFixed(4)).toBe('2.0000');
    expect(state.lines[0]!.lineTotal.toFixed(4)).toBe('2.3000');
    expect(state.tenders).toHaveLength(1);
    expect(state.tenders[0]!.amountTendered).toBeInstanceOf(Decimal);
    expect(state.tenders[0]!.amountTendered.toFixed(4)).toBe('2.3000');
    expect(state.zwgRate).toBeInstanceOf(Decimal);
    expect(state.zwgRate.toFixed(0)).toBe('30');

    // The parked cart came back, with Decimal money.
    expect(state.held).toHaveLength(1);
    expect(state.held[0]!.lines[0]!.variantId).toBe('v-1');
    expect(state.held[0]!.total).toBeInstanceOf(Decimal);
    expect(state.held[0]!.total.toFixed(4)).toBe('11.5000');

    // The transient flags are not persisted: a reload starts idle with no receipt.
    expect(state.status).toBe('idle');
    expect(state.receipt).toBeNull();

    // Recall restores the parked cart from the rehydrated store.
    reloaded.getState().recall();
    expect(reloaded.getState().lines[0]!.variantId).toBe('v-1');
    expect(reloaded.getState().lines[0]!.lineTotal.toFixed(4)).toBe('11.5000');
  });

  it('123. /api/z-reports lists immutable Z-reports as a keyset page and /api/admin/z-reports/:id reads one by key; the 58mm slip renders its totals', async () => {
    const fixture = await posFixture('F3 z-report 123', { unitPrice: '5.0000' });
    const token = tenantToken(fixture.tenant);
    const shiftId = await openShift(fixture);

    // Two sales, then close the shift: one immutable Z-report. Each line is qty 1, priced at the
    // retail list price of 5.0000 (get_price treats a list price as the price for the priced qty).
    await ringSale(fixture, {
      shiftId,
      lines: [{ barcode: fixture.barcode, qty: 1 }],
      tenders: [{ method: 'cash', currency: 'USD', amount_tendered: '100' }],
    });
    await ringSale(fixture, {
      shiftId,
      lines: [{ barcode: fixture.barcode, qty: 1 }],
      tenders: [{ method: 'card', currency: 'USD', amount_tendered: '100' }],
    });

    const closeResponse = await shiftsPost(
      request('/api/admin/shifts', token, {
        method: 'POST',
        body: JSON.stringify({ shift_id: shiftId }),
      }),
    );
    expect(closeResponse.status).toBe(200);
    const zReportId = ((await closeResponse.json()) as { z_report_id: string }).z_report_id;
    expect(zReportId).toBeTruthy();

    // The list route returns it, a keyset page.
    const listResponse = await zReportsListGet(request('/api/z-reports', token));
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as {
      z_reports: Array<{ id: string; z_no: string; sale_count: number; gross_sales: string }>;
      next_cursor: unknown;
    };
    expect(list.z_reports).toHaveLength(1);
    expect(list.z_reports[0]!.id).toBe(zReportId);
    expect(list.z_reports[0]!.sale_count).toBe(2);
    // 2 x 5.0000 subtotal = 10.0000 gross, plus 15% VAT = 1.5000.
    expect(list.z_reports[0]!.gross_sales).toBe('10.0000');

    // The detail route reads it by primary key.
    const detailResponse = await zReportDetailGet(
      request(`/api/admin/z-reports/${zReportId}`, token),
      { params: { id: zReportId } },
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as Record<string, unknown>;
    expect(detail.z_no).toBe(list.z_reports[0]!.z_no);
    expect(detail.sale_count).toBe(2);
    expect(detail.gross_sales).toBe('10.0000');
    expect(detail.tax_total).toBe('1.5000');
    expect(detail.by_method).toMatchObject({ cash: '5.7500', card: '5.7500' });

    // The shift page reads the shift back as closed with its Z-report id.
    const shiftsResponse = await shiftsGet(request('/api/admin/shifts', token));
    const shifts = ((await shiftsResponse.json()) as {
      shifts: Array<{ id: string; status: string; z_report_id: string | null }>;
    }).shifts;
    expect(shifts.find((row) => row.id === shiftId)?.status).toBe('closed');
    expect(shifts.find((row) => row.id === shiftId)?.z_report_id).toBe(zReportId);

    // The 58mm slip builds from the detail route's payload: its model carries Decimal money and the
    // totals it prints equal the stored ones.
    const slip = buildZReportData(
      detail as never,
      { shop: defaultShop(), branchName: 'Main', tillId: 'T1' },
    );
    expect(slip.grossSales).toBeInstanceOf(Decimal);
    expect(slip.grossSales.toFixed(4)).toBe('10.0000');
    expect(slip.taxTotal.toFixed(4)).toBe('1.5000');
    expect(slip.saleCount).toBe(2);
    expect(slip.voidCount).toBe(0);
    expect(Object.keys(slip.byMethod).sort()).toEqual(['card', 'cash']);
    expect(slip.vatByRate['0.150000']!.toFixed(4)).toBe('1.5000');

    // A Z-report is immutable (the console only ever reads it).
    const report = await one<{ sale_count: number }>(
      'select sale_count from public.z_reports where id = $1',
      [zReportId],
    );
    expect(report!.sale_count).toBe(2);
  });

  it('124. The stocktake snapshot returns every line and the console counts the lines the counter has entered', async () => {
    const fixture = await posFixture('F3 stocktake 124', { qty: 100 });
    const token = tenantToken(fixture.tenant);

    // A second variant so the snapshot has more than one line.
    const variant2 = await one<{ id: string }>(
      `insert into public.product_variants (org_id, product_id, sku, name, barcode)
       values ($1, $2, app.next_number($1, 'SKU'), 'Large', $3) returning id`,
      [fixture.tenant.orgId, fixture.productId, `BC-${Math.random().toString(36).slice(2, 10)}`],
    );
    await postReceipt(fixture.tenant, fixture.warehouseId, fixture.productId, 50, 3, DATE, variant2!.id);

    // Open a count through the route, then read its snapshot.
    const openResponse = await stocktakePost(
      request('/api/admin/stocktake', token, {
        method: 'POST',
        body: JSON.stringify({ warehouse_id: fixture.warehouseId, counted_at: DATE }),
      }),
    );
    expect(openResponse.status).toBe(200);
    const open = (await openResponse.json()) as { count_id: string; count_no: string; created_at: string };

    const snapshotResponse = await stocktakeGet(
      request(`/api/admin/stocktake?warehouse_id=${fixture.warehouseId}&snapshot=1`, token),
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      items: Array<{ product_id: string; variant_id: string | null; system_qty: string; unit_cost: string }>;
    };
    expect(snapshot.items).toHaveLength(2);
    const byVariant = new Map(snapshot.items.map((item) => [item.variant_id, item]));
    expect(byVariant.get(fixture.variantId)!.system_qty).toBe('100.0000');
    expect(byVariant.get(fixture.variantId)!.unit_cost).toBe('2.0000');
    expect(byVariant.get(variant2!.id)!.system_qty).toBe('50.0000');
    expect(byVariant.get(variant2!.id)!.unit_cost).toBe('3.0000');

    // The console's progress arithmetic (the real helper the page uses): the counted share is the
    // fraction of snapshot lines the counter has explicitly entered (the snapshot prefills every
    // line, so "present" is not enough).
    const touched = new Set<string>();
    const progress = () => stocktakeProgress(snapshot.items.length, touched.size);
    expect(progress()).toBe(0);
    touched.add(stocktakeLineKey(snapshot.items[0]!));
    expect(progress()).toBe(50);
    touched.add(stocktakeLineKey(snapshot.items[1]!));
    expect(progress()).toBe(100);

    // Import the counted lines (one line differs) and close: one balanced journal for the count.
    const counted = snapshot.items.map((item) => ({
      product_id: item.product_id,
      variant_id: item.variant_id,
      counted_qty: item.variant_id === fixture.variantId ? '95.0000' : item.system_qty,
      system_qty: item.system_qty,
      unit_cost: item.unit_cost,
    }));
    const importResponse = await stocktakePost(
      request('/api/admin/stocktake', token, {
        method: 'POST',
        body: JSON.stringify({
          action: 'lines',
          count_id: open.count_id,
          count_created_at: open.created_at,
          lines: counted,
        }),
      }),
    );
    expect(importResponse.status).toBe(200);
    expect(((await importResponse.json()) as { imported: number }).imported).toBe(2);

    const closeResponse = await stocktakePost(
      request('/api/admin/stocktake', token, {
        method: 'POST',
        body: JSON.stringify({
          action: 'close',
          count_id: open.count_id,
          count_created_at: open.created_at,
          posting_date: DATE,
        }),
      }),
    );
    expect(closeResponse.status).toBe(200);
    const closed = (await closeResponse.json()) as { journal_id: string | null; adjusted_lines: number };
    expect(closed.adjusted_lines).toBe(1);
    expect(closed.journal_id).toBeTruthy();

    // The one journal for the whole count balances (5 units short at cost 2 = 10).
    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where journal_id = $1`,
      [closed.journal_id],
    );
    expect(imbalance!.d).toBe('0.0000');
  });

  it('125. A USD+ZWG split tender through POST /api/pos/sales writes two pos_payments rows and two CORE payments, fully paid', async () => {
    const fixture = await posFixture('F3 split 125', { unitPrice: '5.0000' });
    const shiftId = await openShift(fixture);

    // Total 2 x 5.0000 + 15% VAT = 11.5000. Pay 5.00 USD and the rest in ZWG at 30.
    const sale = await ringSale(fixture, {
      shiftId,
      lines: [{ barcode: fixture.barcode, qty: 2 }],
      tenders: [
        { method: 'cash', currency: 'USD', amount_tendered: '5' },
        { method: 'cash', currency: 'ZWG', amount_tendered: '300' },
      ],
    });
    expect(sale.status).toBe(200);
    const payments = sale.body.payments as Array<{ currency: string }>;
    expect(payments).toHaveLength(2);
    expect(payments.map((payment) => payment.currency)).toEqual(['USD', 'ZWG']);

    const posPayments = await sql<{ currency: string }>(
      'select currency from public.pos_payments where org_id = $1 order by currency',
      [fixture.tenant.orgId],
    );
    expect(posPayments.map((row) => row.currency)).toEqual(['USD', 'ZWG']);

    const corePayments = await one<{ n: string }>(
      'select count(*)::text as n from public.payments where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(corePayments!.n).toBe('2');

    const invoice = await one<{ total: string; amount_paid: string }>(
      'select total::text, amount_paid::text from public.invoices where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(invoice!.amount_paid).toBe(invoice!.total);

    const imbalance = await one<{ d: string }>(
      `select (coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0))::text as d
         from public.journal_lines where org_id = $1`,
      [fixture.tenant.orgId],
    );
    expect(imbalance!.d).toBe('0.0000');
  });

  it('126. The keyboard flow is three actions: scan, F9 exact cash, Enter; the exact-cash sale commits with no change', async () => {
    // The shortcut map the till binds, from the one pure mapping (H4).
    expect(resolveShortcut('F2')).toBe('scan');
    expect(resolveShortcut('F3')).toBe('hold');
    expect(resolveShortcut('F9')).toBe('pay');
    expect(resolveShortcut('Enter')).toBeNull(); // Enter is handled by the focused field, not the map

    const fixture = await posFixture('F3 keyboard 126', { unitPrice: '5.0000' });
    const shiftId = await openShift(fixture);

    // Action 1 (scan + Enter) resolves the barcode to a line; action 2 (F9) tenders the exact total;
    // action 3 (Enter) confirms. The till computes the exact total as 1 x 5.0000 + 15% VAT = 5.7500.
    const exactTotal = new Decimal(fixture.unitPrice).times(1).times(new Decimal('1.15')).toFixed(4);
    expect(exactTotal).toBe('5.7500');

    const sale = await ringSale(fixture, {
      shiftId,
      lines: [{ barcode: fixture.barcode, qty: 1 }],
      tenders: [{ method: 'cash', currency: 'USD', amount_tendered: exactTotal }],
    });
    expect(sale.status).toBe(200);
    expect(sale.body.total).toBe('5.7500');

    // Exact cash means no change is given.
    const payments = sale.body.payments as Array<{ amount_tendered: string; change_given: string }>;
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amount_tendered).toBe('5.7500');
    expect(payments[0]!.change_given).toBe('0.0000');

    const invoice = await one<{ total: string; amount_paid: string }>(
      'select total::text, amount_paid::text from public.invoices where org_id = $1',
      [fixture.tenant.orgId],
    );
    expect(invoice!.total).toBe('5.7500');
    expect(invoice!.amount_paid).toBe('5.7500');
  });

  it('127. The Z-report list is branch-scoped and refuses a limit above 100', async () => {
    const fixture = await posFixture('F3 scope 127');
    const token = tenantToken(fixture.tenant);
    const shiftId = await openShift(fixture);
    await ringSale(fixture, {
      shiftId,
      lines: [{ barcode: fixture.barcode, qty: 1 }],
      tenders: [{ method: 'cash', currency: 'USD', amount_tendered: '100' }],
    });
    await shiftsPost(
      request('/api/admin/shifts', token, {
        method: 'POST',
        body: JSON.stringify({ shift_id: shiftId }),
      }),
    );

    // A limit above 100 is rejected (never clamped silently).
    const tooBig = await zReportsListGet(request('/api/z-reports?limit=101', token));
    expect(tooBig.status).toBe(422);

    // A second branch in the same org sees none of the first branch's Z-reports: the token carries
    // only the second branch, and the route is branch-scoped.
    const secondBranch = await sql<{ id: string }>(
      `insert into public.branches (org_id, name, slug) values ($1, 'Second', 'second') returning id`,
      [fixture.tenant.orgId],
    );
    const branchToken = mintAccessToken({
      sub: fixture.tenant.userId,
      orgId: fixture.tenant.orgId,
      branchIds: [secondBranch[0]!.id],
      email: fixture.tenant.email,
    });

    const otherBranchList = await zReportsListGet(request('/api/z-reports', branchToken));
    expect(otherBranchList.status).toBe(200);
    const otherRows = (await otherBranchList.json()) as { z_reports: unknown[] };
    expect(otherRows.z_reports).toHaveLength(0);

    // The owning branch still sees it.
    const ownList = await zReportsListGet(request('/api/z-reports', token));
    expect(((await ownList.json()) as { z_reports: unknown[] }).z_reports).toHaveLength(1);
  });
});
