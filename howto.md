# How to configure the app for multiple users

This guide explains how to add more than one user to an installation of ERP Core and how tenancy
works once you do. It covers the cloud (email and password) and the branch (cashier PIN) sign-in
paths, the two ways to add a user (invite, or direct setup), and the rules that decide what each
user can see.

Read [Tenancy and RLS](README.md#tenancy-and-rls) in the README first if you want the design
rationale; this file is the step-by-step procedure.

## Contents

1. [The model in one paragraph](#1-the-model-in-one-paragraph)
2. [Requirements](#2-requirements)
3. [Roles and what each one is for](#3-roles-and-what-each-one-is-for)
4. [Option A — add a user with an invite (recommended)](#4-option-a--add-a-user-with-an-invite-recommended)
5. [Option B — add a user directly (admin/seed)](#5-option-b--add-a-user-directly-adminseed)
6. [Adding a second organisation (true multi-tenant)](#6-adding-a-second-organisation-true-multi-tenant)
7. [Branch (cashier PIN) users](#7-branch-cashier-pin-users)
8. [What each user can see (RLS rules)](#8-what-each-user-can-see-rls-rules)
9. [Membership changes and token refresh](#9-membership-changes-and-token-refresh)
10. [Verifying the setup](#10-verifying-the-setup)
11. [Troubleshooting](#11-troubleshooting)
12. [Security rules you must not break](#12-security-rules-you-must-not-break)

---

## 1. The model in one paragraph

Every user is a Supabase Auth user (`auth.users`). A user becomes useful to an organisation through
a **membership** row (`public.memberships`), which is keyed by `(org_id, user_id)` and carries a
`role` and a list of `branch_ids`. At sign-in the app builds the access-token claims from that
membership (`org_id` and `branch_ids`) — `app.login_context` returns exactly the claims the Supabase
custom access token hook would mint — and every table's Row Level Security (RLS) policy compares the
row's `org_id`/`branch_id` against those claims. A user with no membership is valid but sees nothing
(the token carries `org_id: null`). One user can belong to several organisations; sign-in picks the
**oldest active membership** (ordered by `created_at`).

## 2. Requirements

Before you add users, make sure:

- **The stack is running.** `supabase start` is up and `supabase db reset` has applied every
  migration. Docker must be running.
- **Environment is set.** `.env.local` exists (copy `.env.example`) and `DATABASE_URL` points at the
  local database from `supabase status`. `SUPABASE_JWT_SECRET` must be the same value the local
  stack prints in `supabase status` — tokens are signed with it, so a mismatch means every token is
  rejected.
- **An organisation and at least one branch exist.** If you have not seeded yet, run
  `npm run db:seed-demo`, or create them as shown in step 4. Every user is scoped to an org, and a
  branch-scoped user also needs at least one branch id.
- **You have an org member session (or the database owner).** Invite and membership writes are
  governed by RLS on `org_id` only: **any** active member of the org may create an invite or a
  membership for that org. In this phase RLS does **not** further restrict those writes by role.
  Enforce "only owners/admins may invite" in your process, not by relying on the role column.
- **You know each user's email.** Email is the identity; it is lower-cased and trimmed before it is
  stored or matched, so `User@Shop.com` and `user@shop.com` are the same account.

## 3. Roles and what each one is for

Roles live in `public.memberships.role` and are constrained to three values.

| Role | Intended for | Typical branch scope |
| --- | --- | --- |
| `owner` | The account that owns the org. Used by the seed and the console. | All branches (`branch_ids` = every branch) |
| `admin` | A manager who can invite users and manage the catalogue. | The branches they run |
| `member` | A day-to-day user (a cashier on the cloud, a stock clerk). | One or more specific branches |

Two rules apply to every role:

- A role is **not** a privilege check inside the API. What a user can actually read is decided by
  RLS using `org_id` and `branch_ids`. The role is descriptive and is returned by `/api/auth/me`.
- Branch access is the `branch_ids` array on the membership, **not** the role. A `member` scoped to
  branch X sees branch X; an `owner` scoped to `{}` sees no branch rows at all.

There is also a separate branch-only concept, the **cashier PIN** (see [section 7](#7-branch-cashier-pin-users)).
That is for the offline branch server and does not apply to cloud email/password users.

## 4. Option A — add a user with an invite (recommended)

An invite is a single-use, 72-hour token. Only a SHA-256 hash of it is stored, so the plaintext
token is shown **once** and cannot be recovered. This is the normal way to add a user.

### 4.1 Create the invite (as an org member)

`app.create_invite(org_id, email, role, branch_ids, ttl_hours)` returns the raw token. Run it as a
member of the org (RLS scopes the insert to your `org_id`). In psql or Supabase Studio:

```sql
-- As a member of the org (RLS applies), or as the database owner when bootstrapping.
select app.create_invite(
  '<ORG_ID>',                       -- the organisation
  'new.user@example.com',           -- the invitee's email
  'member',                         -- 'owner' | 'admin' | 'member'
  array['<BRANCH_ID>']::uuid[],     -- branches this user may read (may be several)
  72                                -- hours until expiry (default 72)
) as invite_token;
```

Copy the returned `invite_token` immediately — it is not stored. Only the hash goes into
`public.invites.token_hash`.

Notes:

- The email is stored lower-cased.
- Pass an empty array `array[]::uuid[]` for an org-only user, but understand they will then see no
  branch-scoped rows (invoices, stock, journals, …).
- `create_invite` records `created_by = auth.uid()`.
- Creating an invite does **not** create the user account. The invitee must have a sign-in account
  before or when they accept (see 4.3).

### 4.2 Give the token to the invitee

Send them the raw token through whatever channel you trust (they paste it in step 4.3). Do not store
it in a table or a log; it expires in 72 hours and works exactly once.

### 4.3 The invitee accepts (as themselves)

`accept_invite` acts on `auth.uid()`, so the invitee must be **signed in** when they call it — which
means their account must exist first. There is **no self-signup route in this phase** (`/api/auth`
exposes only `login` and `me`; `supabase/config.toml` has `enable_signup = true` but the app has no
signup UI). Create the account as in [Option B](#5-option-b--add-a-user-directly-adminseed) steps 1–2
(the `auth.users` row plus the password), *then* have the invitee accept:

```sql
-- (a) Beforehand, as the database owner: create the account and password for the invitee.
insert into auth.users (id, email)
select gen_random_uuid(), 'new.user@example.com'
where not exists (select 1 from auth.users where lower(email) = 'new.user@example.com');

select app.upsert_user_credentials(
  (select id from auth.users where lower(email) = 'new.user@example.com'),
  'a-strong-password'
);

-- (b) The invitee signs in and, with their own token, accepts the invite.
--     Runs as `authenticated` with the invitee's email set.
select app.accept_invite('<INVITE_TOKEN>') as membership_id;
```

Because the account already exists when they accept, their next `/api/auth/login` returns a token
whose `org_id`/`branch_ids` come from the membership the invite just created.

If you are going to create the account yourself anyway, note that the invite adds little over simply
creating the membership directly (Option B step 3) — its value is that the token encodes the intended
role and branches, is single-use, and is auditable. Choose whichever fits your process.

Behaviour and errors (all are deliberate):

- Unknown token → `invite token is invalid`.
- Already redeemed → `invite token has already been used`.
- Past `expires_at` → `invite token has expired`.
- No signed-in user → `accept_invite requires an authenticated user`.
- On success the membership row is inserted, or if the `(org_id, user_id)` pair already exists it is
  updated and set `is_active = true`. The invite is marked `used_at = now()`.

### 4.4 The new user signs in

The invitee signs in at `/login` with their email and password (`POST /api/auth/login`). The route
verifies the password against the bcrypt hash and returns a token whose `org_id`/`branch_ids` come
from the membership they just accepted. See [section 9](#9-membership-changes-and-token-refresh):
they must sign in **after** accepting, so the token picks up the new claims.

## 5. Option B — add a user directly (admin/seed)

Use this for bootstrapping (the first owner), for support, or for a scripted setup. It does the four
things the invite flow does, in order, without an invite. Run it as the database owner (for example
through `psql`, Supabase Studio, or a small Node/`pg` script) because it writes `auth.users`,
`app.user_credentials` and `public.memberships` directly.

```sql
-- 1. Create the auth user only if the email is new, so re-running this block is safe.
--    (auth.users is Supabase-managed: create the row; GoTrue owns the rest.)
insert into auth.users (id, email)
select gen_random_uuid(), 'user@example.com'
where not exists (
  select 1 from auth.users where lower(email) = 'user@example.com'
);

-- 2. Set the password. The hash is produced by pgcrypto bcrypt in the database; the plaintext
--    never reaches a table. This function is SECURITY DEFINER and granted to service_role only.
select app.upsert_user_credentials(
  (select id from auth.users where lower(email) = 'user@example.com'),
  'a-strong-password'
);

-- 3. Add the membership (this is what sign-in reads to build the token claims).
insert into public.memberships (org_id, user_id, role, branch_ids)
values (
  '<ORG_ID>',
  (select id from auth.users where lower(email) = 'user@example.com'),
  'member',
  array['<BRANCH_ID>']::uuid[]
)
on conflict (org_id, user_id) do update
  set role = excluded.role,
      branch_ids = excluded.branch_ids,
      is_active = true;

-- 4. Confirm what the token will carry.
select app.login_context(
  (select id from auth.users where lower(email) = 'user@example.com')
);
```

`app.login_context` returns the exact JSON the token claims are minted from:

```json
{
  "user_id": "…",
  "email": "user@example.com",
  "org_id": "…",
  "org_name": "Demo store",
  "branch_ids": ["…"],
  "role": "member"
}
```

Password requirements: at least 6 characters (`app.upsert_user_credentials` rejects anything
shorter). For anything beyond a local demo, prefer 8+ and a real secret store.

> Keep `app.upsert_user_credentials` where it is. It is granted to `service_role` only, on purpose:
> no application request path may set another user's password (see
> [section 12](#12-security-rules-you-must-not-break)).

## 6. Adding a second organisation (true multi-tenant)

One user per org is the common case, but the schema is multi-tenant. To stand up a second
organisation:

```sql
-- Creates the org and its defaults: settings, number series, a chart of accounts, VAT and the
-- base-currency exchange rate row. Run as an owner/admin (or the database owner when bootstrapping).
select app.create_org('Northside Pharmacy', 'northside-pharmacy') as new_org_id;

-- Create its first branch.
insert into public.branches (org_id, name, slug)
values ('<NEW_ORG_ID>', 'Main', 'main')
returning id;
```

Then add members the usual way (section 4 or 5), pointing `org_id` at the new org. Tenants are fully
isolated: an Org A token reads no Org B row, because every policy compares against the token's
`org_id`.

If a user should belong to **both** orgs, give them two membership rows (one per org). They will not
have two live sessions at once: a single token names exactly one `org_id`, chosen as the oldest
active membership. Switching orgs means a second membership record selected at sign-in; in this
phase the app does not offer an in-session org switcher.

## 7. Branch (cashier PIN) users

The branch server (`BRANCH_MODE=branch`) replaces cloud sign-in with a **local cashier PIN**, so a
till can sign in with the internet off. This is a different login from the cloud email/password
form; `/login` shows the PIN picker in branch mode and the email form otherwise.

A cashier PIN is stored hashed and is not the same as a password:

```sql
-- Sets (or resets) a cashier's PIN; bcrypt in SQL, never plaintext. SECURITY DEFINER, scoped by
-- its parameters (org, branch, cashier). Run it from the branch admin surface.
select app.set_cashier_pin(
  '<ORG_ID>',
  '<BRANCH_ID>',
  '<CASHIER_USER_ID>',     -- an auth.users id
  '1234',                  -- the PIN (>= 4 chars)
  false                    -- true to mark this PIN as a manager's (for overrides)
);
```

> `app.set_cashier_pin` is granted to `authenticated` and is scoped by its arguments rather than by
> RLS, so in this phase it does not itself restrict *which* caller may set a PIN. Drive it from your
> branch-admin process, not from an untrusted client path.

Rules:

- The cashier must also have an `auth.users` row and a membership scoped to that branch.
- Five wrong attempts lock the PIN for a cooling-off window; the till shows "locked" rather than a
  transport error.
- A **manager override** (for example, to void a line) needs a separate PIN that was set with
  `is_manager = true`, verified by `app.manager_override`.
- A successful PIN sign-in mints a branch token carrying that branch's `org_id` and `branch_id`, so
  a cashier can only ever reach their own branch.

## 8. What each user can see (RLS rules)

RLS is enabled and **forced** on every tenant table, so these rules hold even for the table owner.
Policies read the token, never the `memberships` table:

- **Org-scoped tables** (`branches`, `memberships`, `invites`, `products`, `product_variants`,
  `contacts`, `chart_of_accounts`, `tax_rates`, `exchange_rates`, `fiscal_periods`, `number_series`,
  and `organizations`/`settings`): a row is visible when its `org_id` equals the token's `org_id`
  (`app.has_org_access`).
- **Branch-scoped tables** (`warehouses`, `stock_*`, `journals`, `journal_lines`, `sales_orders`,
  `invoices`, `invoice_lines`, `payments`, `credit_notes`, `purchase_orders`, `audit_logs`, and the
  verticals' branch tables): a row is visible when its `org_id` matches **and** its `branch_id` is in
  the token's `branch_ids` (`app.has_branch_access`).
- **No membership** → the token has `org_id: null` and `branch_ids: []`, so the user reads zero
  tenant rows. They can still sign in; they just see nothing.
- **Membership with an empty `branch_ids`** → sees org-scoped rows but no branch-scoped rows.
- **Writing** uses the same predicate (`with check`), so a user cannot insert a row for another org
  or another branch. An insert naming a foreign `org_id` is rejected.

## 9. Membership changes and token refresh

This is the single most surprising rule, so it is called out here and in the README.

> **Membership changes take effect when the token refreshes, not before.**

RLS reads the claims baked into the **current access token**. It never re-reads the `memberships`
table. So:

- Adding a user to a branch, changing their role, or removing them does **not** change what an
  already-issued token can see.
- The change applies when a **new** token is issued. In this app the practical trigger is **signing
  in again** (`POST /api/auth/login`), which mints a fresh token from the current membership. Tokens
  are valid for 12 hours.
- To revoke access immediately, change the membership **and** have the user sign in again (or wait
  for their token to be replaced). If you need instant revocation in a future phase, that is a
  token-versioning feature, not something to hack in here.

Identity for the claims comes from `app.login_context(user_id)` (the local path) and from
`public.custom_access_token_hook` (the Supabase Auth path). Both read the same membership row, in the
same order, so they agree. In the local stack the hook is shipped but not wired up in
`supabase/config.toml`; the app's `/api/auth/login` uses `app.login_context` instead.

Practical consequence for onboarding: **accept the invite (or create the membership) before the
user's first sign-in,** so their first token already carries the right org and branches.

## 10. Verifying the setup

After adding a user, confirm each layer:

1. **The membership exists and is active.**

   ```sql
   select org_id, user_id, role, branch_ids, is_active
     from public.memberships
    where user_id = '<USER_ID>';
   ```

2. **The token claims are correct.** Sign in and read the response, or decode the token payload:

   ```bash
   curl -s -X POST http://127.0.0.1:3000/api/auth/login \
     -H 'content-type: application/json' \
     -d '{"email":"user@example.com","password":"a-strong-password"}'
   ```

   Expect `org_id`, `branch_ids` and `role` to match the membership.

3. **The session validates.** With the token in hand:

   ```bash
   curl -s http://127.0.0.1:3000/api/auth/me \
     -H "authorization: Bearer <TOKEN>"
   ```

   Expect `{ user, org_id, org_name, branch_ids, role }`.

4. **RLS actually hides other tenants.** Two users in two orgs should each see only their own rows.
   The repository's tests assert exactly this as a user (`SET LOCAL ROLE authenticated` plus
   `request.jwt.claims`); see `tests/tenancy.test.ts` (tests 1–14). Run `npm test` to confirm on your
   machine.

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Sign-in returns 401 with a correct password | No `app.user_credentials` row, or the password differs | Re-run `app.upsert_user_credentials(user_id, password)` |
| Sign-in succeeds but the user sees no data | Membership missing, or `is_active = false`, or `branch_ids = {}` | Check `public.memberships`; set `branch_ids` and `is_active = true` |
| A correct token is rejected everywhere | `SUPABASE_JWT_SECRET` in `.env.local` differs from the running stack | Copy the value from `supabase status` and restart the app |
| A user still sees an old branch after a change | The token has not refreshed | Sign in again (see [section 9](#9-membership-changes-and-token-refresh)) |
| Invite acceptance fails with "already been used" | The token was redeemed once already | Create a new invite |
| Invite acceptance fails with "has expired" | Past the 72-hour (or custom) TTL | Create a new invite |
| "requires an authenticated user" when accepting | Called with no signed-in user | Sign the invitee in first, then accept |
| Branch PIN sign-in shows "locked" | Five wrong attempts | Wait out the cooling-off window, or reset the PIN with `app.set_cashier_pin` |
| A new org is empty (no accounts/numbers/VAT) | Org created outside `app.create_org` | Create orgs with `app.create_org`, which seeds the defaults via triggers |

## 12. Security rules you must not break

These are enforced by the schema and by the app; treat them as invariants when you write setup SQL
or scripts:

- **Never use the Supabase service role key on an application request path.** Request paths run as
  the caller (`withUserContext` drops into `authenticated` and sets `request.jwt.claims`), so RLS is
  genuinely enforced. The one deliberate exception is the login path, which runs as `anon` and calls
  `SECURITY DEFINER` functions — not the service role (`docs/ADR.md`, ADR-0067).
- **Never store a plaintext password or PIN.** Passwords go through `app.upsert_user_credentials`
  (bcrypt) and PINs through `app.set_cashier_pin` (bcrypt). Both hash in the database; the plaintext
  never lands in a table.
- **Never store a plaintext invite token.** Only `token_hash` (SHA-256) is kept. `create_invite`
  returns the raw token once.
- **Do not read `memberships` on a request path to make an access decision.** The decision comes from
  the JWT claims; reading the table would reintroduce the refresh-timing bug in reverse and bypass
  the model.
- **`app.upsert_user_credentials` is service-role only, by design.** Do not grant it to
  `authenticated` or `anon`; that would let one user set another user's password.
- **RLS is forced on every tenant table.** Do not disable it, and do not add a table without
  registering it with the tenant invariants (`scripts/check-tenant-tables.sql`).

## See also

- `README.md` → [Tenancy and RLS](README.md#tenancy-and-rls), and the F1 sign-in section.
- `docs/ADR.md` → ADR-0065, ADR-0066, ADR-0067, ADR-0068 (auth tables, test numbering, the `anon`
  login path, and why there is no edge middleware).
- `tests/tenancy.test.ts` (tests 1–14) and `tests/frontend-f1.test.ts` (tests 112–118) — the
  executable specification for everything above.
- `scripts/seed-demo.ts` — a worked example that creates an org, a branch, an admin user, a
  membership and demo products.
