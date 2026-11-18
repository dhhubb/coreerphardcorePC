'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearSession, currentClaims, hasSession, type SessionClaims } from '@/core/session';
import { isActive as isActiveHref, normalizeRole, roleLabel, visibleGroups } from '@/verticals/home/nav';

/**
 * The app shell: a left sidebar, a header with the org name and the signed-in user, and a sign-out
 * button. It wraps every page under /pos, /admin, /reports, /settings and /cloud (see the route
 * group layouts).
 *
 * The sidebar is the same role-filtered menu model the home page uses, so the two can never drift
 * (F10, ADR-0077). The role comes from the token's `member_role` claim, which is a display value:
 * RLS still scopes every read, so the menu only decides what is offered.
 */

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

  const role = normalizeRole(claims?.memberRole);
  const groups = visibleGroups(role);

  const signOut = () => {
    clearSession();
    window.location.href = '/';
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
          overflowY: 'auto',
        }}
      >
        <Link
          href="/home"
          data-testid="sidebar-home"
          style={{
            display: 'block',
            padding: '0 16px 12px',
            fontWeight: 700,
            letterSpacing: 0.3,
            color: '#e7ecf3',
            textDecoration: 'none',
          }}
        >
          ERP Core
        </Link>
        {groups.map((group) => (
          <div key={group.id}>
            <div
              style={{
                padding: '10px 16px 4px',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: 0.6,
                color: '#7f8da0',
              }}
            >
              {group.label}
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {group.items.map((item) => {
                const active = isActiveHref(pathname, item.href);
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
          </div>
        ))}
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
            <span data-testid="user-role" style={{ fontSize: 12, color: '#7f8da0' }}>
              {roleLabel(role)}
            </span>
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
