'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getToken } from '@/core/session';
import { reportGet, withCursor } from '@/verticals/reports/client';
import { ReportsNav } from '@/verticals/reports/ReportsNav';

/**
 * /reports/stock — the stock reports (F10).
 *
 * Two modes: on-hand (quantity and value per warehouse/product/variant, from the stock_balances
 * cache) and movements (the append-only stock_ledger for a period). Both are keyset pages on
 * (created_at, id) — the page asks for the next page with the cursor the previous page returned,
 * never an offset.
 *
 * "Export PDF" downloads the same report through /api/reports/stock/export, which renders the rows
 * with the dependency-free PDF writer. The token is sent as a bearer header, so the export reads
 * under the same RLS scope as the screen.
 */

type Mode = 'on_hand' | 'movements';

interface OnHandRow {
  id: string;
  warehouse_code: string;
  sku: string;
  name: string;
  qty: string;
  unit_cost: string;
  value: string;
  created_at: string;
}

interface MovementRow {
  id: string;
  warehouse_code: string;
  sku: string;
  name: string;
  direction: 'in' | 'out';
  qty: string;
  unit_cost: string;
  source_type: string;
  created_at: string;
}

interface StockPayload {
  mode: Mode;
  branch_id: string;
  rows: Array<Record<string, unknown>>;
  next_cursor: Record<string, string> | null;
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

export default function StockReportPage() {
  const defaults = useMemo(monthBounds, []);
  const [mode, setMode] = useState<Mode>('on_hand');
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [cursor, setCursor] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const params = useCallback(
    (extra?: Record<string, string>): URLSearchParams => {
      const search = new URLSearchParams({ mode, limit: '50' });
      if (mode === 'movements') {
        search.set('from', from);
        search.set('to', to);
      }
      if (query.trim()) search.set('q', query.trim());
      if (extra) for (const [key, value] of Object.entries(extra)) search.set(key, value);
      return search;
    },
    [mode, from, to, query],
  );

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const body = await reportGet<StockPayload>(`/api/reports/stock?${params().toString()}`);
      setRows(body.rows);
      setCursor(body.next_cursor);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [params]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const body = await reportGet<StockPayload>(
        `/api/reports/stock?${withCursor(params(), cursor).toString()}`,
      );
      setRows((current) => [...current, ...body.rows]);
      setCursor(body.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const exportPdf = async () => {
    try {
      const token = getToken();
      const response = await fetch(`/api/reports/stock/export?${params().toString()}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        setError(`export failed (${response.status})`);
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `stock-${mode === 'movements' ? 'movements' : 'on-hand'}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('could not reach the server');
    }
  };

  const cell: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #eef1f4' };

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Stock reports</h1>
      <ReportsNav current="/reports/stock" />

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          Report
          <select
            data-testid="stock-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as Mode)}
          >
            <option value="on_hand">On hand</option>
            <option value="movements">Movements</option>
          </select>
        </label>

        {mode === 'movements' && (
          <>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              From
              <input
                data-testid="stock-from"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              To
              <input
                data-testid="stock-to"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
          </>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          Search
          <input
            data-testid="stock-query"
            type="search"
            placeholder="SKU or name"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <button type="button" data-testid="stock-export-pdf" onClick={exportPdf}>
          Export PDF
        </button>
      </div>

      {error && (
        <p role="alert" data-testid="stock-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}

      <table data-testid="stock-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left' }}>SKU</th>
            <th style={{ ...cell, textAlign: 'left' }}>Name</th>
            <th style={{ ...cell, textAlign: 'left' }}>Warehouse</th>
            {mode === 'movements' ? (
              <>
                <th style={{ ...cell, textAlign: 'left' }}>Date</th>
                <th style={{ ...cell, textAlign: 'right' }}>In</th>
                <th style={{ ...cell, textAlign: 'right' }}>Out</th>
                <th style={{ ...cell, textAlign: 'left' }}>Source</th>
              </>
            ) : (
              <>
                <th style={{ ...cell, textAlign: 'right' }}>Qty</th>
                <th style={{ ...cell, textAlign: 'right' }}>Unit cost</th>
                <th style={{ ...cell, textAlign: 'right' }}>Value</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const id = String(row['id'] ?? index);
            if (mode === 'movements') {
              const movement = row as unknown as MovementRow;
              return (
                <tr key={id} data-testid={`stock-row-${id}`}>
                  <td style={cell}>{movement.sku}</td>
                  <td style={cell}>{movement.name}</td>
                  <td style={cell}>{movement.warehouse_code}</td>
                  <td style={cell}>{movement.created_at.slice(0, 16).replace('T', ' ')}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    {movement.direction === 'in' ? money(movement.qty) : ''}
                  </td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    {movement.direction === 'out' ? money(movement.qty) : ''}
                  </td>
                  <td style={cell}>{movement.source_type}</td>
                </tr>
              );
            }
            const onHand = row as unknown as OnHandRow;
            return (
              <tr key={id} data-testid={`stock-row-${id}`}>
                <td style={cell}>{onHand.sku}</td>
                <td style={cell}>{onHand.name}</td>
                <td style={cell}>{onHand.warehouse_code}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{money(onHand.qty)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{money(onHand.unit_cost)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{money(onHand.value)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {rows.length === 0 && !busy && <p style={{ color: '#5b6472' }}>No stock rows for this view.</p>}

      {cursor && (
        <button
          type="button"
          data-testid="stock-more"
          onClick={loadMore}
          disabled={busy}
          style={{ marginTop: 12 }}
        >
          {busy ? 'Loading…' : 'Load more'}
        </button>
      )}
    </main>
  );
}
