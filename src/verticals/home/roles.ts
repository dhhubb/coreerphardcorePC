/**
 * Membership roles and the navigation model (F10).
 *
 * `member_role` is a display value carried in the token by the access token hook and by
 * `app.login_context`. It decides which menu items and shortcuts the home page shows; it is never an
 * authorisation decision — RLS still scopes every row by `org_id` and `branch_ids`, so a stale or
 * forged role can only change what is *offered*, never what is *readable* (ADR-0077).
 *
 * Everything here is a pure function so it can be unit-tested without a browser.
 */

export type MemberRole = 'owner' | 'admin' | 'member';

const ROLE_RANK: Record<MemberRole, number> = { member: 0, admin: 1, owner: 2 };

/** Coerce a claim (or an absent one) to a known role. Anything unknown is the least privileged. */
export function normalizeRole(value: string | null | undefined): MemberRole {
  return value === 'owner' || value === 'admin' ? value : 'member';
}

export function roleLabel(role: MemberRole): string {
  return role === 'owner' ? 'Owner' : role === 'admin' ? 'Administrator' : 'Member';
}

/** True when `role` is at least `minimum` in the rank order member < admin < owner. */
export function hasRole(role: MemberRole, minimum: MemberRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
