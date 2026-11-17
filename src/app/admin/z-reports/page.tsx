'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminGet, withCursor } from '@/verticals/admin/client';
import { OpsNav } from '@/verticals/admin/OpsNav';
import { defaultShop } from '@/verticals/pos/receiptData';
import { ZReport58mm } from '@/verticals/pos/ZReport58mm';
import { buildZReportData, type RawZReport } from '@/verticals/pos/zReportData';

/**
 * /admin/z-reports — the branch's immutable Z-reports.
 *
 * The list is a keyset page on (created_at, id) (default 50, maximum 100) read from `z_reports`
 * alone: no materialized view, and no running daily total is kept on each sale. A daily summary
 * reads this table and nothing else (ADR-0064). Selecting a report reads it by primary key through
 * `app.admin_z_report` — a single indexed lookup, so the page stays fast however many `pos_sales`
 * rows exist — and renders the 58mm slip, which prints through `window.print` with no server call.
 */

interface ZReportRow {
  id: string;
  z_no: string;
  shift_id: string;
  opened_at: string;
  closed_at: string;
  opening_float: string;
  sale_count: number;
  void_count: number;
  gross_sales: string;
  tax_total: string;
  by_method: Record<string, string>;
  by_currency: Record<string, string>;
  vat_by_rate: Record<string, string>;
  created_at: string;
}

interface ZReportListResponse {
  z_reports: ZReportRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

export default function ZReportsPage() {
  const [rows, setRows] = useState<ZReportRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [selected, setSelected] = useState<RawZReport | null>(null);
  const [tillId, setTillId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await adminGet<ZReportListResponse>('/api/z-reports');
      setRows(payload.z_reports);
      setCursor(payload.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const payload = await adminGet<ZReportListResponse>(withCursor('/api/z-reports', cursor));
    setRows((current) => [...current, ...payload.z_reports]);
    setCursor(payload.next_cursor);
  }, [cursor]);

  const open = useCallback(async (id: string, till: string) => {
    setError(null);
    try {
      setSelected(await adminGet<RawZReport>(`/api/admin/z-reports/${id}`));
      setTillId(till);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const print = useCallback(() => {
    // The browser owns the dialog; the @page rule below sets the 58mm paper width.
    window.print();
  }, []);

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <style>{`@page { width: 58mm; margin: 0; }
        @media print { body * { visibility: hidden; } .z-report-58, .z-report-58 * { visibility: visible; }
          .z-report-58 { position: absolute; left: 0; top: 0; } }`}</style>

      <h1>Z-reports</h1>
      <OpsNav current="/admin/z-reports" />

      {error && (
        <p role="alert" data-testid="z-reports-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <table data-testid="z-report-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th align="left">Z no</th>
              <th align="right">Sales</th>
              <th align="right">Voids</th>
              <th align="right">Gross</th>
              <th align="right">VAT</th>
              <th align="left">Closed</th>
              <th align="left" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7}>No Z-reports yet.</td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} data-testid={`z-report-${row.id}`}>
                <td>{row.z_no}</td>
                <td align="right">{row.sale_count}</td>
                <td align="right">{row.void_count}</td>
                <td align="right">{row.gross_sales}</td>
                <td align="right">{row.tax_total}</td>
                <td>{row.closed_at}</td>
                <td>
                  <button type="button" onClick={() => void open(row.id, row.shift_id)}>
                    View / print
                  </button>
                </td>
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

      {selected && (
        <section style={{ marginTop: 24 }} data-testid="z-report-detail">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Z-report {selected.z_no}</h2>
            <button type="button" data-testid="print-z-report" onClick={print}>
              Print 58mm
            </button>
          </div>
          <ZReport58mm
            data={buildZReportData(selected, {
              shop: defaultShop(),
              branchName: 'Branch',
              tillId: tillId || '—',
            })}
          />
        </section>
      )}
    </main>
  );
}
