'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, apiJson } from '@/verticals/pos/api';
import { Receipt58mm } from '@/verticals/pos/Receipt58mm';
import { sampleReceiptData } from '@/verticals/pos/printing';
import type { PrinterMode, PrinterSettings } from '@/verticals/pos/printing';
import { CAMERA_HTTPS_MESSAGE } from '@/verticals/pos/CameraScanner';
import { cameraSupported } from '@/verticals/pos/camera';

/**
 * Printer and device settings (H4, extended by F7).
 *
 * The operator chooses how the till prints: the browser's print dialog, or a network printer on the
 * shop LAN (`host:port`, default 9100) that the branch relays the ESC/POS bytes to. A test-print
 * button proves the choice before the next customer arrives. The settings live in the database, so
 * every till in the branch prints the same way.
 *
 * F7 adds the optional camera scanner: the branch turns it on here, and the till then offers it.
 * A camera needs a secure context (HTTPS), so the toggle says so where the page is not secure.
 */
export default function PrinterSettingsPage() {
  const [mode, setMode] = useState<PrinterMode>('browser');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('9100');
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [cameraSecure, setCameraSecure] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setCameraSecure(cameraSupported());
    void (async () => {
      try {
        const settings = await apiJson<PrinterSettings>('/api/pos/printer');
        setMode(settings.mode);
        setHost(settings.host ?? '');
        setPort(String(settings.port));
      } catch {
        /* no settings yet; keep the browser default */
      }
      try {
        const device = await apiJson<{ camera_enabled: boolean }>('/api/pos/device');
        setCameraEnabled(device.camera_enabled);
      } catch {
        /* no device settings yet; keep the camera off */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const save = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const settings = await apiJson<PrinterSettings>('/api/pos/printer', {
        method: 'PUT',
        body: JSON.stringify({
          mode,
          host: mode === 'network' ? host : null,
          port: Number.parseInt(port, 10) || 9100,
        }),
      });
      setMode(settings.mode);
      setHost(settings.host ?? '');
      setPort(String(settings.port));
      await apiJson<{ camera_enabled: boolean }>('/api/pos/device', {
        method: 'PUT',
        body: JSON.stringify({ camera_enabled: cameraEnabled }),
      });
      setStatus('Saved');
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [mode, host, port, cameraEnabled]);

  const testPrint = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const result = await apiJson<{
        printed: boolean;
        transport: 'browser' | 'network';
        bytes?: number;
        base64?: string;
      }>('/api/pos/printer/test', { method: 'POST', body: JSON.stringify({}) });
      if (result.transport === 'browser') {
        // The browser owns the dialog; open the 58mm sample and print it.
        window.print();
        setStatus('Browser print dialog opened');
      } else {
        setStatus(`Printed ${result.bytes ?? 0} bytes to ${host}:${port}`);
      }
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [host, port]);

  const sample = sampleReceiptData('TILL-1', new Date());

  return (
    <main style={{ padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <style>{`@page { width: 58mm; margin: 0; }
        @media print { .no-print { display: none !important; } .print-only { display: block !important; } }
        .print-only { display: none; }`}</style>
      <h1 className="no-print">Printer settings</h1>

      <section className="no-print" style={{ maxWidth: 520 }}>
        <label style={{ display: 'block', marginBottom: 12 }}>
          Printing mode
          <select
            data-testid="printer-mode"
            value={mode}
            disabled={!loaded}
            onChange={(event) => setMode(event.target.value as PrinterMode)}
            style={{ display: 'block', marginTop: 4, padding: 6 }}
          >
            <option value="browser">Browser print dialog</option>
            <option value="network">Network printer (relayed by the branch)</option>
          </select>
        </label>

        {mode === 'network' && (
          <>
            <label style={{ display: 'block', marginBottom: 12 }}>
              Printer IP / host
              <input
                data-testid="printer-host"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="192.168.1.50"
                style={{ display: 'block', marginTop: 4, padding: 6, width: '100%' }}
              />
            </label>
            <label style={{ display: 'block', marginBottom: 12 }}>
              Port
              <input
                data-testid="printer-port"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                style={{ display: 'block', marginTop: 4, padding: 6, width: 120 }}
              />
            </label>
          </>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button data-testid="printer-save" onClick={() => void save()} style={{ padding: '8px 16px' }}>
            Save
          </button>
          <button data-testid="printer-test" onClick={() => void testPrint()} style={{ padding: '8px 16px' }}>
            Test print
          </button>
        </div>

        {status && <p data-testid="printer-status">{status}</p>}
        {error && <p data-testid="printer-error" style={{ color: '#b00' }}>{error}</p>}

        <p style={{ color: '#555', fontSize: 13 }}>
          A network printer is reached by the branch server on the shop LAN; the till sends ESC/POS
          bytes and the branch writes them to the printer&apos;s raw port. Browser mode always works
          with no configuration.
        </p>

        <hr style={{ margin: '20px 0' }} />

        <h2 style={{ fontSize: 16 }}>Camera scanner</h2>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <input
            type="checkbox"
            data-testid="camera-enabled"
            checked={cameraEnabled}
            disabled={!loaded}
            onChange={(event) => setCameraEnabled(event.target.checked)}
          />
          Offer the camera scanner on this branch&apos;s tills
        </label>
        {!cameraSecure && (
          <p data-testid="camera-insecure-note" style={{ color: '#b00', fontSize: 13 }}>
            {CAMERA_HTTPS_MESSAGE}. Serve the till over HTTPS to use a camera.
          </p>
        )}
      </section>

      <section className="print-only">
        <Receipt58mm data={sample} />
      </section>
    </main>
  );
}
