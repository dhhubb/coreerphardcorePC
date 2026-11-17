'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { reportGet } from '@/verticals/reports/client';
import { syncAgeLabel } from '@/verticals/reports/reports';

/**
 * /cloud/reports — the owner console in the cloud.
 *
 * It reads the same /api/reports/* endpoints as the branch, so the figures come from the same SQL
 * functions and cannot drift (ADR-0049). The cloud holds what the branch has synced, so the page
 * always shows "Last sync: …" from `sync_state` (via /api/reports/last-sync), and every report link
 * carries the branch through. A stale figure is explained rather than surprising.
 */

interface LastSync {
  branch_id: string;
  last_cloud_contact_at: string | null;
  last_ingest_at: string | null;
  outbox_size: number;
}

export default function CloudReportsPage() {
  const [sync, setSync] = useState<LastSync | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSync(await reportGet<LastSync>('/api/reports/last-sync'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const label = syncAgeLabel(sync?.last_ingest_at ?? sync?.last_cloud_contact_at ?? null);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Owner console — reports</h1>
      <p data-testid="cloud-last-sync">{label}</p>
      {sync && <p data-testid="cloud-outbox">Outbox {sync.outbox_size}</p>}
      {error && <p data-testid="cloud-error">{error}</p>}

      <p style={{ maxWidth: 640 }}>
        These figures are the branch&apos;s synced data, read through the same endpoints the branch
        console uses. They are only as fresh as the last sync shown above.
      </p>

      <nav style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Link href="/reports/today" data-testid="cloud-link-today">
          Today
        </Link>
        <Link href="/reports/profit" data-testid="cloud-link-profit">
          Profit by product
        </Link>
        <Link href="/reports/vat" data-testid="cloud-link-vat">
          VAT (ZIMRA)
        </Link>
        <Link href="/reports/z" data-testid="cloud-link-z">
          Z-reports
        </Link>
      </nav>
    </main>
  );
}
