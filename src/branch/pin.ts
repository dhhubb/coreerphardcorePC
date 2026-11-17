import type { PoolClient } from 'pg';

/**
 * Local cashier PIN sign-in (decision 12).
 *
 * A cashier signs in to the branch with a PIN and the branch verifies it locally, so sign-in works
 * with the internet off. The PIN is hashed with bcrypt in SQL; the plaintext never leaves the
 * request and is never stored. Five wrong attempts lock the PIN for a cooling-off window.
 *
 * A manager override is a separate manager PIN, verified the same way. This module is the thin
 * TypeScript wrapper over the SQL functions; all the logic (hashing, lockout, comparison) is in
 * `app.authenticate_cashier` and `app.manager_override`.
 */

export interface PinLoginResult {
  ok: boolean;
  locked: boolean;
  failedAttempts: number;
  lockedUntil: string | null;
  isManager: boolean;
}

interface RawPinResult {
  ok: boolean;
  locked: boolean;
  failed_attempts: number;
  locked_until?: string | null;
  is_manager: boolean;
}

function toPinResult(raw: RawPinResult): PinLoginResult {
  return {
    ok: raw.ok,
    locked: raw.locked,
    failedAttempts: raw.failed_attempts,
    lockedUntil: raw.locked_until ?? null,
    isManager: raw.is_manager,
  };
}

/** Store (or reset) a cashier PIN. The PIN is hashed in SQL; it is never stored in plaintext. */
export async function setCashierPin(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    cashierId: string;
    pin: string;
    isManager?: boolean;
  },
): Promise<string> {
  const result = await client.query<{ app: string }>(
    'select app.set_cashier_pin($1, $2, $3, $4, $5) as app',
    [input.orgId, input.branchId, input.cashierId, input.pin, input.isManager ?? false],
  );
  return result.rows[0]!.app;
}

/** Verify a cashier PIN locally. Never raises for a wrong PIN; the outcome is in the result. */
export async function authenticateCashier(
  client: PoolClient,
  input: { orgId: string; branchId: string; cashierId: string; pin: string },
): Promise<PinLoginResult> {
  const result = await client.query<{ app: RawPinResult }>(
    'select app.authenticate_cashier($1, $2, $3, $4) as app',
    [input.orgId, input.branchId, input.cashierId, input.pin],
  );
  return toPinResult(result.rows[0]!.app);
}

/** A manager override: true only when the PIN is correct and belongs to a manager. */
export async function managerOverride(
  client: PoolClient,
  input: { orgId: string; branchId: string; managerId: string; pin: string },
): Promise<boolean> {
  const result = await client.query<{ app: boolean }>(
    'select app.manager_override($1, $2, $3, $4) as app',
    [input.orgId, input.branchId, input.managerId, input.pin],
  );
  return result.rows[0]!.app;
}

export interface BranchCashierRow {
  cashier_id: string;
  label: string;
  is_manager: boolean;
  is_active: boolean;
  locked_until: string | null;
}

/**
 * The branch's cashiers for the PIN sign-in picker. No hash is returned; the label is the
 * cashier's email (or a short id when there is none).
 */
export async function listBranchCashiers(
  client: PoolClient,
  input: { orgId: string; branchId: string },
): Promise<BranchCashierRow[]> {
  const result = await client.query<BranchCashierRow>(
    'select cashier_id, label, is_manager, is_active, locked_until from app.list_branch_cashiers($1, $2)',
    [input.orgId, input.branchId],
  );
  return result.rows;
}
