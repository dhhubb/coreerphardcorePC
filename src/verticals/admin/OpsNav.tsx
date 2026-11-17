'use client';

import Link from 'next/link';

/** The operations console's section links. Shared so every page carries the same navigation. */
const LINKS: Array<{ href: string; label: string }> = [
  { href: '/admin/laybys', label: 'Laybys' },
  { href: '/admin/returns', label: 'Returns' },
  { href: '/admin/shifts', label: 'Shifts & Z-reports' },
  { href: '/admin/z-reports', label: 'Z-report slips' },
  { href: '/admin/stocktake', label: 'Stocktake' },
];

export function OpsNav({ current }: { current: string }) {
  return (
    <nav style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          style={{ fontWeight: link.href === current ? 700 : 400 }}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
