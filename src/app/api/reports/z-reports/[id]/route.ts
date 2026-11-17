import { ApiError, withAuth } from '../../../_lib';
import { zReportDetail } from '@/verticals/reports';
import { resolveBranchId } from '../../_shared';

/**
 * GET /api/reports/z-reports/:id — one Z-report, for the detail page and the 58mm print.
 *
 * A single indexed lookup through `app.report_z_report_detail`, so the page stays fast however many
 * Z-reports exist. The fiscal totals are computed at read time, because a fiscal status changes
 * after the close (ADR-0047).
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const branchId = resolveBranchId(url.searchParams, claims);

    const report = await zReportDetail(client, {
      orgId: claims.orgId!,
      branchId,
      zReportId: context.params.id,
    });
    if (report === null) {
      throw new ApiError(404, 'Z-report not found');
    }

    const money = (value: Record<string, { toFixed: (n: number) => string }>) =>
      Object.fromEntries(Object.entries(value).map(([key, amount]) => [key, amount.toFixed(4)]));

    return {
      id: report.id,
      z_no: report.zNo,
      branch_id: branchId,
      shift_id: report.shiftId,
      opened_at: report.openedAt,
      closed_at: report.closedAt,
      opening_float: report.openingFloat.toFixed(4),
      sale_count: report.saleCount,
      void_count: report.voidCount,
      gross_sales: report.grossSales.toFixed(4),
      tax_total: report.taxTotal.toFixed(4),
      by_method: money(report.byMethod),
      by_currency: money(report.byCurrency),
      vat_by_rate: money(report.vatByRate),
      fiscal: {
        sent: { count: report.fiscal.sent.count, amount: report.fiscal.sent.amount.toFixed(4) },
        pending: { count: report.fiscal.pending.count, amount: report.fiscal.pending.amount.toFixed(4) },
        failed: { count: report.fiscal.failed.count, amount: report.fiscal.failed.amount.toFixed(4) },
      },
      created_at: report.createdAt,
    };
  });
}
