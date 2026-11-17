import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { POS_ENV } from '../playwright.config';

/**
 * F4 — the branch server UI, driven through a browser. This is a navigation/behaviour smoke test,
 * not one of the numbered Vitest tests (tests/frontend-f4.test.ts owns 128–130, which assert the
 * badge decision, the offline PIN sign-in and the sale with the cloud cut at the module level).
 *
 * It runs its own **branch-mode** dev server, because the pages it exercises — /login (PIN mode),
 * /settings/devices and /pos/register — only exist when BRANCH_MODE=branch. It:
 *   1. seeds a branch with one cashier PIN;
 *   2. shows the PIN form on /login;
 *   3. mints a 6-digit device code on /settings/devices and redeems it on /pos/register;
 *   4. cuts the browser's network and reloads /pos: the app shell still renders and the badge shows
 *      cloud-offline (yellow) while the LAN (branch) is up.
 *
 * Run it with:
 *
 *   npm run test:e2e -- e2e/branch-f4.e2e.ts
 */

const PORT = 12155;
const BASE = `http://127.0.0.1:${PORT}`;

interface Seed {
  orgId: string;
  branchId: string;
  cashierId: string;
  pin: string;
}

let server: ChildProcess | null = null;
let seed: Seed;

async function seedBranch(): Promise<Seed> {
  const pool = new Pool({ connectionString: POS_ENV.TEST_DATABASE_URL, max: 2 });
  const client = await pool.connect();
  try {
    const suffix = randomUUID().slice(0, 8);
    const orgId = (
      await client.query(`select app.create_org($1, $2) as id`, [
        `F4 e2e ${suffix}`,
        `f4-e2e-${suffix}`,
      ])
    ).rows[0].id as string;
    const branchId = (
      await client.query(
        `insert into public.branches (org_id, name, slug) values ($1, 'Main', 'main') returning id`,
        [orgId],
      )
    ).rows[0].id as string;

    const cashierId = randomUUID();
    await client.query(`insert into auth.users (id, email) values ($1, $2)`, [
      cashierId,
      `f4-cashier-${suffix}@example.test`,
    ]);
    await client.query(`select app.set_cashier_pin($1, $2, $3, $4, $5)`, [
      orgId,
      branchId,
      cashierId,
      '2468',
      true,
    ]);

    return { orgId, branchId, cashierId, pin: '2468' };
  } finally {
    client.release();
    await pool.end();
  }
}

async function waitForServer(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server at ${url} did not start`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test.beforeAll(async () => {
  seed = await seedBranch();
  server = spawn(
    'npm',
    ['run', 'dev', '--', '--port', String(PORT), '--hostname', '127.0.0.1'],
    {
      env: {
        ...process.env,
        BRANCH_MODE: 'branch',
        BRANCH_ORG_ID: seed.orgId,
        BRANCH_ID: seed.branchId,
        // The cloud is unreachable: the badge must still render and the till must still work.
        CLOUD_URL: 'http://127.0.0.1:9',
        NEXT_DIST_DIR: '.next-e2e-f4',
      },
      stdio: 'ignore',
    },
  );
  await waitForServer(`${BASE}/login`);
});

test.afterAll(async () => {
  server?.kill('SIGTERM');
  server = null;
});

test('F4: PIN sign-in, device registration, and the offline app shell', async ({ page }) => {
  // 1. /login shows the PIN form in branch mode.
  await page.goto(`${BASE}/login`);
  const form = page.getByTestId('login-form');
  await expect(form).toHaveAttribute('data-mode', 'pin');
  await expect(page.getByTestId('login-cashier')).toContainText('@example.test');

  // The cashier signs in with their PIN; the branch verifies it locally (the cloud is down).
  await page.getByTestId('login-pin').fill(seed.pin);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/pos/);

  // 2. An admin mints a 6-digit code on /settings/devices.
  await page.goto(`${BASE}/settings/devices`);
  await page.getByTestId('device-till-id').fill('TILL-E2E');
  await page.getByTestId('device-create-code').click();
  const code = (await page.getByTestId('device-code-value').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[0-9]{6}$/);

  // 3. The till redeems the code once on /pos/register.
  await page.goto(`${BASE}/pos/register`);
  await page.getByTestId('register-code').fill(code);
  await page.getByTestId('register-submit').click();
  await expect(page.getByTestId('register-done')).toBeVisible();

  // 4. The shell loads with the internet (cloud) off — the LAN branch server is still up. The till
  //    must render and the badge must show cloud-offline (yellow), never trust navigator.onLine.
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('scan')).toBeVisible({ timeout: 20_000 });
  const badge = page.getByTestId('cloud-badge');
  await expect(badge).toHaveAttribute('data-tone', 'yellow', { timeout: 20_000 });
  await expect(badge).toHaveAttribute('data-status', 'offline');

  // The scan box is focused and the till is usable with the cloud down.
  await expect(page.getByTestId('scan')).toBeFocused();
});
