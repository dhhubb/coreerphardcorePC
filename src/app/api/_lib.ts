import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { claimsFromAuthorizationHeader, withUserContext, type AuthClaims } from '@/core/auth';
import { DEFAULT_PAGE_LIMIT } from '@/core/sales';

/** A request-path error: never leaks SQL detail to the client. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A rate-limited request. Carries Retry-After so the client knows when to try again. */
export class RateLimitedError extends Error {
  readonly status = 429;
  readonly retryAfter: number;

  constructor(retryAfter: number, message = 'too many sales in one minute') {
    super(message);
    this.retryAfter = retryAfter;
  }
}

export function jsonError(status: number, message: string, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error: message }, { status, ...(headers ? { headers } : {}) });
}

/**
 * Resolve the caller's tenant claims from the Authorization header and run fn inside a
 * transaction as that user. Request paths never use the service role key.
 */
export async function withAuth<T>(
  request: Request,
  fn: (ctx: { client: PoolClient; claims: AuthClaims }) => Promise<T>,
): Promise<NextResponse> {
  try {
    const claims = claimsFromAuthorizationHeader(request.headers.get('authorization'));
    const result = await withUserContext(claims, (client) => fn({ client, claims }));
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RateLimitedError) {
    return jsonError(429, error.message, { 'retry-after': String(error.retryAfter) });
  }
  if (error instanceof ApiError) {
    return jsonError(error.status, error.message);
  }
  const message = (error as Error).message ?? 'internal error';
  if (
    /missing bearer token|invalid access token|malformed access token|expired|has no subject/.test(
      message,
    )
  ) {
    return jsonError(401, 'unauthorized');
  }
  // A SQL guard raised an exception (e.g. insufficient stock, limit out of range).
  if (
    /insufficient stock|must be between|exceeds open balance|is closed|append-only|credit limit exceeded|exceeds the .* sold|is not open|is already closed|cancellation fee|deposit|does not equal credits/i.test(
      message,
    )
  ) {
    return jsonError(422, message);
  }
  return jsonError(500, 'internal error');
}

export function parseLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get('limit');
  if (raw === null) return DEFAULT_PAGE_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 100) {
    throw new ApiError(422, 'limit must be between 1 and 100');
  }
  return value;
}

export function parseCursor(searchParams: URLSearchParams): { createdAt: string; id: string } | null {
  const createdAt = searchParams.get('after_created_at');
  const id = searchParams.get('after_id');
  if (!createdAt || !id) return null;
  return { createdAt, id };
}
