import { ApiError, withAuth } from '@/app/api/_lib';
import { recentBackups, recordBackup } from '@/sync/status';

/**
 * POST /api/backup — the branch records a completed backup run.
 *
 * The branch's nightly job (`npm run branch:backup`) dumps its own Postgres, encrypts the dump and
 * uploads the ciphertext. This endpoint is how the branch tells the cloud the run happened: it
 * records the object key, the byte size and the checksum of the CIPHERTEXT (never the plaintext),
 * so the cloud console can show the last backup and prove the stored bytes match what the branch
 * uploaded. The branch's token scopes the write: it can only record a backup for its own org and
 * branch.
 *
 * GET /api/backup — the recent backup runs for the caller's branch, newest first.
 */

const MAX_BACKUP_PAGE = 100;

interface BackupBody {
  org_id?: string;
  branch_id?: string;
  status?: 'running' | 'uploaded' | 'failed';
  object_key?: string | null;
  byte_size?: number | null;
  checksum?: string | null;
  error?: string | null;
}

export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as BackupBody;

    const orgId = claims.orgId;
    const branchId = body.branch_id ?? claims.branchIds[0] ?? null;
    if (!orgId) throw new ApiError(401, 'unauthorized');
    if (!branchId) throw new ApiError(422, 'branch_id is required');
    if (body.org_id && body.org_id !== orgId) {
      throw new ApiError(403, 'the token does not scope this org');
    }
    if (!claims.branchIds.includes(branchId)) {
      throw new ApiError(403, 'the token does not scope this branch');
    }
    if (!body.status) throw new ApiError(422, 'status is required');

    const id = await recordBackup(client, {
      orgId,
      branchId,
      status: body.status,
      objectKey: body.object_key ?? null,
      byteSize: body.byte_size ?? null,
      checksum: body.checksum ?? null,
      error: body.error ?? null,
    });

    return { backup_id: id, status: body.status };
  });
}

export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const orgId = claims.orgId;
    const branchId = url.searchParams.get('branch_id') ?? claims.branchIds[0] ?? null;
    if (!orgId) throw new ApiError(401, 'unauthorized');
    if (!branchId) throw new ApiError(422, 'branch_id is required');
    if (!claims.branchIds.includes(branchId)) {
      throw new ApiError(403, 'the token does not scope this branch');
    }

    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 20 : Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > MAX_BACKUP_PAGE) {
      throw new ApiError(422, `limit must be between 1 and ${MAX_BACKUP_PAGE}`);
    }

    const backups = await recentBackups(client, orgId, branchId, limit);
    return { backups };
  });
}
