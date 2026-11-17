'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminDelete, adminGet, adminPatch, adminPost, withCursor } from '@/verticals/admin/client';
import { PricingNav } from '@/verticals/admin/PricingNav';
import { PROMOTION_TYPES, type PromotionType } from '@/verticals/admin/types';
import {
  EMPTY_PROMOTION_CONDITIONS,
  buildConditions,
  describeConditions,
  type PromotionConditionInput,
} from '@/verticals/admin/promotionConditions';

/**
 * /admin/promotions — the promotions the till applies, by priority.
 *
 * The list is a keyset page (created_at, id) filtered by is_active and type. Priority decides the
 * order promotions apply in; rows can be dragged to reorder, or moved with the up/down buttons
 * (the keyboard-accessible fallback). Either path calls the reorder endpoint, which assigns
 * priority by position and invalidates the promos:{org_id} cache so the next sale re-reads it.
 *
 * The form builds the `conditions` jsonb the pricing engine reads: a value, an optional set of
 * variant ids, a minimum quantity and a minimum subtotal. A stackable badge marks a promotion that
 * may stack with another.
 *
 * Precedence the preview (and the till) apply:
 *   1. the customer group's price list, falling back to the retail list
 *   2. active promotions, by priority
 *   3. a manual discount, within the role's limit
 */

interface PromotionRow {
  id: string;
  name: string;
  type: PromotionType;
  valid_from: string;
  valid_to: string;
  is_active: boolean;
  priority: number;
  stackable: boolean;
  conditions: Record<string, unknown>;
  created_at: string;
}

interface PromotionResponse {
  promotions: PromotionRow[];
  next_cursor: { createdAt: string; id: string } | null;
}

function toLocalInput(value: string): string {
  return value.slice(0, 16);
}

export default function PromotionsPage() {
  const [rows, setRows] = useState<PromotionRow[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');

  const [name, setName] = useState('');
  const [type, setType] = useState<PromotionType>('percent');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [stackable, setStackable] = useState(false);
  const [conditions, setConditions] = useState<PromotionConditionInput>(EMPTY_PROMOTION_CONDITIONS);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const query = useCallback(() => {
    const params = new URLSearchParams();
    if (activeFilter) params.set('is_active', activeFilter);
    if (typeFilter) params.set('type', typeFilter);
    const text = params.toString();
    return text ? `?${text}` : '';
  }, [activeFilter, typeFilter]);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await adminGet<PromotionResponse>(`/api/admin/promotions${query()}`);
      setRows(payload.promotions);
      setCursor(payload.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const payload = await adminGet<PromotionResponse>(
      withCursor(`/api/admin/promotions${query()}`, cursor),
    );
    setRows((current) => [...current, ...payload.promotions]);
    setCursor(payload.next_cursor);
  }, [cursor, query]);

  const create = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      await adminPost('/api/admin/promotions', {
        name,
        type,
        valid_from: new Date(validFrom).toISOString(),
        valid_to: new Date(validTo).toISOString(),
        priority: rows.length + 1,
        stackable,
        conditions: buildConditions(conditions),
      });
      setName('');
      setStackable(false);
      setConditions(EMPTY_PROMOTION_CONDITIONS);
      await loadFirstPage();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [name, type, validFrom, validTo, stackable, conditions, rows.length, loadFirstPage]);

  const toggleActive = useCallback(
    async (row: PromotionRow) => {
      setError(null);
      try {
        await adminPatch(`/api/admin/promotions/${row.id}`, { is_active: !row.is_active });
        await loadFirstPage();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [loadFirstPage],
  );

  const deactivate = useCallback(
    async (row: PromotionRow) => {
      setError(null);
      try {
        await adminDelete(`/api/admin/promotions/${row.id}`);
        setStatus(`Deactivated ${row.name}`);
        await loadFirstPage();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [loadFirstPage],
  );

  const reorder = useCallback(
    async (ordered: string[]) => {
      setError(null);
      try {
        await adminPost('/api/admin/promotions', { action: 'reorder', ordered_ids: ordered });
        await loadFirstPage();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [loadFirstPage],
  );

  const move = useCallback(
    async (index: number, delta: number) => {
      const target = index + delta;
      if (target < 0 || target >= rows.length) return;
      const ordered = rows.map((row) => row.id);
      const [moved] = ordered.splice(index, 1);
      ordered.splice(target, 0, moved!);
      await reorder(ordered);
    },
    [rows, reorder],
  );

  // Drop the dragged row onto the target row's position, keeping the rest in order.
  const dropAt = useCallback(
    async (targetIndex: number) => {
      const from = dragIndex;
      setDragIndex(null);
      if (from === null || from === targetIndex) return;
      const ordered = rows.map((row) => row.id);
      const [moved] = ordered.splice(from, 1);
      ordered.splice(targetIndex, 0, moved!);
      await reorder(ordered);
    },
    [dragIndex, rows, reorder],
  );

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <h1>Promotions</h1>
      <PricingNav current="/admin/promotions" />

      {error && (
        <p role="alert" data-testid="promotions-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}
      {status && <p data-testid="promotions-status">{status}</p>}

      <p data-testid="precedence-legend" style={{ color: '#5b6472', fontSize: 13 }}>
        Precedence: 1. customer group price list (fallback: retail) → 2. promotion by priority → 3.
        manual discount.
      </p>

      <section style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0' }}>
        <select
          aria-label="Filter by active"
          value={activeFilter}
          onChange={(event) => setActiveFilter(event.target.value)}
        >
          <option value="">All</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
        <select
          aria-label="Filter by type"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option value="">All types</option>
          {PROMOTION_TYPES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </section>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        data-testid="promotion-form"
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end', margin: '12px 0', flexWrap: 'wrap' }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          Name
          <input
            aria-label="New promotion name"
            placeholder="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          Type
          <select
            aria-label="Promotion type"
            value={type}
            onChange={(event) => setType(event.target.value as PromotionType)}
          >
            {PROMOTION_TYPES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          From
          <input
            type="datetime-local"
            aria-label="Valid from"
            value={validFrom}
            onChange={(event) => setValidFrom(event.target.value)}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          To
          <input
            type="datetime-local"
            aria-label="Valid to"
            value={validTo}
            onChange={(event) => setValidTo(event.target.value)}
          />
        </label>

        <fieldset
          data-testid="conditions-builder"
          style={{ display: 'flex', gap: 8, alignItems: 'flex-end', border: '1px solid #e3e6ea', padding: 8 }}
        >
          <legend>Conditions</legend>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            Value
            <input
              aria-label="Condition value"
              placeholder="10"
              style={{ width: 72 }}
              value={conditions.value}
              onChange={(event) => setConditions({ ...conditions, value: event.target.value })}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            Variant ids
            <input
              aria-label="Condition variant ids"
              placeholder="uuid, uuid"
              style={{ width: 180 }}
              value={conditions.variantIds}
              onChange={(event) => setConditions({ ...conditions, variantIds: event.target.value })}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            Min qty
            <input
              aria-label="Condition min qty"
              placeholder="1"
              style={{ width: 64 }}
              value={conditions.minQty}
              onChange={(event) => setConditions({ ...conditions, minQty: event.target.value })}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            Min subtotal
            <input
              aria-label="Condition min subtotal"
              placeholder="0.0000"
              style={{ width: 90 }}
              value={conditions.minSubtotal}
              onChange={(event) => setConditions({ ...conditions, minSubtotal: event.target.value })}
            />
          </label>
        </fieldset>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            aria-label="Stackable"
            data-testid="stackable-checkbox"
            checked={stackable}
            onChange={(event) => setStackable(event.target.checked)}
          />
          Stackable
        </label>

        <button type="submit" data-testid="promotion-submit">
          Add promotion
        </button>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <table data-testid="promotion-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th align="right">Priority</th>
              <th align="left">Name</th>
              <th align="left">Type</th>
              <th align="left">Conditions</th>
              <th align="left">Window</th>
              <th align="left">Active</th>
              <th align="left" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={row.id}
                data-testid={`promotion-${row.id}`}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => void dropAt(index)}
                style={{ cursor: 'grab' }}
              >
                <td align="right">
                  <button type="button" aria-label={`Move ${row.name} up`} onClick={() => void move(index, -1)}>
                    ↑
                  </button>
                  <button type="button" aria-label={`Move ${row.name} down`} onClick={() => void move(index, 1)}>
                    ↓
                  </button>
                  {row.priority}
                </td>
                <td>
                  {row.name}
                  {row.stackable && (
                    <span
                      data-testid={`stackable-badge-${row.id}`}
                      title="Stackable with another promotion"
                      style={{
                        marginLeft: 6,
                        padding: '1px 6px',
                        borderRadius: 8,
                        background: '#e6f0ff',
                        color: '#0b5cff',
                        fontSize: 11,
                      }}
                    >
                      stackable
                    </span>
                  )}
                </td>
                <td>{row.type}</td>
                <td>{describeConditions(row.type, row.conditions)}</td>
                <td>
                  {toLocalInput(row.valid_from)} → {toLocalInput(row.valid_to)}
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Active ${row.name}`}
                    checked={row.is_active}
                    onChange={() => void toggleActive(row)}
                  />
                </td>
                <td>
                  <button type="button" onClick={() => void deactivate(row)}>
                    Deactivate
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
    </main>
  );
}
