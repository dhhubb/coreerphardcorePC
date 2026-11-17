'use client';

/**
 * The branch console's data access, called from /settings/devices, /pos/register and /login.
 *
 * Thin: it calls the route handlers, never the database. The device and cashier endpoints are
 * deliberately unauthenticated (a till has no token before it registers or signs in), so this
 * client sends no bearer token on those. The branch derives the scope from its own environment.
 */

export class BranchApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'BranchApiError';
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(path, init);
  const text = await response.text();
  const payload = text === '' ? null : (JSON.parse(text) as unknown);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `request failed with status ${response.status}`;
    throw new BranchApiError(response.status, message);
  }
  return payload as T;
}

export interface BranchConfig {
  mode: 'cloud' | 'branch';
  branch_mode: boolean;
  pin_login: boolean;
  protocol_version: number;
  org_id: string | null;
  branch_id: string | null;
}

/** Whether this deployment signs in with a PIN (branch mode) or email/password (cloud mode). */
export function branchConfig(): Promise<BranchConfig> {
  return request<BranchConfig>('GET', '/api/branch/config');
}

export interface DeviceRow {
  id: string;
  till_id: string;
  label: string | null;
  code_expires_at: string;
  consumed_at: string | null;
  token_issued_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** A keyset page of the branch's registered devices. */
export async function listDevices(): Promise<DeviceRow[]> {
  const payload = await request<{ devices: DeviceRow[] }>('GET', '/api/branch/devices');
  return payload.devices;
}

/** Mint a 6-digit one-time code for a till. The raw code is returned once. */
export async function createDeviceCode(input: {
  tillId: string;
  ttlMinutes?: number;
}): Promise<{ code: string; expires_in_minutes: number }> {
  return request<{ code: string; expires_in_minutes: number }>('POST', '/api/branch/devices', {
    action: 'create_code',
    till_id: input.tillId,
    ...(input.ttlMinutes !== undefined ? { ttl_minutes: input.ttlMinutes } : {}),
  });
}

/** Redeem a one-time code for a device token. Single use. */
export async function registerDeviceWithCode(input: {
  code: string;
  label?: string | null;
}): Promise<{ token: string }> {
  return request<{ token: string }>('POST', '/api/branch/devices', {
    action: 'register',
    code: input.code,
    label: input.label ?? null,
  });
}

export interface CashierRow {
  cashier_id: string;
  label: string;
  is_manager: boolean;
  is_active: boolean;
  locked_until: string | null;
}

/** The branch's cashiers, for the PIN sign-in picker. */
export async function listCashiers(): Promise<CashierRow[]> {
  const payload = await request<{ cashiers: CashierRow[] }>('GET', '/api/branch/cashiers');
  return payload.cashiers;
}

export interface PinLoginResponse {
  ok: boolean;
  locked: boolean;
  failed_attempts: number;
  locked_until: string | null;
  is_manager: boolean;
  token: string | null;
  expires_at: string | null;
}

/** Sign a cashier in with a PIN. The branch verifies it locally, so this needs no internet. */
export function pinLogin(input: {
  cashierId: string;
  pin: string;
  orgId?: string | null;
  branchId?: string | null;
}): Promise<PinLoginResponse> {
  return request<PinLoginResponse>('POST', '/api/branch/login', {
    cashier_id: input.cashierId,
    pin: input.pin,
    ...(input.orgId ? { org_id: input.orgId } : {}),
    ...(input.branchId ? { branch_id: input.branchId } : {}),
  });
}
