/**
 * Browser-side API access for the till.
 *
 * The till talks to the same thin route handlers as every other client, so it must present a user
 * access token. The token lives in localStorage (the real terminal is signed in by the cashier's
 * session); apiFetch attaches it and never uses the service role key.
 */

import { getToken } from '@/core/session';

export const POS_TOKEN_KEY = 'pos_access_token';

/**
 * The bearer token for a request. Since F1 the signed-in session lives under `token` (see
 * `src/core/session.ts`); `pos_access_token` is kept as a fallback so an older tab, or a test that
 * seeds a token directly, still works. Reads prefer the session key.
 */
export function posToken(): string | null {
  return getToken();
}

export function setPosToken(token: string): void {
  window.localStorage.setItem(POS_TOKEN_KEY, token);
}

/** fetch with the till's bearer token and JSON handling. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = posToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return fetch(path, { ...init, headers });
}

/** fetch and parse JSON, throwing on a non-2xx response. */
export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `${path} failed (${response.status})`);
  }
  return (await response.json()) as T;
}
