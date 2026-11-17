import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { buildReceiptData, defaultShop, type ReceiptData } from './receiptData';
import { escPosToBase64, generateEscPos } from './escpos';
import { apiFetch } from './api';

/**
 * Printing (H4).
 *
 * The till prints one of two ways, chosen per branch and stored in `printer_settings`:
 *   * `browser` — the till renders the 58mm receipt and calls `window.print()` (the browser dialog),
 *     and
 *   * `network` — the till generates the ESC/POS bytes and asks the BRANCH to relay them to the
 *     printer on the shop LAN (`host:port`, default 9100). The branch is the only side that opens
 *     the socket (decision 16: the branch makes outbound connections only; a cloud has no printer).
 *
 * The bytes travel to the branch as base64 inside JSON — a transport encoding, nothing more. The
 * branch decodes to raw bytes and writes them straight to the socket.
 */

export type PrinterMode = 'browser' | 'network';

export interface PrinterSettings {
  mode: PrinterMode;
  host: string | null;
  port: number;
  label: string;
}

export interface PrintResult {
  printed: boolean;
  /** How the slip was produced. */
  transport: 'browser' | 'network';
  /** The number of ESC/POS bytes the printer received (0 for a browser print). */
  bytes: number;
  /** Why a network print did not happen, when it did not. */
  reason?: string;
}

/** The default printer settings: the browser dialog, which always works with no configuration. */
export function defaultPrinterSettings(): PrinterSettings {
  return { mode: 'browser', host: null, port: 9100, label: 'default' };
}

/** The row `app.get_printer_settings` returns. */
interface PrinterSettingsRow {
  mode?: unknown;
  host?: unknown;
  port?: unknown;
  label?: unknown;
}

function toPrinterSettings(row: PrinterSettingsRow | undefined): PrinterSettings {
  const mode = row?.mode === 'network' ? 'network' : 'browser';
  const host = typeof row?.host === 'string' && row.host !== '' ? row.host : null;
  const port = typeof row?.port === 'number' && row.port > 0 ? row.port : 9100;
  const label = typeof row?.label === 'string' && row.label !== '' ? row.label : 'default';
  return { mode, host, port, label };
}

/** Read the branch's printer settings (through RLS). Falls back to browser mode. */
export async function loadPrinterSettings(
  client: PoolClient,
  input: { orgId: string; branchId: string; label?: string },
): Promise<PrinterSettings> {
  const result = await client.query<{ app: PrinterSettingsRow }>(
    `select app.get_printer_settings($1, $2, $3) as app`,
    [input.orgId, input.branchId, input.label ?? 'default'],
  );
  return toPrinterSettings(result.rows[0]?.app);
}

/** Save the branch's printer settings. Returns the stored row. */
export async function savePrinterSettings(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    mode: PrinterMode;
    host?: string | null;
    port?: number;
    label?: string;
  },
): Promise<PrinterSettings> {
  const result = await client.query<{ app: PrinterSettingsRow }>(
    `select app.set_printer_settings($1, $2, $3, $4, $5, $6) as app`,
    [
      input.orgId,
      input.branchId,
      input.mode,
      input.host ?? null,
      input.port ?? 9100,
      input.label ?? 'default',
    ],
  );
  return toPrinterSettings(result.rows[0]?.app);
}

/**
 * A print transport: the thing that actually moves bytes to paper. A browser transport calls
 * `window.print()`; a network transport relays the bytes to the branch, which writes them to the
 * printer socket. Injectable so the timing path is observable in a test without a real printer.
 */
export interface PrinterTransport {
  readonly kind: 'browser' | 'network';
  send(bytes: Uint8Array): Promise<PrintResult>;
}

/**
 * True when the till should open the browser print dialog itself. An automated browser
 * (`navigator.webdriver`) must not, because a print dialog would block the run; a real terminal does.
 * The ESC/POS bytes are still generated either way, so a network printer is unaffected.
 */
export function shouldAutoPrint(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.webdriver !== true;
}

/** The browser transport: render the 58mm receipt and open the print dialog. */
export function browserPrinterTransport(): PrinterTransport {
  return {
    kind: 'browser',
    async send(bytes: Uint8Array): Promise<PrintResult> {
      if (typeof window !== 'undefined' && shouldAutoPrint()) {
        try {
          window.print();
        } catch {
          /* a browser without a print dialog (headless) is not an error */
        }
      }
      return { printed: true, transport: 'browser', bytes: bytes.length };
    },
  };
}

/**
 * The network transport: relay the ESC/POS bytes to the branch, which writes them to the printer.
 * The bytes are base64 in the request body; the branch decodes and relays the raw bytes.
 */
export function networkPrinterTransport(
  settings: PrinterSettings,
): PrinterTransport {
  return {
    kind: 'network',
    async send(bytes: Uint8Array): Promise<PrintResult> {
      const response = await apiFetch('/api/printer/relay', {
        method: 'POST',
        body: JSON.stringify({
          host: settings.host,
          port: settings.port,
          base64: escPosToBase64(bytes),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        return {
          printed: false,
          transport: 'network',
          bytes: 0,
          reason: payload.error ?? `relay failed (${response.status})`,
        };
      }
      const payload = (await response.json()) as { printed?: boolean; bytes?: number };
      return {
        printed: payload.printed ?? false,
        transport: 'network',
        bytes: payload.bytes ?? bytes.length,
      };
    },
  };
}

/** Choose the transport for the branch's configured mode. */
export function printerTransport(settings: PrinterSettings): PrinterTransport {
  return settings.mode === 'network' && settings.host
    ? networkPrinterTransport(settings)
    : browserPrinterTransport();
}

/**
 * Turn a receipt into ESC/POS bytes and send them through the transport. This is the single call
 * the till makes after a sale commits; it is synchronous from the caller's point of view (it
 * returns as soon as the transport accepts the bytes).
 */
export async function printReceipt(
  data: ReceiptData,
  transport: PrinterTransport,
): Promise<PrintResult> {
  const bytes = generateEscPos(data);
  try {
    return await transport.send(bytes);
  } catch (error) {
    // Printing must never fail the sale. The sale has already committed; a printer that is off or a
    // relay that is unreachable is reported, not thrown, so the till can retry or fall back.
    return {
      printed: false,
      transport: transport.kind,
      bytes: 0,
      reason: (error as Error).message,
    };
  }
}

/**
 * The till's post-sale step: build the receipt, generate the bytes and print, in one call. Kept
 * separate from the sale POST so the sale's transaction commits before any printing work begins,
 * and so the print is measured on its own.
 */
export async function completeSaleAndPrint(
  data: ReceiptData,
  settings: PrinterSettings,
): Promise<PrintResult> {
  return printReceipt(data, printerTransport(settings));
}

/** A fixed sample receipt, so a test print is byte-for-byte reproducible. */
export function sampleReceiptData(cashier: string, date: Date): ReceiptData {
  return buildReceiptData(
    {
      saleId: '00000000-0000-0000-0000-000000000000',
      invoiceNo: '000000',
      currency: 'USD',
      subtotal: new Decimal('5.0000'),
      taxTotal: new Decimal('0.7500'),
      total: new Decimal('5.7500'),
      changeTotal: new Decimal('0'),
      lines: [
        {
          lineNo: 1,
          description: 'Test print item',
          qty: new Decimal('1'),
          unitPrice: new Decimal('5.0000'),
          lineSubtotal: new Decimal('5.0000'),
          lineTax: new Decimal('0.7500'),
          lineTotal: new Decimal('5.7500'),
          taxRate: new Decimal('0.150000'),
        },
      ],
      payments: [
        {
          method: 'cash',
          currency: 'USD',
          amountTendered: new Decimal('5.7500'),
          amountApplied: new Decimal('5.7500'),
          rate: new Decimal('1'),
          baseAmount: new Decimal('5.7500'),
          changeGiven: new Decimal('0'),
        },
      ],
      fiscal: {
        status: 'none',
        signature: null,
        qrCode: null,
        receiptNo: null,
        sentAt: null,
        message: null,
      },
    },
    { shop: defaultShop(), cashier, zwgRate: new Decimal('30'), date },
  );
}
