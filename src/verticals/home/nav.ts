import { hasRole, type MemberRole } from './roles';

export { hasRole, normalizeRole, roleLabel, type MemberRole } from './roles';

/**
 * The application menu and the home-page shortcuts (F10).
 *
 * One list, filtered by the signed-in member's role, drives both the top menu on the home page and
 * the left sidebar in the app shell, so the two can never drift. A group is shown when it holds at
 * least one visible item. `minimum` is the least role that may see the item.
 *
 * This is a navigation model, not a security boundary: an operator who types a URL still hits RLS
 * (ADR-0077). The role only decides what is offered.
 */

export interface NavItem {
  href: string;
  label: string;
  testId: string;
  minimum: MemberRole;
  /** A short line for the home-page shortcut card. */
  description: string;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'sell',
    label: 'Sell',
    items: [
      {
        href: '/pos',
        label: 'Till (POS)',
        testId: 'nav-pos',
        minimum: 'member',
        description: 'Ring up a sale at the counter',
      },
      {
        href: '/admin/shifts',
        label: 'Shifts',
        testId: 'nav-shifts',
        minimum: 'member',
        description: 'Open and close a till shift',
      },
      {
        href: '/admin/laybys',
        label: 'Laybys',
        testId: 'nav-laybys',
        minimum: 'member',
        description: 'Layby agreements and deposits',
      },
      {
        href: '/admin/returns',
        label: 'Returns',
        testId: 'nav-returns',
        minimum: 'member',
        description: 'Refunds and credit notes',
      },
    ],
  },
  {
    id: 'catalogue',
    label: 'Catalogue',
    items: [
      {
        href: '/admin/products',
        label: 'Products',
        testId: 'nav-products',
        minimum: 'admin',
        description: 'Products, variants, barcodes, batches',
      },
      {
        href: '/admin/categories',
        label: 'Categories',
        testId: 'nav-categories',
        minimum: 'admin',
        description: 'The product category tree',
      },
      {
        href: '/admin/price-lists',
        label: 'Price lists',
        testId: 'nav-price-lists',
        minimum: 'admin',
        description: 'Price lists and customer groups',
      },
      {
        href: '/admin/promotions',
        label: 'Promotions',
        testId: 'nav-promotions',
        minimum: 'admin',
        description: 'Promotions and pricing rules',
      },
    ],
  },
  {
    id: 'stock',
    label: 'Stock',
    items: [
      {
        href: '/reports/stock',
        label: 'Stock reports',
        testId: 'nav-stock-reports',
        minimum: 'admin',
        description: 'On-hand and movements, export to PDF',
      },
      {
        href: '/admin/stocktake',
        label: 'Stock counts',
        testId: 'nav-stocktake',
        minimum: 'admin',
        description: 'Stocktake counts and adjustments',
      },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    items: [
      {
        href: '/reports',
        label: 'Overview',
        testId: 'nav-reports',
        minimum: 'admin',
        description: 'Profit, best sellers and slow movers',
      },
      {
        href: '/reports/today',
        label: 'Today',
        testId: 'nav-reports-today',
        minimum: 'admin',
        description: "Today's live figures",
      },
      {
        href: '/reports/vat',
        label: 'VAT (ZIMRA)',
        testId: 'nav-reports-vat',
        minimum: 'admin',
        description: 'The VAT return, by rate',
      },
      {
        href: '/reports/z',
        label: 'Z-reports',
        testId: 'nav-reports-z',
        minimum: 'admin',
        description: 'Shift Z-reports',
      },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [
      {
        href: '/admin/sync',
        label: 'Sync',
        testId: 'nav-sync',
        minimum: 'admin',
        description: 'Branch sync and the outbox',
      },
      {
        href: '/settings/devices',
        label: 'Devices',
        testId: 'nav-devices',
        minimum: 'admin',
        description: 'Till device codes and registration',
      },
      {
        href: '/settings/fiscal',
        label: 'Fiscal',
        testId: 'nav-fiscal',
        minimum: 'admin',
        description: 'FDMS fiscalisation queue',
      },
      {
        href: '/settings/import',
        label: 'Import',
        testId: 'nav-import',
        minimum: 'admin',
        description: 'Import products and opening stock',
      },
      {
        href: '/cloud/reports',
        label: 'Owner console',
        testId: 'nav-owner-console',
        minimum: 'owner',
        description: 'Group-wide console across branches',
      },
    ],
  },
];

/** The groups whose items the role may see, with the out-of-role items removed. */
export function visibleGroups(role: MemberRole): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => hasRole(role, item.minimum)),
  })).filter((group) => group.items.length > 0);
}

/** Every visible item, flattened, for the home-page shortcut grid. */
export function visibleItems(role: MemberRole): NavItem[] {
  return visibleGroups(role).flatMap((group) => group.items);
}

/** True when `href` is the active menu item for `pathname`. */
export function isActive(pathname: string, href: string): boolean {
  const target = href.split('?')[0]!;
  if (target === '/pos') return pathname === '/pos' || pathname.startsWith('/pos/');
  if (target === '/reports') return pathname === '/reports';
  return pathname === target || pathname.startsWith(`${target}/`);
}
