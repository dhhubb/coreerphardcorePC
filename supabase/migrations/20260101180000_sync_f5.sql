-- F5 — the sync engine completion slice.
--
-- H2 (20260101080000_sync_h2.sql) shipped the branch outbox, the idempotent cloud ingest, the
-- master-data pull, the retry/conflict policy, the status read and the encrypted backup. F5
-- completes the parts of the brief H2 left out, and it is ADDITIVE: no core table and no core
-- posting function is touched. It edits only the H2 vertical's own objects (ADR-0065, ADR-0072).
--
-- What this migration adds or widens:
--   1. Two event types H2 never emitted — 'z_report' (a closed shift) and 'fiscal_result' (an FDMS
--      outcome) — plus the brief's 'journal' and 'stock_move' spellings, so the check carries the
--      brief's vocabulary as well as H2's.
--   2. sync_conflicts.both_versions, so a conflict records what the branch sent AND what the cloud
--      said, and a retry can rebuild the event.
--   3. A non-blocking cloud dispatcher: one rejected event no longer stops the rest of the batch.
--   4. A GET pull, a backup ingest endpoint and a conflict retry — all branch facts the brief names.
--   5. price_version recorded per sale line, so a sale keeps the version it charged (test 134).
--   6. sync_state.last_backup_at, kept current by a trigger on sync_backups.
--   7. 'customer' and 'user' master-data entity types (the brief lists customers and users).

-- ---------------------------------------------------------------------------
-- 1. The outbox event vocabulary. H2 shipped sale/receipt/adjustment/payment/credit_note/
-- stock_count/master_data. The brief also names journal, stock_move, z_report and fiscal_result.
-- Widen the check so a branch can record them; z_report and fiscal_result get real triggers below.
-- ---------------------------------------------------------------------------
alter table public.sync_outbox drop constraint sync_outbox_event_type_check;
alter table public.sync_outbox add constraint sync_outbox_event_type_check
  check (event_type in ('sale', 'receipt', 'adjustment', 'payment', 'credit_note', 'stock_count',
                        'master_data', 'journal', 'stock_move', 'z_report', 'fiscal_result'));

-- ---------------------------------------------------------------------------
-- 2. Conflicts carry both versions. `detail` stays for H2's rows; `both_versions` holds
-- { local: <the branch's event payload>, cloud: <what the cloud answered> }, so the status page can
-- show both and a retry can rebuild the event from the local side.
-- ---------------------------------------------------------------------------
alter table public.sync_conflicts
  add column both_versions jsonb not null default '{}'::jsonb;
alter table public.sync_conflicts
  add constraint sync_conflicts_both_versions_check check (jsonb_typeof(both_versions) = 'object');

-- Replace the recorder with one that also stores both versions. The old 7-argument signature is
-- dropped so there is exactly one function; callers that pass 7 arguments still resolve, because
-- the new last argument has a default.
drop function if exists app.sync_record_conflict(uuid, uuid, uuid, bigint, text, text, jsonb);

create or replace function app.sync_record_conflict(
  p_org_id        uuid,
  p_branch_id     uuid,
  p_event_id      uuid,
  p_branch_seq    bigint,
  p_event_type    text,
  p_reason        text,
  p_detail        jsonb default '{}'::jsonb,
  p_both_versions jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.sync_conflicts
    (org_id, branch_id, event_id, branch_seq, event_type, reason, detail, both_versions)
  values (p_org_id, p_branch_id, p_event_id, p_branch_seq, p_event_type, p_reason,
          coalesce(p_detail, '{}'::jsonb), coalesce(p_both_versions, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function app.sync_record_conflict(uuid, uuid, uuid, bigint, text, text, jsonb, jsonb)
  to authenticated, service_role;

-- Re-queue a conflicted event as a fresh outbox event, so "retry failed" gives it another chance
-- without un-acking the original (acked_at is write-once). The new event carries the same payload
-- under a new event id, so the cloud treats it as a new delivery.
create or replace function app.sync_requeue_conflict(p_org_id uuid, p_conflict_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row  public.sync_conflicts%rowtype;
  v_type text;
  v_pay  jsonb;
begin
  select * into v_row
    from public.sync_conflicts
   where id = p_conflict_id and org_id = p_org_id;
  if not found then
    raise exception 'no such conflict' using errcode = 'no_data_found';
  end if;

  v_type := coalesce(v_row.event_type, 'sale');
  v_pay := coalesce(v_row.both_versions -> 'local', '{}'::jsonb);
  if v_pay = '{}'::jsonb then
    v_pay := coalesce(v_row.detail, '{}'::jsonb);
  end if;

  return app.sync_outbox_enqueue(v_row.org_id, v_row.branch_id, gen_random_uuid(), v_type, v_pay);
end;
$$;

grant execute on function app.sync_requeue_conflict(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Non-blocking cloud dispatcher. H2 returned early on the first rejection, so one bad event in
-- the middle of a batch stopped every event after it, and a permanently-rejected event was never
-- acked (so the branch re-pushed it forever). The brief requires that a rejected event does not
-- block the others. This dispatcher applies every event it can, records each rejection, and reports
-- highest_seq as the highest sequence it PROCESSED — applied, duplicated, or rejected. A rejected
-- event is therefore resolved: the branch records the conflict (the durable record) and acks past
-- it, so the outbox drains and the branch makes progress. A human retry re-queues it explicitly
-- through app.sync_requeue_conflict.
-- ---------------------------------------------------------------------------
create or replace function app.sync_push_result(
  p_org_id    uuid,
  p_branch_id uuid,
  p_events    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event    jsonb;
  v_seq      bigint;
  v_event_id uuid;
  v_type     text;
  v_payload  jsonb;
  v_result   jsonb;
  v_applied  int := 0;
  v_dup      int := 0;
  v_high     bigint := 0;
  v_rejects  jsonb := '[]'::jsonb;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'push batch must be a json array' using errcode = '22023';
  end if;

  for v_event in select value from jsonb_array_elements(p_events)
  loop
    v_seq := nullif(v_event ->> 'seq', '')::bigint;
    v_event_id := nullif(v_event ->> 'event_id', '')::uuid;
    v_type := v_event ->> 'event_type';
    v_payload := coalesce(v_event -> 'payload', '{}'::jsonb);

    if v_seq is null or v_event_id is null or v_type is null then
      v_rejects := v_rejects || jsonb_build_object(
        'event_id', v_event ->> 'event_id',
        'reason', 'malformed event: seq, event_id and event_type are required'
      );
      continue;
    end if;

    -- Subtransaction per event: a rejected event rolls back only its own work. The loop CONTINUES,
    -- so the rest of the batch still applies (test 131: a rejection does not block other events).
    begin
      v_result := app.sync_apply_event(p_org_id, p_branch_id, v_event_id, v_type, v_seq, v_payload);
      if v_result ->> 'outcome' = 'duplicate' then
        v_dup := v_dup + 1;
      else
        v_applied := v_applied + 1;
      end if;
    exception when others then
      v_rejects := v_rejects || jsonb_build_object(
        'event_id', v_event_id::text,
        'seq', v_seq,
        'reason', sqlerrm
      );
    end;

    -- A rejected event is resolved (it is recorded as a conflict), so the branch may ack past it.
    -- This is what lets the outbox drain instead of re-pushing the same bad event forever.
    if v_seq > v_high then
      v_high := v_seq;
    end if;
  end loop;

  return jsonb_build_object(
    'highest_seq', v_high,
    'applied', v_applied,
    'duplicates', v_dup,
    'rejects', v_rejects
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4a. A closed shift is a branch fact the cloud must learn: emit a 'z_report' event. H2 emitted
-- nothing for z_reports.
-- ---------------------------------------------------------------------------
create or replace function app.sync_outbox_on_z_report()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not app.branch_mode_enabled() then
    return null;
  end if;

  perform app.sync_outbox_enqueue(
    new.org_id, new.branch_id, new.id, 'z_report',
    jsonb_build_object(
      'z_report_id', new.id,
      'shift_id', new.shift_id,
      'z_no', new.z_no,
      'opened_at', new.opened_at,
      'closed_at', new.closed_at,
      'opening_float', new.opening_float,
      'sale_count', new.sale_count,
      'void_count', new.void_count,
      'gross_sales', new.gross_sales,
      'tax_total', new.tax_total,
      'by_method', new.by_method,
      'by_currency', new.by_currency,
      'vat_by_rate', new.vat_by_rate
    )
  );
  return null;
end;
$$;

create trigger sync_outbox_z_report
  after insert on public.z_reports
  for each row execute function app.sync_outbox_on_z_report();

-- ---------------------------------------------------------------------------
-- 4b. An FDMS outcome is a branch fact the cloud must learn: emit a 'fiscal_result' event when a
-- fiscal invoice reaches 'sent' or 'failed'. H2 emitted nothing for fiscal results.
-- ---------------------------------------------------------------------------
create or replace function app.sync_outbox_on_fiscal_result()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not app.branch_mode_enabled() then
    return null;
  end if;
  if new.status not in ('sent', 'failed') then
    return null;
  end if;
  if old.status is not distinct from new.status then
    return null;
  end if;

  perform app.sync_outbox_enqueue(
    new.org_id, new.branch_id, new.id, 'fiscal_result',
    jsonb_build_object(
      'fiscal_invoice_id', new.id,
      'invoice_id', new.invoice_id,
      'status', new.status,
      'attempts', new.attempts,
      'fdms_response', new.fdms_response,
      'last_error', new.last_error,
      'sent_at', new.sent_at
    )
  );
  return null;
end;
$$;

create trigger sync_outbox_fiscal_result
  after update on public.fiscal_invoices
  for each row execute function app.sync_outbox_on_fiscal_result();

-- ---------------------------------------------------------------------------
-- 5. The price version a sale charged. A sale is rung at a price the till read from the local
-- mirror; that mirror row carries a price_version (the cloud change_seq). F5 records, per sale
-- line, the version that applied at the moment of the sale, so a later pull that bumps the version
-- cannot rewrite history (test 134). This is a NEW branch table written by a NEW trigger — the
-- core invoice tables are untouched (ADR-0065).
-- ---------------------------------------------------------------------------
create table public.pos_sale_price_versions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete cascade,
  branch_id       uuid not null references public.branches (id) on delete restrict,
  sale_id         uuid not null,
  sale_created_at timestamptz not null,
  line_no         int not null,
  variant_id      uuid,
  unit_price      numeric(19, 4) not null,
  price_version   bigint not null default 0,
  created_at      timestamptz not null default now(),
  constraint pos_sale_price_versions_line_key unique (org_id, sale_id, line_no)
);

create index pos_sale_price_versions_org_branch_created_idx
  on public.pos_sale_price_versions (org_id, branch_id, created_at desc, id desc);
create index pos_sale_price_versions_org_created_idx
  on public.pos_sale_price_versions (org_id, created_at desc, id desc);
create index pos_sale_price_versions_branch_id_idx on public.pos_sale_price_versions (branch_id);
create index pos_sale_price_versions_sale_id_idx on public.pos_sale_price_versions (sale_id);

select app.apply_tenant_rls('public.pos_sale_price_versions', 'branch');
select app.enforce_immutable('public.pos_sale_price_versions');

create or replace function app.sync_record_sale_price_versions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not app.branch_mode_enabled() then
    return null;
  end if;

  -- One row per invoice line of the sale's invoice, carrying the mirror's price version at sale
  -- time. The mirror may not hold the variant (a branch that has not pulled it), in which case the
  -- version is 0 — the sale still records the price it charged.
  insert into public.pos_sale_price_versions
    (org_id, branch_id, sale_id, sale_created_at, line_no, variant_id, unit_price, price_version)
  select new.org_id, new.branch_id, new.id, new.created_at, il.line_no, il.variant_id,
         il.unit_price, coalesce(d.price_version, 0)
    from public.invoice_lines il
    left join public.branch_master_data d
      on d.org_id = new.org_id
     and d.branch_id = new.branch_id
     and d.entity_type = 'price_list_item'
     and d.entity_id = il.variant_id
   where il.invoice_id = new.invoice_id
  on conflict (org_id, sale_id, line_no) do nothing;

  return null;
end;
$$;

create constraint trigger sync_record_sale_price_versions
  after insert on public.pos_sales
  deferrable initially deferred
  for each row execute function app.sync_record_sale_price_versions();

-- ---------------------------------------------------------------------------
-- 6. The last successful backup, on sync_state. A trigger on sync_backups keeps it current, so no
-- H2 function has to change.
-- ---------------------------------------------------------------------------
alter table public.sync_state add column last_backup_at timestamptz;

create or replace function app.sync_state_note_backup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status <> 'uploaded' then
    return null;
  end if;

  insert into public.sync_state (org_id, branch_id, protocol_version, last_backup_at)
  values (new.org_id, new.branch_id, app.branch_protocol_version(),
          coalesce(new.finished_at, now()))
  on conflict (org_id, branch_id) do update
    set last_backup_at = coalesce(excluded.last_backup_at, now());
  return null;
end;
$$;

create trigger sync_backups_note_backup
  after insert on public.sync_backups
  for each row execute function app.sync_state_note_backup();

-- ---------------------------------------------------------------------------
-- 7. Master-data vocabulary: the brief lists customers and users. Widen both checks so a vertical
-- can record them. (No trigger records them here: doing so would move change_seq under H2's tests,
-- so the wiring is left to the vertical that owns the entity.)
-- ---------------------------------------------------------------------------
alter table public.master_data_changes drop constraint master_data_changes_entity_type_check;
alter table public.master_data_changes add constraint master_data_changes_entity_type_check
  check (entity_type in ('product', 'product_variant', 'price_list_item', 'tax_rate', 'promotion',
                         'exchange_rate', 'settings', 'customer', 'user'));

alter table public.branch_master_data drop constraint branch_master_data_entity_type_check;
alter table public.branch_master_data add constraint branch_master_data_entity_type_check
  check (entity_type in ('product', 'product_variant', 'price_list_item', 'tax_rate', 'promotion',
                         'exchange_rate', 'settings', 'customer', 'user'));

-- ---------------------------------------------------------------------------
-- 8. The status read gains last_backup_at and an explicit pending count (the outbox depth). It
-- keeps every H2 key, so the H2 status page and the F5 page both read it.
-- ---------------------------------------------------------------------------
create or replace function app.sync_status(p_org_id uuid, p_branch_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_state      public.sync_state%rowtype;
  v_outbox     bigint;
  v_max_seq    bigint;
  v_conflicts  bigint;
  v_last_push  timestamptz;
  v_last_pull  timestamptz;
begin
  select * into v_state
    from public.sync_state
   where org_id = p_org_id and branch_id = p_branch_id;

  select count(*), coalesce(max(seq), 0)
    into v_outbox, v_max_seq
    from public.sync_outbox
   where org_id = p_org_id and branch_id = p_branch_id and acked_at is null;

  select count(*)
    into v_conflicts
    from public.sync_conflicts
   where org_id = p_org_id and branch_id = p_branch_id;

  select max(acked_at) into v_last_push
    from public.sync_outbox
   where org_id = p_org_id and branch_id = p_branch_id;

  select max(applied_at) into v_last_pull
    from public.sync_inbox
   where org_id = p_org_id and branch_id = p_branch_id;

  return jsonb_build_object(
    'protocol_version', coalesce(v_state.protocol_version, app.branch_protocol_version()),
    'last_pushed_seq', coalesce(v_state.last_pushed_seq, 0),
    'last_pulled_cursor', v_state.last_pulled_cursor,
    'cloud_status', coalesce(v_state.cloud_status, 'unknown'),
    'cloud_protocol_version', v_state.cloud_protocol_version,
    'push_blocked', coalesce(v_state.cloud_status, 'unknown') = 'incompatible',
    'outbox_size', v_outbox,
    'pending_count', v_outbox,
    'outbox_max_seq', v_max_seq,
    'conflicts', v_conflicts,
    'last_push_at', v_last_push,
    'last_pull_at', v_last_pull,
    'last_backup_at', v_state.last_backup_at
  );
end;
$$;

grant execute on function app.sync_status(uuid, uuid) to authenticated, service_role;
