'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPost } from '@/verticals/admin/client';
import { OpsNav } from '@/verticals/admin/OpsNav';

/**
 * /admin/sync — the sync console.
 *
 * One screen for the branch/cloud sync engine: the outbox depth, the last push and pull, the last
 * backup, the cloud's protocol version, and the conflicts the cloud really rejected. Each conflict
 * shows BOTH versions (what the branch sent and what the cloud answered) and carries a Retry button
 * that re-queues the local event.
 *
 * The status is read from the branch's own database (GET /api/branch/sync/status), so the page
 * answers with the cloud offline — which is exactly when an operator needs it. The cloud protocol
 * banner explains a blocked push.
 */

interface StatusPayload {
  protocol_version: number;
  last_pushed_seq: string;
  last_pulled_cursor: string | null;
  cloud_status: 'unknown' | 'online' | 'offline' | 'incompatible';
  cloud_protocol_version: number | null;
  push_blocked: boolean;
  outbox_size: number;
  pending_count: number;
  conflicts: number;
  last_push_at: string | null;
  last_pull_at: string | null;
  last_backup_at: string | null;
  recent_conflicts: ConflictRow[];
}

interface ConflictRow {
  id: string;
  event_id: string;
  branch_seq: string | null;
  event_type: string | null;
  reason: string;
  both_versions: { local?: unknown; cloud?: unknown };
  created_at: string;
}

function summarise(value: unknown): string {
  if (value === undefined || value === null) return '—';
  try {
    const text = JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  } catch {
    return String(value);
  }
}

export default function SyncPage() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await adminGet<StatusPayload>('/api/branch/sync/status');
      setStatus(payload);
      setError(null);
    } catch {
      setError('the branch did not answer');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const retry = useCallback(
    async (conflictId: string) => {
      setBusy(conflictId);
      setNotice(null);
      try {
        await adminPost('/api/sync/conflicts', { conflict_id: conflictId });
        setNotice('re-queued: the branch will push the event again');
        await load();
      } catch {
        setError('could not re-queue the conflict');
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Sync</h1>
      <OpsNav current="/admin/sync" />
      {error && <p data-testid="sync-error">{error}</p>}
      {notice && <p data-testid="sync-notice">{notice}</p>}

      {status?.push_blocked && (
        <p
          data-testid="protocol-banner"
          style={{ background: '#fff4e5', border: '1px solid #f0b429', padding: 8 }}
        >
          Push is blocked: this branch speaks sync protocol {status.protocol_version}, the cloud
          speaks {status.cloud_protocol_version ?? 'an unknown version'}. Update the branch before it
          can push.
        </p>
      )}

      {status && (
        <>
          <dl data-testid="sync-summary">
            <dt>Cloud</dt>
            <dd data-testid="cloud-status">{status.cloud_status}</dd>
            <dt>Protocol</dt>
            <dd data-testid="protocol-version">
              {status.protocol_version} / cloud {status.cloud_protocol_version ?? '—'}
            </dd>
            <dt>Outbox pending</dt>
            <dd data-testid="pending-count">{status.pending_count}</dd>
            <dt>Last pushed seq</dt>
            <dd data-testid="last-pushed">{status.last_pushed_seq}</dd>
            <dt>Last pulled cursor</dt>
            <dd data-testid="last-pulled">{status.last_pulled_cursor ?? '—'}</dd>
            <dt>Last push at</dt>
            <dd data-testid="last-push-at">{status.last_push_at ?? '—'}</dd>
            <dt>Last pull at</dt>
            <dd data-testid="last-pull-at">{status.last_pull_at ?? '—'}</dd>
            <dt>Last backup</dt>
            <dd data-testid="last-backup-at">{status.last_backup_at ?? 'never'}</dd>
            <dt>Conflicts</dt>
            <dd data-testid="conflict-count">{status.conflicts}</dd>
          </dl>

          <h2>Conflicts</h2>
          {status.recent_conflicts.length === 0 ? (
            <p data-testid="no-conflicts">No conflicts.</p>
          ) : (
            <table data-testid="conflicts">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Reason</th>
                  <th>Branch version</th>
                  <th>Cloud version</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {status.recent_conflicts.map((row) => (
                  <tr key={row.id} data-testid="conflict-row">
                    <td>{row.created_at}</td>
                    <td>{row.event_type ?? '—'}</td>
                    <td>{row.reason}</td>
                    <td data-testid="conflict-local">{summarise(row.both_versions?.local)}</td>
                    <td data-testid="conflict-cloud">{summarise(row.both_versions?.cloud)}</td>
                    <td>
                      <button
                        type="button"
                        data-testid={`retry-${row.id}`}
                        disabled={busy === row.id}
                        onClick={() => void retry(row.id)}
                      >
                        {busy === row.id ? 'Retrying…' : 'Retry'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}
