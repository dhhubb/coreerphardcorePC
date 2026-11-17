-- Every tenant table must have org_id uuid NOT NULL, created_at timestamptz NOT NULL, and RLS
-- enabled and forced.
--
-- Returns one row per table that violates the invariant. Zero rows means it holds.

with tenant_tables as (
  select c.oid, c.relname as table_name, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and c.relispartition = false
    and c.relname in (
      'organizations', 'branches', 'memberships', 'invites', 'settings',
      'products', 'product_variants', 'contacts', 'chart_of_accounts',
      'tax_rates', 'exchange_rates', 'fiscal_periods', 'number_series',
      'warehouses', 'stock_ledger', 'stock_consumptions', 'stock_balances',
      'stock_layer_balances', 'stock_transfers', 'journals', 'journal_lines',
      'sales_orders', 'invoices', 'invoice_lines', 'payments', 'credit_notes',
      'purchase_orders', 'audit_logs',
      'categories', 'product_batches',
      'price_lists', 'price_list_items', 'customer_groups', 'promotions',
      'discount_limits', 'manual_discounts',
      'shifts', 'pos_sales', 'pos_payments', 'pos_sale_keys',
      'pos_sync_exceptions',
      'credit_limits', 'laybys', 'layby_reservations', 'returns', 'return_lines',
      'z_reports', 'stock_counts', 'stock_count_items',
      'fiscal_device_integration', 'fiscal_jobs', 'fiscal_job_attempts',
      'fiscal_invoices', 'fiscal_invoice_attempts', 'number_blocks',
      'printer_settings',
      'import_jobs', 'import_rows', 'import_mappings',
      'device_registrations', 'cashier_pins', 'sync_state',
      'sync_outbox', 'sync_inbox', 'master_data_changes', 'branch_master_data',
      'sync_conflicts', 'sync_backups', 'pos_sale_price_versions',
      'daily_product_sales'
    )
),
cols as (
  select t.oid,
         max(case when a.attname = 'org_id' and a.attnotnull
                       and a.atttypid = 'uuid'::regtype then 1 else 0 end) as has_org_id,
         max(case when a.attname = 'created_at' and a.attnotnull
                       and a.atttypid = 'timestamptz'::regtype then 1 else 0 end) as has_created_at
  from tenant_tables t
  left join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  group by t.oid
)
select t.table_name,
       coalesce(c.has_org_id, 0)     as has_org_id,
       coalesce(c.has_created_at, 0) as has_created_at,
       t.relrowsecurity              as rls_enabled,
       t.relforcerowsecurity         as rls_forced
from tenant_tables t
join cols c on c.oid = t.oid
where coalesce(c.has_org_id, 0) = 0
   or coalesce(c.has_created_at, 0) = 0
   or t.relrowsecurity = false
   or t.relforcerowsecurity = false
order by t.table_name;
