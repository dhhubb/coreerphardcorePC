import Decimal from 'decimal.js';
import { money } from '@/core/money';
import type { PdfTableOptions } from './pdf';
import type { StockMovementRow, StockOnHandRow, StockPeriod } from './stockTypes';

/**
 * The stock report file shapes (F10). Pure: it takes the rows a report page shows and returns the
 * options for the PDF writer, plus the totals. No browser, no database, so it is unit-testable and
 * the on-screen table and the PDF are built from the same numbers.
 */

export interface StockReportHeader {
  orgName: string;
  branchName: string;
  warehouseLabel?: string | null;
  period?: StockPeriod | null;
  generatedAt: string;
}

function metaLines(header: StockReportHeader): string[] {
  const lines = [`Organisation: ${header.orgName}`, `Branch: ${header.branchName}`];
  if (header.warehouseLabel) lines.push(`Warehouse: ${header.warehouseLabel}`);
  if (header.period) lines.push(`Period: ${header.period.from} to ${header.period.to}`);
  lines.push(`Generated: ${header.generatedAt}`);
  return lines;
}

/** Sum the on-hand quantity and value across the rows. */
export function stockOnHandTotals(rows: readonly StockOnHandRow[]): {
  qty: Decimal;
  value: Decimal;
} {
  return rows.reduce(
    (acc, row) => ({ qty: acc.qty.plus(row.qty), value: acc.value.plus(row.value) }),
    { qty: new Decimal(0), value: new Decimal(0) },
  );
}

/** The PDF table for the stock-on-hand report. */
export function stockOnHandTable(
  header: StockReportHeader,
  rows: readonly StockOnHandRow[],
): PdfTableOptions {
  const totals = stockOnHandTotals(rows);
  const columns = [
    { header: 'SKU', width: 90 },
    { header: 'Name', width: 175 },
    { header: 'Warehouse', width: 60 },
    { header: 'Qty', width: 55, align: 'right' as const },
    { header: 'Unit cost', width: 65, align: 'right' as const },
    { header: 'Value', width: 70, align: 'right' as const },
  ];
  const body = rows.map((row) => [
    row.sku,
    row.name,
    row.warehouseCode,
    money(row.qty).toFixed(2),
    money(row.unitCost).toFixed(2),
    money(row.value).toFixed(2),
  ]);
  return {
    title: 'Stock on hand',
    meta: metaLines(header),
    columns,
    rows: body,
    footer: `Rows: ${rows.length}    Total qty: ${money(totals.qty).toFixed(2)}    Total value: ${money(
      totals.value,
    ).toFixed(2)}`,
  };
}

/** Sum the inbound and outbound quantities across the movement rows. */
export function stockMovementTotals(rows: readonly StockMovementRow[]): {
  inQty: Decimal;
  outQty: Decimal;
} {
  return rows.reduce(
    (acc, row) =>
      row.direction === 'in'
        ? { inQty: acc.inQty.plus(row.qty), outQty: acc.outQty }
        : { inQty: acc.inQty, outQty: acc.outQty.plus(row.qty) },
    { inQty: new Decimal(0), outQty: new Decimal(0) },
  );
}

/** The PDF table for the stock-movements report. */
export function stockMovementsTable(
  header: StockReportHeader,
  rows: readonly StockMovementRow[],
): PdfTableOptions {
  const totals = stockMovementTotals(rows);
  const columns = [
    { header: 'Date', width: 88 },
    { header: 'SKU', width: 78 },
    { header: 'Name', width: 135 },
    { header: 'Wh', width: 40 },
    { header: 'In', width: 42, align: 'right' as const },
    { header: 'Out', width: 42, align: 'right' as const },
    { header: 'Source', width: 90 },
  ];
  const body = rows.map((row) => [
    row.createdAt.slice(0, 16).replace('T', ' '),
    row.sku,
    row.name,
    row.warehouseCode,
    row.direction === 'in' ? money(row.qty).toFixed(2) : '',
    row.direction === 'out' ? money(row.qty).toFixed(2) : '',
    row.sourceType,
  ]);
  return {
    title: 'Stock movements',
    meta: metaLines(header),
    columns,
    rows: body,
    footer: `Rows: ${rows.length}    Total in: ${money(totals.inQty).toFixed(
      2,
    )}    Total out: ${money(totals.outQty).toFixed(2)}`,
  };
}
