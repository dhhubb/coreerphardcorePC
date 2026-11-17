'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPatch, adminPost, withCursor } from '@/verticals/admin/client';
import { PricingNav } from '@/verticals/admin/PricingNav';
import { parsePriceCsv } from '@/verticals/admin/priceCsv';
import type { CategoryNode } from '@/verticals/admin/types';

/**
 * /admin/price-lists/:id/items — the editable item table.
 *
 * Each row shows price, cost and margin and can be edited inline (one PATCH). "Bulk update" applies
 * a percentage change to every item in a category (and its descendants). The CSV import uses the
 * same COPY pattern as the stocktake: the browser reads the file, sends the parsed (variant_id,
 * price) lines, and the server streams them into a staging table and merges once.
 */

interface ItemRow {
  id: string;
  variant_id: string;
  product_name: string;
  variant_name: string;
  sku: string;
  category_id: string | null;
  category_name: string | null;
  price: string;
  cost: string | null;
  margin: string | null;
  margin_percent: string | null;
  currency: string;
  created_at: string;
}

interface ItemResponse {
  items: ItemRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

export default function PriceListItemsPage({ params }: { params: { id: string } }) {
  const priceListId = params.id;
  const [rows, setRows] = useState<ItemRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bulkCategory, setBulkCategory] = useState<string>('');
  const [bulkPercent, setBulkPercent] = useState<string>('');

  useEffect(() => {
    void adminGet<{ categories: CategoryNode[] }>('/api/admin/categories')
      .then((payload) => setCategories(payload.categories))
      .catch((err: Error) => setError(err.message));
  }, []);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const suffix = categoryFilter ? `?category_id=${encodeURIComponent(categoryFilter)}` : '';
      const payload = await adminGet<ItemResponse>(`/api/admin/price-lists/${priceListId}/items${suffix}`);
      setRows(payload.items);
      setCursor(payload.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [priceListId, categoryFilter]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const base = `/api/admin/price-lists/${priceListId}/items${categoryFilter ? `?category_id=${encodeURIComponent(categoryFilter)}` : ''}`;
    const payload = await adminGet<ItemResponse>(withCursor(base, cursor));
    setRows((current) => [...current, ...payload.items]);
    setCursor(payload.next_cursor);
  }, [cursor, priceListId, categoryFilter]);

  const savePrice = useCallback(
    async (itemId: string, price: string) => {
      setError(null);
      setStatus(null);
      try {
        await adminPatch(`/api/admin/price-lists/${priceListId}/items`, { item_id: itemId, price });
        setRows((current) =>
          current.map((row) => (row.id === itemId ? { ...row, price: Number(price).toFixed(4) } : row)),
        );
        setStatus('Saved');
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [priceListId],
  );

  const bulkUpdate = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const payload = await adminPatch<{ changed: number }>(
        `/api/admin/price-lists/${priceListId}/items`,
        { action: 'bulk_category', category_id: bulkCategory, percent: bulkPercent },
      );
      setStatus(`Updated ${payload.changed} items`);
      await loadFirstPage();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [priceListId, bulkCategory, bulkPercent, loadFirstPage]);

  const importFile = useCallback(
    async (file: File) => {
      setError(null);
      setStatus(null);
      try {
        const text = await file.text();
        const lines = parsePriceCsv(text);
        const payload = await adminPost<{ imported: number }>(
          '/api/admin/price-lists/import',
          { price_list_id: priceListId, lines },
        );
        setStatus(`Imported ${payload.imported} items`);
        await loadFirstPage();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [priceListId, loadFirstPage],
  );

  return (
    <main style={{ padding: 24, maxWidth: 1200 }}>
      <h1>Price list items</h1>
      <PricingNav current="/admin/price-lists" />

      {error && (
        <p role="alert" data-testid="items-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}
      {status && <p data-testid="items-status">{status}</p>}

      <section style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0', flexWrap: 'wrap' }}>
        <select
          aria-label="Filter by category"
          value={categoryFilter}
          onChange={(event) => setCategoryFilter(event.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((node) => (
            <option key={node.id} value={node.id}>
              {node.path}
            </option>
          ))}
        </select>

        <span>
          <select
            aria-label="Bulk category"
            value={bulkCategory}
            onChange={(event) => setBulkCategory(event.target.value)}
          >
            <option value="">— bulk category —</option>
            {categories.map((node) => (
              <option key={node.id} value={node.id}>
                {node.path}
              </option>
            ))}
          </select>
          <input
            aria-label="Bulk percent"
            placeholder="%"
            style={{ width: 64 }}
            value={bulkPercent}
            onChange={(event) => setBulkPercent(event.target.value)}
          />
          <button
            type="button"
            data-testid="bulk-update"
            disabled={!bulkCategory || bulkPercent === ''}
            onClick={() => void bulkUpdate()}
          >
            Bulk update
          </button>
        </span>

        <label>
          Import CSV (variant_id, price)
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="Import CSV"
            data-testid="csv-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
            }}
          />
        </label>
      </section>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <table data-testid="item-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th align="left">SKU</th>
              <th align="left">Product</th>
              <th align="left">Category</th>
              <th align="right">Price</th>
              <th align="right">Cost</th>
              <th align="right">Margin</th>
              <th align="right">Margin %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid={`item-${row.sku}`}>
                <td>
                  <code>{row.sku}</code>
                </td>
                <td>
                  {row.product_name} — {row.variant_name}
                </td>
                <td>{row.category_name ?? '—'}</td>
                <td align="right">
                  <input
                    aria-label={`Price for ${row.sku}`}
                    data-testid={`price-${row.sku}`}
                    defaultValue={row.price}
                    style={{ width: 100, textAlign: 'right' }}
                    onBlur={(event) => {
                      if (event.target.value !== row.price) {
                        void savePrice(row.id, event.target.value);
                      }
                    }}
                  />
                  <span style={{ marginLeft: 4 }}>{row.currency}</span>
                </td>
                <td align="right">{row.cost ?? '—'}</td>
                <td align="right">{row.margin ?? '—'}</td>
                <td align="right">{row.margin_percent === null ? '—' : `${row.margin_percent}%`}</td>
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
    </main>
  );
}
