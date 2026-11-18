import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from './db';

export interface AuthClaims {
  /** auth.users id */
  sub: string;
  /** Organisation the token is scoped to, or null when the user has no membership. */
  orgId: string | null;
  /** Organisation display name, carried for the shell header. Absent when unknown. */
  orgName?: string | null;
  /** Branches the token is scoped to. */
  branchIds: string[];
  /** The Postgres role the connection assumes (`authenticated`). Not a membership role. */
  role: string;
  /** The membership role (`owner`/`admin`/`member`), or null when the user has no membership. */
  memberRole?: string | null;
  email?: string;
}

interface RawJwtPayload {
  sub?: unknown;
  role?: unknown;
  email?: unknown;
  org_id?: unknown;
  org_name?: unknown;
  branch_ids?: unknown;
  member_role?: unknown;
  exp?: unknown;
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function jwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error('Missing required environment variable: SUPABASE_JWT_SECRET');
  }
  return secret;
}

/**
 * Verify an HS256 Supabase access token and extract the tenant claims.
 * A bad signature, a missing subject, or an expired token is rejected.
 */
export function verifyAccessToken(token: string): AuthClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed access token');
  }
  const [header, payload, signature] = parts as [string, string, string];

  const expected = createHmac('sha256', jwtSecret()).update(`${header}.${payload}`).digest();
  const actual = base64UrlDecode(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('invalid access token signature');
  }

  const decoded = JSON.parse(base64UrlDecode(payload).toString('utf8')) as RawJwtPayload;

  if (typeof decoded.exp === 'number' && decoded.exp * 1000 <= Date.now()) {
    throw new Error('access token has expired');
  }
  if (typeof decoded.sub !== 'string' || decoded.sub === '') {
    throw new Error('access token has no subject');
  }

  const branchIds = Array.isArray(decoded.branch_ids)
    ? decoded.branch_ids.filter((value): value is string => typeof value === 'string')
    : [];

  return {
    sub: decoded.sub,
    orgId: typeof decoded.org_id === 'string' && decoded.org_id !== '' ? decoded.org_id : null,
    ...(typeof decoded.org_name === 'string' && decoded.org_name !== ''
      ? { orgName: decoded.org_name }
      : {}),
    branchIds,
    role: typeof decoded.role === 'string' ? decoded.role : 'authenticated',
    memberRole: typeof decoded.member_role === 'string' ? decoded.member_role : null,
    ...(typeof decoded.email === 'string' ? { email: decoded.email } : {}),
  };
}

export function claimsFromAuthorizationHeader(header: string | null): AuthClaims {
  if (!header || !header.startsWith('Bearer ')) {
    throw new Error('missing bearer token');
  }
  return verifyAccessToken(header.slice('Bearer '.length));
}

/** Claims serialised the way Postgres reads them from request.jwt.claims. */
export function claimsToRequestSetting(claims: AuthClaims): string {
  return JSON.stringify({
    sub: claims.sub,
    role: claims.role,
    ...(claims.email !== undefined ? { email: claims.email } : {}),
    ...(claims.orgName !== undefined && claims.orgName !== null ? { org_name: claims.orgName } : {}),
    org_id: claims.orgId,
    branch_ids: claims.branchIds,
    ...(claims.memberRole !== undefined ? { member_role: claims.memberRole } : {}),
  });
}

/**
 * Apply a user's tenant context to an open transaction. Every request path runs inside this:
 * the connection drops into the `authenticated` role and RLS policies see the JWT claims.
 */
export async function applyUserContext(client: PoolClient, claims: AuthClaims): Promise<void> {
  await client.query('set local role authenticated');
  await client.query('select set_config($1, $2, true)', [
    'request.jwt.claims',
    claimsToRequestSetting(claims),
  ]);
}

/**
 * Run fn inside a transaction as the given user. This is how route handlers talk to the
 * database: no service role, no RLS bypass.
 */
export async function withUserContext<T>(
  claims: AuthClaims,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await applyUserContext(client, claims);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Mint an HS256 access token carrying the tenant claims, in the exact shape the Supabase custom
 * access token hook produces. The login route uses this so a token from `/api/auth/login` is
 * indistinguishable to every RLS policy from one Supabase Auth issued.
 */
export function mintAccessToken(
  claims: {
    sub: string;
    orgId: string | null;
    branchIds: string[];
    orgName?: string | null;
    email?: string;
    role?: string;
    memberRole?: string | null;
  },
  ttlSeconds = 12 * 3600,
): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      sub: claims.sub,
      role: claims.role ?? 'authenticated',
      ...(claims.email !== undefined ? { email: claims.email } : {}),
      ...(claims.orgName !== undefined && claims.orgName !== null ? { org_name: claims.orgName } : {}),
      org_id: claims.orgId,
      branch_ids: claims.branchIds,
      member_role: claims.memberRole ?? null,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  );
  const signature = createHmac('sha256', jwtSecret()).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64Url(signature)}`;
}
