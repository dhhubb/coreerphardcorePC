-- F9 — Reports and the owner console (H6) completion. ADR-0076.
--
-- Additive. It changes no core table shape and no core function signature, and it edits no H6
-- migration. It adds two read-only report functions that H6 left out:
--
--   * app.report_today(...)            — today's live figures for the /reports/today page: sales by
--                                        currency (USD/ZWG) and by till, a multi-branch roll-up the
--                                        caller may see, the low-stock list, the laybys due, the
--                                        sync status and the fiscal queue.
--   * app.report_z_report_detail(...)  — one Z-report by primary key, with the same fiscal totals,
--                                        VAT-by-rate split and sale/void counts the list carries.
--
-- Both are SECURITY INVOKER, so RLS scopes every row the caller may read (ADR-0049). Today's figures
-- come from the live pos_sales / pos_payments tables, bounded by the branch's
-- (org_id, branch_id, created_at DESC) index (ADR-0046), never from a materialised view.

-- ---------------------------------------------------------------------------
-- report_today: the live dashboard for a branch. Everything is "today" (created_at >= current_date),
-- so it uses the (org_id, branch_id, created_at DESC) index on pos_sales and pos_payments. The
-- by-branch roll-up filters only on org_id, so RLS limits it to the branches the token scopes: a
-- branch sees one row, an owner in the cloud sees the group.
-- ---------------------------------------------------------------------------
create or replace function app.report_today(
  p_org_id    uuid,
  p_branch_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- Tendered sales today, split by the currency each tender was taken in.
    'by_currency', coalesce((
      select jsonb_object_agg(c.currency, c.amount)
        from (
          select pp.currency, sum(pp.amount_applied) as amount
            from public.pos_payments pp
           where pp.org_id = p_org_id
             and pp.branch_id = p_branch_id
             and pp.created_at >= current_date
           group by pp.currency
        ) c), '{}'::jsonb),

    -- Tendered sales today converted to base (USD), the figure the owner reads first.
    'sales_base', coalesce((
      select sum(pp.base_amount)
        from public.pos_payments pp
       where pp.org_id = p_org_id
         and pp.branch_id = p_branch_id
         and pp.created_at >= current_date), 0),

    -- How many completed sales today, and the gross they rang.
    'sale_count', coalesce((
      select count(*)
        from public.pos_sales ps
       where ps.org_id = p_org_id
         and ps.branch_id = p_branch_id
         and ps.created_at >= current_date
         and ps.status = 'completed'), 0),
    'gross_sales', coalesce((
      select sum(i.subtotal)
        from public.pos_sales ps
        join public.invoices i on i.id = ps.invoice_id
       where ps.org_id = p_org_id
         and ps.branch_id = p_branch_id
         and ps.created_at >= current_date
         and ps.status = 'completed'), 0),

    -- Sales by till, for the branch's own tills.
    'by_till', coalesce((
      select jsonb_agg(jsonb_build_object(
               'till_id', t.till_id, 'sale_count', t.sale_count, 'gross', t.gross)
             order by t.till_id)
        from (
          select coalesce(s.till_id, 'unassigned') as till_id,
                 count(*) as sale_count,
                 coalesce(sum(i.subtotal), 0) as gross
            from public.pos_sales ps
            left join public.shifts s on s.id = ps.shift_id
            join public.invoices i on i.id = ps.invoice_id
           where ps.org_id = p_org_id
             and ps.branch_id = p_branch_id
             and ps.created_at >= current_date
             and ps.status = 'completed'
           group by coalesce(s.till_id, 'unassigned')
        ) t), '[]'::jsonb),

    -- Sales by branch today, across every branch the token scopes (RLS does the scoping).
    'by_branch', coalesce((
      select jsonb_agg(jsonb_build_object(
               'branch_id', b.branch_id, 'sale_count', b.sale_count, 'gross', b.gross)
             order by b.branch_id)
        from (
          select ps.branch_id,
                 count(*) as sale_count,
                 coalesce(sum(i.subtotal), 0) as gross
            from public.pos_sales ps
            join public.invoices i on i.id = ps.invoice_id
           where ps.org_id = p_org_id
             and ps.created_at >= current_date
             and ps.status = 'completed'
           group by ps.branch_id
        ) b), '[]'::jsonb),

    -- Low stock: on-hand below five, cheapest (lowest qty) first.
    'low_stock', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', ls.product_id, 'variant_id', ls.variant_id,
               'sku', ls.sku, 'name', ls.name, 'qty', ls.qty)
             order by ls.qty asc, ls.product_id asc)
        from (
          select sb.product_id, sb.variant_id,
                 coalesce(pv.sku, p.sku) as sku, p.name,
                 sum(sb.qty) as qty
            from public.stock_balances sb
            join public.products p on p.id = sb.product_id
            left join public.product_variants pv on pv.id = sb.variant_id
           where sb.org_id = p_org_id
             and sb.branch_id = p_branch_id
           group by sb.product_id, sb.variant_id, coalesce(pv.sku, p.sku), p.name
          having sum(sb.qty) < 5
        ) ls), '[]'::jsonb),

    -- Laybys due: open, with a due date that has arrived.
    'laybys_due', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'layby_no', l.layby_no, 'due_date', l.due_date,
               'total', l.total, 'deposit_paid', l.deposit_paid, 'customer', c.name)
             order by l.due_date asc, l.layby_no asc)
        from public.laybys l
        join public.contacts c on c.id = l.contact_id
       where l.org_id = p_org_id
         and l.branch_id = p_branch_id
         and l.status = 'open'
         and l.due_date <= current_date), '[]'::jsonb),

    -- The fiscal queue today: how many invoices are pending, sent or failed, and their amounts.
    'fiscal', jsonb_build_object(
      'pending', coalesce((
        select count(*) from public.fiscal_invoices fi
         where fi.org_id = p_org_id and fi.branch_id = p_branch_id
           and fi.created_at >= current_date and fi.status = 'pending'), 0),
      'sent', coalesce((
        select count(*) from public.fiscal_invoices fi
         where fi.org_id = p_org_id and fi.branch_id = p_branch_id
           and fi.created_at >= current_date and fi.status = 'sent'), 0),
      'failed', coalesce((
        select count(*) from public.fiscal_invoices fi
         where fi.org_id = p_org_id and fi.branch_id = p_branch_id
           and fi.created_at >= current_date and fi.status = 'failed'), 0),
      'failed_amount', coalesce((
        select sum(i.total)
          from public.fiscal_invoices fi
          join public.invoices i on i.id = fi.invoice_id
         where fi.org_id = p_org_id and fi.branch_id = p_branch_id
           and fi.created_at >= current_date and fi.status = 'failed'), 0)),

    -- Sync status: the same figures app.report_last_sync returns.
    'sync', app.report_last_sync(p_org_id, p_branch_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- report_z_report_detail: one Z-report by primary key, with the fiscal totals computed at read time
-- (ADR-0047) and the VAT-by-rate split. A single indexed lookup on z_reports (id), so the detail
-- page is fast however many Z-reports exist.
-- ---------------------------------------------------------------------------
create or replace function app.report_z_report_detail(
  p_org_id      uuid,
  p_branch_id   uuid,
  p_z_report_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', z.id, 'z_no', z.z_no, 'shift_id', z.shift_id, 'opened_at', z.opened_at,
    'closed_at', z.closed_at, 'opening_float', z.opening_float,
    'sale_count', z.sale_count, 'void_count', z.void_count,
    'gross_sales', z.gross_sales, 'tax_total', z.tax_total,
    'by_method', z.by_method, 'by_currency', z.by_currency, 'vat_by_rate', z.vat_by_rate,
    'created_at', z.created_at,
    'fiscal', jsonb_build_object(
      'sent', coalesce((select jsonb_build_object('count', count(*), 'amount', coalesce(sum(i.total), 0))
                          from public.fiscal_invoices fi
                          join public.pos_sales ps on ps.invoice_id = fi.invoice_id
                          join public.invoices i on i.id = fi.invoice_id
                         where fi.org_id = p_org_id and fi.branch_id = p_branch_id
                           and ps.shift_id = z.shift_id and fi.status = 'sent'),
                       jsonb_build_object('count', 0, 'amount', 0)),
      'pending', coalesce((select jsonb_build_object('count', count(*), 'amount', coalesce(sum(i.total), 0))
                             from public.fiscal_invoices fi
                             join public.pos_sales ps on ps.invoice_id = fi.invoice_id
                             join public.invoices i on i.id = fi.invoice_id
                            where fi.org_id = p_org_id and fi.branch_id = p_branch_id
                              and ps.shift_id = z.shift_id and fi.status = 'pending'),
                          jsonb_build_object('count', 0, 'amount', 0)),
      'failed', coalesce((select jsonb_build_object('count', count(*), 'amount', coalesce(sum(i.total), 0))
                            from public.fiscal_invoices fi
                            join public.pos_sales ps on ps.invoice_id = fi.invoice_id
                            join public.invoices i on i.id = fi.invoice_id
                           where fi.org_id = p_org_id and fi.branch_id = p_branch_id
                             and ps.shift_id = z.shift_id and fi.status = 'failed'),
                         jsonb_build_object('count', 0, 'amount', 0))
    )
  )
  from public.z_reports z
 where z.org_id = p_org_id
   and z.branch_id = p_branch_id
   and z.id = p_z_report_id;
$$;

-- Grants.
grant execute on function app.report_today(uuid, uuid) to authenticated, service_role;
grant execute on function app.report_z_report_detail(uuid, uuid, uuid) to authenticated, service_role;
