import { createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import { authenticateCashier, type PinLoginResult } from './pin';

/**
 * The branch sign-in session.
 *
 * A successful PIN sign-in mints a branch access token with the same shape as a cloud token, so the
 * till presents it to the same route handlers and RLS still applies. The token is signed with the
 * same secret the branch uses to verify tokens, and it carries the branch's org and branch id, so a
 * cashier can only ever reach their own branch.
 *
 * There is no Supabase Auth in branch mode (decision 1): the PIN check above is the whole sign-in.
 */

export interface BranchSession {
  token: string;
  cashierId: string;
  orgId: string;
  branchId: string;
  isManager: boolean;
  expiresAt: string;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function jwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error('Missing required environment variable: SUPABASE_JWT_SECRET');
  return secret;
}

/** Mint an HS256 access token carrying the branch tenant claims. */
export function mintBranchToken(input: {
  cashierId: string;
  orgId: string;
  branchId: string;
  isManager: boolean;
  ttlSeconds?: number;
}): { token: string; expiresAt: string } {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 12 * 3600);
  const payload = base64Url(
    JSON.stringify({
      sub: input.cashierId,
      role: input.isManager ? 'manager' : 'authenticated',
      org_id: input.orgId,
      branch_ids: [input.branchId],
      // A manager PIN maps to the admin membership role for the nav; a cashier maps to member.
      // This is a display value only — RLS scopes by org_id and branch_ids, never by member_role.
      member_role: input.isManager ? 'admin' : 'member',
      exp,
    }),
  );
  const signature = createHmac('sha256', jwtSecret()).update(`${header}.${payload}`).digest();
  return {
    token: `${header}.${payload}.${base64Url(signature)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Sign a cashier in with a PIN. Verifies locally, then mints a branch token on success. A wrong PIN
 * or a lockout returns the outcome with no token; it never throws for a bad credential.
 */
export async function signInWithPin(
  client: PoolClient,
  input: { orgId: string; branchId: string; cashierId: string; pin: string },
): Promise<{ result: PinLoginResult; session: BranchSession | null }> {
  const result = await authenticateCashier(client, input);
  if (!result.ok) return { result, session: null };

  const { token, expiresAt } = mintBranchToken({
    cashierId: input.cashierId,
    orgId: input.orgId,
    branchId: input.branchId,
    isManager: result.isManager,
  });

  return {
    result,
    session: {
      token,
      cashierId: input.cashierId,
      orgId: input.orgId,
      branchId: input.branchId,
      isManager: result.isManager,
      expiresAt,
    },
  };
}
