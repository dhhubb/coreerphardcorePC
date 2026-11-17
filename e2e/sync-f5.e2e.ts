import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { POS_ENV } from '../playwright.config';

/**
 * F5 — the sync console, driven through a browser. This is a navigation/behaviour smoke test, not
 * one of the numbered Vitest tests (tests/sync-f5.test.ts owns 131–135).
 *
 * It runs its own branch-mode dev server, seeds a branch with one conflict, signs in with a PIN, and
 * walks /admin/sync: the summary shows the outbox depth and the cloud protocol version, the conflict
 * row shows BOTH versions (what the branch sent and what the cloud answered), and Retry re-queues
 * the event so the pending count rises.
 *
 * Run it with:
 *
 *   npm run test:e2e -- e2e/sync-f5.e2e.ts
 */

const PORT = 12156;
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
        `F5 e2e ${suffix}`,
        `f5-e2e-${suffix}`,
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
      `f5-cashier-${suffix}@example.test`,
    ]);
    await client.query(`select app.set_cashier_pin($1, $2, $3, $4, $5)`, [
      orgId,
      branchId,
      cashierId,
      '2468',
      true,
    ]);

    // One conflict the cloud really rejected, carrying both versions.
    await client.query(
      `insert into public.sync_conflicts
         (org_id, branch_id, event_id, branch_seq, event_type, reason, both_versions)
       values ($1, $2, gen_random_uuid(), 1, 'sale', 'cloud rejected the sale',
               jsonb_build_object(
                 'local', jsonb_build_object('seq', 1, 'event_type', 'sale',
                                             'payload', jsonb_build_object('total', '5.0000')),
                 'cloud', jsonb_build_object('reason', 'cloud rejected the sale')))`,
      [orgId, branchId],
    );

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
        CLOUD_URL: 'http://127.0.0.1:9',
        NEXT_DIST_DIR: '.next-e2e-f5',
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

test('F5: the sync console shows both conflict versions and retry re-queues the event', async ({ page }) => {
  // Sign in with a PIN; the branch verifies it locally.
  await page.goto(`${BASE}/login`);
  await page.getByTestId('login-pin').fill(seed.pin);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/pos/);

  // The sync console.
  await page.goto(`${BASE}/admin/sync`);
  await expect(page.getByTestId('sync-summary')).toBeVisible();
  await expect(page.getByTestId('conflict-count')).toHaveText('1');

  // The conflict row shows both versions: what the branch sent and what the cloud answered.
  const row = page.getByTestId('conflict-row').first();
  await expect(row).toBeVisible();
  await expect(page.getByTestId('conflict-local').first()).toContainText('sale');
  await expect(page.getByTestId('conflict-cloud').first()).toContainText('cloud rejected the sale');

  // Retry re-queues the local event: the pending count rises to 1.
  await expect(page.getByTestId('pending-count')).toHaveText('0');
  await page.getByRole('button', { name: 'Retry' }).first().click();
  await expect(page.getByTestId('sync-notice')).toContainText('re-queued');
  await expect(page.getByTestId('pending-count')).toHaveText('1', { timeout: 20_000 });
});
