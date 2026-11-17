-- F8 — the migration wizard's completion slice (H5).
--
-- H5 shipped the wizard end to end: the staging tables, the chunked COPY, the SQL validation, the
-- one-transaction commit, the opening-stock journal, the /settings/import page and tests 75–85.
-- F8 closes the parts of the brief H5 left out. This migration is additive: it changes no core
-- table and no core posting function, and edits only H5's own objects (ADR-0065, ADR-0075).
--
-- What F8 adds here:
--   1. app.slugify(text) / app.ean13_valid(text) — two pure helpers.
--   2. app.import_row_errors re-created to check the barcode's EAN-13 checksum and the category's
--      shape (the brief's "barcode EAN-13 checksum" and "category" rules).
--   3. app.import_commit_job re-created to create-or-get each category and link the product to it
--      (the brief's "creates products/variants/categories").
--   4. public.import_staging — a compatibility VIEW over import_rows carrying the brief's column
--      names (row_number, raw, status, error).
--   5. The brief's job-status vocabulary (pending / validating / failed) added to the CHECK.
--   6. products.cost — the brief maps Pastel's Cost column; H5 recorded the price but not the cost.

-- ---------------------------------------------------------------------------
-- 0. An additive cost column on products, so the brief's Cost column has somewhere to land. Nullable
-- (a normal product need not carry a cost), so every existing row is unaffected.
-- ---------------------------------------------------------------------------
alter table public.products add column cost numeric(19, 4);

-- ---------------------------------------------------------------------------
-- 1. Two pure helpers.
-- ---------------------------------------------------------------------------

-- A URL-ish slug from free text: lowercased, runs of non-alphanumerics collapsed to one dash.
create or replace function app.slugify(p_text text)
returns text
language sql
immutable
as $$
  select trim(both '-' from
    regexp_replace(lower(btrim(coalesce(p_text, ''))), '[^a-z0-9]+', '-', 'g'));
$$;

-- Is a 13-digit code a valid EAN-13 (modulo-10 check digit over alternating 1/3 weights)?
-- Returns NULL for an absent code, so the caller treats "no barcode" as "not an error".
create or replace function app.ean13_valid(p_code text)
returns boolean
language sql
immutable
as $$
  select case
    when nullif(btrim(coalesce(p_code, '')), '') is null then null
    when btrim(p_code) !~ '^[0-9]{13}$' then false
    else (
      (10 - ((
        substring(btrim(p_code), 1, 1)::int
      + substring(btrim(p_code), 3, 1)::int
      + substring(btrim(p_code), 5, 1)::int
      + substring(btrim(p_code), 7, 1)::int
      + substring(btrim(p_code), 9, 1)::int
      + substring(btrim(p_code), 11, 1)::int
      + 3 * (
          substring(btrim(p_code), 2, 1)::int
        + substring(btrim(p_code), 4, 1)::int
        + substring(btrim(p_code), 6, 1)::int
        + substring(btrim(p_code), 8, 1)::int
        + substring(btrim(p_code), 10, 1)::int
        + substring(btrim(p_code), 12, 1)::int))) % 10) % 10
    ) = substring(btrim(p_code), 13, 1)::int
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. app.import_row_errors re-created. Identical to H5 except for two products rules: the barcode
-- must carry a valid EAN-13 checksum, and the category must be able to form a slug.
-- ---------------------------------------------------------------------------
create or replace function app.import_row_errors(p_kind text, p_data jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_errors jsonb := '[]'::jsonb;
  v_text   text;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_array(jsonb_build_object('field', '_row', 'message', 'the row is empty'));
  end if;

  if p_kind = 'products' then
    if btrim(coalesce(p_data ->> 'external_code', '')) = '' then
      v_errors := v_errors || jsonb_build_object('field', 'external_code',
        'message', 'the Pastel code (external code) is required');
    end if;
    if btrim(coalesce(p_data ->> 'name', '')) = '' then
      v_errors := v_errors || jsonb_build_object('field', 'name', 'message', 'name is required');
    end if;
    -- Unit is optional (it defaults to 'each'), so only a value that is present and wrong fails.
    v_text := lower(btrim(coalesce(p_data ->> 'unit', '')));
    if v_text <> '' and v_text not in ('each', 'kg', 'g', 'l', 'ml', 'pack') then
      v_errors := v_errors || jsonb_build_object('field', 'unit',
        'message', 'unit must be one of each, kg, g, l, ml, pack');
    end if;
    if nullif(btrim(coalesce(p_data ->> 'price', '')), '') is not null
       and btrim(p_data ->> 'price') !~ '^[0-9]+(\.[0-9]+)?$' then
      v_errors := v_errors || jsonb_build_object('field', 'price',
        'message', 'price must be a non-negative number');
    end if;
    -- The barcode, when present, must be a real EAN-13. app.ean13_valid returns NULL for an absent
    -- code, so "is not true" only fires on a present-but-wrong one.
    if app.ean13_valid(p_data ->> 'barcode') is not true
       and nullif(btrim(coalesce(p_data ->> 'barcode', '')), '') is not null then
      v_errors := v_errors || jsonb_build_object('field', 'barcode',
        'message', 'barcode must be a valid EAN-13 (13 digits, correct check digit)');
    end if;
    -- The category, when present, must be able to form a slug; the commit creates-or-gets it.
    if nullif(btrim(coalesce(p_data ->> 'category', '')), '') is not null
       and app.slugify(p_data ->> 'category') = '' then
      v_errors := v_errors || jsonb_build_object('field', 'category',
        'message', 'category must contain at least one letter or digit');
    end if;

  elsif p_kind = 'customers' then
    if btrim(coalesce(p_data ->> 'external_code', '')) = '' then
      v_errors := v_errors || jsonb_build_object('field', 'external_code',
        'message', 'the Pastel code (external code) is required');
    end if;
    if btrim(coalesce(p_data ->> 'name', '')) = '' then
      v_errors := v_errors || jsonb_build_object('field', 'name', 'message', 'name is required');
    end if;
    v_text := lower(btrim(coalesce(p_data ->> 'kind', '')));
    if v_text <> '' and v_text not in ('customer', 'supplier', 'both') then
      v_errors := v_errors || jsonb_build_object('field', 'kind',
        'message', 'kind must be customer, supplier or both');
    end if;
    if nullif(btrim(coalesce(p_data ->> 'email', '')), '') is not null
       and position('@' in (p_data ->> 'email')) = 0 then
      v_errors := v_errors || jsonb_build_object('field', 'email',
        'message', 'email must contain @');
    end if;

  elsif p_kind = 'opening_stock' then
    if btrim(coalesce(p_data ->> 'external_code', '')) = ''
       and btrim(coalesce(p_data ->> 'sku', '')) = '' then
      v_errors := v_errors || jsonb_build_object('field', 'external_code',
        'message', 'a product external code or SKU is required');
    end if;
    if btrim(coalesce(p_data ->> 'qty', '')) !~ '^[0-9]+(\.[0-9]+)?$'
       or btrim(coalesce(p_data ->> 'qty', '')) = '' then
      v_errors := v_errors || jsonb_build_object('field', 'qty',
        'message', 'quantity must be a positive number');
    elsif btrim(p_data ->> 'qty')::numeric <= 0 then
      v_errors := v_errors || jsonb_build_object('field', 'qty',
        'message', 'quantity must be greater than zero');
    end if;
    if nullif(btrim(coalesce(p_data ->> 'unit_cost', '')), '') is not null
       and btrim(p_data ->> 'unit_cost') !~ '^[0-9]+(\.[0-9]+)?$' then
      v_errors := v_errors || jsonb_build_object('field', 'unit_cost',
        'message', 'unit cost must be a non-negative number');
    end if;

  else
    raise exception 'unknown import kind %', p_kind using errcode = '22023';
  end if;

  return v_errors;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. app.import_commit_job re-created. Identical to H5 except that the products branch resolves
-- the mapped category into a categories row (create-or-get by slug) and links the product to it.
-- ---------------------------------------------------------------------------
create or replace function app.import_commit_job(
  p_org_id       uuid,
  p_branch_id    uuid,
  p_job_id       uuid,
  p_posting_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job       public.import_jobs;
  v_invalid   int;
  v_created   int := 0;
  v_updated   int := 0;
  v_skipped   int := 0;
  v_committed int := 0;
  v_journal   uuid;
  v_total     numeric(19, 4) := 0;
  v_price_list uuid;
  v_date      date := coalesce(p_posting_date, current_date);
begin
  if auth.jwt() ->> 'org_id' is not null
     and not app.has_branch_access(p_org_id, p_branch_id) then
    raise exception 'not authorized for branch %', p_branch_id using errcode = '42501';
  end if;

  select * into v_job from public.import_jobs
   where id = p_job_id and org_id = p_org_id and branch_id = p_branch_id
   for update;
  if not found then
    raise exception 'import job % not found', p_job_id using errcode = 'no_data_found';
  end if;
  if v_job.status = 'committed' then
    raise exception 'import job % is already committed', p_job_id using errcode = '23514';
  end if;

  select count(*) into v_invalid from public.import_rows
   where job_id = p_job_id and status = 'invalid';
  if v_invalid > 0 then
    raise exception 'import job % has % invalid rows; fix them and revalidate before committing',
      p_job_id, v_invalid using errcode = '23514';
  end if;

  select count(*) into v_skipped from public.import_rows
   where job_id = p_job_id and status = 'skipped';

  if v_job.kind = 'products' then
    v_price_list := app.ensure_retail_price_list(p_org_id);

    -- Resolve the mapped rows ONCE. The temp table is materialised, so the JSON is parsed once and
    -- the product upsert, the variants, the categories and the prices all read the same set. It is
    -- dropped at commit; the drops below make a second call in the same transaction safe.
    drop table if exists import_src;
    create temporary table import_src on commit drop as
      select r.id as row_id,
             nullif(btrim(coalesce(r.data ->> 'external_code', '')), '') as external_code,
             nullif(btrim(coalesce(r.data ->> 'sku', '')), '') as sku,
             btrim(coalesce(r.data ->> 'name', '')) as name,
             lower(btrim(coalesce(r.data ->> 'unit', 'each')))::public.product_unit as unit,
             nullif(btrim(coalesce(r.data ->> 'price', '')), '')::numeric(19, 4) as price,
             nullif(btrim(coalesce(r.data ->> 'barcode', '')), '') as barcode,
             nullif(btrim(coalesce(r.data ->> 'category', '')), '') as category,
             app.slugify(r.data ->> 'category') as category_slug,
             nullif(btrim(coalesce(r.data ->> 'cost', '')), '')::numeric(19, 4) as cost
        from public.import_rows r
       where r.job_id = p_job_id and r.status = 'valid';

    -- Hand out one SKU per row that did not supply one, from a single locked block.
    alter table import_src add column generated_sku text;
    with need as (
      select row_id, row_number() over (order by row_id) as rn
        from import_src where sku is null
    ),
    nums as (
      select row_number() over () as rn, sku
        from unnest(app.next_numbers(
               p_org_id, 'SKU',
               (select count(*)::int from import_src where sku is null))) as sku
    )
    update import_src s
       set generated_sku = nums.sku
      from need join nums on nums.rn = need.rn
     where s.row_id = need.row_id;

    -- Create-or-get each category the file names, BEFORE the product upsert, so the product can be
    -- linked in the same statement (matched on slug). A category the shop already has is reused.
    drop table if exists import_categories;
    create temporary table import_categories on commit drop as
      select distinct s.category_slug as slug, btrim(s.category) as name
        from import_src s
       where s.category is not null and s.category_slug <> '';

    insert into public.categories (org_id, name, slug)
    select p_org_id, c.name, c.slug from import_categories c
    on conflict (org_id, slug) do nothing;

    -- Upsert the product by its external key, so a re-run updates rather than duplicates. The
    -- category is resolved inline (slug -> id), so there is no second pass over the products.
    drop table if exists import_products;
    create temporary table import_products on commit drop as
      with up as (
        insert into public.products (org_id, sku, name, unit, is_weighable, external_code, cost, category_id)
        select p_org_id,
               coalesce(s.sku, s.generated_sku),
               s.name,
               s.unit,
               s.unit in ('kg', 'g', 'l', 'ml'),
               s.external_code,
               s.cost,
               (select cat.id from public.categories cat
                 where cat.org_id = p_org_id and cat.slug = s.category_slug)
          from import_src s
        on conflict (org_id, external_code) do update
           set name = excluded.name,
               unit = excluded.unit,
               is_weighable = excluded.is_weighable,
               cost = excluded.cost,
               category_id = excluded.category_id,
               updated_at = now()
        returning id, external_code, sku, name, (xmax = 0) as inserted
      )
      select * from up;

    select count(*) filter (where inserted), count(*) filter (where not inserted)
      into v_created, v_updated
      from import_products;

    create index on import_products (external_code);

    -- One default variant per product, so an imported product is sellable at the till.
    insert into public.product_variants (org_id, product_id, sku, name, barcode)
    select p_org_id, p.id, p.sku, p.name, s.barcode
      from import_products p
      join import_src s on s.external_code = p.external_code
    on conflict (org_id, sku) do update
       set name = excluded.name, barcode = excluded.barcode, updated_at = now();

    -- The price lands in the org's retail price list.
    insert into public.price_list_items (org_id, price_list_id, variant_id, price)
    select p_org_id, v_price_list, v.id, s.price
      from import_src s
      join import_products p on p.external_code = s.external_code
      join public.product_variants v on v.org_id = p_org_id and v.product_id = p.id
     where s.price is not null
    on conflict (price_list_id, variant_id) do update
       set price = excluded.price, updated_at = now();

  elsif v_job.kind = 'customers' then
    with up as (
      insert into public.contacts (org_id, kind, name, email, phone, external_code)
      select p_org_id,
             coalesce(nullif(lower(btrim(coalesce(r.data ->> 'kind', ''))), ''), 'customer'),
             btrim(coalesce(r.data ->> 'name', '')),
             nullif(btrim(coalesce(r.data ->> 'email', '')), ''),
             nullif(btrim(coalesce(r.data ->> 'phone', '')), ''),
             nullif(btrim(coalesce(r.data ->> 'external_code', '')), '')
        from public.import_rows r
       where r.job_id = p_job_id and r.status = 'valid'
      on conflict (org_id, external_code) do update
         set name = excluded.name, email = excluded.email, phone = excluded.phone,
             updated_at = now()
      returning (xmax = 0) as inserted
    )
    select count(*) filter (where inserted), count(*) filter (where not inserted)
      into v_created, v_updated
      from up;

  elsif v_job.kind = 'opening_stock' then
    -- Resolve the product and warehouse ONCE into a materialised temp table. The lookup is a
    -- plain equality on an indexed column (external_code, then sku), never an OR across two
    -- columns, so a 1,200-row file does not degrade to a nested loop over every product.
    drop table if exists import_open;
    create temporary table import_open on commit drop as
      select r.id as row_id,
             coalesce(
               (select p.id from public.products p
                 where p.org_id = p_org_id
                   and p.external_code = nullif(btrim(coalesce(r.data ->> 'external_code', '')), '')
                 limit 1),
               (select p.id from public.products p
                 where p.org_id = p_org_id
                   and p.sku = nullif(btrim(coalesce(r.data ->> 'sku', '')), '')
                 limit 1)) as product_id,
             -- Stock is tracked per variant, so an opening layer must name one. Prefer the
             -- variant the row's barcode names; otherwise the product's earliest variant, which
             -- is the one the products import created as its default.
             coalesce(
               (select v.id from public.product_variants v
                 where v.org_id = p_org_id
                   and v.barcode = nullif(btrim(coalesce(r.data ->> 'barcode', '')), '')
                 limit 1),
               (select v.id from public.product_variants v
                 where v.org_id = p_org_id
                   and v.product_id = coalesce(
                     (select p.id from public.products p
                       where p.org_id = p_org_id
                         and p.external_code = nullif(btrim(coalesce(r.data ->> 'external_code', '')), '')
                       limit 1),
                     (select p.id from public.products p
                       where p.org_id = p_org_id
                         and p.sku = nullif(btrim(coalesce(r.data ->> 'sku', '')), '')
                       limit 1))
                 order by v.created_at, v.id
                 limit 1)) as variant_id,
             coalesce(
               (select w.id from public.warehouses w
                 where w.org_id = p_org_id and w.branch_id = p_branch_id
                   and w.code = nullif(btrim(coalesce(r.data ->> 'warehouse_code', '')), '')),
               (select w.id from public.warehouses w
                 where w.org_id = p_org_id and w.branch_id = p_branch_id and w.is_active
                 order by w.created_at, w.id limit 1)) as warehouse_id,
             (r.data ->> 'qty')::numeric(19, 4) as qty,
             coalesce(nullif(btrim(coalesce(r.data ->> 'unit_cost', '')), '')::numeric(19, 4), 0)
               as unit_cost
        from public.import_rows r
       where r.job_id = p_job_id and r.status = 'valid';

    create temporary table import_ins on commit drop as
      with ins as (
        insert into public.stock_ledger
          (id, org_id, branch_id, warehouse_id, product_id, variant_id, direction, qty, unit_cost,
           source_type, source_id, memo, created_at)
        select gen_random_uuid(), p_org_id, p_branch_id, x.warehouse_id, x.product_id, x.variant_id,
               'in', x.qty, x.unit_cost, 'opening', p_job_id, 'Opening stock import', now()
          from import_open x
        returning id, created_at, warehouse_id, product_id, variant_id, qty, unit_cost
      )
      select * from ins;

    insert into public.stock_layer_balances
      (org_id, branch_id, warehouse_id, product_id, variant_id, in_ledger_id,
       in_ledger_created_at, unit_cost, qty_remaining)
    select p_org_id, p_branch_id, i.warehouse_id, i.product_id, i.variant_id, i.id, i.created_at,
           i.unit_cost, i.qty
      from import_ins i;

    insert into public.stock_balances
      (org_id, branch_id, warehouse_id, product_id, variant_id, qty, value)
    select p_org_id, p_branch_id, i.warehouse_id, i.product_id, i.variant_id,
           sum(i.qty), sum(round(i.qty * i.unit_cost, 4))
      from import_ins i
     group by i.warehouse_id, i.product_id, i.variant_id
    on conflict (org_id, warehouse_id, product_id, variant_id) do update
       set qty = public.stock_balances.qty + excluded.qty,
           value = public.stock_balances.value + excluded.value,
           updated_at = now();

    select coalesce(sum(round(i.qty * i.unit_cost, 4)), 0)
      into v_total
      from import_ins i;

    select count(*) into v_created from public.import_rows
     where job_id = p_job_id and status = 'valid';

    -- One balanced journal for the whole opening stock, through the balanced-journal hook.
    if v_total > 0 then
      v_journal := app.post_balanced_journal(
        p_org_id, p_branch_id, v_date, 'opening', p_job_id, 'Opening stock import', 'USD',
        jsonb_build_array(
          jsonb_build_object('account_code', '1000', 'debit', v_total,
                             'description', 'Opening stock'),
          jsonb_build_object('account_code', '3900', 'credit', v_total,
                             'description', 'Opening balance equity')));
    end if;

  else
    raise exception 'unknown import kind %', v_job.kind using errcode = '22023';
  end if;

  update public.import_rows
     set status = 'committed'
   where job_id = p_job_id and status = 'valid';
  get diagnostics v_committed = row_count;

  update public.import_jobs
     set status = 'committed',
         committed_at = now(),
         result = jsonb_build_object(
           'created', v_created, 'updated', v_updated, 'skipped', v_skipped,
           'committed_rows', v_committed, 'journal_id', v_journal,
           'total_value', v_total)
   where id = p_job_id;

  return jsonb_build_object(
    'job_id', p_job_id, 'status', 'committed', 'kind', v_job.kind,
    'created', v_created, 'updated', v_updated, 'skipped', v_skipped,
    'committed_rows', v_committed, 'journal_id', v_journal,
    'total_value', v_total::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. public.import_staging — the brief's name for the staging rows, as a read-only VIEW over
-- import_rows with the brief's column names. security_invoker makes import_rows' tenant RLS apply,
-- so no org can read another org's staged rows through the view.
-- ---------------------------------------------------------------------------
create or replace view public.import_staging
with (security_invoker = true) as
select
  r.id                 as id,
  r.org_id             as org_id,
  r.branch_id          as branch_id,
  r.job_id             as job_id,
  r.row_no             as row_number,
  r.data               as raw,
  r.status             as status,
  r.errors             as error,
  r.created_at         as created_at
from public.import_rows r;

grant select on public.import_staging to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The brief's job-status vocabulary. H5 stored draft / validated / invalid / committed; F8 also
-- allows the brief's pending / validating / failed. The H5 functions keep writing their values, so
-- nothing that already ran changes.
-- ---------------------------------------------------------------------------
alter table public.import_jobs drop constraint import_jobs_status_check;
alter table public.import_jobs add constraint import_jobs_status_check
  check (status in ('draft', 'pending', 'validating', 'validated', 'invalid', 'committed', 'failed'));

-- Grants for the new helpers.
grant execute on function app.slugify(text) to authenticated, service_role;
grant execute on function app.ean13_valid(text) to authenticated, service_role;
