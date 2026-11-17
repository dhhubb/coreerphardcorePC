'use client';

import { getToken } from '@/core/session';

/**
 * The browser-side report client. Thin: it calls the route handlers, never the database, and it is
 * the same client on the branch and in the cloud, so the two consoles read the same endpoints and
 * show the same figures (ADR-0049).
 *
 * Every list is a keyset page: the caller passes the cursor the previous page returned, never an
 * offset.
 */

export class ReportApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ReportApiError';
  }
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export async function reportGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: authHeaders() });
  const text = await response.text();
  const payload = text === '' ? null : (JSON.parse(text) as unknown);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `request failed with status ${response.status}`;
    throw new ReportApiError(response.status, message);
  }
  return payload as T;
}

/** Append a cursor object to a query string, skipping null/undefined values. */
export function withCursor(
  params: URLSearchParams,
  cursor: Record<string, string> | null,
): URLSearchParams {
  if (cursor) {
    for (const [key, value] of Object.entries(cursor)) {
      if (value !== null && value !== undefined) params.set(key, value);
    }
  }
  return params;
}
