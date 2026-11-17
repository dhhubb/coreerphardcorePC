'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { reportGet } from '@/verticals/reports/client';
import { ReportsNav } from '@/verticals/reports/ReportsNav';

/**
 * /reports/vat — the VAT report for the ZIMRA return.
 *
 * It reads /api/reports/vat, which sums invoice_lines by the rate each line used, so its totals
 * match the invoice lines and the Z-report's `vat_by_rate` (the Z-report reads the same lines). The
 * rates are shown as they are stored (0% and 15% today), never hardcoded (ADR-0046, ADR-0048).
 */

interface VatRow {
  tax_rate: string;
  net: string;
  tax: string;
  gross: string;
  line_count: number;
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

export default function VatReportPage() {
  const defaults = useMemo(monthBounds, []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [rows, setRows] = useState<VatRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ from, to });
      const body = await reportGet<{ rows: VatRow[] }>(`/api/reports/vat?${params.toString()}`);
      setError(null);
      setRows(body.rows);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    let net = 0;
    let tax = 0;
    let gross = 0;
    for (const row of rows) {
      net += Number(row.net);
      tax += Number(row.tax);
      gross += Number(row.gross);
    }
    return { net, tax, gross };
  }, [rows]);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>VAT report (ZIMRA)</h1>
      <ReportsNav current="/reports/vat" />

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <label>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      {error && <p data-testid="vat-error">{error}</p>}

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
          {rows.map((row) => (
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

      <p data-testid="vat-totals">
        Net {totals.net.toFixed(2)} · VAT {totals.tax.toFixed(2)} · Gross {totals.gross.toFixed(2)}
      </p>
    </main>
  );
}
