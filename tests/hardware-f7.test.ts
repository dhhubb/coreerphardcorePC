import 'fake-indexeddb/auto';
import { createServer, type Server, type Socket } from 'node:net';
import { createElement } from 'react';
import Decimal from 'decimal.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asUser, expectError, sql } from './support/db';
import { createTenant, tenantToken } from './support/fixtures';
import { createScannerController } from '../src/verticals/pos/useScannerInput';
import { ScannerBuffer } from '../src/verticals/pos/scanner';
import { createIndexedDbStorage, memoryStorage } from '../src/verticals/pos/idbStorage';
import { createCartStore } from '../src/verticals/pos/cart';
import { CameraScanner, CAMERA_HTTPS_MESSAGE } from '../src/verticals/pos/CameraScanner';
import { defaultDeviceSettings } from '../src/verticals/pos/deviceSettings';
import { sampleReceiptData } from '../src/verticals/pos/printing';
import { generateEscPos, escPosToBase64 } from '../src/verticals/pos/escpos';
import { GET as deviceGet, PUT as devicePut } from '../src/app/api/pos/device/route';
import { POST as relayPost } from '../src/app/api/printer/relay/route';
import { POST as legacyPrintPost } from '../src/app/api/branch/print/route';

/**
 * F7 — the hardware-and-receipts completion slice. Tests 141–145, continuing from F6's 140
 * (ADR-0010).
 *
 * H4 already shipped the scanner classifier, the shortcuts, the camera helper, the /pos/settings
 * printer page, the 58mm receipt and the ESC/POS generator (tests 69–74). F7 closes the parts of
 * the brief H4 left out: the `useScannerInput` hook with its DOM-free controller, the persisted
 * holds moving to IndexedDB, the `CameraScanner` component and its HTTPS gate, the branch's camera
 * toggle in /pos/settings, and the brief-named POST /api/printer/relay route.
 *
 * Everything runs against the real local Postgres. The relay is exercised against a real TCP server
 * standing in for the printer, and the components are rendered with `react-dom/server` (there is no
 * jsdom in this repo), so no database and no printer is mocked.
 */

const DATE = '2026-06-15';

function request(path: string, token: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

interface FakePrinter {
  server: Server;
  port: number;
  received: () => Promise<Buffer>;
}

/** A TCP server that collects everything written to it, like a printer's raw port. */
async function startFakePrinter(): Promise<FakePrinter> {
  const chunks: Buffer[] = [];
  const server = createServer((socket: Socket) => {
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    server,
    port: address.port,
    received: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Buffer.concat(chunks);
    },
  };
}

let activePrinter: FakePrinter | null = null;

beforeEach(() => {
  // The relay is a branch operation (decision 16); the branch owns the printer socket.
  process.env.BRANCH_MODE = 'branch';
});

afterEach(async () => {
  delete process.env.BRANCH_MODE;
  if (activePrinter) {
    await new Promise<void>((resolve) => activePrinter!.server.close(() => resolve()));
    activePrinter = null;
  }
});

describe('F7 hardware and receipts completion', () => {
  it('141. The scanner controller buffers a fast burst ending in Enter as one barcode and reports a slow burst as human typing', () => {
    // The DOM-free controller the useScannerInput hook drives, exercised with simulated fast typing.
    const controller = createScannerController();
    const code = '9780201379624';

    let decision = controller.feed({ key: code[0]!, timeStamp: 1000 });
    expect(decision.kind).toBe('char');
    for (let i = 1; i < code.length; i += 1) {
      decision = controller.feed({ key: code[i]!, timeStamp: 1000 + i * 20 });
    }
    expect(controller.pending).toBe(code);
    const closed = controller.feed({ key: 'Enter', timeStamp: 1000 + code.length * 20 });
    expect(closed).toEqual({ kind: 'scan', code, fromScanner: true });
    expect(controller.pending).toBe('');

    // A burst typed slower than the 50 ms threshold is a scan but not from a scanner.
    const slow = createScannerController();
    for (let i = 0; i < 5; i += 1) slow.feed({ key: '1', timeStamp: 2000 + i * 200 });
    expect(slow.feed({ key: 'Enter', timeStamp: 3000 })).toEqual({
      kind: 'scan',
      code: '11111',
      fromScanner: false,
    });

    // The hook's controller is the same state machine as the raw buffer.
    expect(new ScannerBuffer().feed({ key: 'a', timeStamp: 0 })).toEqual({ kind: 'char', value: 'a' });
  });

  it('142. The IndexedDB storage round-trips a persisted cart, so parked carts survive a reload with money revived as Decimal', async () => {
    // A real IndexedDB (fake-indexeddb) backs this storage, so the open/upgrade/transaction path is
    // exercised, not a stub.
    const storage = createIndexedDbStorage('f7-cart-test', 'cart');

    const first = createCartStore(storage);
    first.getState().addLine({
      variantId: 'v-1',
      barcode: 'BC-1',
      name: 'Widget',
      qty: new Decimal(2),
      unitPrice: new Decimal('5.0000'),
      taxRate: new Decimal('0.15'),
      lineSubtotal: new Decimal(0),
      lineTax: new Decimal(0),
      lineTotal: new Decimal(0),
    });
    first.getState().hold();
    // The write is asynchronous (IndexedDB); give it a tick to commit.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A fresh store over the same storage rehydrates the parked cart.
    const reloaded = createCartStore(storage);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reloaded.getState().held).toHaveLength(1);
    expect(reloaded.getState().held[0]!.lines[0]!.variantId).toBe('v-1');
    expect(reloaded.getState().held[0]!.total.toFixed(4)).toBe('11.5000');

    // On the server there is no IndexedDB, so the storage degrades to an in-memory map.
    const fallback = memoryStorage();
    expect(await fallback.getItem('missing')).toBeNull();
    await fallback.setItem('k', 'v');
    expect(await fallback.getItem('k')).toBe('v');
  });

  it('143. The CameraScanner component renders the HTTPS note where a camera cannot work, and its settings default the camera off', () => {
    // There is no `window` in this Node test, so `cameraSupported()` is false: the component must
    // render the HTTPS note and no toggle.
    const html = renderToStaticMarkup(createElement(CameraScanner, { onScan: () => {} }));
    expect(html).toContain('data-testid="camera-unsupported"');
    expect(html).toContain(CAMERA_HTTPS_MESSAGE);
    expect(html).not.toContain('data-testid="camera-toggle"');

    // With the affordance suppressed, nothing renders at all.
    expect(
      renderToStaticMarkup(
        createElement(CameraScanner, { onScan: () => {}, showWhenUnsupported: false }),
      ),
    ).toBe('');

    // The device-settings default is the camera off, so a till is keyboard-only until opted in.
    expect(defaultDeviceSettings()).toEqual({ cameraEnabled: false });
  });

  it('144. The branch camera toggle persists through app.get/set_pos_device_settings and is org-scoped under RLS', async () => {
    const tenant = await createTenant('F7 camera toggle');
    const token = tenantToken(tenant);

    // The default is off before anything is configured.
    const initial = await deviceGet(request('/api/pos/device', token));
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ camera_enabled: false });

    // Turn it on and read it back.
    const saved = await devicePut(
      request('/api/pos/device', token, {
        method: 'PUT',
        body: JSON.stringify({ camera_enabled: true }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ camera_enabled: true });

    const reread = await deviceGet(request('/api/pos/device', token));
    expect(await reread.json()).toEqual({ camera_enabled: true });

    // The function upserts: a second write replaces the row rather than adding one.
    await devicePut(
      request('/api/pos/device', token, {
        method: 'PUT',
        body: JSON.stringify({ camera_enabled: false }),
      }),
    );
    const rows = await sql<{ n: number }>(
      'select count(*)::int as n from public.pos_device_settings where org_id = $1',
      [tenant.orgId],
    );
    expect(rows[0]!.n).toBe(1);

    // Another org's user sees none of this org's device settings (RLS on the branch table).
    const other = await createTenant('F7 camera toggle other');
    const otherRead = await deviceGet(request('/api/pos/device', tenantToken(other)));
    expect(await otherRead.json()).toEqual({ camera_enabled: false });

    // A user acting as this org cannot insert a row for another org: the RLS policy rejects it.
    const error = await expectError(() =>
      asUser(tenant.claims, (client) =>
        client.query(
          `insert into public.pos_device_settings (org_id, branch_id, camera_enabled)
           values ($1, $2, true)`,
          [other.orgId, other.branchId],
        ),
      ),
    );
    expect(error.message).toMatch(/row-level security|permission denied/i);
  });

  it('145. POST /api/printer/relay writes the ESC/POS bytes to the printer on the branch LAN, and the H4 path delegates to it', async () => {
    const printer = await startFakePrinter();
    activePrinter = printer;

    const tenant = await createTenant('F7 relay');
    const token = tenantToken(tenant);

    const bytes = generateEscPos(sampleReceiptData('T1', new Date(`${DATE}T10:00:00Z`)));
    const body = JSON.stringify({
      host: '127.0.0.1',
      port: printer.port,
      base64: escPosToBase64(bytes),
    });

    const response = await relayPost(
      request('/api/printer/relay', token, { method: 'POST', body }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { printed: boolean; bytes: number };
    expect(payload.printed).toBe(true);
    expect(payload.bytes).toBe(bytes.length);

    // The printer received the raw bytes, not base64: the first two bytes are ESC @.
    const received = await printer.received();
    expect(received.equals(Buffer.from(bytes))).toBe(true);

    // A missing host is rejected, so the route cannot become an arbitrary TCP client.
    const bad = await relayPost(
      request('/api/printer/relay', token, {
        method: 'POST',
        body: JSON.stringify({ port: printer.port, base64: escPosToBase64(bytes) }),
      }),
    );
    expect(bad.status).toBe(422);

    // The H4 path keeps working by delegating to the brief-named route.
    const second = await startFakePrinter();
    activePrinter = second;
    const legacy = await legacyPrintPost(
      request('/api/branch/print', token, {
        method: 'POST',
        body: JSON.stringify({
          host: '127.0.0.1',
          port: second.port,
          base64: escPosToBase64(bytes),
        }),
      }),
    );
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).printed).toBe(true);
  });
});
