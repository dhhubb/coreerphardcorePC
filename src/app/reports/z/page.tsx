'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { reportGet } from '@/verticals/reports/client';
import { ReportsNav } from '@/verticals/reports/ReportsNav';

/**
 * /reports/z — the branch's immutable Z-reports, each with its fiscal totals.
 *
 * The list is a keyset page on (created_at, id) read from /api/reports/z-reports (default 50,
 * maximum 100, never OFFSET). The fiscal totals (sent / pending / failed and their amounts) are
 * computed at read time, because a fiscal status changes after the close (ADR-0047). Selecting a
 * report opens its detail, which shows the fiscal totals, the VAT split by rate, the sale and void
 * counts and prints a 58mm slip.
 */

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

interface ZReportList {
  rows: ZReportRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

function money(value: string): string {
  return Number(value).toFixed(2);
}

export default function ZReportsPage() {
  const [rows, setRows] = useState<ZReportRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (append: boolean, next: { createdAt: string; id: string } | null) => {
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (next) {
        params.set('after_created_at', next.createdAt);
        params.set('after_id', next.id);
      }
      const body = await reportGet<ZReportList>(`/api/reports/z-reports?${params.toString()}`);
      setError(null);
      setCursor(body.next_cursor);
      setRows((current) => (append ? [...current, ...body.rows] : body.rows));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false, null);
  }, [load]);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Z-reports</h1>
      <ReportsNav current="/reports/z" />

      {error && <p data-testid="z-list-error">{error}</p>}

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
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
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
              <td>
                <Link href={`/reports/z/${row.id}`} data-testid="z-open">
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {cursor && (
        <button
          type="button"
          data-testid="z-load-more"
          disabled={busy}
          onClick={() => void load(true, cursor)}
        >
          Load more
        </button>
      )}
    </main>
  );
}
