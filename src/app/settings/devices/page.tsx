'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  BranchApiError,
  createDeviceCode,
  listDevices,
  type DeviceRow,
} from '@/branch/client';

/**
 * /settings/devices — register tills on the branch.
 *
 * An admin mints a 6-digit one-time code for a till (it expires after 10 minutes), reads it to the
 * operator, and the operator enters it once at /pos/register. Only the hash of the code is stored
 * (ADR-0024), so the code is shown exactly once, here. The list below is the branch's devices; it
 * never contains a hash or a token.
 */

const STATUS_LABEL: Record<string, string> = {
  registered: 'Registered',
  pending: 'Awaiting code',
  expired: 'Code expired',
  revoked: 'Revoked',
};

function deviceStatus(device: DeviceRow): { key: string; label: string } {
  if (device.revoked_at) return { key: 'revoked', label: STATUS_LABEL.revoked! };
  if (device.consumed_at) return { key: 'registered', label: STATUS_LABEL.registered! };
  if (new Date(device.code_expires_at).getTime() <= Date.now()) {
    return { key: 'expired', label: STATUS_LABEL.expired! };
  }
  return { key: 'pending', label: STATUS_LABEL.pending! };
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [tillId, setTillId] = useState('TILL-1');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDevices(await listDevices());
      setError(null);
    } catch (err) {
      setError(err instanceof BranchApiError ? err.message : 'the branch did not answer');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mint = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCode(null);
    try {
      const result = await createDeviceCode({ tillId });
      setCode(result.code);
      await load();
    } catch (err) {
      setError(err instanceof BranchApiError ? err.message : 'could not create a code');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 820, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Devices</h1>
      <p style={{ color: '#5b6472', fontSize: 13, margin: '0 0 20px' }}>
        Register a till by minting a one-time code. Enter it once at the till&rsquo;s
        <code> /pos/register</code>. Codes expire after 10 minutes and work once.
      </p>

      {error && (
        <p role="alert" data-testid="devices-error" style={{ color: '#c0392b' }}>
          {error}
        </p>
      )}

      <form
        onSubmit={mint}
        data-testid="device-code-form"
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 16 }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          Till id
          <input
            data-testid="device-till-id"
            value={tillId}
            onChange={(event) => setTillId(event.target.value)}
            required
          />
        </label>
        <button type="submit" data-testid="device-create-code" disabled={busy}>
          {busy ? 'Creating…' : 'Create one-time code'}
        </button>
      </form>

      {code && (
        <div
          data-testid="device-code"
          style={{
            border: '1px solid #0b5cff',
            borderRadius: 8,
            padding: 16,
            marginBottom: 20,
            background: '#f2f7ff',
          }}
        >
          <p style={{ margin: '0 0 6px', fontSize: 13, color: '#334' }}>
            Show this code to the till. It expires in 10 minutes and can be used once.
          </p>
          <p
            data-testid="device-code-value"
            style={{ margin: 0, fontSize: 34, letterSpacing: 8, fontWeight: 700 }}
          >
            {code}
          </p>
        </div>
      )}

      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>Registered devices</h2>
      <table data-testid="device-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #e3e6ea', padding: 6 }}>Till</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #e3e6ea', padding: 6 }}>Label</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #e3e6ea', padding: 6 }}>Status</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #e3e6ea', padding: 6 }}>Created</th>
          </tr>
        </thead>
        <tbody>
          {devices.length === 0 && (
            <tr>
              <td colSpan={4} style={{ padding: 8, color: '#888' }}>
                No devices yet.
              </td>
            </tr>
          )}
          {devices.map((device) => {
            const status = deviceStatus(device);
            return (
              <tr key={device.id} data-testid="device-row">
                <td style={{ padding: 6, borderBottom: '1px solid #f0f2f4' }}>{device.till_id}</td>
                <td style={{ padding: 6, borderBottom: '1px solid #f0f2f4' }}>{device.label ?? '—'}</td>
                <td style={{ padding: 6, borderBottom: '1px solid #f0f2f4' }} data-status={status.key}>
                  {status.label}
                </td>
                <td style={{ padding: 6, borderBottom: '1px solid #f0f2f4' }}>
                  {new Date(device.created_at).toLocaleString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
