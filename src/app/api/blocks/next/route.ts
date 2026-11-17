import { withAuth } from '@/app/api/_lib';
import {
  cloudBlockFetcher,
  ensureNextBlock,
  lowWaterForBlock,
  numberBlockStatus,
} from '@/fiscal';
import { cloudUrl } from '@/branch/config';
import { branchSyncToken } from '@/sync/config';

/**
 * GET /api/blocks/next — the branch asks for its next invoice-number block before the current one
 * runs out.
 *
 * The brief names this endpoint `GET /api/blocks/next`. It is the branch-side top-up the H3
 * `/api/fiscal/numbers` route already performs; this route is the brief's name and shape over the
 * same functions, so a branch (or a cron on the branch server) can call it after each sale.
 *
 * When the remaining count is at or below the low-water mark (20% of the block by default) the
 * branch fetches the next block from the cloud and stores it. When the cloud is unreachable the
 * request still succeeds and reports the current status: the branch keeps selling from what it has
 * until the block truly runs out, at which point the next sale fails with a clear message.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const seriesCode = url.searchParams.get('series_code') ?? 'INVOICE';
    const orgId = claims.orgId!;
    const branchId = claims.branchIds[0]!;

    const current = await numberBlockStatus(client, { orgId, branchId, seriesCode });
    const lowWater = lowWaterForBlock(current);

    const target = cloudUrl();
    const token = branchSyncToken();
    if (!target || !token) {
      // No cloud configured (cloud mode, or a branch without a sync token): report the local block.
      return { status: current, requested: false, low_water: lowWater };
    }

    const result = await ensureNextBlock(
      client,
      cloudBlockFetcher({ cloudUrl: target, token, branchId, seriesCode }),
      { orgId, branchId, seriesCode },
    );
    return { status: result.status, requested: result.requested, low_water: lowWater };
  });
}
