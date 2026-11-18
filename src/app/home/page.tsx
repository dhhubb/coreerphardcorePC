'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { currentClaims, hasSession, type SessionClaims } from '@/core/session';
import {
  normalizeRole,
  roleLabel,
  visibleGroups,
  type NavItem,
  type NavGroup,
} from '@/verticals/home/nav';

/**
 * `/home` — the signed-in home page (F10).
 *
 * A top menu bar carries every group the role may see; a shortcut grid below it links to each of the
 * app's functions, again filtered by the role. Both come from the same navigation model the shell
 * sidebar uses (ADR-0077), so a member sees the till and the counters, an admin sees the catalogue,
 * stock, reports and settings, and an owner also sees the owner console.
 *
 * The role is a display value carried in the token's `member_role` claim; RLS still scopes every
 * read, so the menu only decides what is offered.
 */

function ShortcutCard({ item }: { item: NavItem }) {
  return (
    <Link
      href={item.href}
      data-testid={`shortcut-${item.testId}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 14,
        border: '1px solid #e3e6ea',
        borderRadius: 10,
        background: '#ffffff',
        textDecoration: 'none',
        color: '#12181f',
        minHeight: 84,
      }}
    >
      <span style={{ fontWeight: 600 }}>{item.label}</span>
      <span style={{ fontSize: 12, color: '#5b6472' }}>{item.description}</span>
    </Link>
  );
}

function GroupSection({ group }: { group: NavGroup }) {
  return (
    <section data-testid={`home-group-${group.id}`} style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 15, textTransform: 'uppercase', letterSpacing: 0.6, color: '#5b6472' }}>
        {group.label}
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
        {group.items.map((item) => (
          <ShortcutCard key={item.href} item={item} />
        ))}
      </div>
    </section>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [claims, setClaims] = useState<SessionClaims | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!hasSession()) {
      router.replace('/?next=%2Fhome');
      return;
    }
    setClaims(currentClaims());
    setReady(true);
  }, [router]);

  const role = normalizeRole(claims?.memberRole);
  const groups = visibleGroups(role);

  return (
    <div style={{ minHeight: '100vh', background: '#f7f8fa', fontFamily: 'system-ui, sans-serif' }}>
      <header
        data-testid="home-topbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          padding: '12px 24px',
          background: '#0b1220',
          color: '#e7ecf3',
        }}
      >
        <Link href="/home" style={{ color: '#e7ecf3', fontWeight: 700, textDecoration: 'none' }}>
          ERP Core
        </Link>
        <nav
          aria-label="Top menu"
          data-testid="home-topmenu"
          style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}
        >
          {groups.map((group) => (
            <a
              key={group.id}
              href={`#${group.id}`}
              data-testid={`home-topmenu-${group.id}`}
              style={{ color: '#b9c4d4', textDecoration: 'none', fontSize: 14 }}
            >
              {group.label}
            </a>
          ))}
        </nav>
        <span style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
          <span data-testid="home-user-role">{roleLabel(role)}</span>
          <span data-testid="home-user-email" style={{ color: '#b9c4d4' }}>
            {claims?.email ?? ''}
          </span>
        </span>
      </header>

      <main style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
        <h1 style={{ marginTop: 0 }}>Welcome</h1>
        <p style={{ color: '#5b6472', maxWidth: 720 }}>
          {claims?.orgName ?? 'Your organisation'} — here are the functions your role may use. The
          same menu is in the sidebar on every page.
        </p>

        {ready &&
          groups.map((group) => <GroupSection key={group.id} group={group} />)}
      </main>
    </div>
  );
}
