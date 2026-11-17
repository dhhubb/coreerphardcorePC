import type Decimal from 'decimal.js';
import type { PageCursor } from '@/core/sales';

/**
 * The report shapes. Money is always a decimal, never a number (ADR-0045).
 *
 * A product row is a line of the profit report: the quantity sold, the revenue (exclusive of tax),
 * the tax, the cost of goods sold and the profit (revenue - cogs) for the period.
 */
export interface ProductProfitRow {
  productId: string;
  qty: Decimal;
  revenue: Decimal;
  tax: Decimal;
  cogs: Decimal;
  profit: Decimal;
}

export interface ProductProfitPage {
  rows: ProductProfitRow[];
  nextCursor: { afterProductId: string } | null;
}

export interface ProductRankRow extends ProductProfitRow {}

export interface ProductRankPage {
  rows: ProductRankRow[];
  nextCursor: { afterQty: Decimal; afterProductId: string } | null;
}

export interface VatRow {
  taxRate: Decimal;
  net: Decimal;
  tax: Decimal;
  gross: Decimal;
  lineCount: number;
}

/** The fiscal totals a Z-report carries: how many of the shift's invoices reached FDMS, and how. */
export interface FiscalTotals {
  count: number;
  amount: Decimal;
}

export interface FiscalStatusTotals {
  sent: FiscalTotals;
  pending: FiscalTotals;
  failed: FiscalTotals;
}

export interface ZReportRow {
  id: string;
  zNo: string;
  shiftId: string;
  openedAt: string;
  closedAt: string;
  openingFloat: Decimal;
  saleCount: number;
  voidCount: number;
  grossSales: Decimal;
  taxTotal: Decimal;
  byMethod: Record<string, Decimal>;
  byCurrency: Record<string, Decimal>;
  vatByRate: Record<string, Decimal>;
  fiscal: FiscalStatusTotals;
  createdAt: string;
}

export interface ZReportPage {
  rows: ZReportRow[];
  nextCursor: PageCursor | null;
}

/** GL revenue minus cost of goods sold for the period. The profit report must equal this. */
export interface PeriodProfit {
  revenue: Decimal;
  cogs: Decimal;
  profit: Decimal;
}

/** When the branch last synced. The owner console always shows this. */
export interface LastSync {
  lastCloudContactAt: string | null;
  lastIngestAt: string | null;
  lastPushedSeq: string;
  outboxSize: number;
}

/** A row of the low-stock alert: on-hand below the threshold. */
export interface LowStockRow {
  productId: string;
  variantId: string | null;
  sku: string;
  name: string;
  qty: Decimal;
}

/** A layby that has reached its due date and is still open. */
export interface LaybyDueRow {
  id: string;
  laybyNo: string;
  dueDate: string;
  total: Decimal;
  depositPaid: Decimal;
  customer: string;
}

/** Today's sales for one till. */
export interface TillSalesRow {
  tillId: string;
  saleCount: number;
  gross: Decimal;
}

/** Today's sales for one branch (the owner console rolls the group up). */
export interface BranchSalesRow {
  branchId: string;
  saleCount: number;
  gross: Decimal;
}

/** The fiscal queue as of today: how many invoices are in each state. */
export interface TodayFiscal {
  pending: number;
  sent: number;
  failed: number;
  failedAmount: Decimal;
}

/** The live dashboard for /reports/today. Every figure is today's. */
export interface TodayFigures {
  byCurrency: Record<string, Decimal>;
  salesBase: Decimal;
  saleCount: number;
  grossSales: Decimal;
  byTill: TillSalesRow[];
  byBranch: BranchSalesRow[];
  lowStock: LowStockRow[];
  laybysDue: LaybyDueRow[];
  fiscal: TodayFiscal;
  sync: LastSync;
}
