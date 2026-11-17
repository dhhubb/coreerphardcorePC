import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { money, moneyFromSql } from '@/core/money';
import { DEFAULT_PAGE_LIMIT, type PageCursor } from '@/core/sales';
import type {
  LaybyDetail,
  LaybyListRow,
  LaybyStatus,
  ReturnListRow,
  ReturnableLine,
  ShiftListRow,
  ShiftStatus,
  StockCountDetail,
  StockCountListRow,
  StockCountSnapshotRow,
  ZReport,
} from './opsTypes';

/**
 * A3 admin operations data access. Every read calls an `app.admin_*` function (SECURITY INVOKER, so
 * RLS scopes the rows); every write calls the R5 function that already owns the rule. Nothing here
 * recomputes a business rule.
 *
 * The keyset cursor keeps the exact `created_at` text (ADR-0057): a bulk-imported batch shares one
 * microsecond timestamp, and a JS Date would truncate it and stall the next page.
 */

function numRecord(value: unknown): Record<string, Decimal> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, Decimal> = {};
  for (const [key, amount] of Object.entries(value as Record<string, unknown>)) {
    out[key] = moneyFromSql(String(amount));
  }
  return out;
}

function cursorFrom(
  rows: Array<{ created_at_exact: string; id: string }>,
  limit: number,
): PageCursor | null {
  const last = rows[rows.length - 1];
  if (!last || rows.length < limit) return null;
  return { createdAt: last.created_at_exact, id: last.id };
}

/* -------------------------------------------------------------------------------------------- */
/* Laybys                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export async function listLaybys(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    status?: LaybyStatus | null;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ laybys: LaybyListRow[]; nextCursor: PageCursor | null }> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const result = await client.query<{
    id: string;
    layby_no: string;
    status: LaybyStatus;
    due_date: Date;
    currency: string;
    total: string;
    deposit_paid: string;
    contact_id: string;
    contact_name: string | null;
    invoice_id: string | null;
    is_overdue: boolean;
    created_at: Date;
    created_at_exact: string;
  }>(
    `select id, layby_no, status, due_date, currency, total::text, deposit_paid::text,
            contact_id, contact_name, invoice_id, is_overdue, created_at,
            created_at::text as created_at_exact
       from app.admin_list_laybys($1, $2, $3, $4, $5::timestamptz, $6)`,
    [
      input.orgId,
      input.branchId,
      input.status ?? null,
      limit,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );

  const laybys = result.rows.map((row) => ({
    id: row.id,
    laybyNo: row.layby_no,
    status: row.status,
    dueDate: row.due_date.toISOString().slice(0, 10),
    currency: row.currency,
    total: moneyFromSql(row.total),
    depositPaid: moneyFromSql(row.deposit_paid),
    contactId: row.contact_id,
    contactName: row.contact_name,
    invoiceId: row.invoice_id,
    isOverdue: row.is_overdue,
    createdAt: row.created_at.toISOString(),
  }));

  return { laybys, nextCursor: cursorFrom(result.rows, limit) };
}

export async function laybyDetail(
  client: PoolClient,
  input: { orgId: string; laybyId: string },
): Promise<LaybyDetail> {
  const result = await client.query<{ app: RawLaybyDetail }>(
    `select app.admin_layby_detail($1, $2) as app`,
    [input.orgId, input.laybyId],
  );
  return mapLaybyDetail(result.rows[0]!.app);
}

interface RawLaybyDetail {
  id: string;
  layby_no: string;
  status: LaybyStatus;
  due_date: string;
  currency: string;
  subtotal: string;
  tax_total: string;
  total: string;
  deposit_paid: string;
  cancellation_fee: string;
  invoice_id: string | null;
  is_overdue: boolean;
  created_at: string;
  customer: LaybyDetail['customer'];
  reservations: Array<{
    id: string;
    product_id: string;
    variant_id: string | null;
    qty: string;
    unit_price: string;
    unit_cost: string;
    status: string;
  }>;
}

function mapLaybyDetail(raw: RawLaybyDetail): LaybyDetail {
  return {
    id: raw.id,
    laybyNo: raw.layby_no,
    status: raw.status,
    dueDate: String(raw.due_date).slice(0, 10),
    currency: raw.currency,
    subtotal: moneyFromSql(raw.subtotal),
    taxTotal: moneyFromSql(raw.tax_total),
    total: moneyFromSql(raw.total),
    depositPaid: moneyFromSql(raw.deposit_paid),
    cancellationFee: moneyFromSql(raw.cancellation_fee),
    invoiceId: raw.invoice_id,
    isOverdue: raw.is_overdue,
    createdAt: new Date(raw.created_at).toISOString(),
    customer: raw.customer,
    reservations: raw.reservations.map((r) => ({
      id: r.id,
      productId: r.product_id,
      variantId: r.variant_id,
      qty: moneyFromSql(r.qty),
      unitPrice: moneyFromSql(r.unit_price),
      unitCost: moneyFromSql(r.unit_cost),
      status: r.status,
    })),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Returns                                                                                       */
/* -------------------------------------------------------------------------------------------- */

export async function listReturns(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ returns: ReturnListRow[]; nextCursor: PageCursor | null }> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const result = await client.query<{
    id: string;
    return_no: string;
    status: string;
    original_invoice_id: string;
    refund_method: string;
    total: string;
    credit_note_id: string | null;
    created_at: Date;
    created_at_exact: string;
  }>(
    `select id, return_no, status, original_invoice_id, refund_method, total::text,
            credit_note_id, created_at, created_at::text as created_at_exact
       from app.admin_list_returns($1, $2, $3, $4::timestamptz, $5)`,
    [
      input.orgId,
      input.branchId,
      limit,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );

  const returns = result.rows.map((row) => ({
    id: row.id,
    returnNo: row.return_no,
    status: row.status,
    originalInvoiceId: row.original_invoice_id,
    refundMethod: row.refund_method,
    total: moneyFromSql(row.total),
    creditNoteId: row.credit_note_id,
    createdAt: row.created_at.toISOString(),
  }));

  return { returns, nextCursor: cursorFrom(result.rows, limit) };
}

export async function invoiceReturnableLines(
  client: PoolClient,
  input: { orgId: string; invoiceId: string },
): Promise<ReturnableLine[]> {
  const result = await client.query<{
    invoice_line_id: string;
    line_no: number;
    product_id: string;
    variant_id: string | null;
    description: string | null;
    qty_sold: string;
    qty_returned: string;
    qty_returnable: string;
    unit_price: string;
    unit_cost: string;
  }>(`select * from app.admin_invoice_returnable_lines($1, $2)`, [
    input.orgId,
    input.invoiceId,
  ]);

  return result.rows.map((row) => ({
    invoiceLineId: row.invoice_line_id,
    lineNo: row.line_no,
    productId: row.product_id,
    variantId: row.variant_id,
    description: row.description,
    qtySold: moneyFromSql(row.qty_sold),
    qtyReturned: moneyFromSql(row.qty_returned),
    qtyReturnable: moneyFromSql(row.qty_returnable),
    unitPrice: moneyFromSql(row.unit_price),
    unitCost: moneyFromSql(row.unit_cost),
  }));
}

/* -------------------------------------------------------------------------------------------- */
/* Shifts and Z-reports                                                                          */
/* -------------------------------------------------------------------------------------------- */

export async function listShifts(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    status?: ShiftStatus | null;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ shifts: ShiftListRow[]; nextCursor: PageCursor | null }> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const result = await client.query<{
    id: string;
    till_id: string;
    status: ShiftStatus;
    opening_float: string;
    opened_at: Date;
    closed_at: Date | null;
    z_report_id: string | null;
    z_no: string | null;
    created_at: Date;
    created_at_exact: string;
  }>(
    `select id, till_id, status, opening_float::text, opened_at, closed_at, z_report_id, z_no,
            created_at, created_at::text as created_at_exact
       from app.admin_list_shifts($1, $2, $3, $4, $5::timestamptz, $6)`,
    [
      input.orgId,
      input.branchId,
      input.status ?? null,
      limit,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );

  const shifts = result.rows.map((row) => ({
    id: row.id,
    tillId: row.till_id,
    status: row.status,
    openingFloat: moneyFromSql(row.opening_float),
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
    zReportId: row.z_report_id,
    zNo: row.z_no,
    createdAt: row.created_at.toISOString(),
  }));

  return { shifts, nextCursor: cursorFrom(result.rows, limit) };
}

export async function zReport(
  client: PoolClient,
  input: { orgId: string; zReportId: string },
): Promise<ZReport> {
  const result = await client.query<{ app: RawZReport }>(
    `select app.admin_z_report($1, $2) as app`,
    [input.orgId, input.zReportId],
  );
  const raw = result.rows[0]!.app;
  return {
    id: raw.id,
    zNo: raw.z_no,
    branchId: raw.branch_id,
    shiftId: raw.shift_id,
    openedAt: new Date(raw.opened_at).toISOString(),
    closedAt: new Date(raw.closed_at).toISOString(),
    openingFloat: moneyFromSql(raw.opening_float),
    saleCount: raw.sale_count,
    voidCount: raw.void_count,
    grossSales: moneyFromSql(raw.gross_sales),
    taxTotal: moneyFromSql(raw.tax_total),
    byMethod: numRecord(raw.by_method),
    byCurrency: numRecord(raw.by_currency),
    vatByRate: numRecord(raw.vat_by_rate),
    createdAt: new Date(raw.created_at).toISOString(),
  };
}

interface RawZReport {
  id: string;
  z_no: string;
  branch_id: string;
  shift_id: string;
  opened_at: string;
  closed_at: string;
  opening_float: string;
  sale_count: number;
  void_count: number;
  gross_sales: string;
  tax_total: string;
  by_method: unknown;
  by_currency: unknown;
  vat_by_rate: unknown;
  created_at: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Stocktake                                                                                     */
/* -------------------------------------------------------------------------------------------- */

export async function listStockCounts(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ counts: StockCountListRow[]; nextCursor: PageCursor | null }> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const result = await client.query<{
    id: string;
    count_no: string;
    status: 'open' | 'closed';
    warehouse_id: string;
    counted_at: Date;
    line_count: string;
    closed_at: Date | null;
    journal_id: string | null;
    created_at: Date;
    created_at_exact: string;
  }>(
    `select id, count_no, status, warehouse_id, counted_at, line_count::text, closed_at,
            journal_id, created_at, created_at::text as created_at_exact
       from app.admin_list_stock_counts($1, $2, $3, $4::timestamptz, $5)`,
    [
      input.orgId,
      input.branchId,
      limit,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );

  const counts = result.rows.map((row) => ({
    id: row.id,
    countNo: row.count_no,
    status: row.status,
    warehouseId: row.warehouse_id,
    countedAt: row.counted_at.toISOString().slice(0, 10),
    lineCount: Number(row.line_count),
    closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
    journalId: row.journal_id,
    createdAt: row.created_at.toISOString(),
  }));

  return { counts, nextCursor: cursorFrom(result.rows, limit) };
}

export async function stockCountDetail(
  client: PoolClient,
  input: { orgId: string; countId: string; countCreatedAt: string },
): Promise<StockCountDetail> {
  const result = await client.query<{ app: RawStockCountDetail }>(
    `select app.admin_stock_count_detail($1, $2, $3::timestamptz) as app`,
    [input.orgId, input.countId, input.countCreatedAt],
  );
  const raw = result.rows[0]!.app;
  return {
    id: raw.id,
    countNo: raw.count_no,
    status: raw.status,
    warehouseId: raw.warehouse_id,
    countedAt: String(raw.counted_at).slice(0, 10),
    closedAt: raw.closed_at === null ? null : new Date(raw.closed_at).toISOString(),
    journalId: raw.journal_id,
    createdAt: new Date(raw.created_at).toISOString(),
    lineCount: Number(raw.line_count),
    varianceLines: Number(raw.variance_lines),
    inventoryIncrease: moneyFromSql(raw.inventory_increase),
    inventoryDecrease: moneyFromSql(raw.inventory_decrease),
  };
}

interface RawStockCountDetail {
  id: string;
  count_no: string;
  status: 'open' | 'closed';
  warehouse_id: string;
  counted_at: string;
  closed_at: string | null;
  journal_id: string | null;
  created_at: string;
  line_count: number | string;
  variance_lines: number | string;
  inventory_increase: string;
  inventory_decrease: string;
}

export async function stockCountSnapshot(
  client: PoolClient,
  input: { orgId: string; warehouseId: string },
): Promise<StockCountSnapshotRow[]> {
  const result = await client.query<{
    product_id: string;
    variant_id: string | null;
    system_qty: string;
    unit_cost: string;
  }>(`select * from app.admin_stock_count_snapshot($1, $2)`, [input.orgId, input.warehouseId]);

  return result.rows.map((row) => ({
    productId: row.product_id,
    variantId: row.variant_id,
    systemQty: moneyFromSql(row.system_qty),
    unitCost: moneyFromSql(row.unit_cost),
  }));
}

export interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  allowNegativeStock: boolean;
}

/** The branch's active warehouses, for the stocktake and layby pickers. */
export async function listWarehouses(
  client: PoolClient,
  input: { orgId: string; branchId: string },
): Promise<WarehouseRow[]> {
  const result = await client.query<{
    id: string;
    code: string;
    name: string;
    allow_negative_stock: boolean;
  }>(`select * from app.admin_list_warehouses($1, $2)`, [input.orgId, input.branchId]);

  return result.rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    allowNegativeStock: row.allow_negative_stock,
  }));
}

export interface StockCountLineInput {
  productId: string;
  variantId?: string | null;
  countedQty: string | Decimal;
  systemQty: string | Decimal;
  unitCost: string | Decimal;
}

/**
 * Import a stock count's counted lines. The R5 route used COPY, but COPY FROM is not supported under
 * row-level security (0A000), so the admin path goes through app.admin_import_stock_count_lines, a
 * set-based insert that runs as the caller (ADR-0063).
 */
export async function importStockCountLines(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    countId: string;
    countCreatedAt: string;
    lines: readonly StockCountLineInput[];
  },
): Promise<number> {
  const payload = JSON.stringify(
    input.lines.map((line) => ({
      product_id: line.productId,
      variant_id: line.variantId ?? null,
      counted_qty: new Decimal(line.countedQty).toFixed(4),
      system_qty: new Decimal(line.systemQty).toFixed(4),
      unit_cost: new Decimal(line.unitCost).toFixed(4),
    })),
  );

  const result = await client.query<{ app: number }>(
    `select app.admin_import_stock_count_lines($1, $2, $3, $4::timestamptz, $5::jsonb) as app`,
    [input.orgId, input.branchId, input.countId, input.countCreatedAt, payload],
  );
  return result.rows[0]!.app;
}

/** Re-exported so a page can format money without importing decimal.js. */
export function formatMoney(value: Decimal | string): string {
  return money(value).toFixed(4);
}

/**
 * The stocktake progress, as a whole-number percentage (F3).
 *
 * The snapshot prefills every line with the system figure, so "counted" means the counter has
 * visited the line — not merely that a number is present. `touched` is the set of line keys the
 * operator has edited; the share is those over the snapshot's line count.
 */
export function stocktakeProgress(lineCount: number, touchedCount: number): number {
  if (lineCount <= 0) return 0;
  return Math.round((touchedCount / lineCount) * 100);
}

/** The stable key for a snapshot line, used to track which lines the counter has entered. */
export function stocktakeLineKey(item: { product_id: string; variant_id: string | null }): string {
  return `${item.product_id}:${item.variant_id ?? ''}`;
}
