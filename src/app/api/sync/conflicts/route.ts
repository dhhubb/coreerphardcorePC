import { ApiError, withAuth } from '@/app/api/_lib';
import { recentConflicts, requeueConflict } from '@/sync/status';

/**
 * GET /api/sync/conflicts — the branch's recent conflicts, newest first.
 *
 * POST /api/sync/conflicts — re-queue one conflicted event.
 *
 * A conflict is a durable record that the cloud really rejected an event (a network failure is
 * retried, never recorded). Each row carries both versions: `both_versions.local` is the event the
 * branch sent, `both_versions.cloud` is what the cloud answered. "Retry failed" appends the local
 * event to the outbox again under a fresh event id, so the branch re-pushes it without un-acking
 * the original (acked_at is write-once).
 */

interface RetryBody {
  conflict_id?: string;
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
    const limit = rawLimit === null ? 50 : Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      throw new ApiError(422, 'limit must be between 1 and 100');
    }

    const conflicts = await recentConflicts(client, orgId, branchId, limit);
    return { conflicts };
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as RetryBody;
    const orgId = claims.orgId;
    const branchId = claims.branchIds[0] ?? null;
    if (!orgId) throw new ApiError(401, 'unauthorized');
    if (!branchId) throw new ApiError(422, 'branch_id is required');
    if (!body.conflict_id) throw new ApiError(422, 'conflict_id is required');

    const seq = await requeueConflict(client, orgId, body.conflict_id);
    return { requeued_seq: seq };
  });
}
