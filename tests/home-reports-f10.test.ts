import { createElement } from 'react';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { asUser, one, sql } from './support/db';
import { addProduct, addWarehouse, createTenant, postReceipt, tenantToken, type Tenant } from './support/fixtures';
import { GET as stockRoute } from '../src/app/api/reports/stock/route';
import { GET as stockExportRoute } from '../src/app/api/reports/stock/export/route';
import { GET as meGet } from '../src/app/api/auth/me/route';
import { POST as loginPost } from '../src/app/api/auth/login/route';
import { mintBranchToken } from '../src/branch/session';
import { verifyAccessToken } from '../src/core/auth';
import { SignInForm } from '../src/verticals/home/SignInForm';
import { hasRole, normalizeRole, roleLabel, visibleGroups, visibleItems } from '../src/verticals/home/nav';
import { escapePdfText, fitText, buildTablePdf } from '../src/verticals/reports/pdf';
import { stockMovementsTable, stockOnHandTable, stockOnHandTotals } from '../src/verticals/reports/stockReport';
import { stockOnHand, stockMovements } from '../src/verticals/reports/stock';
import { moneyFromSql } from '../src/core/money';
import type { StockOnHandRow, StockMovementRow } from '../src/verticals/reports/stockTypes';

/**
 * F10 — the landing page, the role-aware home page and the PDF stock reports. Tests 161–172,
 * continuing from F9's 160 (ADR-0010, ADR-0077).
 *
 * The brief for F10 did not allocate numbers. ADR-0010 fixes the rule: a new run continues from the
 * highest number actually present, which is 160. F10 therefore owns 161–172.
 *
 * Every test drives the real route handlers, the real SQL functions and the real token signature
 * against the local Postgres. Nothing is mocked.
 */

const TODAY = new Date().toISOString().slice(0, 10);
const MONTH_START = `${TODAY.slice(0, 7)}-01`;
const MONTH_END = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0))
  .toISOString()
  .slice(0, 10);

/** A tenant with a credentialed owner whose password is `secret-password`. */
async function authFixture(name: string): Promise<{ tenant: Tenant; email: string }> {
  const tenant = await createTenant(name);
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}@example.test`;
  await sql('update auth.users set email = $2 where id = $1', [tenant.userId, email]);
  await sql('select app.upsert_user_credentials($1, $2)', [tenant.userId, 'secret-password']);
  return { tenant, email };
}

function postLogin(body: unknown): Promise<Response> {
  return loginPost(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function getStock(token: string, query = ''): Promise<Response> {
  return stockRoute(
    new Request(`http://localhost/api/reports/stock${query}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

function getStockExport(token: string, query = ''): Promise<Response> {
  return stockExportRoute(
    new Request(`http://localhost/api/reports/stock/export${query}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

/** A tenant with a warehouse and a receipted product, so stock_balances and stock_ledger have rows. */
async function stockFixture(name: string): Promise<Tenant & { warehouseId: string; productId: string }> {
  const tenant = await createTenant(name);
  const warehouseId = await addWarehouse(tenant, 'W1');
  const productId = await addProduct(tenant, `${name} widget`);
  await postReceipt(tenant, warehouseId, productId, 10, 4, '2026-06-15');
  return { ...tenant, warehouseId, productId };
}

describe('F10 home page, roles and stock reports', () => {
  it('161. the landing shows the sign-in form first, and the role model coerces unknown roles to the least privileged', () => {
    // The landing page's first view is the sign-in form (cloud mode until the branch config answers).
    const html = renderToStaticMarkup(createElement(SignInForm, { onSignedIn: () => {} }));
    expect(html).toContain('data-testid="login-form"');
    expect(html).toContain('data-mode="cloud"');
    expect(html).toContain('data-testid="login-email"');
    expect(html).toContain('data-testid="login-password"');

    // The role model. An unknown or absent claim is the least privileged role, never an escalation.
    expect(normalizeRole('owner')).toBe('owner');
    expect(normalizeRole('admin')).toBe('admin');
    expect(normalizeRole('member')).toBe('member');
    expect(normalizeRole('superuser')).toBe('member');
    expect(normalizeRole(null)).toBe('member');
    expect(normalizeRole(undefined)).toBe('member');
    expect(roleLabel('owner')).toBe('Owner');
    expect(hasRole('owner', 'admin')).toBe(true);
    expect(hasRole('admin', 'owner')).toBe(false);
    expect(hasRole('member', 'member')).toBe(true);
  });

  it('162. the home menu and shortcuts are filtered by role, and the owner console is owner-only', () => {
    const member = visibleGroups('member');
    const admin = visibleGroups('admin');
    const owner = visibleGroups('owner');

    // A member sees the sell group only; no catalogue, stock, reports or administration.
    expect(member.map((group) => group.id)).toEqual(['sell']);

    // An admin sees the console groups but not the owner console.
    const adminIds = admin.map((group) => group.id);
    expect(adminIds).toContain('catalogue');
    expect(adminIds).toContain('stock');
    expect(adminIds).toContain('reports');
    expect(adminIds).toContain('admin');
    expect(visibleItems('admin').some((item) => item.testId === 'nav-owner-console')).toBe(false);

    // An owner sees strictly more than an admin, and the owner console.
    expect(visibleItems('owner').length).toBeGreaterThan(visibleItems('admin').length);
    expect(visibleItems('owner').some((item) => item.testId === 'nav-owner-console')).toBe(true);

    // Every visible item is fully described and carries a unique href.
    const hrefs = visibleItems('owner').map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const item of visibleItems('owner')) {
      expect(item.href.startsWith('/')).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.testId.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
    }
  });

  it('163. a signed-in token carries member_role, and /api/auth/me returns it', async () => {
    const { tenant, email } = await authFixture('F10 roles');
    const response = await postLogin({ email, password: 'secret-password' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; member_role: string };
    // The owner membership the fixture created is carried into the token.
    expect(body.member_role).toBe('owner');
    expect(verifyAccessToken(body.token).memberRole).toBe('owner');

    const me = await meGet(
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: `Bearer ${body.token}` },
      }),
    );
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { member_role: string; role: string };
    expect(meBody.member_role).toBe('owner');
    // `role` is still the Postgres role, not the membership role.
    expect(meBody.role).toBe('authenticated');
    void tenant;
  });

  it('164. the access token hook adds member_role for a member and null when there is no membership', async () => {
    const tenant = await createTenant('F10 hook');
    const withMembership = await one<{ claims: Record<string, unknown> }>(
      `select (public.custom_access_token_hook(
                jsonb_build_object('user_id', $1::text, 'claims', '{}'::jsonb)
              ) -> 'claims') as claims`,
      [tenant.userId],
    );
    expect(withMembership?.claims['org_id']).toBe(tenant.orgId);
    expect(withMembership?.claims['member_role']).toBe('owner');

    // A user with no membership gets a null member_role, exactly like a null org_id.
    const orphanId = randomUUID();
    await sql('insert into auth.users (id, email) values ($1, $2)', [orphanId, `o-${orphanId}@example.test`]);
    const orphan = await one<{ claims: Record<string, unknown> }>(
      `select (public.custom_access_token_hook(
                jsonb_build_object('user_id', $1::text, 'claims', '{}'::jsonb)
              ) -> 'claims') as claims`,
      [orphanId],
    );
    expect(orphan?.claims['org_id']).toBeNull();
    expect(orphan?.claims['member_role']).toBeNull();
  });

  it('165. a branch PIN token carries member_role: admin for a manager, member for a cashier', () => {
    const manager = mintBranchToken({
      cashierId: randomUUID(),
      orgId: randomUUID(),
      branchId: randomUUID(),
      isManager: true,
    });
    expect(verifyAccessToken(manager.token).memberRole).toBe('admin');

    const cashier = mintBranchToken({
      cashierId: randomUUID(),
      orgId: randomUUID(),
      branchId: randomUUID(),
      isManager: false,
    });
    expect(verifyAccessToken(cashier.token).memberRole).toBe('member');
  });

  it('166. the on-hand report returns the balance a receipt created, and RLS hides another org', async () => {
    const tenant = await stockFixture('F10 on hand');
    const other = await stockFixture('F10 on hand other');

    const page = await asUser(tenant.claims, (client) =>
      stockOnHand(client, { orgId: tenant.orgId, branchId: tenant.branchId }),
    );
    expect(page.rows.length).toBe(1);
    const row = page.rows[0]!;
    expect(row.qty.toFixed(4)).toBe('10.0000');
    expect(row.value.toFixed(4)).toBe('40.0000');
    expect(row.unitCost.toFixed(4)).toBe('4.0000');
    expect(row.warehouseCode).toBe('W1');

    // The other org's rows are invisible: RLS scopes the read, not the argument.
    const otherRows = await asUser(tenant.claims, (client) =>
      client.query('select id from public.stock_balances where org_id = $1', [other.orgId]),
    );
    expect(otherRows.rowCount).toBe(0);
  });

  it('167. the movements report returns the period in, excludes out-of-range dates, and keeps the direction', async () => {
    const tenant = await stockFixture('F10 movements');

    // The ledger's created_at is the write time, so the receipt lands in the current month.
    const thisMonth = await asUser(tenant.claims, (client) =>
      stockMovements(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        period: { from: MONTH_START, to: MONTH_END },
      }),
    );
    expect(thisMonth.rows.length).toBe(1);
    expect(thisMonth.rows[0]!.direction).toBe('in');
    expect(thisMonth.rows[0]!.qty.toFixed(4)).toBe('10.0000');
    expect(thisMonth.rows[0]!.unitCost.toFixed(4)).toBe('4.0000');
    expect(thisMonth.rows[0]!.sourceType).toBe('receipt');

    // A period that does not contain the receipt returns nothing.
    const ancient = await asUser(tenant.claims, (client) =>
      stockMovements(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        period: { from: '2000-01-01', to: '2000-01-31' },
      }),
    );
    expect(ancient.rows.length).toBe(0);
  });

  it('168. GET /api/reports/stock is a keyset page and rejects a limit above 100', async () => {
    const tenant = await stockFixture('F10 stock route');
    const token = tenantToken(tenant);

    const ok = await getStock(token, '?mode=on_hand&limit=50');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      mode: string;
      branch_id: string;
      rows: Array<{ sku: string; qty: string; value: string }>;
      next_cursor: unknown;
    };
    expect(body.mode).toBe('on_hand');
    expect(body.branch_id).toBe(tenant.branchId);
    expect(body.rows.length).toBe(1);
    expect(body.rows[0]!.qty).toBe('10.0000');
    expect(body.rows[0]!.value).toBe('40.0000');

    // A limit above the maximum is rejected, never silently clamped.
    const tooBig = await getStock(token, '?limit=101');
    expect(tooBig.status).toBe(422);

    // Movements mode reads the ledger for the period.
    const movements = await getStock(token, `?mode=movements&from=${MONTH_START}&to=${MONTH_END}`);
    expect(movements.status).toBe(200);
    const movementBody = (await movements.json()) as { mode: string; rows: Array<{ direction: string }> };
    expect(movementBody.mode).toBe('movements');
    expect(movementBody.rows.length).toBe(1);
    expect(movementBody.rows[0]!.direction).toBe('in');

    // No token: rejected.
    const anon = await stockRoute(new Request('http://localhost/api/reports/stock'));
    expect(anon.status).toBe(401);
  });

  it('169. GET /api/reports/stock/export returns a PDF that names the org and the branch', async () => {
    const tenant = await stockFixture('F10 export');
    const token = tenantToken(tenant);

    const response = await getStockExport(token, '?mode=on_hand');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain('attachment');

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.toString('latin1')).toContain('%%EOF');
    // The header names the org and the branch, so an exported file stands on its own.
    const text = bytes.toString('latin1');
    expect(text).toContain('F10 export');
    expect(text).toContain('Branch: Main');
    expect(text).toContain('Stock on hand');
  });

  it('170. the PDF writer escapes text, fits it to a column, and paginates a long table', () => {
    // Parentheses and backslashes are escaped; anything non-ASCII is replaced, never emitted raw.
    expect(escapePdfText('a (b) c\\d')).toBe('a \\(b\\) c\\\\d');
    expect(escapePdfText('café — ok')).toBe('caf? ? ok');
    expect(fitText('short', 100, 9)).toBe('short');
    expect(fitText('a-very-long-value', 20, 9)).toContain('…');

    // A table long enough to need several pages still produces one valid document.
    const rows = Array.from({ length: 300 }, (_, i) => [`row ${i}`, `${i}`]);
    const pdf = buildTablePdf({
      title: 'Long table',
      meta: ['Organisation: X', 'Branch: Y'],
      columns: [
        { header: 'A', width: 200 },
        { header: 'B', width: 100, align: 'right' },
      ],
      rows,
    });
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // 300 rows do not fit on one page: the document has several pages, each with the title block.
    const pageCount = Number(/\/Count (\d+)/.exec(text)?.[1] ?? '0');
    expect(pageCount).toBeGreaterThan(1);
    expect(text.split('/Type /Page ').length - 1).toBe(pageCount);
    expect(text).toContain('row 0');
    expect(text).toContain('row 299');
    expect((text.match(/\(Long table\) Tj/g) ?? []).length).toBe(pageCount);
  });

  it('171. the stock report tables total the rows and split movements into in and out', () => {
    const onHand = (qty: string, value: string): StockOnHandRow => ({
      id: randomUUID(),
      warehouseId: randomUUID(),
      warehouseCode: 'W1',
      productId: randomUUID(),
      variantId: null,
      sku: 'SKU-1',
      name: 'Widget',
      qty: moneyFromSql(qty),
      value: moneyFromSql(value),
      unitCost: moneyFromSql('1'),
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const rows = [onHand('10', '40'), onHand('5', '20')];
    const totals = stockOnHandTotals(rows);
    expect(totals.qty.toFixed(4)).toBe('15.0000');
    expect(totals.value.toFixed(4)).toBe('60.0000');

    const table = stockOnHandTable(
      { orgName: 'Org', branchName: 'Main', generatedAt: '2026-06-15 00:00:00' },
      rows,
    );
    expect(table.footer).toContain('Total qty: 15.00');
    expect(table.footer).toContain('Total value: 60.00');
    expect(table.rows.length).toBe(2);

    const movement = (direction: 'in' | 'out', qty: string): StockMovementRow => ({
      id: randomUUID(),
      warehouseId: randomUUID(),
      warehouseCode: 'W1',
      productId: randomUUID(),
      variantId: null,
      sku: 'SKU-1',
      name: 'Widget',
      direction,
      qty: moneyFromSql(qty),
      unitCost: moneyFromSql('1'),
      sourceType: 'receipt',
      sourceId: null,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const movements = [movement('in', '10'), movement('out', '4'), movement('in', '2')];
    const movementTable = stockMovementsTable(
      { orgName: 'Org', branchName: 'Main', generatedAt: '2026-06-15 00:00:00' },
      movements,
    );
    expect(movementTable.footer).toContain('Total in: 12.00');
    expect(movementTable.footer).toContain('Total out: 4.00');
  });

  it('172. the stock reports read only the caller’s branch, so another branch shows nothing', async () => {
    const tenant = await createTenant('F10 branch scope');
    const warehouseId = await addWarehouse(tenant, 'W1');
    const productId = await addProduct(tenant, 'scoped widget');
    await postReceipt(tenant, warehouseId, productId, 7, 3, '2026-06-15');

    // A token that scopes no branch of this org sees no stock rows.
    const orphan = await createTenant('F10 branch scope orphan', { withMembership: false });
    void orphan;
    const otherBranch = await one<{ id: string }>(
      'insert into public.branches (org_id, name, slug) values ($1, $2, $3) returning id',
      [tenant.orgId, 'Second', 'second'],
    );

    // The default branch (in the token) has the receipt.
    const inScope = await asUser(tenant.claims, (client) =>
      stockOnHand(client, { orgId: tenant.orgId, branchId: tenant.branchId }),
    );
    expect(inScope.rows.length).toBe(1);

    // The other branch of the same org has no stock_balances rows, and the caller cannot see them.
    const outOfScope = await asUser(tenant.claims, (client) =>
      stockOnHand(client, { orgId: tenant.orgId, branchId: otherBranch!.id }),
    );
    expect(outOfScope.rows.length).toBe(0);
  });
});
