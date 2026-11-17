import { randomUUID } from 'node:crypto';
import { sql, tx } from './db';

/**
 * The tenant tables. `scope` is 'org' or 'branch'; `volatile` marks the tables whose rows are
 * created by the posting functions rather than by hand.
 */
export interface TenantTable {
  name: string;
  scope: 'org' | 'branch';
  /** Branch-scoped tables that must carry (org_id, branch_id, created_at desc, id desc). */
  highVolume: boolean;
  /** Partitioned on created_at. */
  partitioned: boolean;
}

export const TENANT_TABLES: TenantTable[] = [
  { name: 'organizations', scope: 'org', highVolume: false, partitioned: false },
  { name: 'branches', scope: 'org', highVolume: false, partitioned: false },
  { name: 'memberships', scope: 'org', highVolume: false, partitioned: false },
  { name: 'invites', scope: 'org', highVolume: false, partitioned: false },
  { name: 'settings', scope: 'org', highVolume: false, partitioned: false },
  { name: 'number_series', scope: 'org', highVolume: false, partitioned: false },
  { name: 'products', scope: 'org', highVolume: false, partitioned: false },
  { name: 'product_variants', scope: 'org', highVolume: false, partitioned: false },
  { name: 'contacts', scope: 'org', highVolume: false, partitioned: false },
  { name: 'chart_of_accounts', scope: 'org', highVolume: false, partitioned: false },
  { name: 'tax_rates', scope: 'org', highVolume: false, partitioned: false },
  { name: 'exchange_rates', scope: 'org', highVolume: false, partitioned: false },
  { name: 'fiscal_periods', scope: 'org', highVolume: false, partitioned: false },
  { name: 'warehouses', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'stock_ledger', scope: 'branch', highVolume: true, partitioned: true },
  { name: 'stock_consumptions', scope: 'branch', highVolume: true, partitioned: true },
  { name: 'stock_balances', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'stock_layer_balances', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'stock_transfers', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'journals', scope: 'branch', highVolume: true, partitioned: true },
  { name: 'journal_lines', scope: 'branch', highVolume: true, partitioned: true },
  { name: 'sales_orders', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'invoices', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'invoice_lines', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'payments', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'credit_notes', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'purchase_orders', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'audit_logs', scope: 'branch', highVolume: true, partitioned: true },
  // R1 (retail): products, barcodes and search.
  { name: 'categories', scope: 'org', highVolume: false, partitioned: false },
  { name: 'product_batches', scope: 'org', highVolume: false, partitioned: false },
  // R2 (retail): pricing and promotions.
  { name: 'price_lists', scope: 'org', highVolume: false, partitioned: false },
  { name: 'price_list_items', scope: 'org', highVolume: false, partitioned: false },
  { name: 'customer_groups', scope: 'org', highVolume: false, partitioned: false },
  { name: 'promotions', scope: 'org', highVolume: false, partitioned: false },
  { name: 'discount_limits', scope: 'org', highVolume: false, partitioned: false },
  { name: 'manual_discounts', scope: 'branch', highVolume: true, partitioned: false },
  // R3 (retail): online POS sale.
  { name: 'shifts', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'pos_sales', scope: 'branch', highVolume: true, partitioned: true },
  { name: 'pos_payments', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'pos_sale_keys', scope: 'org', highVolume: false, partitioned: false },
  // R4 (retail): offline outbox and sync.
  { name: 'pos_sync_exceptions', scope: 'branch', highVolume: true, partitioned: false },
  // R5 (operations): laybys, returns, credit limits, z-reports, stock counts.
  { name: 'credit_limits', scope: 'org', highVolume: false, partitioned: false },
  { name: 'laybys', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'layby_reservations', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'returns', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'return_lines', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'z_reports', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'stock_counts', scope: 'branch', highVolume: true, partitioned: true },
  { name: 'stock_count_items', scope: 'branch', highVolume: true, partitioned: false },
  // R6 (fiscal): the queue-only fiscal integration adapter.
  { name: 'fiscal_device_integration', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'fiscal_jobs', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'fiscal_job_attempts', scope: 'branch', highVolume: true, partitioned: false },
  // H3 (fiscal and numbering): the branch FDMS queue and cloud-issued number blocks.
  { name: 'fiscal_invoices', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'fiscal_invoice_attempts', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'number_blocks', scope: 'branch', highVolume: true, partitioned: false },
  // H4 (hardware and receipts): the branch's printer configuration.
  { name: 'printer_settings', scope: 'branch', highVolume: true, partitioned: false },
  // H5 (migration wizard): the staging tables and the saved column mappings.
  { name: 'import_jobs', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'import_rows', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'import_mappings', scope: 'branch', highVolume: true, partitioned: false },
  // H1 (branch server): device registration, local PIN auth, sync state.
  { name: 'device_registrations', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'cashier_pins', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'sync_state', scope: 'branch', highVolume: true, partitioned: false },
  // H2 (sync engine): branch outbox, cloud inbox, master-data change log, branch mirror,
  // conflict log and backup metadata.
  { name: 'sync_outbox', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'sync_inbox', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'master_data_changes', scope: 'org', highVolume: false, partitioned: false },
  { name: 'branch_master_data', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'sync_conflicts', scope: 'branch', highVolume: true, partitioned: false },
  { name: 'sync_backups', scope: 'branch', highVolume: true, partitioned: false },
  // F5 (sync engine completion): the price version each sale line charged.
  { name: 'pos_sale_price_versions', scope: 'branch', highVolume: true, partitioned: false },
  // H6 (reports): the append-only daily product-sales facts and the report reads over them.
  { name: 'daily_product_sales', scope: 'branch', highVolume: true, partitioned: false },
];

export const PARTITIONED_TABLES = TENANT_TABLES.filter((t) => t.partitioned).map((t) => t.name);

export const HIGH_VOLUME_BRANCH_TABLES = TENANT_TABLES.filter(
  (t) => t.scope === 'branch' && t.highVolume,
).map((t) => t.name);

export const ORG_SCOPED_TABLES = TENANT_TABLES.filter((t) => t.scope === 'org').map((t) => t.name);
export const BRANCH_SCOPED_TABLES = TENANT_TABLES.filter((t) => t.scope === 'branch').map(
  (t) => t.name,
);

export interface SeedIds {
  orgId: string;
  branchId: string;
  warehouseId: string;
  productId: string;
  contactId: string;
  accountId: string;
  journalId: string;
  journalCreatedAt: string;
  ledgerInId: string;
  ledgerInCreatedAt: string;
  ledgerOutId: string;
  ledgerOutCreatedAt: string;
  invoiceId: string;
  userId: string;
}

/**
 * Insert exactly one row into every tenant table for the given org/branch, so a test can assert
 * that a user of another org sees none of them. Runs as the postgres superuser (RLS bypassed),
 * which is the point: the rows exist, and the other org's user must not see them.
 */
export async function seedOneRowPerTenantTable(
  orgId: string,
  branchId: string,
): Promise<SeedIds> {
  const userId = randomUUID();
  await sql('insert into auth.users (id, email) values ($1, $2)', [
    userId,
    `seed-${userId}@example.test`,
  ]);

  const warehouse = await sql<{ id: string }>(
    `insert into public.warehouses (org_id, branch_id, code, name)
     values ($1, $2, $3, 'Seed WH') returning id`,
    [orgId, branchId, `WH-${randomUUID().slice(0, 8)}`],
  );
  const warehouseId = warehouse[0]!.id;

  const product = await sql<{ id: string }>(
    `insert into public.products (org_id, sku, name)
     values ($1, $2, 'Seed Product') returning id`,
    [orgId, `SKU-${randomUUID().slice(0, 8)}`],
  );
  const productId = product[0]!.id;

  const contact = await sql<{ id: string }>(
    `insert into public.contacts (org_id, kind, name)
     values ($1, 'customer', 'Seed Contact') returning id`,
    [orgId],
  );
  const contactId = contact[0]!.id;

  const account = await sql<{ id: string }>(
    'select id from public.chart_of_accounts where org_id = $1 and code = $2',
    [orgId, '1000'],
  );
  const accountId = account[0]!.id;

  await sql(
    `insert into public.memberships (org_id, user_id, role, branch_ids)
     values ($1, $2, 'member', array[$3]::uuid[])`,
    [orgId, userId, branchId],
  );

  await sql(
    `insert into public.invites (org_id, email, token_hash, expires_at)
     values ($1, 'invitee@example.test', $2, now() + interval '72 hours')`,
    [orgId, randomUUID()],
  );

  await sql(
    `insert into public.product_variants (org_id, product_id, sku, name)
     values ($1, $2, $3, 'Seed Variant')`,
    [orgId, productId, `SKU-${randomUUID().slice(0, 8)}`],
  );

  await sql(
    `insert into public.fiscal_periods (org_id, name, start_date, end_date)
     values ($1, 'Seed Period', date '2020-01-01', date '2020-12-31')`,
    [orgId],
  );

  await sql(
    `insert into public.tax_rates (org_id, code, name, rate, effective_from)
     values ($1, $2, 'Seed Rate', 0.05, date '2020-01-01')`,
    [orgId, `SEED-${randomUUID().slice(0, 8)}`],
  );

  await sql(
    `insert into public.exchange_rates (org_id, currency, rate, effective_from)
     values ($1, 'ZAR', 18.5, date '2020-01-01')`,
    [orgId],
  );

  // The journal and its two balanced lines must be written in one transaction: the deferred
  // balance trigger fires at commit.
  const journalRow = await tx(async (client) => {
    const journal = await client.query<{ id: string; created_at: string }>(
      `insert into public.journals (org_id, branch_id, posting_date, source_type)
       values ($1, $2, current_date, 'manual') returning id, created_at::text as created_at`,
      [orgId, branchId],
    );
    const id = journal.rows[0]!.id;
    const createdAt = journal.rows[0]!.created_at;
    await client.query(
      `insert into public.journal_lines
         (org_id, branch_id, journal_id, journal_created_at, line_no, account_id, debit,
          base_debit, posting_date)
       values ($1, $2, $3, $4, 1, $5, 1, 1, current_date)`,
      [orgId, branchId, id, createdAt, accountId],
    );
    await client.query(
      `insert into public.journal_lines
         (org_id, branch_id, journal_id, journal_created_at, line_no, account_id, credit,
          base_credit, posting_date)
       values ($1, $2, $3, $4, 2, $5, 1, 1, current_date)`,
      [orgId, branchId, id, createdAt, accountId],
    );
    return { id, createdAt };
  });
  const journalId = journalRow.id;
  const journalCreatedAt = journalRow.createdAt;

  const ledgerIn = await sql<{ id: string; created_at: string }>(
    `insert into public.stock_ledger
       (org_id, branch_id, warehouse_id, product_id, direction, qty, unit_cost, source_type)
     values ($1, $2, $3, $4, 'in', 10, 1, 'receipt') returning id, created_at::text as created_at`,
    [orgId, branchId, warehouseId, productId],
  );
  const ledgerInId = ledgerIn[0]!.id;
  const ledgerInCreatedAt = ledgerIn[0]!.created_at;

  const ledgerOut = await sql<{ id: string; created_at: string }>(
    `insert into public.stock_ledger
       (org_id, branch_id, warehouse_id, product_id, direction, qty, unit_cost, source_type)
     values ($1, $2, $3, $4, 'out', 1, 1, 'sale') returning id, created_at::text as created_at`,
    [orgId, branchId, warehouseId, productId],
  );
  const ledgerOutId = ledgerOut[0]!.id;
  const ledgerOutCreatedAt = ledgerOut[0]!.created_at;

  await sql(
    `insert into public.stock_consumptions
       (org_id, branch_id, warehouse_id, product_id, out_ledger_id, out_ledger_created_at,
        in_ledger_id, in_ledger_created_at, qty, unit_cost)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, 1)`,
    [orgId, branchId, warehouseId, productId, ledgerOutId, ledgerOutCreatedAt, ledgerInId,
     ledgerInCreatedAt],
  );

  await sql(
    `insert into public.stock_balances (org_id, branch_id, warehouse_id, product_id, qty, value)
     values ($1, $2, $3, $4, 9, 9)`,
    [orgId, branchId, warehouseId, productId],
  );

  await sql(
    `insert into public.stock_layer_balances
       (org_id, branch_id, warehouse_id, product_id, in_ledger_id, in_ledger_created_at,
        unit_cost, qty_remaining)
     values ($1, $2, $3, $4, $5, $6, 1, 9)`,
    [orgId, branchId, warehouseId, productId, ledgerInId, ledgerInCreatedAt],
  );

  const warehouse2 = await sql<{ id: string }>(
    `insert into public.warehouses (org_id, branch_id, code, name)
     values ($1, $2, $3, 'Seed WH 2') returning id`,
    [orgId, branchId, `WH2-${randomUUID().slice(0, 8)}`],
  );

  await sql(
    `insert into public.stock_transfers
       (org_id, branch_id, from_warehouse_id, to_warehouse_id, product_id, qty)
     values ($1, $2, $3, $4, $5, 1)`,
    [orgId, branchId, warehouseId, warehouse2[0]!.id, productId],
  );

  await sql(
    `insert into public.sales_orders (org_id, branch_id, contact_id)
     values ($1, $2, $3)`,
    [orgId, branchId, contactId],
  );

  const invoice = await sql<{ id: string }>(
    `insert into public.invoices
       (org_id, branch_id, contact_id, invoice_no, invoice_date, subtotal, tax_total, total)
     values ($1, $2, $3, $4, current_date, 1, 0, 1) returning id`,
    [orgId, branchId, contactId, `SEED-INV-${randomUUID().slice(0, 8)}`],
  );
  const invoiceId = invoice[0]!.id;

  await sql(
    `insert into public.invoice_lines
       (org_id, branch_id, invoice_id, line_no, product_id, warehouse_id, qty, unit_price)
     values ($1, $2, $3, 1, $4, $5, 1, 1)`,
    [orgId, branchId, invoiceId, productId, warehouseId],
  );

  await sql(
    `insert into public.payments (org_id, branch_id, contact_id, invoice_id, amount)
     values ($1, $2, $3, $4, 1)`,
    [orgId, branchId, contactId, invoiceId],
  );

  await sql(
    `insert into public.credit_notes (org_id, branch_id, invoice_id, credit_no, total)
     values ($1, $2, $3, $4, 1)`,
    [orgId, branchId, invoiceId, `SEED-CN-${randomUUID().slice(0, 8)}`],
  );

  await sql(
    `insert into public.purchase_orders (org_id, branch_id, contact_id, po_no)
     values ($1, $2, $3, $4)`,
    [orgId, branchId, contactId, `SEED-PO-${randomUUID().slice(0, 8)}`],
  );

  await sql(
    `insert into public.audit_logs (org_id, branch_id, table_name, record_id, action)
     values ($1, $2, 'invoices', $3, 'insert')`,
    [orgId, branchId, invoiceId],
  );

  await sql(
    `insert into public.categories (org_id, name, slug)
     values ($1, 'Seed Category', $2)`,
    [orgId, `seed-cat-${randomUUID().slice(0, 8)}`],
  );

  await sql(
    `insert into public.product_batches (org_id, variant_id, batch_no, expiry_date)
     values ($1, (select id from public.product_variants where org_id = $1 limit 1), $2, date '2030-01-01')`,
    [orgId, `BATCH-${randomUUID().slice(0, 8)}`],
  );

  // R2 (retail): pricing and promotions.
  const retailList = await sql<{ id: string }>(
    `insert into public.price_lists (org_id, name, kind)
     values ($1, 'Retail', 'retail') returning id`,
    [orgId],
  );
  const retailListId = retailList[0]!.id;

  await sql(
    `insert into public.price_list_items (org_id, price_list_id, variant_id, price)
     values ($1, $2, (select id from public.product_variants where org_id = $1 limit 1), 10.0000)`,
    [orgId, retailListId],
  );

  await sql(
    `insert into public.customer_groups (org_id, name, price_list_id)
     values ($1, 'Seed Group', $2)`,
    [orgId, retailListId],
  );

  await sql(
    `insert into public.promotions (org_id, name, type, valid_from, valid_to, conditions)
     values ($1, 'Seed Promo', 'percent', now() - interval '1 day', now() + interval '1 day',
             '{"value": 5}'::jsonb)`,
    [orgId],
  );

  await sql(
    `insert into public.discount_limits (org_id, role, max_percent)
     values ($1, 'member', 5.0000)`,
    [orgId],
  );

  await sql(
    `insert into public.manual_discounts
       (org_id, branch_id, invoice_id, line_no, role, amount, reason)
     values ($1, $2, $3, 1, 'member', 1.0000, 'Seed discount')`,
    [orgId, branchId, invoiceId],
  );

  // R3 (retail): online POS sale.
  const shift = await sql<{ id: string }>(
    `insert into public.shifts (org_id, branch_id, till_id, opening_float)
     values ($1, $2, $3, 0) returning id`,
    [orgId, branchId, `TILL-${randomUUID().slice(0, 8)}`],
  );
  const shiftId = shift[0]!.id;

  await sql(
    `insert into public.pos_sales
       (org_id, branch_id, shift_id, invoice_id, client_sale_id, status)
     values ($1, $2, $3, $4, $5, 'completed')`,
    [orgId, branchId, shiftId, invoiceId, randomUUID()],
  );

  await sql(
    `insert into public.pos_sale_keys (org_id, client_sale_id)
     values ($1, $2)`,
    [orgId, randomUUID()],
  );

  await sql(
    `insert into public.pos_payments
       (org_id, branch_id, sale_id, sale_created_at, method, currency, amount_tendered,
        amount_applied, rate, base_amount, change_given)
     select $1, $2, ps.id, ps.created_at, 'cash', 'USD', 1, 1, 1, 1, 0
       from public.pos_sales ps
      where ps.org_id = $1
      limit 1`,
    [orgId, branchId],
  );

  // R4 (retail): offline outbox and sync.
  await sql(
    `insert into public.pos_sync_exceptions (org_id, branch_id, client_sale_id, kind, detail)
     values ($1, $2, $3, 'negative_stock', '{"reason": "seed"}'::jsonb)`,
    [orgId, branchId, randomUUID()],
  );

  // R5 (operations): laybys, returns, credit limits, z-reports, stock counts.
  await sql(
    `insert into public.credit_limits (org_id, contact_id, credit_limit)
     values ($1, $2, 1000.0000)`,
    [orgId, contactId],
  );

  const layby = await sql<{ id: string }>(
    `insert into public.laybys
       (org_id, branch_id, contact_id, warehouse_id, layby_no, due_date, subtotal, tax_total,
        total, deposit_paid)
     values ($1, $2, $3, $4, $5, current_date + 30, 10, 1.5, 11.5, 2) returning id`,
    [orgId, branchId, contactId, warehouseId, `SEED-LB-${randomUUID().slice(0, 8)}`],
  );
  const laybyId = layby[0]!.id;

  await sql(
    `insert into public.layby_reservations
       (org_id, branch_id, layby_id, product_id, warehouse_id, line_no, qty, unit_price, unit_cost,
        tax_rate)
     values ($1, $2, $3, $4, $5, 1, 1, 10, 5, 0.15)`,
    [orgId, branchId, laybyId, productId, warehouseId],
  );

  const ret = await sql<{ id: string }>(
    `insert into public.returns
       (org_id, branch_id, original_invoice_id, contact_id, return_no, refund_method, total)
     values ($1, $2, $3, $4, $5, 'cash', 1) returning id`,
    [orgId, branchId, invoiceId, contactId, `SEED-RT-${randomUUID().slice(0, 8)}`],
  );
  const returnId = ret[0]!.id;

  await sql(
    `insert into public.return_lines
       (org_id, branch_id, return_id, invoice_line_id, line_no, qty, unit_price, unit_cost)
     select $1, $2, $3, il.id, 1, 1, 1, 1
       from public.invoice_lines il where il.invoice_id = $4 limit 1`,
    [orgId, branchId, returnId, invoiceId],
  );

  await sql(
    `insert into public.z_reports
       (org_id, branch_id, shift_id, z_no, opened_at, closed_at, opening_float, sale_count,
        void_count, gross_sales, tax_total, by_method, by_currency, vat_by_rate)
     values ($1, $2, $3, $4, now() - interval '1 hour', now(), 0, 1, 0, 1, 0, '{}', '{}', '{}')`,
    [orgId, branchId, shiftId, `SEED-Z-${randomUUID().slice(0, 8)}`],
  );

  const count = await sql<{ id: string; created_at: string }>(
    `insert into public.stock_counts (org_id, branch_id, warehouse_id, count_no, counted_at)
     values ($1, $2, $3, $4, current_date)
     returning id, created_at::text as created_at`,
    [orgId, branchId, warehouseId, `SEED-SC-${randomUUID().slice(0, 8)}`],
  );
  const countId = count[0]!.id;
  const countCreatedAt = count[0]!.created_at;

  await sql(
    `insert into public.stock_count_items
       (org_id, branch_id, count_id, count_created_at, line_no, product_id, counted_qty,
        system_qty, unit_cost)
     values ($1, $2, $3, $4, 1, $5, 9, 9, 1)`,
    [orgId, branchId, countId, countCreatedAt, productId],
  );

  // R6 (fiscal): the queue-only fiscal integration adapter.
  await sql(
    `insert into public.fiscal_device_integration
       (org_id, branch_id, device_type, mode, status, payload)
     values ($1, $2, 'generic_http', 'async', 'active', '{"endpoint": "https://seed.example.test"}'::jsonb)`,
    [orgId, branchId],
  );

  const fiscalSale = await sql<{ id: string }>(
    `select id from public.pos_sales where org_id = $1 limit 1`,
    [orgId],
  );

  const fiscalJob = await sql<{ id: string }>(
    `insert into public.fiscal_jobs (org_id, branch_id, sale_id, invoice_id, status, payload)
     values ($1, $2, $3, $4, 'queued', '{"seed": true}'::jsonb) returning id`,
    [orgId, branchId, fiscalSale[0]!.id, invoiceId],
  );

  await sql(
    `insert into public.fiscal_job_attempts
       (org_id, branch_id, job_id, attempt_no, outcome, error)
     values ($1, $2, $3, 1, 'unreachable', 'seed')`,
    [orgId, branchId, fiscalJob[0]!.id],
  );

  // H3 (fiscal and numbering): the branch FDMS queue and a cloud-issued number block.
  const fiscalInvoice = await sql<{ id: string }>(
    `insert into public.fiscal_invoices (org_id, branch_id, invoice_id, fdms_payload, status)
     values ($1, $2, $3, '{"seed": true}'::jsonb, 'pending') returning id`,
    [orgId, branchId, invoiceId],
  );

  await sql(
    `insert into public.fiscal_invoice_attempts
       (org_id, branch_id, fiscal_invoice_id, attempt_no, outcome, error)
     values ($1, $2, $3, 1, 'unreachable', 'seed')`,
    [orgId, branchId, fiscalInvoice[0]!.id],
  );

  await sql(
    `insert into public.number_blocks
       (org_id, branch_id, series_code, block_no, first_value, last_value, next_value)
     values ($1, $2, 'INVOICE', 1, 1, 200, 1)`,
    [orgId, branchId],
  );

  // H5 (migration wizard): a job, its staged rows and a saved mapping.
  const importJob = await sql<{ id: string }>(
    `insert into public.import_jobs (org_id, branch_id, kind, mapping)
     values ($1, $2, 'products', '{"StockCode": "external_code"}'::jsonb) returning id`,
    [orgId, branchId],
  );

  await sql(
    `insert into public.import_rows (org_id, branch_id, job_id, row_no, data)
     values ($1, $2, $3, 1, '{"external_code": "P1", "name": "Seed"}'::jsonb)`,
    [orgId, branchId, importJob[0]!.id],
  );

  await sql(
    `insert into public.import_mappings (org_id, branch_id, kind, mapping)
     values ($1, $2, 'products', '{"StockCode": "external_code"}'::jsonb)`,
    [orgId, branchId],
  );

  // H1 (branch server): device registration, local PIN auth, sync state.
  await sql(
    `insert into public.device_registrations
       (org_id, branch_id, till_id, code_hash, code_expires_at, consumed_at, device_token_hash)
     values ($1, $2, $3, $4, now() + interval '24 hours', now(), $5)`,
    [orgId, branchId, `TILL-${randomUUID().slice(0, 8)}`, randomUUID(), randomUUID()],
  );

  await sql(
    `insert into public.cashier_pins (org_id, branch_id, cashier_id, pin_hash, is_manager)
     values ($1, $2, $3, extensions.crypt('1234', extensions.gen_salt('bf', 10)), true)`,
    [orgId, branchId, userId],
  );

  await sql(
    `insert into public.sync_state (org_id, branch_id, protocol_version, cloud_status)
     values ($1, $2, 1, 'offline')`,
    [orgId, branchId],
  );

  // H2 (sync engine): outbox, inbox, master-data change log, branch mirror, conflicts, backups.
  await sql(
    `insert into public.sync_outbox (org_id, branch_id, event_id, event_type, payload)
     values ($1, $2, gen_random_uuid(), 'sale', '{"seed": true}'::jsonb)`,
    [orgId, branchId],
  );

  await sql(
    `insert into public.sync_inbox (org_id, branch_id, event_id, event_type, branch_seq, payload)
     values ($1, $2, gen_random_uuid(), 'sale', 1, '{"seed": true}'::jsonb)`,
    [orgId, branchId],
  );

  await sql(
    `insert into public.master_data_changes
       (org_id, change_seq, entity_type, entity_id, operation, payload)
     values ($1, 1, 'product', $2, 'upsert', '{"seed": true}'::jsonb)`,
    [orgId, productId],
  );

  await sql(
    `insert into public.branch_master_data
       (org_id, branch_id, entity_type, entity_id, payload, change_seq)
     values ($1, $2, 'product', $3, '{"seed": true}'::jsonb, 1)`,
    [orgId, branchId, productId],
  );

  await sql(
    `insert into public.sync_conflicts
       (org_id, branch_id, event_id, branch_seq, event_type, reason, detail)
     values ($1, $2, gen_random_uuid(), 1, 'sale', 'seed', '{"seed": true}'::jsonb)`,
    [orgId, branchId],
  );

  await sql(
    `insert into public.sync_backups
       (org_id, branch_id, status, object_key, byte_size, checksum)
     values ($1, $2, 'uploaded', 'seed/backup.dump', 1024, 'seed')`,
    [orgId, branchId],
  );

  // F5 (sync engine completion): the price version a sale line charged.
  await sql(
    `insert into public.pos_sale_price_versions
       (org_id, branch_id, sale_id, sale_created_at, line_no, unit_price, price_version)
     values ($1, $2, $3, now(), 1, 10.0000, 1)`,
    [orgId, branchId, randomUUID()],
  );

  // H6 (reports): one closed-day fact row for the seed product.
  await sql(
    `insert into public.daily_product_sales
       (org_id, branch_id, business_date, shift_id, product_id, qty, gross, tax, cogs)
     values ($1, $2, current_date - 1, $3, $4, 1, 10, 1.5, 4)`,
    [orgId, branchId, shiftId, productId],
  );

  return {
    orgId,
    branchId,
    warehouseId,
    productId,
    contactId,
    accountId,
    journalId,
    journalCreatedAt,
    ledgerInId,
    ledgerInCreatedAt,
    ledgerOutId,
    ledgerOutCreatedAt,
    invoiceId,
    userId,
  };
}
