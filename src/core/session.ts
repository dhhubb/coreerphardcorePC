'use client';

/**
 * The browser session (F1).
 *
 * The token lives in localStorage under `token` and the org id under `org_id`, as the brief
 * specifies. Pages cannot read localStorage on the server, so the app shell gates navigation on the
 * client (it redirects to /login when there is no token) and every API call re-verifies the token
 * on the server. The legacy `pos_access_token` key is still read as a fallback so an existing
 * browser session keeps working.
 */

export const TOKEN_KEY = 'token';
export const ORG_ID_KEY = 'org_id';
export const LEGACY_TOKEN_KEY = 'pos_access_token';

export interface SessionClaims {
  sub: string;
  orgId: string | null;
  orgName: string | null;
  branchIds: string[];
  role: string;
  email?: string;
  exp: number | null;
}

/** Decode a JWT payload without verifying it. Display only: never trust it for a decision. */
export function decodeClaims(token: string): SessionClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    const raw = JSON.parse(json) as Record<string, unknown>;
    return {
      sub: typeof raw.sub === 'string' ? raw.sub : '',
      orgId: typeof raw.org_id === 'string' && raw.org_id !== '' ? raw.org_id : null,
      orgName: typeof raw.org_name === 'string' ? raw.org_name : null,
      branchIds: Array.isArray(raw.branch_ids)
        ? raw.branch_ids.filter((value): value is string => typeof value === 'string')
        : [],
      role: typeof raw.role === 'string' ? raw.role : 'authenticated',
      ...(typeof raw.email === 'string' ? { email: raw.email } : {}),
      exp: typeof raw.exp === 'number' ? raw.exp : null,
    };
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return (
    window.localStorage.getItem(TOKEN_KEY) ?? window.localStorage.getItem(LEGACY_TOKEN_KEY)
  );
}

export function getOrgId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ORG_ID_KEY);
}

export function currentClaims(): SessionClaims | null {
  const token = getToken();
  return token ? decodeClaims(token) : null;
}

/** Store a signed-in session under the brief's keys. */
export function setSession(token: string, orgId: string | null): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  if (orgId) window.localStorage.setItem(ORG_ID_KEY, orgId);
  else window.localStorage.removeItem(ORG_ID_KEY);
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(ORG_ID_KEY);
  window.localStorage.removeItem(LEGACY_TOKEN_KEY);
}

/** True when a token is present. Does not check the signature; the server does that. */
export function hasSession(): boolean {
  return getToken() !== null;
}
