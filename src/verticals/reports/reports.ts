import type Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { moneyFromSql } from '@/core/money';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type PageCursor } from '@/core/sales';
import type {
  FiscalStatusTotals,
  FiscalTotals,
  LastSync,
  PeriodProfit,
  ProductProfitPage,
  ProductProfitRow,
  ProductRankPage,
  TodayFigures,
  VatRow,
  ZReportPage,
  ZReportRow,
} from './types';

/**
 * The report reads. Every figure comes from SQL (app.report_*); this module only shapes the rows.
 *
 * Two sources, one rule (ADR-0046): a closed day is read from the immutable daily facts, and today
 * is read live from invoices + invoice_lines bounded by invoice_date. The SQL decides which; this
 * module never re-implements it.
 */

/** A period is inclusive of both dates. */
export interface Period {
  from: string;
  to: string;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_PAGE_LIMIT);
}

function num(value: unknown): string {
  return value === null || value === undefined ? '0' : String(value);
}

function productRow(row: Record<string, unknown>): ProductProfitRow {
  return {
    productId: String(row['product_id']),
    qty: moneyFromSql(num(row['qty'])),
    revenue: moneyFromSql(num(row['revenue'])),
    tax: moneyFromSql(num(row['tax'])),
    cogs: moneyFromSql(num(row['cogs'])),
    profit: moneyFromSql(num(row['profit'])),
  };
}

function moneyRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, amount] of Object.entries(value as Record<string, unknown>)) {
    out[key] = moneyFromSql(String(amount)).toFixed(4);
  }
  return out;
}

function decimalRecord(value: unknown): Record<string, Decimal> {
  const out: Record<string, Decimal> = {};
  for (const [key, amount] of Object.entries(moneyRecord(value))) {
    out[key] = moneyFromSql(amount);
  }
  return out;
}

function fiscalTotals(value: unknown): FiscalTotals {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    count: Number(record['count'] ?? 0),
    amount: moneyFromSql(num(record['amount'])),
  };
}

function fiscalStatus(value: unknown): FiscalStatusTotals {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    sent: fiscalTotals(record['sent']),
    pending: fiscalTotals(record['pending']),
    failed: fiscalTotals(record['failed']),
  };
}

/** Profit by product for the period. Keyset on product_id. */
export async function profitByProduct(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    period: Period;
    limit?: number;
    afterProductId?: string | null;
  },
): Promise<ProductProfitPage> {
  const limit = clampLimit(input.limit);
  const result = await client.query<{ r: { rows: Record<string, unknown>[]; next_after_product_id: string | null } }>(
    'select app.report_profit_by_product($1, $2, $3::date, $4::date, $5, $6) as r',
    [input.orgId, input.branchId, input.period.from, input.period.to, limit, input.afterProductId ?? null],
  );
  const payload = result.rows[0]!.r;
  const rows = payload.rows.map(productRow);
  const next = payload.next_after_product_id;
  return {
    rows,
    nextCursor: rows.length === limit && next ? { afterProductId: next } : null,
  };
}

/** Best sellers (ascending = false) or slow movers (ascending = true). Keyset on (qty, product_id). */
export async function productRanking(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    period: Period;
    ascending: boolean;
    limit?: number;
    afterQty?: string | null;
    afterProductId?: string | null;
  },
): Promise<ProductRankPage> {
  const limit = clampLimit(input.limit);
  const fn = input.ascending ? 'app.report_slow_movers' : 'app.report_best_sellers';
  const result = await client.query<{
    r: {
      rows: Record<string, unknown>[];
      next_after_qty: string | null;
      next_after_product_id: string | null;
    };
  }>(`select ${fn}($1, $2, $3::date, $4::date, $5, $6, $7) as r`, [
    input.orgId,
    input.branchId,
    input.period.from,
    input.period.to,
    limit,
    input.afterQty ?? null,
    input.afterProductId ?? null,
  ]);
  const payload = result.rows[0]!.r;
  const rows = payload.rows.map(productRow);
  const nextQty = payload.next_after_qty;
  const nextId = payload.next_after_product_id;
  return {
    rows,
    nextCursor:
      rows.length === limit && nextQty !== null && nextId !== null
        ? { afterQty: moneyFromSql(nextQty), afterProductId: nextId }
        : null,
  };
}

/** The VAT report: sales split by the VAT rate each line used, for the ZIMRA return. */
export async function vatReport(
  client: PoolClient,
  input: { orgId: string; branchId: string; period: Period },
): Promise<VatRow[]> {
  const result = await client.query<{ r: Record<string, unknown>[] }>(
    'select app.report_vat($1, $2, $3::date, $4::date) as r',
    [input.orgId, input.branchId, input.period.from, input.period.to],
  );
  return result.rows[0]!.r.map((row) => ({
    taxRate: moneyFromSql(num(row['tax_rate'])),
    net: moneyFromSql(num(row['net'])),
    tax: moneyFromSql(num(row['tax'])),
    gross: moneyFromSql(num(row['gross'])),
    lineCount: Number(row['line_count'] ?? 0),
  }));
}

/** A keyset page of Z-reports, each with its fiscal totals. */
export async function zReports(
  client: PoolClient,
  input: { orgId: string; branchId: string; limit?: number; cursor?: PageCursor | null },
): Promise<ZReportPage> {
  const limit = clampLimit(input.limit);
  const result = await client.query<{
    r: {
      rows: Record<string, unknown>[];
      next_after_created_at: string | null;
      next_after_id: string | null;
    };
  }>('select app.report_z_reports($1, $2, $3, $4::timestamptz, $5) as r', [
    input.orgId,
    input.branchId,
    limit,
    input.cursor?.createdAt ?? null,
    input.cursor?.id ?? null,
  ]);
  const payload = result.rows[0]!.r;
  const rows: ZReportRow[] = payload.rows.map((row) => ({
    id: String(row['id']),
    zNo: String(row['z_no']),
    shiftId: String(row['shift_id']),
    openedAt: String(row['opened_at']),
    closedAt: String(row['closed_at']),
    openingFloat: moneyFromSql(num(row['opening_float'])),
    saleCount: Number(row['sale_count'] ?? 0),
    voidCount: Number(row['void_count'] ?? 0),
    grossSales: moneyFromSql(num(row['gross_sales'])),
    taxTotal: moneyFromSql(num(row['tax_total'])),
    byMethod: decimalRecord(row['by_method']),
    byCurrency: decimalRecord(row['by_currency']),
    vatByRate: decimalRecord(row['vat_by_rate']),
    fiscal: fiscalStatus(row['fiscal']),
    createdAt: String(row['created_at']),
  }));
  const nextAt = payload.next_after_created_at;
  const nextId = payload.next_after_id;
  return {
    rows,
    nextCursor: rows.length === limit && nextAt && nextId ? { createdAt: nextAt, id: nextId } : null,
  };
}

/** GL revenue minus cost of goods sold for the period. The profit report must equal this. */
export async function glPeriodProfit(
  client: PoolClient,
  input: { orgId: string; branchId: string; period: Period },
): Promise<PeriodProfit> {
  const result = await client.query<{ r: Record<string, unknown> }>(
    'select app.report_gl_period_profit($1, $2, $3::date, $4::date) as r',
    [input.orgId, input.branchId, input.period.from, input.period.to],
  );
  const row = result.rows[0]!.r;
  return {
    revenue: moneyFromSql(num(row['revenue'])),
    cogs: moneyFromSql(num(row['cogs'])),
    profit: moneyFromSql(num(row['profit'])),
  };
}

/** When the branch last synced. The owner console always shows this. */
export async function lastSync(
  client: PoolClient,
  input: { orgId: string; branchId: string },
): Promise<LastSync> {
  const result = await client.query<{ r: Record<string, unknown> }>(
    'select app.report_last_sync($1, $2) as r',
    [input.orgId, input.branchId],
  );
  return lastSyncFrom(result.rows[0]!.r);
}

function lastSyncFrom(row: Record<string, unknown>): LastSync {
  const contact = row['last_cloud_contact_at'];
  const ingest = row['last_ingest_at'];
  return {
    lastCloudContactAt: contact === null || contact === undefined ? null : String(contact),
    lastIngestAt: ingest === null || ingest === undefined ? null : String(ingest),
    lastPushedSeq: String(row['last_pushed_seq'] ?? '0'),
    outboxSize: Number(row['outbox_size'] ?? 0),
  };
}

/**
 * "Last sync: 2 min ago", from the timestamp the console holds. A null timestamp is "never", and a
 * future or clock-skewed one is "just now" rather than a negative age. Kept here (not in the page) so
 * the branch and the cloud label a stale figure the same way (ADR-0049, ADR-0076).
 */
export function syncAgeLabel(
  lastSyncAt: string | null,
  now: Date = new Date(),
): string {
  if (!lastSyncAt) return 'Last sync: never';
  const at = new Date(lastSyncAt).getTime();
  if (!Number.isFinite(at)) return 'Last sync: never';
  const seconds = Math.floor((now.getTime() - at) / 1000);
  if (seconds <= 5) return 'Last sync: just now';
  if (seconds < 60) return `Last sync: ${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Last sync: ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last sync: ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `Last sync: ${days} day${days === 1 ? '' : 's'} ago`;
}

/** Today's live figures for the /reports/today dashboard (ADR-0076). */
export async function todayFigures(
  client: PoolClient,
  input: { orgId: string; branchId: string },
): Promise<TodayFigures> {
  const result = await client.query<{ r: Record<string, unknown> }>(
    'select app.report_today($1, $2) as r',
    [input.orgId, input.branchId],
  );
  const row = result.rows[0]!.r;
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  return {
    byCurrency: decimalRecord(row['by_currency']),
    salesBase: moneyFromSql(num(row['sales_base'])),
    saleCount: Number(row['sale_count'] ?? 0),
    grossSales: moneyFromSql(num(row['gross_sales'])),
    byTill: list(row['by_till']).map((t) => ({
      tillId: String(t['till_id']),
      saleCount: Number(t['sale_count'] ?? 0),
      gross: moneyFromSql(num(t['gross'])),
    })),
    byBranch: list(row['by_branch']).map((b) => ({
      branchId: String(b['branch_id']),
      saleCount: Number(b['sale_count'] ?? 0),
      gross: moneyFromSql(num(b['gross'])),
    })),
    lowStock: list(row['low_stock']).map((l) => ({
      productId: String(l['product_id']),
      variantId: l['variant_id'] === null || l['variant_id'] === undefined ? null : String(l['variant_id']),
      sku: String(l['sku'] ?? ''),
      name: String(l['name'] ?? ''),
      qty: moneyFromSql(num(l['qty'])),
    })),
    laybysDue: list(row['laybys_due']).map((l) => ({
      id: String(l['id']),
      laybyNo: String(l['layby_no']),
      dueDate: String(l['due_date']),
      total: moneyFromSql(num(l['total'])),
      depositPaid: moneyFromSql(num(l['deposit_paid'])),
      customer: String(l['customer'] ?? ''),
    })),
    fiscal: (() => {
      const f = (row['fiscal'] ?? {}) as Record<string, unknown>;
      return {
        pending: Number(f['pending'] ?? 0),
        sent: Number(f['sent'] ?? 0),
        failed: Number(f['failed'] ?? 0),
        failedAmount: moneyFromSql(num(f['failed_amount'])),
      };
    })(),
    sync: lastSyncFrom((row['sync'] ?? {}) as Record<string, unknown>),
  };
}

/** One Z-report by primary key, with the same fiscal totals the list carries (ADR-0047, ADR-0076). */
export async function zReportDetail(
  client: PoolClient,
  input: { orgId: string; branchId: string; zReportId: string },
): Promise<ZReportRow | null> {
  const result = await client.query<{ r: Record<string, unknown> | null }>(
    'select app.report_z_report_detail($1, $2, $3) as r',
    [input.orgId, input.branchId, input.zReportId],
  );
  const row = result.rows[0]!.r;
  if (row === null || row === undefined) return null;
  return {
    id: String(row['id']),
    zNo: String(row['z_no']),
    shiftId: String(row['shift_id']),
    openedAt: String(row['opened_at']),
    closedAt: String(row['closed_at']),
    openingFloat: moneyFromSql(num(row['opening_float'])),
    saleCount: Number(row['sale_count'] ?? 0),
    voidCount: Number(row['void_count'] ?? 0),
    grossSales: moneyFromSql(num(row['gross_sales'])),
    taxTotal: moneyFromSql(num(row['tax_total'])),
    byMethod: decimalRecord(row['by_method']),
    byCurrency: decimalRecord(row['by_currency']),
    vatByRate: decimalRecord(row['vat_by_rate']),
    fiscal: fiscalStatus(row['fiscal']),
    createdAt: String(row['created_at']),
  };
}
