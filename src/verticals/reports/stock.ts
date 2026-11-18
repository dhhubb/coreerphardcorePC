import type { PoolClient } from 'pg';
import { moneyFromSql } from '@/core/money';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@/core/sales';
import type { PageCursor } from '@/core/sales';
import type {
  StockMovementPage,
  StockMovementRow,
  StockOnHandPage,
  StockOnHandRow,
  StockPeriod,
} from './stockTypes';

/**
 * The stock report reads (F10). Every row comes from SQL (app.report_stock_*); this module only
 * shapes it. Both functions are SECURITY INVOKER, so RLS scopes the rows by org and branch.
 *
 * Both lists are keyset pages on (created_at, id) descending: the caller passes the cursor the
 * previous page returned, never an offset.
 */

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_PAGE_LIMIT);
}

function num(value: unknown): string {
  return value === null || value === undefined ? '0' : String(value);
}

function isoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nextCursor(
  rows: ReadonlyArray<{ createdAt: string; id: string }>,
  limit: number,
): PageCursor | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1]!;
  return { createdAt: last.createdAt, id: last.id };
}

function onHandRow(row: Record<string, unknown>): StockOnHandRow {
  return {
    id: String(row['id']),
    warehouseId: String(row['warehouse_id']),
    warehouseCode: String(row['warehouse_code']),
    productId: String(row['product_id']),
    variantId: row['variant_id'] === null ? null : String(row['variant_id']),
    sku: String(row['sku']),
    name: String(row['name']),
    qty: moneyFromSql(num(row['qty'])),
    value: moneyFromSql(num(row['value'])),
    unitCost: moneyFromSql(num(row['unit_cost'])),
    createdAt: isoString(row['created_at']),
  };
}

function movementRow(row: Record<string, unknown>): StockMovementRow {
  return {
    id: String(row['id']),
    warehouseId: String(row['warehouse_id']),
    warehouseCode: String(row['warehouse_code']),
    productId: String(row['product_id']),
    variantId: row['variant_id'] === null ? null : String(row['variant_id']),
    sku: String(row['sku']),
    name: String(row['name']),
    direction: row['direction'] === 'out' ? 'out' : 'in',
    qty: moneyFromSql(num(row['qty'])),
    unitCost: moneyFromSql(num(row['unit_cost'])),
    sourceType: String(row['source_type']),
    sourceId: row['source_id'] === null ? null : String(row['source_id']),
    createdAt: isoString(row['created_at']),
  };
}

/** On-hand quantity and value per warehouse/product/variant. Keyset on (created_at, id). */
export async function stockOnHand(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    warehouseId?: string | null;
    query?: string | null;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<StockOnHandPage> {
  const limit = clampLimit(input.limit);
  const result = await client.query<{ r: Record<string, unknown> }>(
    `select * from app.report_stock_on_hand($1, $2, $3, $4, $5, $6, $7) as r`,
    [
      input.orgId,
      input.branchId,
      input.warehouseId ?? null,
      input.query ?? null,
      limit,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );
  const rows = result.rows.map((row) => onHandRow(row));
  return { rows, nextCursor: nextCursor(rows, limit) };
}

/** The stock_ledger movements for a period. Keyset on (created_at, id). */
export async function stockMovements(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    period: StockPeriod;
    warehouseId?: string | null;
    query?: string | null;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<StockMovementPage> {
  const limit = clampLimit(input.limit);
  const result = await client.query<{ r: Record<string, unknown> }>(
    `select * from app.report_stock_movements($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9) as r`,
    [
      input.orgId,
      input.branchId,
      input.period.from,
      input.period.to,
      input.warehouseId ?? null,
      input.query ?? null,
      limit,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ],
  );
  const rows = result.rows.map((row) => movementRow(row));
  return { rows, nextCursor: nextCursor(rows, limit) };
}
