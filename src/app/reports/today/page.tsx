'use client';

import { useCallback, useEffect, useState } from 'react';
import { reportGet } from '@/verticals/reports/client';
import { syncAgeLabel } from '@/verticals/reports/reports';
import { ReportsNav } from '@/verticals/reports/ReportsNav';

/**
 * /reports/today — the live dashboard: today's sales in USD and ZWG, sales by branch and by till,
 * the low-stock alert (on-hand below five), the laybys that are due, the sync status and the fiscal
 * queue. Everything is today's, read live from /api/reports/today (ADR-0046).
 */

interface TodayPayload {
  sales_base: string;
  sale_count: number;
  gross_sales: string;
  by_currency: Record<string, string>;
  by_till: Array<{ till_id: string; sale_count: number; gross: string }>;
  by_branch: Array<{ branch_id: string; sale_count: number; gross: string }>;
  low_stock: Array<{ product_id: string; sku: string; name: string; qty: string }>;
  laybys_due: Array<{ id: string; layby_no: string; due_date: string; total: string; customer: string }>;
  fiscal: { pending: number; sent: number; failed: number; failed_amount: string };
  sync: {
    last_cloud_contact_at: string | null;
    last_ingest_at: string | null;
    outbox_size: number;
  };
}

function money(value: string): string {
  return Number(value).toFixed(2);
}

export default function TodayReportPage() {
  const [data, setData] = useState<TodayPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await reportGet<TodayPayload>('/api/reports/today');
      setError(null);
      setData(body);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Today</h1>
      <ReportsNav current="/reports/today" />

      <p data-testid="today-sync">
        {syncAgeLabel(data?.sync.last_ingest_at ?? data?.sync.last_cloud_contact_at ?? null)}
      </p>

      {error && <p data-testid="today-error">{error}</p>}

      {data && (
        <>
          <section data-testid="today-sales">
            <h2>Sales today</h2>
            <p data-testid="today-sales-base">USD (base): {money(data.sales_base)}</p>
            <p data-testid="today-sales-count">Sales: {data.sale_count}</p>
            <ul data-testid="today-by-currency">
              {Object.entries(data.by_currency).map(([currency, amount]) => (
                <li key={currency} data-testid="today-currency">
                  {currency}: {money(amount)}
                </li>
              ))}
            </ul>
          </section>

          <section data-testid="today-by-branch">
            <h2>By branch</h2>
            <ul>
              {data.by_branch.map((row) => (
                <li key={row.branch_id} data-testid="today-branch">
                  {row.branch_id.slice(0, 8)} — {row.sale_count} sales · {money(row.gross)}
                </li>
              ))}
            </ul>
          </section>

          <section data-testid="today-by-till">
            <h2>By till</h2>
            <ul>
              {data.by_till.map((row) => (
                <li key={row.till_id} data-testid="today-till">
                  {row.till_id} — {row.sale_count} sales · {money(row.gross)}
                </li>
              ))}
            </ul>
          </section>

          <section data-testid="today-low-stock">
            <h2>Low stock (&lt; 5)</h2>
            <ul>
              {data.low_stock.map((row) => (
                <li key={`${row.product_id}:${row.sku}`} data-testid="today-low-stock-row">
                  {row.name} ({row.sku}) — {Number(row.qty).toFixed(2)} left
                </li>
              ))}
            </ul>
          </section>

          <section data-testid="today-laybys">
            <h2>Laybys due</h2>
            <ul>
              {data.laybys_due.map((row) => (
                <li key={row.id} data-testid="today-layby">
                  {row.layby_no} — {row.customer} · due {row.due_date} · {money(row.total)}
                </li>
              ))}
            </ul>
          </section>

          <section data-testid="today-fiscal">
            <h2>Fiscal queue</h2>
            <p data-testid="today-fiscal-counts">
              Pending {data.fiscal.pending} · Sent {data.fiscal.sent} · Failed {data.fiscal.failed}
            </p>
          </section>
        </>
      )}
    </main>
  );
}
