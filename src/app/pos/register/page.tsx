'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BranchApiError, registerDeviceWithCode } from '@/branch/client';
import { loadDeviceRegistration, saveDeviceRegistration } from '@/branch/deviceStore';

/**
 * /pos/register — register this till.
 *
 * The operator enters the 6-digit code an admin minted on /settings/devices. The branch redeems it
 * once and issues a device token, which is stored in IndexedDB (deviceStore) so it survives a
 * reload. The raw token is never written anywhere else; the branch keeps only its hash (ADR-0024).
 */

export default function RegisterPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState<string | null>(null);

  // A till that already has a token does not need to register again.
  useEffect(() => {
    void loadDeviceRegistration().then((existing) => {
      if (existing) setRegistered(existing.tillId);
    });
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await registerDeviceWithCode({
        code: code.trim(),
        label: label.trim() === '' ? null : label.trim(),
      });
      const stored = await saveDeviceRegistration({
        deviceToken: result.token,
        tillId: label.trim() === '' ? 'TILL' : label.trim(),
        label: label.trim() === '' ? null : label.trim(),
      });
      setRegistered(stored.tillId);
    } catch (err) {
      setError(err instanceof BranchApiError ? err.message : 'the branch did not answer');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        background: '#f4f6f8',
      }}
    >
      <form
        onSubmit={submit}
        data-testid="register-form"
        style={{
          width: 380,
          background: '#fff',
          border: '1px solid #e3e6ea',
          borderRadius: 8,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20 }}>Register this till</h1>
        <p style={{ margin: 0, color: '#5b6472', fontSize: 13 }}>
          Enter the 6-digit code from Devices settings.
        </p>

        {registered && (
          <p data-testid="register-done" style={{ color: '#1a7f37', margin: 0 }}>
            Registered as {registered}.{' '}
            <button type="button" onClick={() => router.push('/login')} style={{ marginLeft: 4 }}>
              Go to sign in
            </button>
          </p>
        )}

        {error && (
          <p role="alert" data-testid="register-error" style={{ color: '#c0392b', margin: 0 }}>
            {error}
          </p>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          One-time code
          <input
            data-testid="register-code"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))}
            required
            style={{ fontSize: 24, letterSpacing: 6, padding: 8 }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          Till name (optional)
          <input
            data-testid="register-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>

        <button type="submit" data-testid="register-submit" disabled={busy || code.length !== 6}>
          {busy ? 'Registering…' : 'Register'}
        </button>
      </form>
    </main>
  );
}
