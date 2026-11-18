'use client';

import Link from 'next/link';

/**
 * The reports console's section links. Shared so every report page carries the same navigation and
 * the branch and the cloud console reach the same pages (ADR-0049).
 */
const LINKS: Array<{ href: string; label: string }> = [
  { href: '/reports', label: 'Overview' },
  { href: '/reports/today', label: "Today" },
  { href: '/reports/profit', label: 'Profit' },
  { href: '/reports/vat', label: 'VAT (ZIMRA)' },
  { href: '/reports/stock', label: 'Stock' },
  { href: '/reports/z', label: 'Z-reports' },
];

export function ReportsNav({ current }: { current: string }) {
  return (
    <nav
      data-testid="reports-nav"
      style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}
    >
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          data-testid={`reports-nav-${link.href}`}
          style={{ fontWeight: link.href === current ? 700 : 400 }}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
