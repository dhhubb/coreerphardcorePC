-- F4: Branch server foundation — device codes, the cashier picker, and the branch console reads.
--
-- Additive only (ADR-0065, ADR-0071). Nothing here edits an applied migration, a core table or a
-- core function. F4 completes the H1 branch surface the brief names that H1 left as backend-only:
-- a 6-digit device code, a list of registered devices for /settings/devices, and a cashier list for
-- the /login PIN picker.
--
-- Adds:
--   * app.create_device_code(org_id, branch_id, till_id, ttl_minutes) — a 6-DIGIT one-time code
--     that expires after 10 minutes by default. Stores only its hash (same pattern as
--     app.create_device_registration, ADR-0024) and retries on a hash collision.
--   * app.list_device_registrations(org_id, branch_id, limit, after_created_at, after_id) — a
--     keyset page of a branch's devices. Never returns a hash.
--   * app.list_branch_cashiers(org_id, branch_id) — the branch's cashier PINs, with a display
--     label, for the PIN sign-in picker.
--
-- Design notes:
--   * A 6-digit code has only 10^6 values, so app.create_device_code retries on a collision of the
--     unique code_hash; the loop is bounded and raises if it cannot allocate.
--   * app.list_branch_cashiers is SECURITY DEFINER because it joins auth.users for a display label
--     and `authenticated` cannot read auth.users (verified: permission denied). It is scoped by its
--     org_id and branch_id parameters, so it can only ever return the caller's own branch. It is a
--     pre-auth read (the till has no token yet), so the route derives the scope from the branch's
--     own environment, exactly as the branch login route does.

-- ---------------------------------------------------------------------------
-- Mint a 6-digit one-time device code. Stores only the sha256 hash and returns the raw code once.
-- Expires after p_ttl_minutes (10 by default). Retries on a hash collision, since 6 digits is a
-- small space. The code is redeemed by the existing app.register_device.
-- ---------------------------------------------------------------------------
create or replace function app.create_device_code(
  p_org_id      uuid,
  p_branch_id   uuid,
  p_till_id     text,
  p_ttl_minutes int default 10
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_hash text;
  i      int;
begin
  if p_till_id is null or btrim(p_till_id) = '' then
    raise exception 'till_id is required' using errcode = '22023';
  end if;
  if p_ttl_minutes is null or p_ttl_minutes < 1 then
    raise exception 'ttl_minutes must be at least 1' using errcode = '22023';
  end if;

  for i in 1..20 loop
    -- A zero-padded 6-digit decimal, so '000123' is a valid code.
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    v_hash := app.hash_secret(v_code);
    begin
      insert into public.device_registrations
        (org_id, branch_id, till_id, code_hash, code_expires_at)
      values (p_org_id, p_branch_id, btrim(p_till_id), v_hash,
              now() + make_interval(mins => p_ttl_minutes));
      return v_code;
    exception when unique_violation then
      -- code_hash already exists; draw another code.
    end;
  end loop;

  raise exception 'could not allocate a unique device code' using errcode = '22023';
end;
$$;

comment on function app.create_device_code(uuid, uuid, text, int) is
  'Mints a 6-digit one-time device code (default 10-minute expiry); stores only its hash.';

-- ---------------------------------------------------------------------------
-- A keyset page of a branch's registered devices, newest first. The hashes are never returned.
-- ---------------------------------------------------------------------------
create or replace function app.list_device_registrations(
  p_org_id           uuid,
  p_branch_id        uuid,
  p_limit            int default 50,
  p_after_created_at timestamptz default null,
  p_after_id         uuid default null
)
returns table (
  id              uuid,
  till_id         text,
  label           text,
  code_expires_at timestamptz,
  consumed_at     timestamptz,
  token_issued_at timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz
)
language plpgsql
stable
security invoker
as $$
declare
  v_limit int := app.assert_page_limit(p_limit);
begin
  return query
  select d.id, d.till_id, d.label, d.code_expires_at, d.consumed_at, d.token_issued_at,
         d.revoked_at, d.created_at
    from public.device_registrations d
   where d.org_id = p_org_id
     and d.branch_id = p_branch_id
     and (
       p_after_created_at is null
       or (d.created_at, d.id) < (p_after_created_at, p_after_id)
     )
   order by d.created_at desc, d.id desc
   limit v_limit;
end;
$$;

comment on function app.list_device_registrations(uuid, uuid, int, timestamptz, uuid) is
  'Keyset page of a branch''s devices (created_at, id); never returns a hash.';

-- ---------------------------------------------------------------------------
-- The branch's cashiers, for the PIN sign-in picker. A label (the cashier's email, or a short id
-- when there is none) is returned so the till can show a human choice. No hash is ever returned.
--
-- SECURITY DEFINER: it joins auth.users for the label, which `authenticated` cannot read. It is
-- scoped by its parameters, so it can only return rows for the given org and branch.
-- ---------------------------------------------------------------------------
create or replace function app.list_branch_cashiers(
  p_org_id    uuid,
  p_branch_id uuid
)
returns table (
  cashier_id   uuid,
  label        text,
  is_manager   boolean,
  is_active    boolean,
  locked_until timestamptz
)
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select cp.cashier_id,
         coalesce(u.email, 'cashier-' || left(cp.cashier_id::text, 8)) as label,
         cp.is_manager,
         cp.is_active,
         cp.locked_until
    from public.cashier_pins cp
    left join auth.users u on u.id = cp.cashier_id
   where cp.org_id = p_org_id
     and cp.branch_id = p_branch_id
   order by cp.is_manager desc, label asc;
$$;

comment on function app.list_branch_cashiers(uuid, uuid) is
  'The branch''s cashier PINs with a display label, for the PIN sign-in picker. No hash returned.';

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
grant execute on function app.create_device_code(uuid, uuid, text, int)
  to authenticated, service_role;
grant execute on function app.list_device_registrations(uuid, uuid, int, timestamptz, uuid)
  to authenticated, service_role;
grant execute on function app.list_branch_cashiers(uuid, uuid) to authenticated, service_role;
