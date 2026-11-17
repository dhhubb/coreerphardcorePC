import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { POS_ENV } from '../playwright.config';

/**
 * F3 — the Z-report page and the stocktake progress bar, driven through the browser.
 *
 * This is a navigation/smoke test, not one of the numbered Vitest tests (tests/ owns those). It
 * closes a shift (writing one immutable Z-report), then walks /admin/z-reports: the list shows the
 * report, "View / print" renders the 58mm slip, and the slip carries the report's totals. It then
 * opens a stock count and proves the progress bar tracks the counted lines.
 *
 * Run it with:
 *
 *   npm run test:e2e -- e2e/operations-f3.e2e.ts
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

interface Seed {
  token: string;
  zNo: string;
}

/** One tenant with a closed shift (one Z-report) and stock on hand for a stock count. */
async function seed(): Promise<Seed> {
  const pool = new Pool({ connectionString: POS_ENV.TEST_DATABASE_URL, max: 2 });
  const client = await pool.connect();
  try {
    const suffix = Math.random().toString(36).slice(2, 10);
    const org = (
      await client.query(`select app.create_org($1, $2) as id`, [
        `F3 e2e ${suffix}`,
        `f3-e2e-${suffix}`,
      ])
    ).rows[0].id as string;

    const branch = (
      await client.query(
        `insert into public.branches (org_id, name, slug) values ($1, 'Main', 'main') returning id`,
        [org],
      )
    ).rows[0].id as string;

    const warehouse = (
      await client.query(
        `insert into public.warehouses (org_id, branch_id, code, name)
         values ($1, $2, 'W1', 'Shop floor') returning id`,
        [org, branch],
      )
    ).rows[0].id as string;

    const product = (
      await client.query(
        `insert into public.products (org_id, sku, name)
         values ($1, app.next_number($1, 'SKU'), 'F3 widget') returning id`,
        [org],
      )
    ).rows[0].id as string;

    const variant = (
      await client.query(
        `insert into public.product_variants (org_id, product_id, sku, name, barcode)
         values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
        [org, product, `F3E2E-${suffix}`],
      )
    ).rows[0].id as string;

    const priceList = (
      await client.query(
        `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
        [org],
      )
    ).rows[0].id as string;
    await client.query(
      `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
       values ($1, $2, $3, 5.0000)`,
      [org, priceList, variant],
    );

    await client.query(`select app.post_receipt($1, $2, $3, $4, $5, 100, 2, '2026-06-15'::date)`, [
      org,
      branch,
      warehouse,
      product,
      variant,
    ]);

    const shift = (
      await client.query(
        `insert into public.shifts (org_id, branch_id, till_id, opening_float)
         values ($1, $2, 'T1', 0) returning id`,
        [org, branch],
      )
    ).rows[0].id as string;

    // One cash sale of a single 5.0000 line, then close the shift to write one Z-report.
    await client.query(
      `select app.post_pos_sale($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, null, '2026-06-15'::date)`,
      [
        org,
        branch,
        warehouse,
        shift,
        crypto.randomUUID(),
        JSON.stringify([{ variant_id: variant, qty: 1 }]),
        JSON.stringify([{ method: 'cash', currency: 'USD', amount_tendered: 100 }]),
      ],
    );

    const userId = crypto.randomUUID();
    const email = `f3-e2e-${suffix}@example.test`;
    await client.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, email]);
    await client.query(
      `insert into public.memberships (org_id, user_id, role, branch_ids)
       values ($1, $2, 'owner', array[$3]::uuid[])`,
      [org, userId, branch],
    );

    const closed = (
      await client.query(`select app.close_shift($1, $2, $3) as z_id`, [org, shift, userId])
    ).rows[0].z_id as string;
    const zNo = (
      await client.query(`select z_no from public.z_reports where id = $1`, [closed])
    ).rows[0].z_no as string;

    return {
      token: mintToken({ sub: userId, orgId: org, branchIds: [branch], email }),
      zNo,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

test('F3: a Z-report prints at 58mm and the stocktake progress bar tracks counted lines', async ({
  page,
}) => {
  const { token, zNo } = await seed();

  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    ['pos_access_token', token],
  );

  // --- Z-reports page: list, then the 58mm slip ---------------------------------------------
  await page.goto('/admin/z-reports');
  await expect(page.getByRole('heading', { name: 'Z-reports', exact: true })).toBeVisible();

  const row = page.getByTestId('z-report-table').locator('tbody tr', { hasText: zNo });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: 'View / print' }).click();
  const slip = page.getByTestId('z-report-58');
  await expect(slip).toBeVisible();
  // 1 x 5.0000 subtotal = 5.0000 gross, plus 15% VAT = 0.7500.
  await expect(page.getByTestId('z-gross')).toHaveText('5.00');
  await expect(page.getByTestId('z-tax-total')).toHaveText('0.75');
  await expect(page.getByTestId('z-sale-count')).toHaveText('1');
  await expect(page.getByTestId('z-by-method')).toContainText('cash');
  await expect(page.getByTestId('z-footer')).toContainText('Powered by AfritecX');

  // The slip is exactly 58mm wide (58mm at 96dpi ≈ 219.2px; allow a pixel for rounding).
  const width = await slip.evaluate((node) => parseFloat(getComputedStyle(node).width));
  expect(width).toBeGreaterThan(218);
  expect(width).toBeLessThan(220.5);

  // --- Stocktake progress bar ---------------------------------------------------------------
  await page.getByRole('link', { name: 'Stocktake' }).click();
  await expect(page.getByRole('heading', { name: 'Stocktake', exact: true })).toBeVisible();

  await page.getByLabel('Warehouse').selectOption({ index: 1 });
  await page.getByTestId('open-count').click();
  await expect(page.getByTestId('active-count')).toBeVisible();

  // Nothing counted yet: the bar is empty.
  const progress = page.getByTestId('count-progress');
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByTestId('count-progress-label')).toContainText('0 of 1');
  expect(await page.getByTestId('count-progress-bar').evaluate((node) => (node as HTMLElement).style.width)).toBe('0%');

  // Enter the counted quantity: the bar fills.
  await page.getByLabel(/Counted qty/).first().fill('90');
  await expect(page.getByTestId('count-progress-label')).toContainText('1 of 1');
  await expect(progress).toHaveAttribute('aria-valuenow', '100');
  expect(await page.getByTestId('count-progress-bar').evaluate((node) => (node as HTMLElement).style.width)).toBe('100%');
});
