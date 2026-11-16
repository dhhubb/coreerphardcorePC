'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { setSession, hasSession } from '@/core/session';

/**
 * /login — email and password sign-in (F1).
 *
 * Posts to /api/auth/login, stores the returned token under `token` and the org id under `org_id`
 * (both in localStorage), then redirects to /pos (or the `next` page the app shell recorded). The
 * server re-verifies the token on every API call, so the stored value is only a convenience.
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

  const [email, setEmail] = useState('admin@demo.com');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A user who is already signed in does not need the form.
  useEffect(() => {
    if (hasSession()) router.replace(next);
  }, [router, next]);

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
      router.replace(next);
    } catch {
      setError('could not reach the server');
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
        data-testid="login-form"
        style={{
          width: 360,
          background: '#ffffff',
          border: '1px solid #e3e6ea',
          borderRadius: 8,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
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
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
