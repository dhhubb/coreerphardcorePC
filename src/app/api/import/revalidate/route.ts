import { ApiError, withAuth } from '@/app/api/_lib';
import { updateImportRow, validateImportJob } from '@/verticals/import/jobs';

interface RevalidateBody {
  /** Fix one staged row's data and revalidate it (the UI's inline edit). */
  row_id?: string;
  data?: Record<string, string>;
  /** Revalidate the whole job (the default when no row_id is given). */
  job_id?: string;
}

/**
 * POST /api/import/revalidate — the brief's name for the revalidation step.
 *
 * With `row_id` and `data`, it fixes one row and revalidates it (then revalidates the whole job so
 * the commit gate reflects the fix). With only `job_id`, it revalidates the whole job. Either way it
 * returns the job counts, so the UI can enable or block the commit button.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as RevalidateBody;
    const orgId = claims.orgId!;
    const branchId = claims.branchIds[0]!;

    if (body.row_id) {
      if (!body.data || typeof body.data !== 'object') {
        throw new ApiError(422, 'data must be an object when row_id is given');
      }
      await updateImportRow(client, { orgId, branchId, rowId: body.row_id, data: body.data });
    }

    if (typeof body.job_id !== 'string' || body.job_id === '') {
      throw new ApiError(422, 'job_id is required');
    }

    const validation = await validateImportJob(client, { orgId, branchId, jobId: body.job_id });
    return {
      job_id: validation.jobId,
      status: validation.status,
      total_rows: validation.totalRows,
      invalid_rows: validation.invalidRows,
      skipped_rows: validation.skippedRows,
    };
  });
}
