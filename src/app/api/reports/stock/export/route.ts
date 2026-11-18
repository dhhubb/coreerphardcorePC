import { claimsFromAuthorizationHeader, withUserContext } from '@/core/auth';
import { ApiError, toErrorResponse } from '../../../_lib';
import { stockMovements, stockOnHand } from '@/verticals/reports/stock';
import { buildTablePdf } from '@/verticals/reports/pdf';
import { stockMovementsTable, stockOnHandTable, type StockReportHeader } from '@/verticals/reports/stockReport';
import { resolveBranchId, parsePeriod } from '../../_shared';
import type { StockMovementRow, StockOnHandRow } from '@/verticals/reports/stockTypes';

/**
 * GET /api/reports/stock/export — the stock report as a PDF download.
 *
 * Same figures as GET /api/reports/stock, but it pages through the keyset internally (bounded by
 * MAX_ROWS) and renders the rows with the dependency-free PDF writer. The document carries the org,
 * the branch and the period, so an exported file stands on its own. RLS still scopes every row
 * (ADR-0077).
 */

const PAGE_SIZE = 100;
const MAX_ROWS = 5_000;

async function readAll<T>(
  fetchPage: (cursor: { createdAt: string; id: string } | null) => Promise<{ rows: T[]; nextCursor: { createdAt: string; id: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: { createdAt: string; id: string } | null = null;
  do {
    const page = await fetchPage(cursor);
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor && rows.length < MAX_ROWS);
  return rows.slice(0, MAX_ROWS);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const claims = claimsFromAuthorizationHeader(request.headers.get('authorization'));
    const url = new URL(request.url);
    const orgId = claims.orgId;
    if (!orgId) throw new ApiError(403, 'the token does not scope an organisation');
    const branchId = resolveBranchId(url.searchParams, claims);
    const mode = url.searchParams.get('mode') === 'movements' ? 'movements' : 'on_hand';
    const warehouseId = url.searchParams.get('warehouse_id');
    const query = url.searchParams.get('q');
    const period = parsePeriod(url.searchParams);

    const pdf = await withUserContext(claims, async (client) => {
      const org = await client.query<{ name: string }>(
        'select name from public.organizations where id = $1',
        [orgId],
      );
      const branch = await client.query<{ name: string }>(
        'select name from public.branches where id = $1',
        [branchId],
      );
      let warehouseLabel: string | null = null;
      if (warehouseId) {
        const warehouse = await client.query<{ code: string; name: string }>(
          'select code, name from public.warehouses where id = $1',
          [warehouseId],
        );
        const row = warehouse.rows[0];
        warehouseLabel = row ? `${row.code} — ${row.name}` : null;
      }

      const header: StockReportHeader = {
        orgName: org.rows[0]?.name ?? orgId,
        branchName: branch.rows[0]?.name ?? branchId,
        warehouseLabel,
        period: mode === 'movements' ? period : null,
        generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      };

      if (mode === 'movements') {
        const rows = await readAll<StockMovementRow>((cursor) =>
          stockMovements(client, { orgId, branchId, period, warehouseId, query, limit: PAGE_SIZE, cursor }),
        );
        return buildTablePdf(stockMovementsTable(header, rows));
      }

      const rows = await readAll<StockOnHandRow>((cursor) =>
        stockOnHand(client, { orgId, branchId, warehouseId, query, limit: PAGE_SIZE, cursor }),
      );
      return buildTablePdf(stockOnHandTable(header, rows));
    });

    const filename = `stock-${mode === 'movements' ? 'movements' : 'on-hand'}-${new Date()
      .toISOString()
      .slice(0, 10)}.pdf`;
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
