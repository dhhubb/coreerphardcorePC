'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { hasSession } from '@/core/session';
import { SignInForm } from '@/verticals/home/SignInForm';

/**
 * `/` — the landing page. It shows the sign-in form first; a successful sign-in stores the session
 * and then leads to the home page (`/home`), which lays out the menus and shortcuts the signed-in
 * member's role may see (F10, ADR-0077).
 *
 * A visitor who is already signed in skips the form and goes straight to the home page.
 */

function Landing() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/home';
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (hasSession()) {
      router.replace(next);
      return;
    }
    setChecked(true);
  }, [router, next]);

  return (
    <main
      data-testid="landing"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 48,
        flexWrap: 'wrap',
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        background: 'linear-gradient(135deg, #f4f6f8 0%, #e7ecf3 100%)',
      }}
    >
      <section style={{ maxWidth: 420 }}>
        <h1 style={{ margin: 0, fontSize: 34, letterSpacing: -0.5 }}>ERP Core</h1>
        <p style={{ color: '#3b4553', fontSize: 16, lineHeight: 1.5 }}>
          A multi-tenant ERP for retail, pharmacy, hardware and school verticals. Sign in to reach
          the till, the catalogue, stock and reports your role allows.
        </p>
      </section>

      {checked ? <SignInForm onSignedIn={() => router.replace(next)} /> : null}
    </main>
  );
}

export default function LandingPage() {
  return (
    <Suspense fallback={null}>
      <Landing />
    </Suspense>
  );
}

