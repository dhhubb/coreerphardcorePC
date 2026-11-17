import type { PoolClient } from 'pg';
import {
  BRANCH_PROTOCOL_VERSION,
  branchMode,
  cloudUrl,
  isBranchMode,
  type BranchMode,
} from './config';
import { probeConfiguredCloud, type CloudStatus } from './connectivity';

/**
 * The branch health report.
 *
 * The till polls this instead of trusting `navigator.onLine` (decision: a LAN-up/internet-down
 * branch must still report the cloud as offline). The branch answers from its own state: it is up
 * (this response exists), its local database is reachable, and it reports what it last saw of the
 * cloud. A probe refreshes the cloud observation on demand.
 *
 * The endpoint is deliberately cheap and safe with no internet: the database check is a trivial
 * `select 1`, and the cloud probe has a short timeout and treats every failure as `offline`.
 */

export interface BranchHealth {
  mode: BranchMode;
  /** The branch process answered, so it is up. Always true in a 200 response. */
  branch_up: boolean;
  /** Alias the till polls on: the branch is reachable. Same value as branch_up. */
  branch_online: boolean;
  /** The local database answered `select 1`. */
  database_up: boolean;
  /** The branch's sync protocol version. */
  protocol_version: number;
  /** The configured cloud URL, or null when the branch has none. */
  cloud_url: string | null;
  /** What the branch currently believes about the cloud. */
  cloud_status: CloudStatus;
  /** Convenience flag the till badge reads: the cloud is reachable and version-compatible. */
  cloud_online: boolean;
  cloud_protocol_version: number | null;
  /** True when the branch must refuse to push (protocol mismatch, decision 17). */
  push_blocked: boolean;
  /** Unacked outbox events, or null when the caller is not scoped to a branch. */
  outbox_size: number | null;
}

/** Check the local database with a trivial query. */
export async function databaseUp(client: PoolClient): Promise<boolean> {
  try {
    await client.query('select 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the health report. When `probe` is true the branch reaches out to the cloud (short
 * timeout); otherwise it reports the last stored observation, so a poll never waits on the cloud.
 */
export async function branchHealth(
  client: PoolClient,
  options: { probe?: boolean; orgId?: string; branchId?: string } = {},
): Promise<BranchHealth> {
  const mode = branchMode();
  const url = cloudUrl();
  const dbUp = await databaseUp(client);

  let cloudStatus: CloudStatus = 'offline';
  let cloudVersion: number | null = null;
  let outboxSize: number | null = null;

  if (options.orgId && options.branchId) {
    const size = await client.query<{ app: string }>(
      'select app.sync_outbox_size($1, $2) as app',
      [options.orgId, options.branchId],
    );
    outboxSize = Number(size.rows[0]?.app ?? 0);
  }

  if (options.probe) {
    const result = await probeConfiguredCloud();
    cloudStatus = result.status;
    cloudVersion = result.cloudProtocolVersion;
    if (options.orgId && options.branchId) {
      await client.query('select app.record_cloud_contact($1, $2, $3, $4)', [
        options.orgId,
        options.branchId,
        cloudVersion,
        cloudStatus === 'online',
      ]);
    }
  } else if (options.orgId && options.branchId) {
    const stored = await client.query<{
      cloud_status: CloudStatus;
      cloud_protocol_version: number | null;
    }>(
      `select s ->> 'cloud_status' as cloud_status,
              (s ->> 'cloud_protocol_version')::int as cloud_protocol_version
         from (select app.branch_sync_state($1, $2) as s) t`,
      [options.orgId, options.branchId],
    );
    if (stored.rows[0]) {
      cloudStatus = stored.rows[0].cloud_status;
      cloudVersion = stored.rows[0].cloud_protocol_version;
    }
  }

  return {
    mode,
    branch_up: true,
    branch_online: true,
    database_up: dbUp,
    protocol_version: BRANCH_PROTOCOL_VERSION,
    cloud_url: url,
    cloud_status: cloudStatus,
    cloud_online: cloudStatus === 'online',
    cloud_protocol_version: cloudVersion,
    push_blocked: cloudStatus === 'incompatible',
    outbox_size: outboxSize,
  };
}

export { isBranchMode };
