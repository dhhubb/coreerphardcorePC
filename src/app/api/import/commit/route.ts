import { ApiError, withAuth } from '@/app/api/_lib';
import { commitImportJob } from '@/verticals/import/jobs';

interface CommitBody {
  job_id: string;
  posting_date?: string | null;
}

/**
 * POST /api/import/commit — the brief's name for the commit step.
 *
 * Runs the whole job in one transaction (app.import_commit_job): products, variants and categories
 * are created or updated by external key, opening stock writes ledger rows plus one balanced
 * journal, and any invalid row blocks the commit. A failure part-way through rolls the whole job
 * back, so there is no partial data.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json().catch(() => ({}))) as CommitBody;
    if (typeof body.job_id !== 'string' || body.job_id === '') {
      throw new ApiError(422, 'job_id is required');
    }

    const result = await commitImportJob(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      jobId: body.job_id,
      postingDate: body.posting_date ?? null,
    });

    return {
      job_id: result.jobId,
      status: result.status,
      kind: result.kind,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      committed_rows: result.committedRows,
      journal_id: result.journalId,
      total_value: result.totalValue.toFixed(4),
    };
  });
}
