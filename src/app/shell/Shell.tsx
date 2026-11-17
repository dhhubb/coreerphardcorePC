'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearSession, currentClaims, hasSession, type SessionClaims } from '@/core/session';

/**
 * The app shell: a left sidebar, a header with the org name and the signed-in user, and a sign-out
 * button. It wraps every page under /pos and /admin (see the route group layouts).
 *
 * The shell renders from the token's claims without a server round-trip; the org name is a display
 * value, not an authorisation decision.
 */

interface NavItem {
  href: string;
  label: string;
  testId: string;
}

const NAV: NavItem[] = [
  { href: '/pos', label: 'POS', testId: 'nav-pos' },
  { href: '/admin/products', label: 'Products', testId: 'nav-products' },
  { href: '/admin/categories', label: 'Categories', testId: 'nav-categories' },
  { href: '/admin/price-lists', label: 'Price Lists', testId: 'nav-price-lists' },
  { href: '/admin/promotions', label: 'Promotions', testId: 'nav-promotions' },
  { href: '/admin/shifts', label: 'Shifts', testId: 'nav-shifts' },
  { href: '/reports?tab=z', label: 'Z-Reports', testId: 'nav-z-reports' },
  { href: '/admin/stocktake', label: 'Stock counts', testId: 'nav-stocktake' },
  { href: '/admin/sync', label: 'Sync', testId: 'nav-sync' },
];

function isActive(pathname: string, href: string): boolean {
  const target = href.split('?')[0]!;
  if (target === '/pos') return pathname === '/pos' || pathname.startsWith('/pos/');
  return pathname === target || pathname.startsWith(`${target}/`);
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [claims, setClaims] = useState<SessionClaims | null>(null);

  useEffect(() => {
    if (!hasSession()) {
      // No session: send the operator to sign in, remembering where they were headed. The pages
      // cannot read localStorage on the server, so the gate lives here rather than in middleware.
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    setClaims(currentClaims());
  }, [router, pathname]);

  const signOut = () => {
    clearSession();
    window.location.href = '/login';
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <nav
        aria-label="Main navigation"
        data-testid="sidebar"
        style={{
          width: 220,
          flex: '0 0 220px',
          borderRight: '1px solid #e3e6ea',
          background: '#0b1220',
          color: '#e7ecf3',
          padding: '16px 0',
        }}
      >
        <div style={{ padding: '0 16px 12px', fontWeight: 700, letterSpacing: 0.3 }}>ERP Core</div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  data-testid={item.testId}
                  aria-current={active ? 'page' : undefined}
                  style={{
                    display: 'block',
                    padding: '9px 16px',
                    color: active ? '#ffffff' : '#b9c4d4',
                    background: active ? '#17304f' : 'transparent',
                    textDecoration: 'none',
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header
          data-testid="app-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 24px',
            borderBottom: '1px solid #e3e6ea',
            background: '#ffffff',
          }}
        >
          <span data-testid="org-name" style={{ fontWeight: 600 }}>
            {claims?.orgName ?? claims?.orgId ?? 'ERP Core'}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 12, color: '#5b6472' }}>
            <span data-testid="user-email">{claims?.email ?? ''}</span>
            <button type="button" data-testid="sign-out" onClick={signOut}>
              Sign out
            </button>
          </span>
        </header>
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      </div>
    </div>
  );
}
