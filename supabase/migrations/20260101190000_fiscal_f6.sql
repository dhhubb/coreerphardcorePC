-- F6 — the fiscal-and-numbering completion slice.
--
-- H3 (20260101090000_fiscal_numbering_h3.sql) shipped the branch FDMS queue, the worker, the
-- FdmsClient interface with a mock and an HTTP client, cloud-issued number blocks, the receipt's
-- fiscal block, the /settings/fiscal page and tests 64–68 — which already map onto this brief's gate
-- (its tests 1, 2, 8, 24, 25). F6 closes the parts of the brief H3 left out, and it is ADDITIVE: no
-- core table and no core posting function is touched. It edits only H3's own objects (ADR-0065,
-- ADR-0073).
--
-- What this migration adds or widens:
--   1. fiscal_invoices.invoice_number — the number the invoice used, snapshotted on the queue row
--      (the brief's schema lists it), so a queue row is self-describing.
--   2. The brief's named queue index (org_id, branch_id, status, created_at DESC).
--   3. public.invoice_number_blocks — a compatibility VIEW over number_blocks with the brief's
--      column vocabulary (start_number/end_number/current_number, status active|exhausted). It is a
--      view, not a second table: number_blocks is already the system of record, and a duplicate
--      table would be a second place for the same counter to drift (ADR-0073).
--   4. app.claim_invoice_number re-created with the brief's exact exhaustion message, which still
--      contains the H3 phrase test 67 matches on.
--   5. app.fiscal_invoice_enqueue re-created to record invoice_number in the same transaction.

-- ---------------------------------------------------------------------------
-- 1. The invoice number on the queue row. Snapshotted at enqueue time from the invoice, so the
-- queue row carries the number even before the join to invoices.
-- ---------------------------------------------------------------------------
alter table public.fiscal_invoices add column if not exists invoice_number text;

update public.fiscal_invoices fi
   set invoice_number = i.invoice_no
  from public.invoices i
 where i.id = fi.invoice_id
   and fi.invoice_number is null;

-- ---------------------------------------------------------------------------
-- 2. The brief's named queue index: org + branch + status + newest first. The H3 partial index on
-- pending rows stays (the worker uses it); this one serves the admin page across every status.
-- ---------------------------------------------------------------------------
create index if not exists fiscal_invoices_org_branch_status_created_idx
  on public.fiscal_invoices (org_id, branch_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. The brief's number-block vocabulary as a read-only view over number_blocks. A branch's block is
-- 'active' while it still has a number to hand out, 'exhausted' once next_value has passed
-- last_value. The view is what a reader or a dashboard asks; number_blocks stays the only writer.
-- ---------------------------------------------------------------------------
-- security_invoker = true so the view runs as the CALLER: number_blocks' tenant RLS still applies
-- and one org can never read another org's blocks through the view (a default view would run as its
-- owner and bypass RLS).
create or replace view public.invoice_number_blocks
with (security_invoker = true) as
select
  b.id,
  b.org_id,
  b.branch_id,
  b.series_code,
  b.block_no,
  b.first_value                                          as start_number,
  b.last_value                                           as end_number,
  b.next_value                                           as current_number,
  case when b.next_value <= b.last_value then 'active' else 'exhausted' end as status,
  b.created_at,
  b.updated_at
from public.number_blocks b;

grant select on public.invoice_number_blocks to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. app.claim_invoice_number re-created with the brief's exhaustion message. The logic is
-- identical to H3; only the raised text changes, and it still contains "block exhausted", so the H3
-- test 67 regex keeps matching. The brief's sentence is the operator-facing part.
-- ---------------------------------------------------------------------------
create or replace function app.claim_invoice_number(
  p_org_id uuid,
  p_branch_id uuid,
  p_series_code text default 'INVOICE'
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_block public.number_blocks;
  v_value bigint;
  v_has_blocks boolean;
begin
  select * into v_block
    from public.number_blocks b
   where b.org_id = p_org_id
     and b.branch_id = p_branch_id
     and b.series_code = p_series_code
     and b.next_value <= b.last_value
   order by b.block_no
   limit 1
   for update;

  if found then
    v_value := v_block.next_value;
    update public.number_blocks
       set next_value = v_value + 1
     where id = v_block.id;
    return lpad(v_value::text, 6, '0');
  end if;

  select exists (
    select 1 from public.number_blocks b
     where b.org_id = p_org_id and b.branch_id = p_branch_id and b.series_code = p_series_code
  ) into v_has_blocks;

  if not v_has_blocks then
    return app.next_number(p_org_id, p_series_code);
  end if;

  raise exception 'Invoice numbers exhausted - connect to cloud to get new block (invoice number block exhausted for branch % series %)', p_branch_id, p_series_code
    using errcode = 'P0001';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. app.fiscal_invoice_enqueue re-created to record invoice_number. Everything else is H3's.
-- ---------------------------------------------------------------------------
create or replace function app.fiscal_invoice_enqueue(
  p_org_id uuid,
  p_branch_id uuid,
  p_invoice_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_invoice_no text;
begin
  if not app.branch_mode_enabled() then
    return null;
  end if;

  select i.invoice_no into v_invoice_no
    from public.invoices i
   where i.id = p_invoice_id;

  insert into public.fiscal_invoices
    (org_id, branch_id, invoice_id, invoice_number, fdms_payload, status, attempts, next_attempt_at)
  values
    (p_org_id, p_branch_id, p_invoice_id, v_invoice_no,
     jsonb_build_object('invoice_id', p_invoice_id, 'invoice_no', v_invoice_no,
                        'queued_at', now()),
     'pending', 0, now())
  on conflict (org_id, invoice_id) do nothing
  returning id into v_id;

  if v_id is null then
    select fi.id into v_id
      from public.fiscal_invoices fi
     where fi.org_id = p_org_id and fi.invoice_id = p_invoice_id;
  end if;

  return v_id;
end;
$$;

grant execute on function app.claim_invoice_number(uuid, uuid, text)
  to authenticated, service_role;
grant execute on function app.fiscal_invoice_enqueue(uuid, uuid, uuid)
  to authenticated, service_role;
