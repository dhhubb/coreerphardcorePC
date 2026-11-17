-- F7 — the till's device settings, completing the hardware-and-receipts slice (H4).
--
-- H4 stored the branch's printer choice in public.printer_settings and rendered the 58mm receipt.
-- F7 closes the parts of the brief H4 left out. This migration is additive: it changes no core table
-- and no core posting function, and edits only H4's own surface (ADR-0065, ADR-0074).
--
-- The one piece of stored state F7 adds is the branch's CAMERA toggle. A camera needs a secure
-- context (HTTPS) and is optional, so the operator turns it on per branch on /pos/settings; the till
-- reads the flag and renders the CameraScanner only where a camera can work. It lives in its own
-- table rather than in printer_settings: that table is about printing, and a camera is not a printer.

create table public.pos_device_settings (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  branch_id      uuid not null references public.branches (id) on delete restrict,
  -- Whether the branch wants the optional camera scanner offered on the till.
  camera_enabled boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- One settings row per branch.
  constraint pos_device_settings_branch_key unique (org_id, branch_id)
);

create index pos_device_settings_org_branch_created_idx
  on public.pos_device_settings (org_id, branch_id, created_at desc, id desc);
create index pos_device_settings_org_created_idx
  on public.pos_device_settings (org_id, created_at desc, id desc);
create index pos_device_settings_branch_id_idx on public.pos_device_settings (branch_id);

create trigger pos_device_settings_set_updated_at
  before update on public.pos_device_settings
  for each row execute function app.set_updated_at();

-- Read the branch's device settings. Returns the default (camera off) when none is configured, so
-- the till always has an answer.
create or replace function app.get_pos_device_settings(
  p_org_id uuid,
  p_branch_id uuid
)
returns jsonb
language sql
stable
as $$
  select coalesce(
    (select jsonb_build_object('camera_enabled', s.camera_enabled)
       from public.pos_device_settings s
      where s.org_id = p_org_id
        and s.branch_id = p_branch_id),
    jsonb_build_object('camera_enabled', false)
  );
$$;

-- Upsert the branch's device settings. Idempotent on (org_id, branch_id).
create or replace function app.set_pos_device_settings(
  p_org_id uuid,
  p_branch_id uuid,
  p_camera_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.pos_device_settings;
begin
  insert into public.pos_device_settings (org_id, branch_id, camera_enabled)
  values (p_org_id, p_branch_id, coalesce(p_camera_enabled, false))
  on conflict (org_id, branch_id) do update
     set camera_enabled = excluded.camera_enabled
  returning * into v_row;

  return jsonb_build_object('camera_enabled', v_row.camera_enabled);
end;
$$;

-- RLS and grants, exactly like every other tenant table.
select app.apply_tenant_rls('public.pos_device_settings', 'branch');

grant execute on function app.get_pos_device_settings(uuid, uuid) to authenticated, service_role;
grant execute on function app.set_pos_device_settings(uuid, uuid, boolean) to authenticated, service_role;
