import { getPool } from './db';
import { mintAccessToken } from './auth';

/**
 * Email/password sign-in (F1).
 *
 * The password is verified in Postgres (`app.authenticate`), which compares it against a bcrypt
 * hash; the plaintext never touches a table. On success the tenant claims come from
 * `app.login_context` (the same claims the custom access token hook mints) and a token is signed
 * here. This path runs as the caller — never the service role — and reads no tenant table directly.
 */

export interface LoginResult {
  token: string;
  expiresAt: string;
  userId: string;
  email: string;
  orgId: string | null;
  orgName: string | null;
  branchIds: string[];
  role: string;
  memberRole: string | null;
}

interface LoginContextRow {
  user_id: string;
  email: string | null;
  org_id: string | null;
  org_name: string | null;
  branch_ids: string[];
  role: string;
  member_role: string | null;
}

const TTL_SECONDS = 12 * 3600;

/**
 * Verify an email and password. Returns null when the pair does not match — a wrong email and a
 * wrong password are indistinguishable, so the route can answer 401 either way without leaking
 * which accounts exist.
 */
export async function login(email: string, password: string): Promise<LoginResult | null> {
  const client = await getPool().connect();
  try {
    // A signed-out caller has no user, so the path runs as `anon`, not `authenticated`. The two
    // functions it calls are SECURITY DEFINER, so they resolve the password and the claims with
    // their own privileges; `anon` itself can read neither `app.user_credentials` nor a tenant row.
    await client.query('begin');
    await client.query('set local role anon');

    const auth = await client.query<{ user_id: string | null }>(
      'select app.authenticate($1, $2) as user_id',
      [email, password],
    );
    const userId = auth.rows[0]?.user_id ?? null;
    if (userId === null) {
      await client.query('commit');
      return null;
    }

    const context = await client.query<LoginContextRow>(
      `select (c ->> 'user_id') as user_id,
              (c ->> 'email')   as email,
              (c ->> 'org_id')  as org_id,
              (c ->> 'org_name') as org_name,
              coalesce(
                (select array_agg(value::text)
                   from jsonb_array_elements_text(coalesce(c -> 'branch_ids', '[]'::jsonb)) as value),
                '{}'::text[]
              ) as branch_ids,
              (c ->> 'role')    as role,
              (c ->> 'member_role') as member_role
         from app.login_context($1) c`,
      [userId],
    );
    const row = context.rows[0];
    await client.query('commit');
    if (!row) return null;

    const token = mintAccessToken(
      {
        sub: row.user_id,
        orgId: row.org_id,
        orgName: row.org_name,
        branchIds: row.branch_ids,
        memberRole: row.member_role,
        ...(row.email !== null ? { email: row.email } : {}),
      },
      TTL_SECONDS,
    );

    return {
      token,
      expiresAt: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
      userId: row.user_id,
      email: row.email ?? email,
      orgId: row.org_id,
      orgName: row.org_name,
      branchIds: row.branch_ids,
      role: row.role,
      memberRole: row.member_role,
    };
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      /* connection already aborted */
    }
    throw error;
  } finally {
    client.release();
  }
}
