'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { hasSession } from '@/core/session';
import { SignInForm } from '@/verticals/home/SignInForm';

/**
 * /login — sign in.
 *
 * The sign-in form itself lives in the home vertical (SignInForm), so the landing page (`/`) and
 * this page share one implementation (F10, ADR-0077). This page keeps the `?next=` redirect target
 * and the branch/cloud mode selection the form already handles.
 */

function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/home';

  // A user who is already signed in does not need the form.
  useEffect(() => {
    if (hasSession()) router.replace(next);
  }, [router, next]);

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
      <SignInForm onSignedIn={() => router.replace(next)} />
    </main>
  );
}

export default function LoginRoute() {
  return (
    <Suspense fallback={null}>
      <LoginPage />
    </Suspense>
  );
}
