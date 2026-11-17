import { withAuth } from '../../_lib';
import { todayFigures } from '@/verticals/reports';
import { resolveBranchId } from '../_shared';

/**
 * GET /api/reports/today — today's live figures for the /reports/today dashboard.
 *
 * Everything is today's: the takings split by currency and by till, the group's sales by branch (RLS
 * scopes which branches the caller may see), the low-stock list, the laybys that are due, the fiscal
 * queue and the sync status. The figures come from `app.report_today`, which reads the live
 * pos_sales / pos_payments tables bounded by today's index (ADR-0046, ADR-0076).
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const branchId = resolveBranchId(url.searchParams, claims);

    const figures = await todayFigures(client, { orgId: claims.orgId!, branchId });

    return {
      branch_id: branchId,
      sales_base: figures.salesBase.toFixed(4),
      sale_count: figures.saleCount,
      gross_sales: figures.grossSales.toFixed(4),
      by_currency: Object.fromEntries(
        Object.entries(figures.byCurrency).map(([key, value]) => [key, value.toFixed(4)]),
      ),
      by_till: figures.byTill.map((till) => ({
        till_id: till.tillId,
        sale_count: till.saleCount,
        gross: till.gross.toFixed(4),
      })),
      by_branch: figures.byBranch.map((branch) => ({
        branch_id: branch.branchId,
        sale_count: branch.saleCount,
        gross: branch.gross.toFixed(4),
      })),
      low_stock: figures.lowStock.map((row) => ({
        product_id: row.productId,
        variant_id: row.variantId,
        sku: row.sku,
        name: row.name,
        qty: row.qty.toFixed(4),
      })),
      laybys_due: figures.laybysDue.map((row) => ({
        id: row.id,
        layby_no: row.laybyNo,
        due_date: row.dueDate,
        total: row.total.toFixed(4),
        deposit_paid: row.depositPaid.toFixed(4),
        customer: row.customer,
      })),
      fiscal: {
        pending: figures.fiscal.pending,
        sent: figures.fiscal.sent,
        failed: figures.fiscal.failed,
        failed_amount: figures.fiscal.failedAmount.toFixed(4),
      },
      sync: {
        last_cloud_contact_at: figures.sync.lastCloudContactAt,
        last_ingest_at: figures.sync.lastIngestAt,
        last_pushed_seq: figures.sync.lastPushedSeq,
        outbox_size: figures.sync.outboxSize,
      },
    };
  });
}
