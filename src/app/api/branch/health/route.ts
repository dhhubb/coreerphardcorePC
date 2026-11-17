import { NextResponse } from 'next/server';
import { claimsFromAuthorizationHeader, withUserContext, type AuthClaims } from '@/core/auth';
import { getPool } from '@/core/db';
import { BRANCH_PROTOCOL_VERSION, branchMode, cloudUrl, isBranchMode } from '@/branch/config';
import { branchHealth, databaseUp } from '@/branch/health';

/**
 * GET /api/branch/health — the branch's health report.
 *
 * The till polls this to learn whether the branch is up and what it last saw of the cloud. It is
 * deliberately reachable without a bearer token, because the cloud probes the same path to decide
 * the branch/cloud protocol version (decision 17) and a health check that needs credentials cannot
 * answer when auth is the thing that is broken.
 *
 * With a token it also reports the branch's stored cloud observation; without one it reports the
 * live local state only. `?probe=1` refreshes the cloud observation (short timeout, never hangs).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const wantProbe = url.searchParams.get('probe') === '1';

  let claims: AuthClaims | null = null;
  try {
    claims = claimsFromAuthorizationHeader(request.headers.get('authorization'));
  } catch {
    claims = null;
  }

  // The cloud side answers with its protocol version so a branch can compare versions.
  if (!isBranchMode()) {
    return NextResponse.json({
      mode: branchMode(),
      branch_up: true,
      branch_online: true,
      protocol_version: BRANCH_PROTOCOL_VERSION,
      cloud_url: cloudUrl(),
    });
  }

  const scope = claims?.orgId && claims.branchIds[0]
    ? { orgId: claims.orgId, branchId: claims.branchIds[0] }
    : {};

  try {
    if (claims) {
      const health = await withUserContext(claims, (client) =>
        branchHealth(client, { ...scope, ...(wantProbe ? { probe: true } : {}) }),
      );
      return NextResponse.json(health);
    }

    const client = await getPool().connect();
    try {
      const dbUp = await databaseUp(client);
      return NextResponse.json({
        mode: branchMode(),
        branch_up: true,
        branch_online: true,
        database_up: dbUp,
        protocol_version: BRANCH_PROTOCOL_VERSION,
        cloud_url: cloudUrl(),
        cloud_status: 'offline',
        cloud_online: false,
        cloud_protocol_version: null,
        push_blocked: false,
        outbox_size: null,
      });
    } finally {
      client.release();
    }
  } catch {
    // A health endpoint must answer even when something is wrong: report not-up rather than 500.
    return NextResponse.json({
      mode: branchMode(),
      branch_up: false,
      branch_online: false,
      database_up: false,
      protocol_version: BRANCH_PROTOCOL_VERSION,
      cloud_url: cloudUrl(),
      cloud_status: 'offline',
      cloud_online: false,
      cloud_protocol_version: null,
      push_blocked: false,
      outbox_size: null,
    });
  }
}
