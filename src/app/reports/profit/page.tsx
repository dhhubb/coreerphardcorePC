'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { reportGet, withCursor } from '@/verticals/reports/client';
import { ReportsNav } from '@/verticals/reports/ReportsNav';

/**
 * /reports/profit — profit by product for a period, with the best-sellers and slow-movers lists.
 *
 * The figures come from /api/reports/profit (closed days from the immutable daily facts, today
 * live), /api/reports/best-sellers (order by quantity DESC) and /api/reports/slow-movers (quantity
 * ASC). Every list is a keyset page: the page asks for the next page with the cursor the previous
 * page returned, never an offset (ADR-0045).
 */

interface ProductRow {
  product_id: string;
  qty: string;
  revenue: string;
  tax: string;
  cogs: string;
  profit: string;
}

type Mode = 'profit' | 'best' | 'slow';

const ENDPOINT: Record<Mode, string> = {
  profit: '/api/reports/profit',
  best: '/api/reports/best-sellers',
  slow: '/api/reports/slow-movers',
};

function money(value: string): string {
  return Number(value).toFixed(2);
}

function monthBounds(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export default function ProfitReportPage() {
  const defaults = useMemo(monthBounds, []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [mode, setMode] = useState<Mode>('profit');
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [cursor, setCursor] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (which: Mode, append: boolean, next: Record<string, string> | null) => {
      setBusy(true);
      try {
        const params = withCursor(new URLSearchParams({ from, to }), next);
        const body = await reportGet<{
          rows: ProductRow[];
          next_cursor: Record<string, string> | null;
        }>(`${ENDPOINT[which]}?${params.toString()}`);
        setError(null);
        setCursor(body.next_cursor ?? null);
        setRows((current) => (append ? [...current, ...body.rows] : body.rows));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [from, to],
  );

  useEffect(() => {
    void load(mode, false, null);
  }, [load, mode]);

  const totals = useMemo(() => {
    let revenue = 0;
    let cogs = 0;
    for (const row of rows) {
      revenue += Number(row.revenue);
      cogs += Number(row.cogs);
    }
    return { revenue, cogs, profit: revenue - cogs };
  }, [rows]);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Profit by product</h1>
      <ReportsNav current="/reports/profit" />

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <label>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      <nav style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['profit', 'best', 'slow'] as Mode[]).map((name) => (
          <button
            key={name}
            type="button"
            data-testid={`profit-tab-${name}`}
            aria-pressed={mode === name}
            onClick={() => setMode(name)}
          >
            {name === 'profit' ? 'Profit' : name === 'best' ? 'Best sellers' : 'Slow movers'}
          </button>
        ))}
      </nav>

      {error && <p data-testid="profit-error">{error}</p>}

      <p data-testid="profit-totals">
        Revenue {totals.revenue.toFixed(2)} · COGS {totals.cogs.toFixed(2)} · Profit{' '}
        {totals.profit.toFixed(2)}
      </p>

      <table data-testid="profit-rows">
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
          {rows.map((row) => (
            <tr key={row.product_id} data-testid="profit-row">
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

      {cursor && (
        <button
          type="button"
          data-testid="profit-load-more"
          disabled={busy}
          onClick={() => void load(mode, true, cursor)}
        >
          Load more
        </button>
      )}
    </main>
  );
}
