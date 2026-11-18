import type Decimal from 'decimal.js';
import type { PageCursor } from '@/core/sales';

/**
 * The stock report shapes (F10). Money and quantities are decimals, never numbers (ADR-0045).
 *
 * A stock-on-hand row is one warehouse/product/variant balance: the on-hand quantity and the value
 * the stock_balances cache carries. A movement row is one append-only stock_ledger entry.
 */

export interface StockOnHandRow {
  id: string;
  warehouseId: string;
  warehouseCode: string;
  productId: string;
  variantId: string | null;
  sku: string;
  name: string;
  qty: Decimal;
  value: Decimal;
  unitCost: Decimal;
  createdAt: string;
}

export interface StockOnHandPage {
  rows: StockOnHandRow[];
  nextCursor: PageCursor | null;
}

export interface StockMovementRow {
  id: string;
  warehouseId: string;
  warehouseCode: string;
  productId: string;
  variantId: string | null;
  sku: string;
  name: string;
  direction: 'in' | 'out';
  qty: Decimal;
  unitCost: Decimal;
  sourceType: string;
  sourceId: string | null;
  createdAt: string;
}

export interface StockMovementPage {
  rows: StockMovementRow[];
  nextCursor: PageCursor | null;
}

/** The period a stock report covers. Both dates are inclusive. */
export interface StockPeriod {
  from: string;
  to: string;
}
