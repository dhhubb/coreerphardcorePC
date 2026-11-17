import { ApiError, withAuth } from '@/app/api/_lib';
import { retryFiscalInvoice } from '@/fiscal';

interface RetryBody {
  fiscal_invoice_id?: string;
}

/**
 * POST /api/fiscal/retry — admin: retry a FAILED fiscal invoice.
 *
 * The brief names this endpoint `POST /api/fiscal/retry`. It is the same operation as H3's
 * `POST /api/fiscal/invoices/:id/retry`, addressed by body instead of by path, so the admin page (and
 * an operator script) can retry by id in one call. It clears the attempt counter and re-arms the row
 * as pending, so the branch worker submits it again on its next pass.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json().catch(() => ({}))) as RetryBody;
    if (!body.fiscal_invoice_id) {
      throw new ApiError(422, 'fiscal_invoice_id is required');
    }
    await retryFiscalInvoice(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      fiscalInvoiceId: body.fiscal_invoice_id,
    });
    return { fiscal_invoice_id: body.fiscal_invoice_id, status: 'pending' };
  });
}
