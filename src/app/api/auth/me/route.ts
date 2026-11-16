import { withAuth } from '../../_lib';

/**
 * GET /api/auth/me — validate the caller's token and describe the session.
 *
 * Runs inside the user's transaction, so an invalid or expired token is rejected by the middleware
 * and by `withAuth` with a 401. The org name is read from the token when present and otherwise from
 * the caller's own organizations row (RLS scopes it to the org the token names), so a token minted
 * before the org name was added to the claims still resolves.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    let orgName = claims.orgName ?? null;
    if (orgName === null && claims.orgId) {
      const row = await client.query<{ name: string }>(
        'select name from public.organizations where id = $1',
        [claims.orgId],
      );
      orgName = row.rows[0]?.name ?? null;
    }

    return {
      user: { id: claims.sub, email: claims.email ?? null },
      org_id: claims.orgId,
      org_name: orgName,
      branch_ids: claims.branchIds,
      role: claims.role,
    };
  });
}
