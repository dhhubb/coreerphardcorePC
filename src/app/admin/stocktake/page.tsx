'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPost, withCursor } from '@/verticals/admin/client';
import { stocktakeProgress, stocktakeLineKey } from '@/verticals/admin/ops';
import { OpsNav } from '@/verticals/admin/OpsNav';

/**
 * /admin/stocktake — open a count, prefill the counted quantities from the snapshot, import the
 * lines and close the count.
 *
 * Closing posts exactly one CORE stock adjustment (one journal) for the whole count. The list is a
 * keyset page (created_at, id); a count's primary key is (id, created_at) because stock_counts is
 * partitioned, so the detail link carries the created_at too.
 */

interface StockCountRow {
  id: string;
  count_no: string;
  status: 'open' | 'closed';
  warehouse_id: string;
  counted_at: string;
  line_count: number;
  closed_at: string | null;
  journal_id: string | null;
  created_at: string;
}

interface StockCountListResponse {
  stock_counts: StockCountRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

interface SnapshotItem {
  product_id: string;
  variant_id: string | null;
  system_qty: string;
  unit_cost: string;
}

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
}

export default function StocktakePage() {
  const [rows, setRows] = useState<StockCountRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [snapshot, setSnapshot] = useState<SnapshotItem[]>([]);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, true>>({});
  const [activeCount, setActiveCount] = useState<{ id: string; createdAt: string; countNo: string } | null>(
    null,
  );

  // Progress: the share of snapshot lines the operator has explicitly entered. The snapshot
  // prefills every line with the system figure, so "counted" means the counter has visited the line,
  // not merely that a number is present.
  const totalLines = snapshot.length;
  const countedLines = Object.keys(touched).length;
  const progressPercent = stocktakeProgress(totalLines, countedLines);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await adminGet<StockCountListResponse>('/api/admin/stocktake');
      setRows(payload.stock_counts);
      setCursor(payload.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFirstPage();
    void adminGet<{ warehouses: WarehouseRow[] }>('/api/admin/warehouses')
      .then((payload) => setWarehouses(payload.warehouses))
      .catch(() => setWarehouses([]));
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const payload = await adminGet<StockCountListResponse>(
      withCursor('/api/admin/stocktake', cursor),
    );
    setRows((current) => [...current, ...payload.stock_counts]);
    setCursor(payload.next_cursor);
  }, [cursor]);

  const openCount = useCallback(async () => {
    setError(null);
    setNotice(null);
    if (!warehouseId) {
      setError('choose a warehouse');
      return;
    }
    try {
      const count = await adminPost<{ count_id: string; count_no: string; created_at: string }>(
        '/api/admin/stocktake',
        { warehouse_id: warehouseId },
      );
      setActiveCount({ id: count.count_id, createdAt: count.created_at, countNo: count.count_no });
      const snap = await adminGet<{ items: SnapshotItem[] }>(
        `/api/admin/stocktake?warehouse_id=${warehouseId}&snapshot=1`,
      );
      setSnapshot(snap.items);
      setCounted(
        Object.fromEntries(
          snap.items.map((item) => [stocktakeLineKey(item), item.system_qty]),
        ),
      );
      setTouched({});
      await loadFirstPage();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [warehouseId, loadFirstPage]);

  const closeCount = useCallback(async () => {
    if (!activeCount) return;
    setError(null);
    setNotice(null);
    try {
      const lines = snapshot.map((item) => ({
        product_id: item.product_id,
        variant_id: item.variant_id,
        counted_qty: counted[stocktakeLineKey(item)] ?? item.system_qty,
        system_qty: item.system_qty,
        unit_cost: item.unit_cost,
      }));
      await adminPost('/api/admin/stocktake', {
        action: 'lines',
        count_id: activeCount.id,
        count_created_at: activeCount.createdAt,
        lines,
      });
      const result = await adminPost<{ journal_id: string | null; adjusted_lines: number }>(
        '/api/admin/stocktake',
        { action: 'close', count_id: activeCount.id, count_created_at: activeCount.createdAt },
      );
      setNotice(
        `Count ${activeCount.countNo} closed: ${result.adjusted_lines} line(s) adjusted, journal ${result.journal_id ?? '—'}.`,
      );
      setActiveCount(null);
      setSnapshot([]);
      setCounted({});
      setTouched({});
      await loadFirstPage();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeCount, snapshot, counted, loadFirstPage]);

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <h1>Stocktake</h1>
      <OpsNav current="/admin/stocktake" />

      {error && (
        <p role="alert" data-testid="stocktake-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}
      {notice && <p data-testid="stocktake-notice">{notice}</p>}

      <section style={{ margin: '12px 0' }}>
        <h2>New count</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            aria-label="Warehouse"
            value={warehouseId}
            onChange={(event) => setWarehouseId(event.target.value)}
          >
            <option value="">— choose a warehouse —</option>
            {warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.code} — {warehouse.name}
              </option>
            ))}
          </select>
          <button type="button" data-testid="open-count" onClick={() => void openCount()}>
            Open count
          </button>
        </div>

        {activeCount && (
          <>
            <p data-testid="active-count">
              Counting {activeCount.countNo}. Edit any quantity that differs from the system figure.
            </p>
            <div
              data-testid="count-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
              aria-label="Stocktake progress"
              style={{
                height: 10,
                borderRadius: 5,
                background: '#e5e7eb',
                overflow: 'hidden',
                margin: '8px 0',
              }}
            >
              <div
                data-testid="count-progress-bar"
                style={{
                  width: `${progressPercent}%`,
                  height: '100%',
                  background: '#2f855a',
                  transition: 'width 120ms ease',
                }}
              />
            </div>
            <p data-testid="count-progress-label">
              {countedLines} of {totalLines} line(s) counted ({progressPercent}%)
            </p>
            <table
              data-testid="count-lines"
              style={{ borderCollapse: 'collapse', width: '100%', marginTop: 12 }}
            >
              <thead>
                <tr>
                  <th align="left">Item</th>
                  <th align="right">System</th>
                  <th align="right">Unit cost</th>
                  <th align="right">Counted</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.map((item) => (
                  <tr key={stocktakeLineKey(item)}>
                    <td>
                      <code>{item.variant_id ?? item.product_id}</code>
                    </td>
                    <td align="right">{item.system_qty}</td>
                    <td align="right">{item.unit_cost}</td>
                    <td align="right">
                      <input
                        aria-label={`Counted qty ${stocktakeLineKey(item)}`}
                        value={counted[stocktakeLineKey(item)] ?? ''}
                        onChange={(event) => {
                          const key = stocktakeLineKey(item);
                          setCounted((current) => ({ ...current, [key]: event.target.value }));
                          setTouched((current) => ({ ...current, [key]: true }));
                        }}
                        style={{ width: 90, textAlign: 'right' }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              data-testid="close-count"
              onClick={() => void closeCount()}
              style={{ marginTop: 12 }}
            >
              Close count
            </button>
          </>
        )}
      </section>

      <section>
        <h2>Counts</h2>
        {loading ? (
          <p>Loading…</p>
        ) : (
          <table data-testid="stocktake-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th align="left">Count</th>
                <th align="left">Status</th>
                <th align="left">Counted</th>
                <th align="right">Lines</th>
                <th align="left">Journal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`count-${row.count_no}`}>
                  <td>
                    <code>{row.count_no}</code>
                  </td>
                  <td>{row.status}</td>
                  <td>{row.counted_at}</td>
                  <td align="right">{row.line_count}</td>
                  <td>{row.journal_id ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cursor && (
          <button type="button" onClick={() => void loadMore()} style={{ marginTop: 12 }}>
            Load more
          </button>
        )}
      </section>
    </main>
  );
}

