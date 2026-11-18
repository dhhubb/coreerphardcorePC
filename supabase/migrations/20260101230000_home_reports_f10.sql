-- F10 — home page, role-aware navigation and stock reports (PDF). ADR-0077.
--
-- Additive. It edits no applied migration and changes no core table shape. It adds:
--
--   * a re-created public.custom_access_token_hook that also carries `member_role`, so a token
--     minted by Supabase Auth and a token minted by app.login_context carry the same claim
--     (AGENTS.md: re-creating a function is the additive way to change it);
--   * two read-only report functions, both SECURITY INVOKER so RLS scopes every row:
--       - app.report_stock_on_hand(...)   — on-hand quantity and value per warehouse/product/variant
--       - app.report_stock_movements(...) — the stock_ledger movements for a period
--
-- The stock reports read stock_balances (a mutable cache rebuildable from the ledger) and the
-- append-only stock_ledger. Neither adds a table, a materialised view or a core-table column.

-- ---------------------------------------------------------------------------
-- The access token hook: add `member_role` alongside org_id and branch_ids. `role` stays the
-- Postgres role ('authenticated'), as Supabase expects; `member_role` is the membership role
-- (owner/admin/member) and is a display value only. RLS never reads it — the policies still scope
-- by org_id and branch_ids — so a stale member_role can never widen access.
-- ---------------------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  v_user_id    uuid := (event ->> 'user_id')::uuid;
  v_claims     jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  v_membership public.memberships%rowtype;
begin
  select * into v_membership
    from public.memberships
   where user_id = v_user_id
     and is_active
   order by created_at
   limit 1;

  if found then
    v_claims := jsonb_set(v_claims, '{org_id}', to_jsonb(v_membership.org_id::text), true);
    v_claims := jsonb_set(v_claims, '{branch_ids}', to_jsonb(v_membership.branch_ids), true);
    v_claims := jsonb_set(v_claims, '{member_role}', to_jsonb(v_membership.role), true);
  else
    v_claims := jsonb_set(v_claims, '{org_id}', 'null'::jsonb, true);
    v_claims := jsonb_set(v_claims, '{branch_ids}', '[]'::jsonb, true);
    v_claims := jsonb_set(v_claims, '{member_role}', 'null'::jsonb, true);
  end if;

  return jsonb_set(event, '{claims}', v_claims, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- app.login_context: re-created to also return `member_role`, so the token the login route mints
-- carries the same claim the access token hook mints. The org name is still carried for the shell.
-- ---------------------------------------------------------------------------
create or replace function app.login_context(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'user_id',    u.id,
    'email',      u.email,
    'org_id',     m.org_id,
    'org_name',   o.name,
    'branch_ids', coalesce(m.branch_ids, '{}'::uuid[]),
    'role',       coalesce(m.role, 'authenticated'),
    'member_role', m.role
  )
    from auth.users u
    left join lateral (
      select org_id, branch_ids, role
        from public.memberships
       where user_id = u.id and is_active
       order by created_at
       limit 1
    ) m on true
    left join public.organizations o on o.id = m.org_id
   where u.id = p_user_id;
$$;

-- ---------------------------------------------------------------------------
-- report_stock_on_hand: one row per (warehouse, product, variant) the caller can see, with the
-- on-hand quantity and its value. RLS scopes the stock_balances rows by branch. Keyset on
-- (created_at, id) descending, so a page asks for the next page with the previous page's cursor
-- and never uses OFFSET. An optional warehouse and a case-insensitive sku/name query narrow it.
-- ---------------------------------------------------------------------------
create or replace function app.report_stock_on_hand(
  p_org_id           uuid,
  p_branch_id        uuid,
  p_warehouse_id     uuid default null,
  p_query            text default null,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id             uuid,
  warehouse_id   uuid,
  warehouse_code text,
  product_id     uuid,
  variant_id     uuid,
  sku            text,
  name           text,
  qty            numeric,
  value          numeric,
  unit_cost      numeric,
  created_at     timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select sb.id, sb.warehouse_id, w.code,
         sb.product_id, sb.variant_id,
         coalesce(v.sku, p.sku) as sku,
         case when v.id is null then p.name else p.name || ' — ' || v.name end as name,
         sb.qty, sb.value,
         case when sb.qty <> 0 then round(sb.value / sb.qty, 4) else 0 end as unit_cost,
         sb.created_at
    from public.stock_balances sb
    join public.products p on p.id = sb.product_id
    join public.warehouses w on w.id = sb.warehouse_id
    left join public.product_variants v on v.id = sb.variant_id
   where sb.org_id = p_org_id
     and sb.branch_id = p_branch_id
     and (p_warehouse_id is null or sb.warehouse_id = p_warehouse_id)
     and (
       nullif(btrim(coalesce(p_query, '')), '') is null
       or coalesce(v.sku, p.sku) ilike ('%' || btrim(p_query) || '%')
       or p.name ilike ('%' || btrim(p_query) || '%')
     )
     and (
       p_after_created_at is null
       or (sb.created_at, sb.id) < (p_after_created_at, p_after_id)
     )
   order by sb.created_at desc, sb.id desc
   limit v_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- report_stock_movements: the stock_ledger movements for a period, one row per movement, with the
-- direction, the quantity, the unit cost and the source document. RLS scopes the ledger rows by
-- branch. Keyset on (created_at, id) descending, bounded by an inclusive [from, to] date range that
-- reads the (org_id, branch_id, created_at) index.
-- ---------------------------------------------------------------------------
create or replace function app.report_stock_movements(
  p_org_id           uuid,
  p_branch_id        uuid,
  p_from             date,
  p_to               date,
  p_warehouse_id     uuid default null,
  p_query            text default null,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id             uuid,
  warehouse_id   uuid,
  warehouse_code text,
  product_id     uuid,
  variant_id     uuid,
  sku            text,
  name           text,
  direction      text,
  qty            numeric,
  unit_cost      numeric,
  source_type    text,
  source_id      uuid,
  created_at     timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select sl.id, sl.warehouse_id, w.code,
         sl.product_id, sl.variant_id,
         coalesce(v.sku, p.sku) as sku,
         case when v.id is null then p.name else p.name || ' — ' || v.name end as name,
         sl.direction, sl.qty, sl.unit_cost, sl.source_type, sl.source_id,
         sl.created_at
    from public.stock_ledger sl
    join public.products p on p.id = sl.product_id
    join public.warehouses w on w.id = sl.warehouse_id
    left join public.product_variants v on v.id = sl.variant_id
   where sl.org_id = p_org_id
     and sl.branch_id = p_branch_id
     and sl.created_at >= p_from::timestamptz
     and sl.created_at < (p_to + 1)::timestamptz
     and (p_warehouse_id is null or sl.warehouse_id = p_warehouse_id)
     and (
       nullif(btrim(coalesce(p_query, '')), '') is null
       or coalesce(v.sku, p.sku) ilike ('%' || btrim(p_query) || '%')
       or p.name ilike ('%' || btrim(p_query) || '%')
     )
     and (
       p_after_created_at is null
       or (sl.created_at, sl.id) < (p_after_created_at, p_after_id)
     )
   order by sl.created_at desc, sl.id desc
   limit v_limit;
end;
$$;

-- Grants. Both functions run as the caller (SECURITY INVOKER), so RLS still applies.
grant execute on function app.report_stock_on_hand(uuid, uuid, uuid, text, int, timestamptz, uuid)
  to authenticated, service_role;
grant execute on function app.report_stock_movements(uuid, uuid, date, date, uuid, text, int, timestamptz, uuid)
  to authenticated, service_role;
