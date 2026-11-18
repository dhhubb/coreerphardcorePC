import { withAuth, parseCursor, parseLimit } from '../../_lib';
import { stockMovements, stockOnHand } from '@/verticals/reports/stock';
import { resolveBranchId, parsePeriod } from '../_shared';

/**
 * GET /api/reports/stock — a keyset page of a stock report.
 *
 * `mode=on_hand` (the default) returns the on-hand quantity and value per warehouse/product/variant
 * from the stock_balances cache; `mode=movements` returns the append-only stock_ledger movements for
 * a period. Both pages are keyset on (created_at, id), default 50, maximum 100, never an offset.
 *
 * The figures come from app.report_stock_* which run as the caller, so RLS scopes every row to the
 * branches the token carries (ADR-0077).
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const orgId = claims.orgId!;
    const branchId = resolveBranchId(url.searchParams, claims);
    const mode = url.searchParams.get('mode') === 'movements' ? 'movements' : 'on_hand';
    const warehouseId = url.searchParams.get('warehouse_id');
    const query = url.searchParams.get('q');
    const limit = parseLimit(url.searchParams);
    const cursor = parseCursor(url.searchParams);

    if (mode === 'movements') {
      const period = parsePeriod(url.searchParams);
      const page = await stockMovements(client, {
        orgId,
        branchId,
        period,
        warehouseId,
        query,
        limit,
        cursor,
      });
      return {
        mode,
        branch_id: branchId,
        period,
        rows: page.rows.map((row) => ({
          id: row.id,
          warehouse_id: row.warehouseId,
          warehouse_code: row.warehouseCode,
          product_id: row.productId,
          variant_id: row.variantId,
          sku: row.sku,
          name: row.name,
          direction: row.direction,
          qty: row.qty.toFixed(4),
          unit_cost: row.unitCost.toFixed(4),
          source_type: row.sourceType,
          source_id: row.sourceId,
          created_at: row.createdAt,
        })),
        next_cursor: page.nextCursor,
      };
    }

    const page = await stockOnHand(client, {
      orgId,
      branchId,
      warehouseId,
      query,
      limit,
      cursor,
    });
    return {
      mode,
      branch_id: branchId,
      rows: page.rows.map((row) => ({
        id: row.id,
        warehouse_id: row.warehouseId,
        warehouse_code: row.warehouseCode,
        product_id: row.productId,
        variant_id: row.variantId,
        sku: row.sku,
        name: row.name,
        qty: row.qty.toFixed(4),
        value: row.value.toFixed(4),
        unit_cost: row.unitCost.toFixed(4),
        created_at: row.createdAt,
      })),
      next_cursor: page.nextCursor,
    };
  });
}
