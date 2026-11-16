'use client';

import { getToken } from '@/core/session';
import { useCallback, useEffect, useState } from 'react';

/**
 * The branch sync status page (/branch/sync).
 *
 * It reads GET /api/branch/sync/status, which answers from the branch's own database, so the page
 * works with the cloud offline. It shows the outbox depth, the last push and pull, the cloud
 * observation, and any conflicts the cloud really rejected (newest first).
 */

interface ConflictRow {
  id: string;
  event_id: string;
  branch_seq: string | null;
  event_type: string | null;
  reason: string;
  created_at: string;
}

interface StatusPayload {
  mode: string;
  protocol_version: number;
  last_pushed_seq: string;
  last_pulled_cursor: string | null;
  cloud_status: 'unknown' | 'online' | 'offline' | 'incompatible';
  cloud_protocol_version: number | null;
  push_blocked: boolean;
  outbox_size: number;
  outbox_max_seq: string;
  conflicts: number;
  last_push_at: string | null;
  last_pull_at: string | null;
  recent_conflicts: ConflictRow[];
}

export default function BranchSyncPage() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = getToken();
    try {
      const response = await fetch('/api/branch/sync/status', {
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) {
        setError(`status request failed (${response.status})`);
        return;
      }
      setStatus((await response.json()) as StatusPayload);
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

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Branch sync</h1>
      {error && <p data-testid="sync-error">{error}</p>}
      {status && (
        <>
          <dl data-testid="sync-summary">
            <dt>Cloud</dt>
            <dd data-testid="cloud-status">{status.cloud_status}</dd>
            <dt>Outbox pending</dt>
            <dd data-testid="outbox-size">{status.outbox_size}</dd>
            <dt>Last pushed seq</dt>
            <dd>{status.last_pushed_seq}</dd>
            <dt>Last pulled cursor</dt>
            <dd>{status.last_pulled_cursor ?? '—'}</dd>
            <dt>Conflicts</dt>
            <dd data-testid="conflict-count">{status.conflicts}</dd>
          </dl>
          {status.push_blocked && (
            <p data-testid="push-blocked">
              Push is blocked: the cloud runs an incompatible protocol version.
            </p>
          )}
          <h2>Recent conflicts</h2>
          <table data-testid="conflicts">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {status.recent_conflicts.map((row) => (
                <tr key={row.id} data-testid="conflict-row">
                  <td>{row.created_at}</td>
                  <td>{row.event_type ?? '—'}</td>
                  <td>{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
