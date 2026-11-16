/**
 * Seed a demo tenant so the app is usable from the sign-in page.
 *
 *   npm run db:seed-demo
 *
 * Creates (or reuses) one organisation with:
 *   * an admin user — admin@demo.com / admin123 — with a bcrypt password hash,
 *   * a branch and a till,
 *   * ten products, each with a variant, a barcode and a retail price,
 *   * stock for each product (a receipt, so the till can sell them).
 *
 * It prints the credentials, the barcodes, and a ready-to-use access token. Sign in at /login, or
 * paste the token into the browser console as a shortcut:
 *
 *   localStorage.setItem('token', '<token>'); location.reload();
 *
 * The token carries the same claims the Supabase custom access token hook would add, so the RLS
 * policies apply exactly as they do in production. It expires after 12 hours.
 */
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { mintAccessToken } from '../src/core/auth';

const DEMO_EMAIL = 'admin@demo.com';
const DEMO_PASSWORD = 'admin123';

function loadEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && match[1]) out[match[1]] = match[2] ?? '';
  }
  return out;
}

const fileEnv = {
  ...loadEnvFile(path.resolve(__dirname, '..', '.env.local')),
  ...loadEnvFile(path.resolve(__dirname, '..', '.env.test')),
};

// The token is signed with the local Supabase JWT secret; make it visible to src/core/auth.ts.
for (const [key, value] of Object.entries(fileEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const PRODUCTS = [
  { name: 'Coffee 250g', barcode: 'DEMO-COFFEE', price: '5.0000', cost: '2.0000' },
  { name: 'Bread loaf', barcode: 'DEMO-BREAD', price: '2.5000', cost: '1.1000' },
  { name: 'Milk 1L', barcode: 'DEMO-MILK', price: '1.7500', cost: '0.9000' },
  { name: 'Sugar 1kg', barcode: 'DEMO-SUGAR', price: '3.2000', cost: '1.6000' },
  { name: 'Cooking oil 2L', barcode: 'DEMO-OIL', price: '6.5000', cost: '3.8000' },
  { name: 'Maize meal 10kg', barcode: 'DEMO-MAIZE', price: '12.0000', cost: '8.0000' },
  { name: 'Tea bags 100', barcode: 'DEMO-TEA', price: '4.1000', cost: '2.2000' },
  { name: 'Soap bar', barcode: 'DEMO-SOAP', price: '1.2000', cost: '0.5500' },
  { name: 'Matches pack', barcode: 'DEMO-MATCHES', price: '0.8000', cost: '0.3000' },
  { name: 'Salt 500g', barcode: 'DEMO-SALT', price: '0.9000', cost: '0.4000' },
];

async function main(): Promise<void> {
  const connectionString =
    process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? fileEnv.TEST_DATABASE_URL ?? fileEnv.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Set DATABASE_URL or TEST_DATABASE_URL (see supabase status)');
  }

  const pool = new Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  try {
    // Reuse the demo org if it exists, so re-running the seed does not pile up tenants.
    const existingOrg = await client.query<{ id: string }>(
      `select id from public.organizations where slug = 'demo' limit 1`,
    );
    const org =
      existingOrg.rows[0]?.id ??
      (
        await client.query('select app.create_org($1, $2) as id', ['Demo store', 'demo'])
      ).rows[0].id as string;

    const existingBranch = await client.query<{ id: string }>(
      `select id from public.branches where org_id = $1 and slug = 'main' limit 1`,
      [org],
    );
    const branch =
      existingBranch.rows[0]?.id ??
      (
        await client.query(
          `insert into public.branches (org_id, name, slug) values ($1, 'Main', 'main') returning id`,
          [org],
        )
      ).rows[0].id as string;

    const existingWarehouse = await client.query<{ id: string }>(
      `select id from public.warehouses where org_id = $1 and code = 'W1' limit 1`,
      [org],
    );
    const warehouse =
      existingWarehouse.rows[0]?.id ??
      (
        await client.query(
          `insert into public.warehouses (org_id, branch_id, code, name)
           values ($1, $2, 'W1', 'Shop floor') returning id`,
          [org, branch],
        )
      ).rows[0].id as string;

    const existingList = await client.query<{ id: string }>(
      `select id from public.price_lists where org_id = $1 and kind = 'retail' limit 1`,
      [org],
    );
    const priceList =
      existingList.rows[0]?.id ??
      (
        await client.query(
          `insert into public.price_lists (org_id, name, kind) values ($1, 'Retail', 'retail') returning id`,
          [org],
        )
      ).rows[0].id as string;

    // The admin user: reuse by email, set the password hash every run so the credentials always work.
    const userId = await upsertAdminUser(client, DEMO_EMAIL, DEMO_PASSWORD, org, branch);

    // Products: only seed the ones that are missing, so re-running is idempotent.
    const seeded: Array<{ name: string; barcode: string; price: string }> = [];
    for (const item of PRODUCTS) {
      const exists = await client.query<{ id: string }>(
        `select v.id from public.product_variants v
          where v.org_id = $1 and v.barcode = $2 limit 1`,
        [org, item.barcode],
      );
      if (exists.rows[0]) {
        seeded.push({ name: item.name, barcode: item.barcode, price: item.price });
        continue;
      }

      const product = (
        await client.query(
          `insert into public.products (org_id, sku, name)
           values ($1, app.next_number($1, 'SKU'), $2) returning id`,
          [org, item.name],
        )
      ).rows[0].id as string;

      const variant = (
        await client.query(
          `insert into public.product_variants (org_id, product_id, sku, name, barcode)
           values ($1, $2, app.next_number($1, 'SKU'), 'Standard', $3) returning id`,
          [org, product, item.barcode],
        )
      ).rows[0].id as string;

      await client.query(
        `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
         values ($1, $2, $3, $4)`,
        [org, priceList, variant, item.price],
      );

      await client.query(`select app.post_receipt($1, $2, $3, $4, $5, 100, $6, current_date)`, [
        org,
        branch,
        warehouse,
        product,
        variant,
        item.cost,
      ]);

      seeded.push({ name: item.name, barcode: item.barcode, price: item.price });
    }

    const token = mintAccessToken({
      sub: userId,
      orgId: org,
      orgName: 'Demo store',
      branchIds: [branch],
      email: DEMO_EMAIL,
    });

    console.log('');
    console.log('Seeded demo tenant.');
    console.log('');
    console.log(`  Sign in at /login:`);
    console.log(`    email:    ${DEMO_EMAIL}`);
    console.log(`    password: ${DEMO_PASSWORD}`);
    console.log('');
    console.log(`  Organisation: Demo store (${org})`);
    console.log(`  Branch:       Main (${branch})`);
    console.log(`  Till:         TILL-1`);
    console.log('');
    console.log('  Products (scan these barcodes at /pos):');
    for (const item of seeded) console.log(`    ${item.barcode.padEnd(16)} ${item.name.padEnd(20)} ${item.price}`);
    console.log('');
    console.log('  Or, as a shortcut, paste this in the browser console, then reload:');
    console.log('');
    console.log(`    localStorage.setItem('token', '${token}'); location.reload();`);
    console.log('');
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Create or reuse the demo admin user and set its password. The password hash is written by
 * `app.upsert_user_credentials`, which calls pgcrypto's bcrypt in the database, so the plaintext
 * never reaches a table. The membership is (re)written so the login context resolves the org.
 */
async function upsertAdminUser(
  client: PoolClient,
  email: string,
  password: string,
  org: string,
  branch: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    'select id from auth.users where lower(email) = lower($1) limit 1',
    [email],
  );
  let userId = existing.rows[0]?.id;
  if (!userId) {
    userId = randomUUID();
    await client.query('insert into auth.users (id, email) values ($1, $2)', [userId, email]);
  }

  await client.query('select app.upsert_user_credentials($1, $2)', [userId, password]);

  await client.query(
    `insert into public.memberships (org_id, user_id, role, branch_ids)
     values ($1, $2, 'owner', array[$3]::uuid[])
     on conflict (org_id, user_id) do update
       set role = 'owner', branch_ids = array[$3]::uuid[], is_active = true`,
    [org, userId, branch],
  );

  return userId;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
