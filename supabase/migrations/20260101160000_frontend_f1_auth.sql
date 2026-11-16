-- F1: frontend shell and auth.
--
-- Additive. The core tables and functions are untouched (ADR-0065). This adds one table and three
-- functions so a user can sign in with an email and password instead of pasting a token into
-- localStorage:
--
--   * app.user_credentials — bcrypt password hash keyed by auth.users.id. It is deliberately NOT a
--     public tenant table: it carries no org_id (a user may belong to several orgs), it is never
--     reachable through the Data API, and only the login path reads it. So it is not registered in
--     scripts/check-tenant-tables.sql or tests/support/tenant-tables.ts.
--   * app.authenticate(email, password) — verifies the password and returns the auth.users.id. Runs
--     as the definer so the login route needs no service role and no RLS bypass.
--   * app.login_context(user_id) — the tenant claims for the token (the same shape the custom access
--     token hook mints) plus the org name for the shell header.
--   * app.upsert_user_credentials(id, password) — sets a password (the seed and the tests use it).

create table app.user_credentials (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  password_hash text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table app.user_credentials is
  'bcrypt password hashes for email/password sign-in. Not a tenant table: no org_id, not exposed.';

create trigger user_credentials_set_updated_at
  before update on app.user_credentials
  for each row execute function app.set_updated_at();

-- Set (or replace) a user's password. The hash is produced by pgcrypto's bcrypt in the database, so
-- a plaintext password never reaches a table and never leaves this call.
create or replace function app.upsert_user_credentials(p_user_id uuid, p_password text)
returns void
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
begin
  if p_password is null or length(p_password) < 6 then
    raise exception 'password must be at least 6 characters' using errcode = '22023';
  end if;
  insert into app.user_credentials (user_id, password_hash)
  values (p_user_id, extensions.crypt(p_password, extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update
    set password_hash = excluded.password_hash,
        updated_at    = now();
end;
$$;

-- Verify an email and password and return the auth.users.id, or null when the pair does not match.
--
-- A wrong email and a wrong password are indistinguishable: both return null. `extensions.crypt`
-- compares against the stored hash with the stored salt, so the check is constant-time in the hash.
create or replace function app.authenticate(p_email text, p_password text)
returns uuid
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
  v_user_id uuid;
  v_hash    text;
begin
  if p_email is null or p_password is null then
    return null;
  end if;

  select u.id, c.password_hash
    into v_user_id, v_hash
    from auth.users u
    join app.user_credentials c on c.user_id = u.id
   where lower(u.email) = lower(trim(p_email))
   limit 1;

  if v_user_id is null then
    return null;
  end if;
  if extensions.crypt(p_password, v_hash) <> v_hash then
    return null;
  end if;
  return v_user_id;
end;
$$;

-- The login context for a user: the tenant claims the custom access token hook would mint, plus the
-- org name for the shell header. Resolved from the active membership, as the definer, so the login
-- route (which has no user context yet) needs no service role. Returns null when the user has no
-- membership: the token then carries a null org_id, exactly like the hook.
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
    'role',       coalesce(m.role, 'authenticated')
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

-- The login path runs as the caller; only these functions are reachable, and both need no table
-- access for the caller. No grant on the table itself: nothing but the definer functions reads it.
grant execute on function app.authenticate(text, text) to anon, authenticated, service_role;
grant execute on function app.login_context(uuid) to anon, authenticated, service_role;
grant execute on function app.upsert_user_credentials(uuid, text) to service_role;
