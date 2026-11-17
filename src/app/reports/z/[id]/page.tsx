'use client';

import { useCallback, useEffect, useState } from 'react';
import { reportGet } from '@/verticals/reports/client';
import { ReportsNav } from '@/verticals/reports/ReportsNav';
import { defaultShop } from '@/verticals/pos/receiptData';
import { ZReport58mm } from '@/verticals/pos/ZReport58mm';
import { buildZReportData, type RawZReport } from '@/verticals/pos/zReportData';

/**
 * /reports/z/:id — one Z-report.
 *
 * It reads /api/reports/z-reports/:id (a single indexed lookup) and shows the fiscal totals (sent /
 * pending / failed and their amounts, computed at read time — ADR-0047), the VAT totals split by
 * rate, the sale and void counts, and prints a 58mm slip through the browser (the same path the
 * receipt uses). The slip prints from an already-fetched immutable row, so there is no server call
 * at print time and it works with the network cut.
 */

interface FiscalTotals {
  count: number;
  amount: string;
}

interface ZReportDetail extends RawZReport {
  id: string;
  fiscal: { sent: FiscalTotals; pending: FiscalTotals; failed: FiscalTotals };
}

function money(value: string): string {
  return Number(value).toFixed(2);
}

export default function ZReportDetailPage({ params }: { params: { id: string } }) {
  const [report, setReport] = useState<ZReportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await reportGet<ZReportDetail>(`/api/reports/z-reports/${params.id}`);
      setError(null);
      setReport(body);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const print = useCallback(() => {
    // The browser owns the dialog; the @page rule below sets the 58mm paper width.
    window.print();
  }, []);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <style>{`@page { width: 58mm; margin: 0; }
        @media print { body * { visibility: hidden; } .z-report-58, .z-report-58 * { visibility: visible; }
          .z-report-58 { position: absolute; left: 0; top: 0; } }`}</style>

      <h1>Z-report detail</h1>
      <ReportsNav current="/reports/z" />

      {error && <p data-testid="z-detail-error">{error}</p>}

      {report && (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Z-report {report.z_no}</h2>
            <button type="button" data-testid="print-z-report" onClick={print}>
              Print 58mm
            </button>
          </div>

          <table data-testid="z-detail-fiscal">
            <thead>
              <tr>
                <th>Fiscal</th>
                <th>Count</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr data-testid="z-detail-fiscal-sent">
                <td>Sent</td>
                <td>{report.fiscal.sent.count}</td>
                <td>{money(report.fiscal.sent.amount)}</td>
              </tr>
              <tr data-testid="z-detail-fiscal-pending">
                <td>Pending</td>
                <td>{report.fiscal.pending.count}</td>
                <td>{money(report.fiscal.pending.amount)}</td>
              </tr>
              <tr data-testid="z-detail-fiscal-failed">
                <td>Failed</td>
                <td>{report.fiscal.failed.count}</td>
                <td>{money(report.fiscal.failed.amount)}</td>
              </tr>
            </tbody>
          </table>

          <table data-testid="z-detail-vat">
            <thead>
              <tr>
                <th>VAT rate</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(report.vat_by_rate).map(([rate, amount]) => (
                <tr key={rate} data-testid="z-detail-vat-row">
                  <td>{(Number(rate) * 100).toFixed(2)}%</td>
                  <td>{money(amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p data-testid="z-detail-counts">
            Sales {report.sale_count} · Voids {report.void_count}
          </p>

          <ZReport58mm
            data={buildZReportData(report, {
              shop: defaultShop(),
              branchName: 'Branch',
              tillId: '—',
            })}
          />
        </>
      )}
    </main>
  );
}
