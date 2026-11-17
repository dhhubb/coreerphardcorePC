import type { PoolClient } from 'pg';

/**
 * The branch's device settings (F7): currently the optional camera toggle.
 *
 * A camera needs a secure context (HTTPS) and is optional, so the branch decides whether the till
 * offers it. The flag lives in the database (app.get/set_pos_device_settings) so every till in the
 * branch agrees, exactly like the printer setting next to it.
 */

export interface PosDeviceSettings {
  cameraEnabled: boolean;
}

/** The default device settings: the camera is off, so a till is keyboard-only until opted in. */
export function defaultDeviceSettings(): PosDeviceSettings {
  return { cameraEnabled: false };
}

interface DeviceSettingsRow {
  camera_enabled?: unknown;
}

function toDeviceSettings(row: DeviceSettingsRow | undefined): PosDeviceSettings {
  return { cameraEnabled: row?.camera_enabled === true };
}

/** Read the branch's device settings (through RLS). Falls back to the camera being off. */
export async function loadDeviceSettings(
  client: PoolClient,
  input: { orgId: string; branchId: string },
): Promise<PosDeviceSettings> {
  const result = await client.query<{ app: DeviceSettingsRow }>(
    `select app.get_pos_device_settings($1, $2) as app`,
    [input.orgId, input.branchId],
  );
  return toDeviceSettings(result.rows[0]?.app);
}

/** Save the branch's device settings. Returns the stored row. */
export async function saveDeviceSettings(
  client: PoolClient,
  input: { orgId: string; branchId: string; cameraEnabled: boolean },
): Promise<PosDeviceSettings> {
  const result = await client.query<{ app: DeviceSettingsRow }>(
    `select app.set_pos_device_settings($1, $2, $3) as app`,
    [input.orgId, input.branchId, input.cameraEnabled],
  );
  return toDeviceSettings(result.rows[0]?.app);
}
