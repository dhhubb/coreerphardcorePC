/**
 * The sync status page's data, read from app.sync_status.
 *
 * The status page shows the outbox depth, the last push and pull, and any conflicts the cloud
 * really rejected. It reads from the branch's own database, so it answers with the cloud offline.
 */

import type { PoolClient } from 'pg';

export interface SyncStatus {
  protocol_version: number;
  last_pushed_seq: string;
  last_pulled_cursor: string | null;
  cloud_status: 'unknown' | 'online' | 'offline' | 'incompatible';
  cloud_protocol_version: number | null;
  push_blocked: boolean;
  outbox_size: number;
  /** F5: the outbox depth, named the way the brief names it. Same value as outbox_size. */
  pending_count: number;
  outbox_max_seq: string;
  conflicts: number;
  last_push_at: string | null;
  last_pull_at: string | null;
  /** F5: when the branch last uploaded a backup, or null when it never has. */
  last_backup_at: string | null;
}

/** Read the status report. */
export async function syncStatus(
  client: PoolClient,
  orgId: string,
  branchId: string,
): Promise<SyncStatus> {
  const result = await client.query<{ status: SyncStatus }>(
    'select app.sync_status($1, $2) as status',
    [orgId, branchId],
  );
  return result.rows[0]!.status;
}

export interface SyncConflictRow {
  id: string;
  event_id: string;
  branch_seq: string | null;
  event_type: string | null;
  reason: string;
  /** F5: { local, cloud } — what the branch sent and what the cloud said. */
  both_versions: { local?: unknown; cloud?: unknown };
  created_at: string;
}

/** The recent conflicts, newest first, for the status page. Keyset on (created_at, id). */
export async function recentConflicts(
  client: PoolClient,
  orgId: string,
  branchId: string,
  limit = 50,
): Promise<SyncConflictRow[]> {
  const result = await client.query<SyncConflictRow>(
    `select id, event_id, branch_seq, event_type, reason, both_versions, created_at
       from public.sync_conflicts
      where org_id = $1 and branch_id = $2
      order by created_at desc, id desc
      limit $3`,
    [orgId, branchId, Math.min(Math.max(limit, 1), 100)],
  );
  return result.rows;
}

/** Re-queue a conflicted event as a fresh outbox event so the branch tries it again. */
export async function requeueConflict(
  client: PoolClient,
  orgId: string,
  conflictId: string,
): Promise<string> {
  const result = await client.query<{ app: string }>(
    'select app.sync_requeue_conflict($1, $2) as app',
    [orgId, conflictId],
  );
  return result.rows[0]!.app;
}

export interface BackupRow {
  id: string;
  status: 'running' | 'uploaded' | 'failed';
  object_key: string | null;
  byte_size: string | null;
  checksum: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/** The recent backups, newest first. Keyset on (created_at, id). */
export async function recentBackups(
  client: PoolClient,
  orgId: string,
  branchId: string,
  limit = 20,
): Promise<BackupRow[]> {
  const result = await client.query<BackupRow>(
    `select id, status, object_key, byte_size, checksum, error, created_at, finished_at
       from public.sync_backups
      where org_id = $1 and branch_id = $2
      order by created_at desc, id desc
      limit $3`,
    [orgId, branchId, Math.min(Math.max(limit, 1), 100)],
  );
  return result.rows;
}

export interface RecordBackupInput {
  orgId: string;
  branchId: string;
  status: 'running' | 'uploaded' | 'failed';
  objectKey?: string | null;
  byteSize?: number | null;
  checksum?: string | null;
  error?: string | null;
}

/** Record a backup run. The cloud ingest endpoint and the branch both call this. */
export async function recordBackup(
  client: PoolClient,
  input: RecordBackupInput,
): Promise<string> {
  const result = await client.query<{ app: string }>(
    'select app.record_sync_backup($1, $2, $3, $4, $5, $6, $7) as app',
    [
      input.orgId,
      input.branchId,
      input.status,
      input.objectKey ?? null,
      input.byteSize ?? null,
      input.checksum ?? null,
      input.error ?? null,
    ],
  );
  return result.rows[0]!.app;
}
