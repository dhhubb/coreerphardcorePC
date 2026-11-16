'use client';

import Decimal from 'decimal.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, apiJson, posToken } from '@/verticals/pos/api';
import { currentClaims, type SessionClaims } from '@/core/session';
import { enqueueSale, countPending, type OutboxSale } from '@/verticals/pos/outbox';
import { syncOnce } from '@/verticals/pos/sync';
import { RegisterServiceWorker } from '@/branch/RegisterServiceWorker';
import { useBranchHealth, type BranchHealthState } from '@/branch/useBranchHealth';
import { Receipt58mm } from '@/verticals/pos/Receipt58mm';
import { buildReceiptData, defaultShop } from '@/verticals/pos/receiptData';
import { checkoutAndPrint, type CheckoutTimings } from '@/verticals/pos/checkout';
import {
  defaultPrinterSettings,
  loadPrinterSettings,
  type PrinterSettings,
} from '@/verticals/pos/printing';
import { ScannerBuffer } from '@/verticals/pos/scanner';
import { resolveShortcut, shortcutHint } from '@/verticals/pos/shortcuts';
import { cameraSupported, startCameraScan, type CameraScanner } from '@/verticals/pos/camera';
import {
  cartTotals,
  remainingBase,
  tenderedBase,
  useCart,
  type CartLine,
  type PosReceipt,
} from '@/verticals/pos/cart';

/**
 * The till (H4).
 *
 * Keyboard only. A keyboard-wedge scanner types the barcode and presses Enter; the till reads the
 * keystrokes directly, so a scan is one action no matter what has focus. Shortcuts: F2 focuses the
 * scan field, F3 parks the cart (hold), F9 opens payment with the exact amount preselected and Enter
 * confirms. A one-item exact-cash sale is still three actions: scan, F9, Enter.
 *
 * Printing happens after the sale commits: the receipt is rendered at 58mm and printed through the
 * browser dialog or relayed to a network printer by the branch (see `printing.ts`).
 */

const ZWG_SEED_RATE = new Decimal('30');

interface SearchHit {
  variant_id: string;
  product_name: string;
  variant_name: string;
  sku: string;
  barcode: string | null;
  match_type: string;
}

function displayMoney(value: Decimal): string {
  return value.toFixed(2);
}

export default function PosPage() {
  const router = useRouter();
  const {
    lines,
    tenders,
    held,
    actions,
    status,
    error,
    receipt,
    zwgRate,
    addLine,
    addTender,
    bumpActions,
    setZwgRate,
    setStatus,
    setError,
    setReceipt,
    hold,
    recall,
    clear,
  } = useCart();

  const [scan, setScan] = useState('');
  const [tillId, setTillId] = useState('TILL-1');
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [taxCode, setTaxCode] = useState('VAT15');
  const [taxRate, setTaxRate] = useState(new Decimal('0.15'));
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [printer, setPrinter] = useState<PrinterSettings>(defaultPrinterSettings());
  const [timings, setTimings] = useState<CheckoutTimings | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [shopName] = useState(defaultShop().name);
  const [claims, setClaims] = useState<SessionClaims | null>(null);

  // The till is a signed-in surface: without a session, send the operator to the sign-in page.
  useEffect(() => {
    if (!posToken()) {
      router.replace('/login?next=%2Fpos');
      return;
    }
    setClaims(currentClaims());
  }, [router]);

  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<CameraScanner | null>(null);
  const scannerRef = useRef(new ScannerBuffer());
  const busyRef = useRef(false);

  const health = useBranchHealth();

  const totals = useMemo(() => cartTotals(lines), [lines]);
  const remaining = useMemo(() => remainingBase(lines, tenders, zwgRate), [lines, tenders, zwgRate]);

  const exactCash = useCallback(
    (currency: 'USD' | 'ZWG'): Decimal =>
      currency === 'USD'
        ? remaining
        : remaining.times(zwgRate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
    [remaining, zwgRate],
  );

  // Load the terminal context: the open shift, the branch's warehouse, the VAT rate, the printer.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const contextRes = await apiFetch(`/api/pos/shifts?till_id=${encodeURIComponent(tillId)}`);
      if (contextRes.ok) {
        const context = (await contextRes.json()) as {
          shift_id: string | null;
          warehouse_id: string | null;
          tax_code: string;
          tax_rate: string;
        };
        if (!cancelled) {
          setWarehouseId(context.warehouse_id);
          setTaxCode(context.tax_code);
          setTaxRate(new Decimal(context.tax_rate));
          if (context.shift_id) setShiftId(context.shift_id);
          else {
            const openRes = await apiFetch('/api/pos/shifts', {
              method: 'POST',
              body: JSON.stringify({ till_id: tillId, opening_float: '0' }),
            });
            if (openRes.ok) {
              const opened = (await openRes.json()) as { shift_id: string };
              if (!cancelled) setShiftId(opened.shift_id);
            }
          }
        }
      }

      try {
        const settings = await apiJson<PrinterSettings>('/api/pos/printer');
        if (!cancelled) setPrinter(settings);
      } catch {
        /* keep the browser default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tillId]);

  useEffect(() => {
    setZwgRate(ZWG_SEED_RATE);
  }, [setZwgRate]);

  // The offline outbox drain loop.
  const drain = useCallback(async () => {
    setSyncing(true);
    try {
      await syncOnce();
    } finally {
      setSyncing(false);
      setPending(await countPending());
    }
  }, []);

  useEffect(() => {
    void (async () => setPending(await countPending()))();
  }, []);

  useEffect(() => {
    const onOnline = () => void drain();
    window.addEventListener('online', onOnline);
    const timer = setInterval(() => void drain(), 15_000);
    void drain();
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(timer);
    };
  }, [drain]);

  // A scanner types the barcode and sends Enter. Keep focus on the scan field by default.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Live lookup as the operator types, so an ambiguous barcode can be chosen with the arrow keys.
  useEffect(() => {
    const query = scan.trim();
    if (query === '') {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const response = await apiFetch(`/api/pos/search?q=${encodeURIComponent(query)}`);
      if (!response.ok || cancelled) return;
      const payload = (await response.json()) as { results: SearchHit[] };
      if (!cancelled) {
        setHits(payload.results);
        setSelected(0);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scan]);

  const addHit = useCallback(
    async (hit: SearchHit) => {
      let unitPrice = new Decimal(0);
      try {
        const response = await apiFetch('/api/pos/price', {
          method: 'POST',
          body: JSON.stringify({ items: [{ variant_id: hit.variant_id, qty: '1.0000' }] }),
        });
        if (response.ok) {
          const payload = (await response.json()) as {
            lines: Array<{ variant_id: string; unit_price: string }>;
          };
          const priced = payload.lines.find((line) => line.variant_id === hit.variant_id);
          if (priced) unitPrice = new Decimal(priced.unit_price);
        }
      } catch {
        /* fall through with a zero price; the sale prices server-side */
      }

      const lineSubtotal = unitPrice.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const lineTax = lineSubtotal.times(taxRate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      addLine({
        variantId: hit.variant_id,
        barcode: hit.barcode,
        name: `${hit.product_name}${hit.variant_name ? ` — ${hit.variant_name}` : ''}`,
        qty: new Decimal(1),
        unitPrice,
        taxRate,
        lineSubtotal,
        lineTax,
        lineTotal: lineSubtotal.plus(lineTax),
      });
      setScan('');
      setHits([]);
    },
    [addLine, taxRate],
  );

  const scanNow = useCallback(
    async (code: string) => {
      const response = await apiFetch(`/api/pos/search?q=${encodeURIComponent(code)}`);
      if (!response.ok) return;
      const payload = (await response.json()) as { results: SearchHit[] };
      const exact = payload.results.find((hit) => hit.barcode === code) ?? payload.results[0];
      if (exact) await addHit(exact);
    },
    [addHit],
  );

  const postSale = useCallback(async (): Promise<PosReceipt | null> => {
    if (lines.length === 0 || tenders.length === 0) return null;
    setStatus('posting');
    setError(null);

    const clientSaleId = crypto.randomUUID();
    const saleBody = {
      warehouse_id: warehouseId,
      shift_id: shiftId,
      client_sale_id: clientSaleId,
      tax_code: taxCode,
      lines: lines.map((line) => ({
        variant_id: line.variantId,
        barcode: line.barcode,
        qty: line.qty.toFixed(4),
        unit_price: line.unitPrice.toFixed(4),
      })),
      tenders: tenders.map((tender) => ({
        method: tender.method,
        currency: tender.currency,
        amount_tendered: tender.amountTendered.toFixed(4),
      })),
    };

    const queuedSale: Omit<OutboxSale, 'attempts' | 'nextAttemptAt' | 'lastError'> = {
      clientSaleId,
      shiftId,
      warehouseId: warehouseId ?? '',
      soldAt: new Date().toISOString(),
      currency: 'USD',
      lines: lines.map((line) => ({
        variantId: line.variantId,
        barcode: line.barcode,
        qty: line.qty.toFixed(4),
        unitPrice: line.unitPrice.toFixed(4),
        promotionIds: [],
      })),
      tenders: tenders.map((tender) => ({
        method: tender.method,
        currency: tender.currency,
        amountTendered: tender.amountTendered.toFixed(4),
      })),
    };

    let response: Response;
    try {
      response = await apiFetch('/api/pos/sales', {
        method: 'POST',
        body: JSON.stringify(saleBody),
      });
    } catch {
      await enqueueSale(queuedSale);
      setPending(await countPending());
      setStatus('queued');
      return null;
    }

    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        await enqueueSale(queuedSale);
        setPending(await countPending());
        setStatus('queued');
        return null;
      }
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setStatus('error');
      setError(payload.error ?? `sale failed (${response.status})`);
      return null;
    }

    const payload = (await response.json()) as RawSaleResponse;
    return toReceipt(payload);
  }, [lines, tenders, warehouseId, shiftId, taxCode, setStatus, setError]);

  /**
   * The whole checkout: ring the sale, build the receipt, print. The sale commits before the print
   * is issued, and the two timings are shown on screen (the print-issued delay and the total).
   */
  const checkout = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setTimings(null);
    try {
      // `postSale` sets the status (paid / queued / error) and returns null when the sale did not
      // commit; in that case there is nothing to print.
      const result = await checkoutAndPrint({
        postSale: async () => {
          const sale = await postSale();
          if (!sale) throw new CheckoutAborted();
          return sale;
        },
        settings: printer,
        cashier: tillId,
        zwgRate,
        now: () => Date.now(),
      });
      setTimings(result.timings);
      setReceipt(result.receipt);
      setStatus('paid');
    } catch (caught) {
      if (caught instanceof CheckoutAborted) return;
      setStatus('error');
      setError((caught as Error).message);
    } finally {
      busyRef.current = false;
    }
  }, [postSale, printer, tillId, zwgRate, setReceipt, setStatus, setError]);

  const payExact = useCallback(
    (currency: 'USD' | 'ZWG') => {
      if (remaining.greaterThan(0)) {
        addTender({ method: 'cash', currency, amountTendered: exactCash(currency) });
      }
      setPayOpen(true);
    },
    [remaining, addTender, exactCash],
  );

  /**
   * The scan field's own keys. Function keys (F2/F3/F4/F9/F10) are handled at the document level so
   * they work no matter what has focus; handling them here too would count each press twice.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        bumpActions();
        if (scan.trim() !== '') {
          const trimmed = scan.trim();
          const exact = hits.find((hit) => hit.barcode === trimmed);
          if (exact) void addHit(exact);
          else void scanNow(trimmed);
          return;
        }
        if (status === 'paid' || status === 'queued' || status === 'error') {
          clear();
          setPayOpen(false);
          setTimings(null);
          return;
        }
        if (remaining.isZero() && tenders.length > 0) void checkout();
        return;
      }
      if (event.key === 'ArrowDown' && hits.length > 0) {
        event.preventDefault();
        setSelected((current) => Math.min(current + 1, hits.length - 1));
      }
      if (event.key === 'ArrowUp' && hits.length > 0) {
        event.preventDefault();
        setSelected((current) => Math.max(current - 1, 0));
      }
    },
    [
      scan,
      hits,
      remaining,
      tenders.length,
      status,
      addHit,
      scanNow,
      bumpActions,
      clear,
      checkout,
    ],
  );

  // The document-level scanner and shortcut handler: a scan works no matter what has focus, and the
  // shortcuts work from anywhere on the till. Keys typed into the scan field are handled by the
  // field's own onKeyDown above, so this ignores them to avoid double counting.
  useEffect(() => {
    const isScanField = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && target.dataset.testid === 'scan';

    const onDocumentKeyDown = (event: KeyboardEvent) => {
      const inField = isScanField(event.target);
      const shortcut = resolveShortcut(event.key);
      if (shortcut === 'scan') {
        event.preventDefault();
        bumpActions();
        scannerRef.current.reset();
        setScan('');
        inputRef.current?.focus();
        return;
      }
      if (shortcut === 'hold') {
        event.preventDefault();
        bumpActions();
        scannerRef.current.reset();
        setScan('');
        hold();
        return;
      }
      if (shortcut === 'recall') {
        event.preventDefault();
        bumpActions();
        recall();
        return;
      }
      if (shortcut === 'pay') {
        event.preventDefault();
        bumpActions();
        payExact('USD');
        return;
      }
      if (shortcut === 'pay-zwg') {
        event.preventDefault();
        bumpActions();
        payExact('ZWG');
        return;
      }
      if (inField) return;

      const decision = scannerRef.current.feed({ key: event.key, timeStamp: event.timeStamp });
      if (decision.kind === 'char') {
        event.preventDefault();
        setScan((current) => current + decision.value);
        return;
      }
      if (decision.kind === 'scan') {
        event.preventDefault();
        bumpActions();
        setScan('');
        void scanNow(decision.code);
        return;
      }
      if (decision.kind === 'enter' && event.key === 'Enter') {
        event.preventDefault();
        bumpActions();
        if (status === 'paid' || status === 'queued' || status === 'error') {
          clear();
          setPayOpen(false);
          setTimings(null);
          return;
        }
        if (remaining.isZero() && tenders.length > 0) void checkout();
      }
    };

    document.addEventListener('keydown', onDocumentKeyDown);
    return () => document.removeEventListener('keydown', onDocumentKeyDown);
  }, [
    bumpActions,
    hold,
    recall,
    scanNow,
    status,
    clear,
    remaining,
    tenders.length,
    checkout,
    payExact,
  ]);

  const toggleCamera = useCallback(async () => {
    if (cameraOn) {
      cameraRef.current?.stop();
      cameraRef.current = null;
      setCameraOn(false);
      return;
    }
    setCameraError(null);
    try {
      const video = videoRef.current;
      if (!video) return;
      const scanner = await startCameraScan({
        video,
        onResult: (code) => {
          bumpActions();
          void scanNow(code);
        },
        onError: (error) => setCameraError(error.message),
      });
      cameraRef.current = scanner;
      setCameraOn(true);
    } catch (caught) {
      setCameraError((caught as Error).message);
    }
  }, [cameraOn, bumpActions, scanNow]);

  useEffect(() => () => cameraRef.current?.stop(), []);

  return (
    <main className="pos" onMouseDown={(event) => event.preventDefault()}>
      <style>{POS_STYLES}</style>
      <RegisterServiceWorker />

      <section className="left">
        <h1>POS</h1>
        <SessionBar
          claims={claims}
          tillId={tillId}
          branchId={claims?.branchIds[0] ?? null}
          health={health}
        />
        <CloudBadge health={health} />
        <p className="hint" data-testid="shortcut-hint">
          {shortcutHint()} · Enter confirm &amp; print
        </p>

        <label className="scan-label">
          Scan
          <input
            ref={inputRef}
            data-testid="scan"
            className="scan"
            value={scan}
            autoFocus
            autoComplete="off"
            onChange={(event) => setScan(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>

        {cameraSupported() && (
          <div className="camera">
            <button type="button" data-testid="camera-toggle" onClick={() => void toggleCamera()}>
              {cameraOn ? 'Stop camera' : 'Scan with camera'}
            </button>
            <video ref={videoRef} data-testid="camera-video" muted playsInline style={{ width: 200 }} />
            {cameraError && <span className="error">{cameraError}</span>}
          </div>
        )}

        {hits.length > 0 && (
          <ul className="hits" data-testid="hits">
            {hits.map((hit, index) => (
              <li key={hit.variant_id} className={index === selected ? 'hit selected' : 'hit'}>
                {hit.product_name} {hit.variant_name} · {hit.sku}
              </li>
            ))}
          </ul>
        )}

        <table className="cart" data-testid="cart">
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line: CartLine) => (
              <tr key={line.key} data-testid="cart-line">
                <td>{line.name}</td>
                <td>{line.qty.toString()}</td>
                <td>{displayMoney(line.unitPrice)}</td>
                <td>{displayMoney(line.lineTotal)}</td>
              </tr>
            ))}
            {lines.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  Cart empty
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="totals">
          <span>Subtotal {displayMoney(totals.subtotal)}</span>
          <span>VAT {displayMoney(totals.taxTotal)}</span>
          <strong data-testid="total">Total {displayMoney(totals.total)}</strong>
          <span data-testid="remaining">Remaining {displayMoney(remaining)}</span>
        </div>

        <div className="tenders" data-testid="tenders">
          {tenders.map((tender, index) => (
            <div key={index}>
              {tender.currency} {tender.method} {displayMoney(tender.amountTendered)}
            </div>
          ))}
        </div>

        {payOpen && (
          <div className="pay" data-testid="pay-panel">
            <strong>Payment</strong>
            <span data-testid="pay-amount">
              {displayMoney(remaining)} {remaining.isZero() ? 'settled' : 'due'}
            </span>
            <span className="hint">Enter confirms and prints</span>
          </div>
        )}

        <div className="status">
          <span data-testid="actions">Actions {actions}</span>
          <span data-testid="status">{status}</span>
          <span data-testid="pending">Pending {pending}</span>
          <span data-testid="held">Held {held.length}</span>
          {syncing && <span data-testid="syncing">syncing</span>}
          {timings && (
            <span data-testid="print-timing">
              print {timings.printIssuedMs}ms · total {timings.totalMs}ms
            </span>
          )}
          {error && <span className="error">{error}</span>}
        </div>
      </section>

      <section className="right" data-testid="receipt">
        {receipt ? (
          <Receipt58mm
            data={buildReceiptData(receipt, {
              shop: defaultShop(),
              cashier: tillId,
              zwgRate,
              date: new Date(),
            })}
          />
        ) : (
          <p className="hint">No receipt yet.</p>
        )}
      </section>
    </main>
  );
}

/** Thrown when the sale did not commit, so the checkout has nothing to print. */
class CheckoutAborted extends Error {}

interface RawSaleResponse {
  sale_id: string;
  invoice_id: string;
  invoice_no: string;
  currency: string;
  subtotal: string;
  tax_total: string;
  total: string;
  change_total: string;
  lines: Array<{
    line_no: number;
    description: string | null;
    qty: string;
    unit_price: string;
    line_subtotal: string;
    line_tax: string;
    line_total: string;
    tax_rate: string;
  }>;
  payments: Array<{
    method: string;
    currency: string;
    amount_tendered: string;
    amount_applied: string;
    rate: string;
    base_amount: string;
    change_given: string;
  }>;
  fiscal?: {
    status: string;
    signature?: string | null;
    qr_code?: string | null;
    receipt_no?: string | null;
    sent_at?: string | null;
    message?: string | null;
  } | null;
}

function toReceipt(payload: RawSaleResponse): PosReceipt {
  return {
    saleId: payload.sale_id,
    invoiceNo: payload.invoice_no,
    currency: payload.currency,
    subtotal: new Decimal(payload.subtotal),
    taxTotal: new Decimal(payload.tax_total),
    total: new Decimal(payload.total),
    changeTotal: new Decimal(payload.change_total),
    lines: payload.lines.map((line) => ({
      lineNo: line.line_no,
      description: line.description,
      qty: new Decimal(line.qty),
      unitPrice: new Decimal(line.unit_price),
      lineSubtotal: new Decimal(line.line_subtotal),
      lineTax: new Decimal(line.line_tax),
      lineTotal: new Decimal(line.line_total),
      taxRate: new Decimal(line.tax_rate),
    })),
    payments: payload.payments.map((payment) => ({
      method: payment.method,
      currency: payment.currency,
      amountTendered: new Decimal(payment.amount_tendered),
      amountApplied: new Decimal(payment.amount_applied),
      rate: new Decimal(payment.rate),
      baseAmount: new Decimal(payment.base_amount),
      changeGiven: new Decimal(payment.change_given),
    })),
    fiscal: {
      status:
        payload.fiscal?.status === 'sent'
          ? 'sent'
          : payload.fiscal?.status === 'pending'
            ? 'pending'
            : 'none',
      signature: payload.fiscal?.signature ?? null,
      qrCode: payload.fiscal?.qr_code ?? null,
      receiptNo: payload.fiscal?.receipt_no ?? null,
      sentAt: payload.fiscal?.sent_at ?? null,
      message: payload.fiscal?.message ?? null,
    },
  };
}

/**
 * The signed-in operator's strip: who is on the till, the branch, the till id, and a live
 * online/offline badge. The badge follows the branch health poll, not `navigator.onLine`, so it
 * shows the truth on a shop LAN whose internet is down.
 */
function SessionBar({
  claims,
  tillId,
  branchId,
  health,
}: {
  claims: SessionClaims | null;
  tillId: string;
  branchId: string | null;
  health: BranchHealthState;
}) {
  const online = health.branchReachable && health.cloudStatus === 'online';
  const label = !health.branchReachable
    ? 'Offline'
    : health.cloudStatus === 'online'
      ? 'Online'
      : health.cloudStatus === 'incompatible'
        ? 'Incompatible'
        : 'Offline';

  return (
    <div className="session" data-testid="session-bar">
      <span data-testid="cashier">{claims?.email ?? 'not signed in'}</span>
      <span data-testid="branch">branch {branchId ? branchId.slice(0, 8) : '—'}</span>
      <span data-testid="till">till {tillId}</span>
      <span
        className={online ? 'badge badge-up' : 'badge badge-off'}
        data-testid="connection-status"
        data-status={online ? 'online' : 'offline'}
      >
        {label}
      </span>
    </div>
  );
}

/**
 * The branch/cloud status badge. Shown always, because a cashier must know whether the cloud is
 * reachable before they need it.
 */
function CloudBadge({ health }: { health: BranchHealthState }) {
  if (!health.branchReachable) {
    return (
      <p className="badge badge-down" data-testid="cloud-badge" data-status="branch-down">
        Branch unreachable — sales queue locally
      </p>
    );
  }

  if (health.cloudStatus === 'online') {
    return (
      <p className="badge badge-up" data-testid="cloud-badge" data-status="online">
        Cloud online
      </p>
    );
  }

  if (health.cloudStatus === 'incompatible') {
    return (
      <p className="badge badge-warn" data-testid="cloud-badge" data-status="incompatible">
        Cloud version mismatch (branch {health.protocolVersion}, cloud {health.cloudProtocolVersion})
        — sync paused
      </p>
    );
  }

  return (
    <p className="badge badge-off" data-testid="cloud-badge" data-status="offline">
      Cloud offline — sales queue locally
    </p>
  );
}

/** 58mm thermal receipt. @page sets the paper width; the article is sized to match. */
const POS_STYLES = `
  @page { width: 58mm; margin: 0; }
  :root { color-scheme: light; }
  body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pos { display: grid; grid-template-columns: 1fr 58mm; gap: 16px; padding: 12px; }
  .left { min-width: 0; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .hint { color: #555; font-size: 12px; margin: 0 0 10px; }
  .session { display: flex; gap: 12px; align-items: center; font-size: 12px; color: #444;
             margin: 0 0 8px; flex-wrap: wrap; }
  .session .badge { margin: 0; }
  .scan-label { display: block; font-size: 12px; color: #555; }
  .scan { width: 100%; font-size: 18px; padding: 8px; }
  .camera { margin: 8px 0; display: flex; gap: 8px; align-items: center; }
  .hits { list-style: none; margin: 6px 0; padding: 0; border: 1px solid #ddd; }
  .hit { padding: 6px 8px; font-size: 14px; }
  .hit.selected { background: #eef; }
  .cart { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 14px; }
  .cart th, .cart td { text-align: left; border-bottom: 1px solid #eee; padding: 6px 4px; }
  .cart .empty { color: #888; }
  .totals { display: flex; gap: 16px; font-size: 14px; align-items: baseline; }
  .totals strong { font-size: 18px; }
  .tenders { margin-top: 8px; font-size: 14px; }
  .pay { margin-top: 8px; padding: 8px; border: 1px solid #333; display: flex; gap: 16px;
         align-items: baseline; font-size: 14px; }
  .status { margin-top: 10px; display: flex; gap: 16px; font-size: 13px; color: #444;
            flex-wrap: wrap; }
  .error { color: #b00; }
  .badge { display: inline-block; margin: 0 0 8px; padding: 2px 8px; border-radius: 10px;
           font-size: 12px; font-weight: 600; }
  .badge-up { background: #e6f4ea; color: #1a7f37; }
  .badge-off { background: #fdecea; color: #b3261e; }
  .badge-warn { background: #fff4e5; color: #b26a00; }
  .badge-down { background: #eee; color: #555; }
  .right { border-left: 1px dashed #bbb; padding-left: 12px; }
  @media print {
    .left { display: none; }
    .right { border: 0; padding: 0; }
  }
`;
