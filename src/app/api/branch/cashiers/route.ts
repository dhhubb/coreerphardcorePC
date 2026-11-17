import type { PoolClient } from 'pg';
import { NextResponse } from 'next/server';
import { ApiError, jsonError, toErrorResponse } from '@/app/api/_lib';
import { withUserContext, type AuthClaims } from '@/core/auth';
import { isBranchMode } from '@/branch/config';
import { listBranchCashiers } from '@/branch/pin';

/**
 * GET /api/branch/cashiers — the branch's cashiers, for the PIN sign-in picker.
 *
 * The till has no token before sign-in, so the branch answers from its own environment (the same
 * pattern as the branch login route). The SQL function is SECURITY DEFINER and scoped by its
 * parameters, so it can only ever return the caller's own branch. No PIN hash is returned.
 */

export async function GET(request: Request): Promise<NextResponse> {
  if (!isBranchMode()) {
    return jsonError(404, 'branch cashiers are only available in branch mode');
  }
  try {
    const url = new URL(request.url);
    const orgId = url.searchParams.get('org_id') ?? process.env.BRANCH_ORG_ID ?? null;
    const branchId = url.searchParams.get('branch_id') ?? process.env.BRANCH_ID ?? null;
    if (!orgId) throw new ApiError(422, 'org_id is required');
    if (!branchId) throw new ApiError(422, 'branch_id is required');

    const claims: AuthClaims = { sub: orgId, orgId, branchIds: [branchId], role: 'authenticated' };
    const cashiers = await withUserContext(claims, (client: PoolClient) =>
      listBranchCashiers(client, { orgId, branchId }),
    );
    return NextResponse.json({ cashiers });
  } catch (error) {
    return toErrorResponse(error);
  }
}
