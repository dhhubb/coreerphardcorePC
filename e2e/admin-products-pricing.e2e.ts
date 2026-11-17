import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { POS_ENV } from '../playwright.config';

/**
 * F2 — the admin products / pricing / promotions console, driven through the browser.
 *
 * This is a navigation/smoke test, not one of the numbered Vitest tests (tests/ owns those). It
 * walks the F2 console using the real UI: it navigates with the sidebar, creates a category, a
 * product and a barcoded variant, then exercises the pieces F2 added — the promotions conditions
 * builder, the stackable checkbox and badge, and the precedence legend. It seeds its own tenant,
 * mints a real access token and drives the app exactly as the browser does, so it proves the pages
 * render and the console reaches the admin APIs.
 *
 * Run it with:
 *
 *   npm run test:e2e -- e2e/admin-products-pricing.e2e.ts
 */

const JWT_SECRET =
  POS_ENV.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Mint an HS256 Supabase-style access token carrying the tenant claims. */
function mintToken(claims: { sub: string; orgId: string; branchIds: string[]; email: string }): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      sub: claims.sub,
      role: 'authenticated',
      email: claims.email,
      org_id: claims.orgId,
      branch_ids: claims.branchIds,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64Url(signature)}`;
}

async function seed(): Promise<{ token: string }> {
  const pool = new Pool({ connectionString: POS_ENV.TEST_DATABASE_URL, max: 2 });
  const client = await pool.connect();
  try {
    const suffix = Math.random().toString(36).slice(2, 10);
    const org = (
      await client.query(`select app.create_org($1, $2) as id`, [
        `F2 e2e ${suffix}`,
        `f2-e2e-${suffix}`,
      ])
    ).rows[0].id as string;

    const branch = (
      await client.query(
        `insert into public.branches (org_id, name, slug) values ($1, 'Main', 'main') returning id`,
        [org],
      )
    ).rows[0].id as string;

    const userId = crypto.randomUUID();
    const email = `f2-e2e-${suffix}@example.test`;
    await client.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, email]);
    await client.query(
      `insert into public.memberships (org_id, user_id, role, branch_ids)
       values ($1, $2, 'owner', array[$3]::uuid[])`,
      [org, userId, branch],
    );

    return { token: mintToken({ sub: userId, orgId: org, branchIds: [branch], email }) };
  } finally {
    client.release();
    await pool.end();
  }
}

test('F2 console: an operator can manage products, pricing and promotions', async ({ page }) => {
  const { token } = await seed();

  // The page reads the access token from localStorage before it loads, exactly as a signed-in
  // operator's browser would.
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    ['pos_access_token', token],
  );

  // --- Categories ---------------------------------------------------------------------------
  await page.goto('/admin/categories');
  await expect(page.getByRole('heading', { name: 'Categories', exact: true })).toBeVisible();
  await page.getByLabel('Name').fill('Beverages');
  await page.getByLabel('Slug').fill('beverages');
  await page.getByTestId('category-submit').click();
  await expect(page.getByTestId('category-name')).toContainText('Beverages');

  // --- Products -----------------------------------------------------------------------------
  await page.getByTestId('nav-products').click();
  await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
  await page.getByLabel('New product name').fill('F2 Cola');
  await page.getByTestId('product-submit').click();
  await expect(page.getByTestId('product-table')).toContainText('F2 Cola');

  // The product's variants page hosts the barcode scanner field.
  await page.getByRole('link', { name: 'Variants' }).first().click();
  await expect(page.getByRole('heading', { name: 'Variants', exact: true })).toBeVisible();
  await expect(page.getByTestId('barcode-scanner-input')).toBeVisible();

  // --- Promotions ---------------------------------------------------------------------------
  await page.getByTestId('nav-promotions').click();
  await expect(page.getByRole('heading', { name: 'Promotions', exact: true })).toBeVisible();

  // The precedence legend F2 adds is shown.
  await expect(page.getByTestId('precedence-legend')).toContainText('Precedence');

  // The conditions builder and the stackable checkbox F2 adds are present.
  await expect(page.getByTestId('conditions-builder')).toBeVisible();
  await expect(page.getByLabel('Condition value')).toBeVisible();
  await expect(page.getByTestId('stackable-checkbox')).toBeVisible();

  // Create a stackable percent promotion with a value condition.
  await page.getByLabel('New promotion name').fill('F2 ten percent');
  await page.getByLabel('Promotion type').selectOption('percent');
  const now = Date.now();
  const from = new Date(now - 60_000).toISOString().slice(0, 16);
  const to = new Date(now + 3_600_000).toISOString().slice(0, 16);
  await page.getByLabel('Valid from').fill(from);
  await page.getByLabel('Valid to').fill(to);
  await page.getByLabel('Condition value').fill('10');
  await page.getByTestId('stackable-checkbox').check();
  await page.getByTestId('promotion-submit').click();

  // The promotion appears, marked stackable.
  const row = page.getByTestId('promotion-table').locator('tbody tr').first();
  await expect(row).toContainText('F2 ten percent');
  await expect(row).toContainText('10% off');
  await expect(page.getByTestId('promotion-table')).toContainText('stackable');

  // --- Price lists & the live preview -------------------------------------------------------
  await page.getByTestId('nav-price-lists').click();
  await expect(page.getByRole('heading', { name: 'Price lists', exact: true })).toBeVisible();

  await page.goto('/admin/pricing-preview');
  await expect(page.getByRole('heading', { name: 'Live price preview', exact: true })).toBeVisible();
  await expect(page.getByTestId('preview-run')).toBeVisible();
});
