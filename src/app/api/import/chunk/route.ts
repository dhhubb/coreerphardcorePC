import { ApiError, withAuth } from '@/app/api/_lib';
import { loadImportChunk } from '@/verticals/import/jobs';

interface ChunkBody {
  job_id: string;
  start_row_no?: number;
  rows: Array<Record<string, string>>;
}

/**
 * POST /api/import/chunk — stage one more chunk of already-mapped rows.
 *
 * This is the brief's name for the staging step: the browser parses the CSV and maps the columns,
 * then uploads the rows in chunks of 500. It appends to an existing job (opened by
 * POST /api/import/jobs). Each chunk is one set-based INSERT from a JSON array, so a 5,000-row file
 * is ten round trips, not 5,000 inserts (ADR-0075).
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as ChunkBody;
    if (typeof body.job_id !== 'string' || body.job_id === '') {
      throw new ApiError(422, 'job_id is required');
    }
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      throw new ApiError(422, 'rows must be a non-empty array');
    }
    const startRowNo = body.start_row_no ?? 1;
    if (!Number.isInteger(startRowNo) || startRowNo < 1) {
      throw new ApiError(422, 'start_row_no must be a positive integer');
    }

    const staged = await loadImportChunk(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      jobId: body.job_id,
      startRowNo,
      rows: body.rows,
    });

    return { job_id: body.job_id, staged_rows: staged };
  });
}
