-- Bootstrap a plain Postgres for ERP Core.
--
-- A hosted Supabase project, or `supabase start`, already provides everything below. A
-- self-managed Postgres (a branch box, or a cloud on your own Postgres) does not: the migrations
-- call auth.jwt()/auth.uid()/auth.role(), reference auth.users, and grant to the Supabase roles.
-- Run this once against an empty database, before `supabase db push`:
--
--   psql "$DATABASE_URL" -f scripts/bootstrap-postgres.sql
--
-- Idempotent. It creates schemas, the three JWT accessors (the same definitions GoTrue installs),
-- and a minimal auth.users table. With no GoTrue in front, rows in auth.users are created by
-- app.upsert_user_credentials / the invite flow, and the app mints its own tokens.

create schema if not exists extensions;
create schema if not exists auth;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gin with schema extensions;
create extension if not exists pg_trgm with schema extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit createrole;
  end if;
end
$$;

-- The claims live in request.jwt.claims, which is what SET LOCAL ROLE + set_config sets.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb;
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
$$;

-- Only the columns the core references. GoTrue owns the real table when it is present.
create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text,
  created_at timestamptz not null default now()
);

-- The RLS policies call auth.jwt() while running as `authenticated`, and the money/crypto helpers
-- live in `extensions`. Supabase grants USAGE on both schemas; a plain Postgres does not.
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
