'use client';

import { getToken } from '@/core/session';
import { useCallback, useEffect, useState } from 'react';

/**
 * The fiscal admin page (/settings/fiscal).
 *
 * It reads GET /api/fiscal/invoices for the queue (with counts by status) and offers a retry for
 * failed rows and a manual submit for pending or failed rows. Every action goes through a thin route
 * handler; the page never talks to the database itself.
 */

interface FiscalInvoice {
  id: string;
  invoice_id: string;
  invoice_no: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at: string;
}

interface QueuePayload {
  summary: { pending: number; sent: number; failed: number; total: number };
  invoices: FiscalInvoice[];
  next_cursor: { createdAt: string; id: string } | null;
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export default function FiscalSettingsPage() {
  const [queue, setQueue] = useState<QueuePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/fiscal/invoices', { headers: authHeaders() });
      if (!response.ok) {
        setError(`queue request failed (${response.status})`);
        return;
      }
      setQueue((await response.json()) as QueuePayload);
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

  const act = useCallback(
    async (id: string, action: 'retry' | 'send') => {
      setBusy(id);
      try {
        const response = await fetch(`/api/fiscal/invoices/${id}/${action}`, {
          method: 'POST',
          headers: authHeaders(),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `action failed (${response.status})`);
        } else {
          setError(null);
        }
        await load();
      } catch {
        setError('the branch did not answer');
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Fiscal invoices</h1>
      {error && <p data-testid="fiscal-error">{error}</p>}

      {queue && (
        <>
          <dl data-testid="fiscal-summary">
            <dt>Pending</dt>
            <dd data-testid="fiscal-pending-count">{queue.summary.pending}</dd>
            <dt>Sent</dt>
            <dd data-testid="fiscal-sent-count">{queue.summary.sent}</dd>
            <dt>Failed</dt>
            <dd data-testid="fiscal-failed-count">{queue.summary.failed}</dd>
          </dl>

          <table data-testid="fiscal-queue">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {queue.invoices.map((row) => (
                <tr key={row.id} data-testid="fiscal-row">
                  <td>{row.invoice_no}</td>
                  <td data-testid="fiscal-status">{row.status}</td>
                  <td>{row.attempts}</td>
                  <td>{row.last_error ?? '—'}</td>
                  <td>
                    {row.status === 'failed' && (
                      <button
                        type="button"
                        disabled={busy === row.id}
                        onClick={() => void act(row.id, 'retry')}
                      >
                        Retry
                      </button>
                    )}
                    {row.status !== 'sent' && (
                      <button
                        type="button"
                        disabled={busy === row.id}
                        onClick={() => void act(row.id, 'send')}
                      >
                        Submit now
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
