import Decimal from 'decimal.js';
import { formatDate, formatMoney, formatRate } from './receiptData';

/**
 * The Z-report as the paper slip needs it (F3).
 *
 * A Z-report is immutable: it is written once when a shift closes and never updated
 * (`app.enforce_immutable`). This model is the shape the slip prints and the shape the console
 * holds, so the screen and the paper cannot disagree. Money stays a `Decimal` end to end.
 */
export interface ZReportData {
  zNo: string;
  shopName: string;
  shopAddressLines: string[];
  shopVatNumber: string;
  branchName: string;
  tillId: string;
  openedAt: string;
  closedAt: string;
  openingFloat: Decimal;
  saleCount: number;
  voidCount: number;
  grossSales: Decimal;
  taxTotal: Decimal;
  /** Totals by tender method (cash, card, …), each a Decimal amount. */
  byMethod: Record<string, Decimal>;
  /** Totals by tender currency (USD, ZWG), each a Decimal amount. */
  byCurrency: Record<string, Decimal>;
  /** VAT totals by rate (0.15 → amount), each a Decimal amount. */
  vatByRate: Record<string, Decimal>;
  footer: string;
}

export interface ZReportShop {
  name: string;
  addressLines: string[];
  vatNumber: string;
}

export const Z_REPORT_FOOTER = 'Powered by AfritecX';

/** The raw shape the `/api/admin/z-reports/:id` route returns (money as fixed-scale strings). */
export interface RawZReport {
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
  by_method: Record<string, string>;
  by_currency: Record<string, string>;
  vat_by_rate: Record<string, string>;
}

function decimalRecord(record: Record<string, string> | undefined): Record<string, Decimal> {
  return Object.fromEntries(
    Object.entries(record ?? {}).map(([key, amount]) => [key, new Decimal(amount)]),
  );
}

/** Build the slip model from a route response. */
export function buildZReportData(
  raw: RawZReport,
  context: { shop: ZReportShop; branchName: string; tillId: string },
): ZReportData {
  return {
    zNo: raw.z_no,
    shopName: context.shop.name,
    shopAddressLines: context.shop.addressLines,
    shopVatNumber: context.shop.vatNumber,
    branchName: context.branchName,
    tillId: context.tillId,
    openedAt: raw.opened_at,
    closedAt: raw.closed_at,
    openingFloat: new Decimal(raw.opening_float),
    saleCount: raw.sale_count,
    voidCount: raw.void_count,
    grossSales: new Decimal(raw.gross_sales),
    taxTotal: new Decimal(raw.tax_total),
    byMethod: decimalRecord(raw.by_method),
    byCurrency: decimalRecord(raw.by_currency),
    vatByRate: decimalRecord(raw.vat_by_rate),
    footer: Z_REPORT_FOOTER,
  };
}
