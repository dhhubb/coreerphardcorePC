import type { PoolClient } from 'pg';

/**
 * Device registration (decision 12).
 *
 * A till is registered with a one-time code. The code is created by an admin (in the cloud or on
 * the branch admin page), entered once on the till, and redeemed for a device token. Only the hash
 * of the code and the hash of the issued token are stored; the raw values exist only in the
 * response. This is the same pattern as an invite token (ADR-0024).
 */

/** Mint a one-time device registration code. Returns the raw code, which is shown once. */
export async function createDeviceRegistration(
  client: PoolClient,
  input: { orgId: string; branchId: string; tillId: string; ttlHours?: number },
): Promise<string> {
  const result = await client.query<{ app: string }>(
    'select app.create_device_registration($1, $2, $3, $4) as app',
    [input.orgId, input.branchId, input.tillId, input.ttlHours ?? 24],
  );
  return result.rows[0]!.app;
}

/** Redeem a one-time code for a device token. Single use; the code is consumed. */
export async function registerDevice(
  client: PoolClient,
  input: { orgId: string; branchId: string; code: string; label?: string | null },
): Promise<string> {
  const result = await client.query<{ app: string }>(
    'select app.register_device($1, $2, $3, $4) as app',
    [input.orgId, input.branchId, input.code, input.label ?? null],
  );
  return result.rows[0]!.app;
}

/** Verify a device token. Returns the registration id; raises when the token is invalid. */
export async function authenticateDevice(
  client: PoolClient,
  input: { orgId: string; branchId: string; token: string },
): Promise<string> {
  const result = await client.query<{ app: string }>(
    'select app.authenticate_device($1, $2, $3) as app',
    [input.orgId, input.branchId, input.token],
  );
  return result.rows[0]!.app;
}

/** Mint a 6-digit one-time code (10-minute default). The raw code is returned once. */
export async function createDeviceCode(
  client: PoolClient,
  input: { orgId: string; branchId: string; tillId: string; ttlMinutes?: number },
): Promise<string> {
  const result = await client.query<{ app: string }>(
    'select app.create_device_code($1, $2, $3, $4) as app',
    [input.orgId, input.branchId, input.tillId, input.ttlMinutes ?? 10],
  );
  return result.rows[0]!.app;
}

export interface DeviceRegistrationRow {
  id: string;
  till_id: string;
  label: string | null;
  code_expires_at: string;
  consumed_at: string | null;
  token_issued_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** A keyset page of a branch's registered devices, newest first. No hash is returned. */
export async function listDeviceRegistrations(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    limit?: number;
    afterCreatedAt?: string | null;
    afterId?: string | null;
  },
): Promise<DeviceRegistrationRow[]> {
  const result = await client.query<DeviceRegistrationRow>(
    `select id, till_id, label, code_expires_at, consumed_at, token_issued_at, revoked_at, created_at
       from app.list_device_registrations($1, $2, $3, $4, $5)`,
    [
      input.orgId,
      input.branchId,
      input.limit ?? 50,
      input.afterCreatedAt ?? null,
      input.afterId ?? null,
    ],
  );
  return result.rows;
}
