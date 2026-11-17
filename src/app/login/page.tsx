'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { setSession, hasSession } from '@/core/session';
import {
  BranchApiError,
  branchConfig,
  listCashiers,
  pinLogin,
  type BranchConfig,
  type CashierRow,
} from '@/branch/client';

/**
 * /login — sign in.
 *
 * Two modes, chosen by the deployment (decision 1):
 *   * branch mode (BRANCH_MODE=branch): the cashier picks their name and enters a PIN. The branch
 *     verifies it locally, so sign-in works with the internet off. Five wrong PINs lock the PIN;
 *     a manager override needs a manager's own PIN.
 *   * cloud mode: email and password, posting to /api/auth/login (F1).
 *
 * The mode comes from GET /api/branch/config. Until it answers, the cloud form is shown, which is
 * the right default: an unset BRANCH_MODE is never branch mode.
 */

interface LoginResponse {
  token: string;
  org_id: string | null;
  org_name: string | null;
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/pos';

  const [config, setConfig] = useState<BranchConfig | null>(null);

  // A user who is already signed in does not need the form.
  useEffect(() => {
    if (hasSession()) router.replace(next);
  }, [router, next]);

  useEffect(() => {
    void branchConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

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
      {config?.pin_login ? (
        <PinForm config={config} onSignedIn={() => router.replace(next)} />
      ) : (
        <CloudForm onSignedIn={() => router.replace(next)} />
      )}
    </main>
  );
}

/** Cloud mode: email and password. */
function CloudForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('admin@demo.com');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<LoginResponse> & {
        error?: string;
      };
      if (!response.ok || !payload.token) {
        setError(payload.error ?? `sign-in failed (${response.status})`);
        return;
      }
      setSession(payload.token, payload.org_id ?? null);
      onSignedIn();
    } catch {
      setError('could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} data-testid="login-form" data-mode="cloud" style={CARD}>
      <h1 style={{ margin: 0, fontSize: 20 }}>Sign in</h1>
      <p style={{ margin: 0, color: '#5b6472', fontSize: 13 }}>ERP Core</p>

      {error && (
        <p role="alert" data-testid="login-error" style={{ color: '#c0392b', margin: 0 }}>
          {error}
        </p>
      )}

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        Email
        <input
          data-testid="login-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        Password
        <input
          data-testid="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>

      <button type="submit" data-testid="login-submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

/** Branch mode: pick a cashier, enter a PIN. */
function PinForm({ config, onSignedIn }: { config: BranchConfig; onSignedIn: () => void }) {
  const [cashiers, setCashiers] = useState<CashierRow[] | null>(null);
  const [cashierId, setCashierId] = useState<string>('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await listCashiers();
      setCashiers(rows);
      setLoadError(null);
      if (rows[0]) setCashierId((current) => current || rows[0]!.cashier_id);
    } catch (err) {
      setLoadError(err instanceof BranchApiError ? err.message : 'the branch did not answer');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await pinLogin({
        cashierId,
        pin,
        orgId: config.org_id,
        branchId: config.branch_id,
      });
      if (!result.ok || !result.token) {
        setError(
          result.locked
            ? 'PIN locked — ask a manager to override'
            : `wrong PIN (${result.failed_attempts} of 5)`,
        );
        setPin('');
        return;
      }
      setSession(result.token, config.org_id);
      onSignedIn();
    } catch (err) {
      setError(err instanceof BranchApiError ? err.message : 'could not reach the branch');
    } finally {
      setBusy(false);
    }
  };

  const selected = cashiers?.find((cashier) => cashier.cashier_id === cashierId) ?? null;

  return (
    <form onSubmit={submit} data-testid="login-form" data-mode="pin" style={CARD}>
      <h1 style={{ margin: 0, fontSize: 20 }}>Sign in</h1>
      <p style={{ margin: 0, color: '#5b6472', fontSize: 13 }}>Branch till — PIN</p>

      {loadError && (
        <p role="alert" data-testid="login-error" style={{ color: '#c0392b', margin: 0 }}>
          {loadError}
        </p>
      )}
      {error && (
        <p role="alert" data-testid="login-error" style={{ color: '#c0392b', margin: 0 }}>
          {error}
        </p>
      )}

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        Cashier
        <select
          data-testid="login-cashier"
          value={cashierId}
          onChange={(event) => setCashierId(event.target.value)}
          required
        >
          {cashiers === null && <option value="">Loading…</option>}
          {cashiers?.length === 0 && <option value="">No cashiers registered</option>}
          {cashiers?.map((cashier) => (
            <option key={cashier.cashier_id} value={cashier.cashier_id}>
              {cashier.label}
              {cashier.is_manager ? ' (manager)' : ''}
              {cashier.locked_until && new Date(cashier.locked_until).getTime() > Date.now()
                ? ' — locked'
                : ''}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        PIN
        <input
          data-testid="login-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          required
        />
      </label>

      <button
        type="submit"
        data-testid="login-submit"
        disabled={busy || !cashierId || pin.length === 0}
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {selected?.is_manager && (
        <p style={{ margin: 0, fontSize: 12, color: '#5b6472' }}>Manager override available.</p>
      )}
    </form>
  );
}

const CARD: React.CSSProperties = {
  width: 360,
  background: '#ffffff',
  border: '1px solid #e3e6ea',
  borderRadius: 8,
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
