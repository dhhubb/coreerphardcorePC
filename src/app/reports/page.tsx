'use client';

import { getToken } from '@/core/session';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * The reports page (/reports) — the owner console and the branch view in one.
 *
 * The figures come from the same endpoints on both sides, so the console shows the branch's synced
 * data. The page always shows when the branch last synced, so a stale figure is explained rather
 * than surprising (ADR-0049). Every list is a keyset page: the page asks for the next page with the
 * cursor the previous page returned, never an offset.
 */

interface ProductRow {
  product_id: string;
  qty: string;
  revenue: string;
  tax: string;
  cogs: string;
  profit: string;
}

interface VatRow {
  tax_rate: string;
  net: string;
  tax: string;
  gross: string;
  line_count: number;
}

interface FiscalTotals {
  count: number;
  amount: string;
}

interface ZReportRow {
  id: string;
  z_no: string;
  sale_count: number;
  void_count: number;
  gross_sales: string;
  tax_total: string;
  fiscal: { sent: FiscalTotals; pending: FiscalTotals; failed: FiscalTotals };
  created_at: string;
}

interface LastSync {
  branch_id: string;
  last_cloud_contact_at: string | null;
  last_ingest_at: string | null;
  outbox_size: number;
}

type Tab = 'profit' | 'best' | 'slow' | 'vat' | 'z';

function authHeaders(): HeadersInit {
  const token = getToken();
  return {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function money(value: string): string {
  return Number(value).toFixed(2);
}

function monthBounds(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export default function ReportsPage() {
  const defaults = useMemo(monthBounds, []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [tab, setTab] = useState<Tab>('profit');
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [vat, setVat] = useState<VatRow[]>([]);
  const [reports, setReports] = useState<ZReportRow[]>([]);
  const [cursor, setCursor] = useState<Record<string, string> | null>(null);
  const [sync, setSync] = useState<LastSync | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const period = useMemo(() => `from=${from}&to=${to}`, [from, to]);

  const loadSync = useCallback(async () => {
    try {
      const response = await fetch('/api/reports/last-sync', { headers: authHeaders() });
      if (response.ok) setSync((await response.json()) as LastSync);
    } catch {
      /* the sync label is best effort */
    }
  }, []);

  const endpoint = useCallback((which: Tab): string => {
    switch (which) {
      case 'profit':
        return '/api/reports/profit';
      case 'best':
        return '/api/reports/best-sellers';
      case 'slow':
        return '/api/reports/slow-movers';
      case 'vat':
        return '/api/reports/vat';
      case 'z':
        return '/api/reports/z-reports';
    }
  }, []);

  const load = useCallback(
    async (which: Tab, append: boolean, next: Record<string, string> | null) => {
      setBusy(true);
      try {
        const params = new URLSearchParams(period);
        if (next) for (const [key, value] of Object.entries(next)) params.set(key, value);
        const response = await fetch(`${endpoint(which)}?${params.toString()}`, {
          headers: authHeaders(),
        });
        if (!response.ok) {
          setError(`report request failed (${response.status})`);
          return;
        }
        const body = (await response.json()) as {
          rows: ProductRow[] | VatRow[] | ZReportRow[];
          next_cursor: Record<string, string> | null;
        };
        setError(null);
        setCursor(body.next_cursor ?? null);
        if (which === 'vat') {
          setVat(body.rows as VatRow[]);
        } else if (which === 'z') {
          const page = body.rows as ZReportRow[];
          setReports((current) => (append ? [...current, ...page] : page));
        } else {
          const page = body.rows as ProductRow[];
          setRows((current) => (append ? [...current, ...page] : page));
        }
      } catch {
        setError('the branch did not answer');
      } finally {
        setBusy(false);
      }
    },
    [endpoint, period],
  );

  useEffect(() => {
    void load(tab, false, null);
  }, [load, tab]);

  useEffect(() => {
    void loadSync();
    const timer = setInterval(() => void loadSync(), 30_000);
    return () => clearInterval(timer);
  }, [loadSync]);

  const productTable = (data: ProductRow[]) => (
    <table data-testid="report-rows">
      <thead>
        <tr>
          <th>Product</th>
          <th>Qty</th>
          <th>Revenue</th>
          <th>Tax</th>
          <th>COGS</th>
          <th>Profit</th>
        </tr>
      </thead>
      <tbody>
        {data.map((row) => (
          <tr key={row.product_id} data-testid="report-row">
            <td>{row.product_id.slice(0, 8)}</td>
            <td>{Number(row.qty).toFixed(2)}</td>
            <td>{money(row.revenue)}</td>
            <td>{money(row.tax)}</td>
            <td>{money(row.cogs)}</td>
            <td>{money(row.profit)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Reports</h1>

      <p data-testid="last-sync">
        {sync?.last_ingest_at
          ? `Last synced: ${new Date(sync.last_ingest_at).toLocaleString()}`
          : 'Last synced: never'}
        {sync ? ` · outbox ${sync.outbox_size}` : ''}
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <label>
          From{' '}
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>
          To <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
      </div>

      <nav style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['profit', 'best', 'slow', 'vat', 'z'] as Tab[]).map((name) => (
          <button
            key={name}
            type="button"
            data-testid={`tab-${name}`}
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
          >
            {name === 'profit'
              ? 'Profit by product'
              : name === 'best'
                ? 'Best sellers'
                : name === 'slow'
                  ? 'Slow movers'
                  : name === 'vat'
                    ? 'VAT (ZIMRA)'
                    : 'Z-reports'}
          </button>
        ))}
      </nav>

      {error && <p data-testid="report-error">{error}</p>}

      {(tab === 'profit' || tab === 'best' || tab === 'slow') && productTable(rows)}

      {tab === 'vat' && (
        <table data-testid="vat-rows">
          <thead>
            <tr>
              <th>Rate</th>
              <th>Net</th>
              <th>VAT</th>
              <th>Gross</th>
              <th>Lines</th>
            </tr>
          </thead>
          <tbody>
            {vat.map((row) => (
              <tr key={row.tax_rate} data-testid="vat-row">
                <td>{(Number(row.tax_rate) * 100).toFixed(2)}%</td>
                <td>{money(row.net)}</td>
                <td>{money(row.tax)}</td>
                <td>{money(row.gross)}</td>
                <td>{row.line_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === 'z' && (
        <table data-testid="z-rows">
          <thead>
            <tr>
              <th>Z no</th>
              <th>Sales</th>
              <th>Voids</th>
              <th>Gross</th>
              <th>VAT</th>
              <th>Fiscal sent</th>
              <th>Fiscal pending</th>
              <th>Fiscal failed</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((row) => (
              <tr key={row.id} data-testid="z-row">
                <td>{row.z_no}</td>
                <td>{row.sale_count}</td>
                <td>{row.void_count}</td>
                <td>{money(row.gross_sales)}</td>
                <td>{money(row.tax_total)}</td>
                <td data-testid="z-fiscal-sent">
                  {row.fiscal.sent.count} / {money(row.fiscal.sent.amount)}
                </td>
                <td data-testid="z-fiscal-pending">
                  {row.fiscal.pending.count} / {money(row.fiscal.pending.amount)}
                </td>
                <td data-testid="z-fiscal-failed">
                  {row.fiscal.failed.count} / {money(row.fiscal.failed.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {cursor && (
        <button
          type="button"
          data-testid="load-more"
          disabled={busy}
          onClick={() => void load(tab, true, cursor)}
        >
          Load more
        </button>
      )}
    </main>
  );
}
