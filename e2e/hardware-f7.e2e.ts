import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { POS_ENV } from '../playwright.config';

/**
 * F7 — hardware and receipts completion, keyboard only.
 *
 * This is a navigation/behaviour smoke test, not one of the numbered Vitest tests (tests/hardware-f7
 * .test.ts owns 141–145). It proves the brief's headline flow end to end: a one-item cash sale is
 * scan → F9 (pay exact) → Enter, with the scan read at the document level by `useScannerInput` even
 * though the scan field is blurred, and the camera scanner absent on an insecure (http) origin.
 *
 * Run it with:
 *
 *   npm run test:e2e -- e2e/hardware-f7.e2e.ts
 */

const JWT_SECRET =
  POS_ENV.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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
  barcode: string;
  orgId: string;
}

async function seed(): Promise<Seed> {
  const pool = new Pool({ connectionString: POS_ENV.TEST_DATABASE_URL, max: 2 });
  const client = await pool.connect();
  try {
    const suffix = Math.random().toString(36).slice(2, 10);
    const org = (
      await client.query(`select app.create_org($1, $2) as id`, [`F7 e2e ${suffix}`, `f7-e2e-${suffix}`])
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
         values ($1, $2, 'W1', 'W1') returning id`,
        [org, branch],
      )
    ).rows[0].id as string;

    const product = (
      await client.query(
        `insert into public.products (org_id, sku, name)
         values ($1, app.next_number($1, 'SKU'), 'F7 widget') returning id`,
        [org],
      )
    ).rows[0].id as string;

    const barcode = `F7-${suffix}`;
    const variant = (
      await client.query(
        `insert into public.product_variants (org_id, product_id, sku, name, barcode)
         values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
        [org, product, barcode],
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

    // The branch has the camera turned off, so the till stays keyboard-only.
    await client.query(
      `select app.set_pos_device_settings($1, $2, false)`,
      [org, branch],
    );

    const userId = crypto.randomUUID();
    const email = `f7-${suffix}@example.test`;
    await client.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, email]);
    await client.query(
      `insert into public.memberships (org_id, user_id, role, branch_ids)
       values ($1, $2, 'owner', array[$3]::uuid[])`,
      [org, userId, branch],
    );

    return {
      token: mintToken({ sub: userId, orgId: org, branchIds: [branch], email }),
      barcode,
      orgId: org,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

test('F7. A one-item cash sale is scan → F9 → Enter, read at the document level, and the camera is absent on http', async ({
  page,
}) => {
  const { token, barcode } = await seed();

  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    ['pos_access_token', token],
  );

  await page.goto('/pos');

  const scan = page.getByTestId('scan');
  await expect(scan).toBeFocused();

  // Blur the field: the hook reads the document, so a keyboard-wedge scan still lands.
  await scan.evaluate((element: HTMLInputElement) => element.blur());
  await expect(scan).not.toBeFocused();

  // Scan one item.
  await page.keyboard.type(barcode, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cart-line')).toHaveCount(1);

  // F9 tenders the exact amount; the remaining balance is zero.
  await page.keyboard.press('F9');
  await expect(page.getByTestId('pay-panel')).toBeVisible();
  await expect(page.getByTestId('remaining')).toHaveText('Remaining 0.00');

  // Enter confirms and the sale is paid.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('status')).toHaveText('paid');
  await expect(page.getByTestId('receipt-total')).toHaveText('5.75');

  // The camera scanner is not offered: the branch turned it off, and the origin is not secure.
  await expect(page.getByTestId('camera-scanner')).toHaveCount(0);
});
