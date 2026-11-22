# From VS Code to production

A step-by-step guide to taking ERP Core from a clone in VS Code to a running deployment. It covers
the two shapes this codebase actually ships in — **cloud** (one Postgres, many branches, Redis) and
**branch** (one shop, one Postgres, no internet) — because they differ in how you build and start
the app, not in the code.

Everything below was run against this repository as it stands. Where a command's output matters,
the expected output is quoted.

## Contents

1. [What you need installed](#1-what-you-need-installed)
2. [Open the project in VS Code](#2-open-the-project-in-vs-code)
3. [Run it locally](#3-run-it-locally)
4. [Know the four environment files](#4-know-the-four-environment-files)
5. [Develop it further](#5-develop-it-further)
6. [The cloud path: dev to production](#6-the-cloud-path-dev-to-production)
7. [The branch path: dev to production](#7-the-branch-path-dev-to-production)
8. [Deploying the app itself](#8-deploying-the-app-itself)
9. [Go live: first organisation, first stock, first sale](#9-go-live-first-organisation-first-stock-first-sale)
10. [Verify a deployment](#10-verify-a-deployment)
11. [Operating it: partitions, backups, fiscal](#11-operating-it-partitions-backups-fiscal)
12. [Upgrading an existing deployment](#12-upgrading-an-existing-deployment)
13. [Troubleshooting](#13-troubleshooting)

## 1. What you need installed

| Tool | Version used here | Why |
| --- | --- | --- |
| Node.js | 24.22.2 | Next.js 14, `tsx` scripts, Vitest |
| npm | 12.2.2 | `package-lock.json` is committed; use `npm ci` on a server |
| Docker | 29.9.3 | `supabase start` runs Postgres and Auth in containers |
| Supabase CLI | 3.2.0 | Migrations, local stack, `db push` |
| PostgreSQL client (`psql`) | 17 | The two invariant check scripts, plus ad-hoc queries |
| Redis | 7 (cloud only) | Promotion candidate cache and POS rate limiting |

```bash
node --version && npm --version && docker --version && psql --version
```

The Supabase CLI is **not** a dependency in `package.json`; it is resolved from `npx`. Install it
globally if you prefer, and check which one you get, because the CLI version must be recent enough to
know the config schema:

```bash
supabase --version    # 3.2.0 here
```

Postgres 17 is required. `supabase/config.toml` pins `major_version = 17`, and the migrations use
partitioned-table constraint triggers that older versions reject (ADR-0001).

## 2. Open the project in VS Code

```bash
git clone <your-remote> erp-core
cd erp-core
code .
```

Install the **ESLint** extension if VS Code prompts you. The repo has no `.vscode/settings.json`, so
ESLint only runs on save if you enable it yourself (Settings → `editor.codeActionsOnSave` →
`source.fixAll.eslint`). There is no Prettier config and no Prettier dependency, so do not add one
without agreeing on it first — it would reformat the whole tree.

Lint is `next lint` against `.eslintrc.json`, which extends `next/core-web-vitals` and adds one
override that matters:

```json
{ "files": ["src/accounting/**/*.ts"], "rules": { "@typescript-eslint/no-explicit-any": "error" } }
```

`any` in `src/accounting` is a build failure, by rule rather than by convention.

Two things in `tsconfig.json` will surprise you if you have not seen them: `strict`, plus
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. They are deliberate. Array indexing
yields `T | undefined`, and you cannot pass `undefined` to an optional property — use a conditional
spread (`...(value ? { key: value } : {})`), which is the pattern used throughout `src/`.

`npm install` once, then `npm run lint` should be clean:

```bash
npm install
npm run lint      # ✔ No ESLint warnings or errors
```

## 3. Run it locally

Docker must be running before the first step.

```bash
supabase start          # Postgres 17 + Auth + Studio in containers (first run pulls images)
supabase db reset       # apply all 34 migrations to an empty database
cp .env.example .env.local
npm run db:seed-demo    # optional: one demo org, branch, till and ten products
npm run dev             # http://localhost:3000
```

`supabase start` prints the local keys and URLs; `npm run db:status` prints them again as JSON at any
time. Copy `DATABASE_URL`, `TEST_DATABASE_URL`, `SUPABASE_JWT_SECRET` and `REDIS_URL` from there into
`.env.local`.

`supabase db reset` ends with `no files matched pattern: supabase/seed.sql`. That is expected: this
repo has **no seed file** and the migrations must work on an empty database. Seed with
`npm run db:seed-demo` when you want demo data.

Redis is not part of `supabase start`. Run it however you prefer:

```bash
docker run -d --name erp-redis -p 6379:6379 redis:7-alpine
# or: redis-server --daemonize yes
```

Then the two gates:

```bash
npm test          # Test Files 33 passed (33) / Tests 236 passed (236)
npm run build     # exits 0
```

`npm test` talks to the real local Postgres on 54322 and a real Redis on 6379. Nothing is mocked, so
both must be up or the suite fails with connection errors rather than assertion failures. Verified:
with Redis stopped, exactly those three files fail (`Test Files 3 failed (3)` /
`Tests 7 failed | 3 passed (10)`). A branch deployment has no Redis for this reason — it uses
in-process stores with the same semantics (ADR-0027) — but the cloud path expects a real one.

### Signing in locally

After `npm run db:seed-demo`, sign in at `/` with `admin@demo.com` / `admin123`. The seed prints a
ready-made access token too, which is the fastest way to poke the API:

```bash
curl -s localhost:3000/api/auth/me -H "authorization: Bearer $TOKEN"
```

## 4. Know the four environment files

| File | Committed | Used by |
| --- | --- | --- |
| `.env.example` | yes | The template. Copy it, never edit it for your machine. |
| `.env.local` | **no** (gitignored) | `next dev`, `next start`, and every `npm run` script |
| `.env.test` | yes | Vitest and Playwright, merged **over** `.env.local` |
| — (real env) | — | A server or container: variables set by the platform, no file at all |

`vitest.config.ts` and `playwright.config.ts` both load `.env.local` then `.env.test` and let the
second win, so a test run can point at a different database than your dev server. The scripts in
`scripts/` load the same two files. `src/core/env.ts` reads `process.env` lazily, which is why the
order above works without a `dotenv` import anywhere.

The variables that matter:

| Variable | Needed by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | everything | `postgresql://…:54322/postgres` locally |
| `TEST_DATABASE_URL` | tests | Falls back to `DATABASE_URL` when unset |
| `SUPABASE_JWT_SECRET` | token verify | **Must match the database's issuer.** Changing it invalidates every issued token |
| `REDIS_URL` | cloud | Defaults to `redis://127.0.0.1:6379`. Absent on a branch (ADR-0027) |
| `BRANCH_MODE` | branch | `cloud` (default) or `branch`. **Read at build time** — see §7 |
| `BRANCH_ORG_ID`, `BRANCH_ID` | branch | The one org and branch this box serves |
| `CLOUD_URL`, `BRANCH_SYNC_TOKEN` | branch sync | Unset is a valid offline state; the tick is a no-op |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | branch server | When both are set, the branch serves HTTPS |
| `BRANCH_BACKUP_KEY` | branch backup | 32 bytes, hex or base64. Without it, `branch:backup` refuses to run |
| `FDMS_*` | fiscal | `FDMS_ENDPOINT` + `FDMS_DEVICE_SERIAL` switch the adapter on; unset queues nothing |

Never put the Supabase **service role key** in `.env.local` for the app. No request path uses it
(`withUserContext` drops into `authenticated` instead), and a leaked service role key bypasses RLS.

## 5. Develop it further

This is the loop you live in once the app runs locally: change something, migrate the database, run
the tests, commit.

### 5.1 Clone and branch

```bash
git clone <repo-url> coreerp
cd coreerp
npm install
```

Work on a branch, never on the default branch. A branch is cheap and it keeps `main` deployable:

```bash
git switch -c feature/pharmacy-batches
```

### 5.2 Where code goes

| You are adding | Put it in | Notes |
| --- | --- | --- |
| A core business rule | `supabase/migrations/`, as a SQL function in the `app` schema | Business logic is SQL; see §5.3 |
| A typed wrapper over that function | `src/core/` | Thin. It calls one function and maps the row |
| An HTTP endpoint | `src/app/api/<area>/route.ts` | Parse, call, serialise. No business logic |
| A vertical's screens | `src/verticals/<vertical>/` | Additive only; see §5.5 |
| A test | `tests/` | Continue the numbering (§5.4) |

The rule that keeps this maintainable: **route handlers stay thin.** A handler parses the request,
opens one user-scoped transaction, calls one `app.*` function, and serialises the result. If you find
yourself writing an `if` about business state in a route, it belongs in SQL.

### 5.3 Changing the schema

Migrations are ordered SQL files applied by the Supabase CLI. Never edit a migration that has
already been applied anywhere — not on your machine, not on staging, not in production. Add a new one:

```bash
npx supabase migration new add_batch_number
# writes supabase/migrations/<timestamp>_add_batch_number.sql
npx supabase db reset          # apply everything from scratch, locally
```

`db reset` is the honest check. It drops the local database and replays all 34 migrations in order,
so it catches a migration that only works because of something left over from an earlier session.
Run it before you push.

Two conventions the schema relies on and a new table must follow:

- Every tenant table gets `org_id uuid not null` and `created_at timestamptz not null default now()`,
  plus `branch_id` if it is branch-scoped.
- Apply RLS and the standard indexes with the helpers rather than by hand:

  ```sql
  select app.apply_tenant_rls('public.your_table', 'branch');  -- or 'org'
  ```

Then register the table in `scripts/check-tenant-tables.sql`, or the invariant check will not cover
it. `scripts/check-fk-indexes.sql` and `scripts/check-tenant-tables.sql` must both return zero rows
before you call a schema change done.

### 5.4 Adding a test

Tests are numbered, and the numbers are allocated in the order work is actually built (ADR-0010).
Find the highest number in use and continue from there:

```bash
grep -rhoE "^\s*(it|test)\((['\`])[0-9]+" tests/ | grep -oE "[0-9]+" | sort -n | tail -1
```

Put the new tests in a new file named for the slice (`tests/pharmacy-batches.test.ts`) and add a row
to the table in the README's "The tests" section.

Tests run against the real local Postgres and the real local Redis. Do not mock the database, and do
not weaken or skip a test to make a gate pass — if you believe an assertion is wrong, write an ADR
and stop for review.

### 5.5 Adding a vertical

A vertical (Retail, Pharmacy, Hardware, School) sits on top of the core and is **additive only**. It
gets its own folder and its own migrations, and it calls core functions instead of reimplementing
them: `app.post_journal`, `app.post_receipt`, `app.create_invoice`, `app.allocate_payment`,
`app.create_credit_note`, `app.post_stock_adjustment`, `app.next_number`, `app.ensure_partitions`.
If it needs a new column on a core table, write an ADR first and stop for review (ADR-0065).

### 5.6 The gate before you commit

```bash
npm run db:reset   # migrations apply to an empty database
npm test           # the whole suite
npm run lint       # ESLint, including no-any for src/accounting
npm run build      # production build
```

All four pass, or you are not done. Then commit:

```bash
git add -A
git commit -m "pharmacy: add batch numbers"
git push -u origin feature/pharmacy-batches
```

### 5.7 Debugging tips that save an hour

- **A route returns `{"error":"internal error"}`.** The real error is in the server log, not the
  response. Read the terminal running `npm run dev`.
- **RLS returns zero rows and you expect rows.** Check the token actually carries `org_id` and
  `branch_ids`. `npm run db:seed-demo` prints a ready token you can compare against.
- **A membership change does not take effect.** It will not, until the token refreshes. Sign out and
  in. This is by design, not a bug.
- **The dev server serves a stale page.** Stop it and run `npm run build` once: a type error shows up
  there and not in the dev overlay. Then start dev again.
- **Port 3000 is taken.** Something from a previous run is still alive. Find it (`lsof -i :3000`)
  and stop that process, rather than starting a second server on another port.

## 6. The cloud path: dev to production

The cloud is the source of truth: Supabase Postgres, Supabase Auth, Redis, and one Next.js process
(or several) behind a load balancer.

### 6.1 Create the database

Either a hosted Supabase project or your own Postgres 17.

**Hosted Supabase.** Create the project in the dashboard, then link this repo:

```bash
supabase login                 # opens a browser, stores an access token
supabase link --project-ref <ref>
supabase db push               # applies supabase/migrations/ in order
```

**Your own Postgres 17.** A plain Postgres does not have the `auth` schema, the `auth.jwt()` helper,
or the `anon` / `authenticated` / `service_role` roles the migrations grant to. Bootstrap it once,
before the first push:

```bash
psql "$DATABASE_URL" -f scripts/bootstrap-postgres.sql
npx supabase db push --remote "$DATABASE_URL" --yes
```

That combination was verified end to end: the bootstrap plus 34 migrations apply cleanly to a stock
`postgres:17` image, and the app then serves logins, product lists and POS sales against it. The
bootstrap is idempotent, so re-running it is safe.

> `--include-all` is only needed when you want migrations the remote history already marks as applied
> to be re-applied — for example after resetting the history table. On a database that has never seen
> this repo, a plain `db push` applies all 34 in order; verified on a fresh `postgres:17`. Do not
> reach for `--include-all` as a habit: on a live database it re-runs migrations already applied.

`db push` prints each migration as it applies and ends with `Finished supabase db push.` It does not
seed; there is no seed file.

### 6.2 Point the app at it

On the server (or in your platform's environment settings), set at minimum:

```
DATABASE_URL=postgresql://…        # session or transaction pooler is fine; the app uses `pg`
SUPABASE_JWT_SECRET=…              # from Project Settings → API → JWT secret
REDIS_URL=redis://…                # a managed Redis, reachable from the app
NODE_ENV=production
```

`BRANCH_MODE` must be unset or `cloud`. This is the default, so leave it alone.

### 6.3 Build and start

```bash
npm ci
npm run build
npm start                          # next start, default port 3000, PORT overrides
```

`next.config.mjs` marks `pg` as an external server package and uses `NEXT_DIST_DIR` when set, so a CI
build and a local dev server do not clobber each other's `.next`.

Run at least one process; run several behind a proxy if you need to. The app holds no in-process
state that matters — the Postgres pool is per process, and Redis holds only counters and cache
entries that can be rebuilt.

### 6.4 Set up the first organisation and owner

There is no sign-up screen, on purpose: every user is created by an existing member or by an admin.
For the first owner, follow `howto.md` §5 (Option B). In short, against the database:

1. insert the user into `auth.users`,
2. `select app.upsert_user_credentials(<user id>, '<password>')`,
3. insert the `public.memberships` row with the org and branch ids,
4. `select app.login_context(<user id>)` to confirm the claims the token will carry.

The first organisation itself comes from `select app.create_org('<name>', '<slug>')`. Every later
user is added through the invite flow (`howto.md` §4) or the same Option B block.

### 6.5 The access token hook

The RLS policies read `org_id` and `branch_ids` from the JWT. A Supabase custom access token hook
(`public.custom_access_token_hook`) adds them at mint time.

On a **hosted** project, enable it in the dashboard: Authentication → Hooks → Customize Access Token
(CCC) → Postgres function → `public.custom_access_token_hook`. The function is already granted to
`supabase_auth_admin` by the migrations.

On **your own Postgres**, the app mints and verifies its own HS256 tokens (`src/core/auth.ts`) after
`app.authenticate` checks the password, so the hook is not in the path — but if you later put GoTrue
in front, enable the hook there or tokens will carry no tenant claims and every RLS policy will
return zero rows.

**Membership changes take effect on token refresh.** Policies read the claims baked into the current
token, never the `memberships` table. Adding or removing a membership does not change what an
already-issued token can see; the user must refresh (sign in again, or wait for the refresh). This is
asserted by core test 6 and documented in the README.

## 7. The branch path: dev to production

A branch is one shop: its own Postgres, its own Next.js process on the LAN, PIN sign-in, no Redis,
and no dependency on the cloud being reachable. Same code, same migrations.

### 7.1 The one rule that bites: `BRANCH_MODE` is baked at build time

`/api/branch/config` is prerendered at build time, so the mode and the org/branch ids are frozen into
the build. Verified behaviour:

- Built with `BRANCH_MODE=branch` and started with **no** runtime env → `GET /api/branch/config`
  still answers `{"mode":"branch","pin_login":true,"org_id":"…","branch_id":"…"}`.
- Built as cloud (default) and started with `BRANCH_MODE=branch` → `config` still answers
  `{"mode":"cloud"}`, and `GET /api/branch/cashiers` answers
  `{"error":"branch cashiers are only available in branch mode"}`.

So: **set `BRANCH_MODE`, `BRANCH_ORG_ID` and `BRANCH_ID` in the environment that runs `npm run build`,
not only the one that runs the server.** The runtime values are still needed (the database pool, the
sync runner and the PIN routes read them live), so set them in both places. Getting this wrong shows
up as a till stuck on the email/password form.

### 7.2 Prepare the box

```bash
# Postgres 17 on the box, then:
psql "$DATABASE_URL" -f scripts/bootstrap-postgres.sql
npx supabase db push --remote "$DATABASE_URL" --yes
```

Or run `supabase start` on the box if you want the whole Supabase stack there; the migrations do not
care. Redis is not needed and must not be configured — the rate limiter and the promotion cache fall
back to in-process stores with the same semantics (ADR-0027).

### 7.3 Build and start

```bash
BRANCH_MODE=branch BRANCH_ORG_ID=<org> BRANCH_ID=<branch> npm run build

BRANCH_MODE=branch BRANCH_ORG_ID=<org> BRANCH_ID=<branch> \
SUPABASE_JWT_SECRET=<secret> DATABASE_URL=<url> \
HOSTNAME=0.0.0.0 PORT=3000 \
npm run start:branch
```

`npm run start:branch` runs `scripts/branch-server.mjs`, a custom Next.js server. With
`TLS_CERT_FILE` and `TLS_KEY_FILE` set it serves HTTPS, otherwise plain HTTP. Issue a certificate
for the LAN host:

```bash
npm run branch:https                 # writes certs/branch.{crt,key} for the machine's first LAN IP
BRANCH_MODE=branch TLS_CERT_FILE=certs/branch.crt TLS_KEY_FILE=certs/branch.key npm run start:branch
```

Install `certs/branch.crt` on each till, or use a certificate from your own CA. HTTPS is what lets the
till install as a PWA and use IndexedDB in a secure context.

> `HOSTNAME` is a real environment variable in most shells. If it is set to the machine's own name
> (as it is in many containers), the server binds to that interface only. Set `HOSTNAME=0.0.0.0`
> explicitly for a LAN deployment.

### 7.4 Sync with the cloud

Sync is a separate long-lived process, not part of the web server:

```bash
BRANCH_MODE=branch BRANCH_ORG_ID=<org> BRANCH_ID=<branch> \
CLOUD_URL=https://cloud.example BRANCH_SYNC_TOKEN=<branch token> \
npm run branch:sync
```

It pushes the outbox and pulls master-data changes every `SYNC_INTERVAL_MS` (default 15s). With no
`CLOUD_URL` the tick is a no-op, which is a valid offline state: the branch keeps selling and the
outbox grows until the cloud is reachable. `POST /api/sync/push` on the cloud applies a batch in one
transaction with a savepoint per event and dedupes on `(org_id, event_id)`, so a retried push never
double-posts.

Run it under a process supervisor (systemd, s6, or your container platform's restart policy). It is
designed to be killed and restarted at any point.

### 7.5 Fiscal (optional)

`npm run branch:fiscal` runs the FDMS queue worker. It only does anything when `FDMS_ENDPOINT` and
`FDMS_DEVICE_SERIAL` are set; otherwise the queue is empty and the loop idles. The mode is
queue-only — nothing blocks a sale on the fiscal device (ADR-0022). ZIMRA's exact requirements are an
open item in `docs/ADR.md`; nothing in this phase is a compliance claim.

## 8. Deploying the app itself

The build output is a standard Next.js 14 app, so anything that can run `next start` can host it.

**A container** (sketch — the repo does not ship a Dockerfile):

```dockerfile
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
EXPOSE 3000
CMD ["npm", "start"]
```

Do **not** run `supabase start` in production; that is a local development stack. Run the migrations
from a deploy step (`supabase db push`) and keep the app container stateless.

**A systemd unit** for a branch box:

```ini
[Unit]
Description=ERP Core branch
After=network-online.target postgresql.service

[Service]
WorkingDirectory=/opt/erp-core
EnvironmentFile=/etc/erp-core/branch.env
ExecStart=/usr/bin/npm run start:branch
Restart=always
RestartSec=5
User=erp

[Install]
WantedBy=multi-user.target
```

`/etc/erp-core/branch.env` carries the variables from §4. Keep it mode `0600`; it holds the JWT
secret and the database password. A separate `erp-sync.service` runs `npm run branch:sync` with the
same file.

**Reverse proxy.** On the cloud, terminate TLS in front of `next start` (nginx, Caddy, or your
platform's load balancer). Forward the `Authorization` header unchanged — the app verifies the bearer
token itself and never reads a session cookie.

## 9. Go live: first organisation, first stock, first sale

A deployment that answers HTTP is not a business yet. It has no organisation, no owner, no stock and
nothing to sell. This section is the shortest honest path from an empty database to a receipt in a
customer's hand. Everything below was run against a freshly reset database while writing this guide.

### 9.1 Create the organisation

An organisation is the tenant. Creating one fires three triggers that seed everything it needs, so
you do not insert accounts, tax rates or number series by hand:

- a `settings` row with `base_currency = 'USD'`,
- number series for `INVOICE`, `CREDIT_NOTE`, `SKU` and `PO`,
- a chart of accounts (1000 Inventory, 1100 AR, 1200 Bank, 2000 AP, 2100 VAT Output, 2200 VAT Input,
  3000 Retained Earnings, 4000 Sales Revenue, 5000 COGS, 6999 Rounding Differences),
- one VAT rate, `VAT15` at 15%, effective 2020-01-01, **marked to be confirmed**.

```sql
select app.create_org('Go Live Ltd', 'go-live');
```

Run this as the database owner (psql, Supabase Studio, or a small script). `create_org` is
`SECURITY DEFINER`, so it does not need a JWT.

> **The VAT rate is a placeholder.** `VAT15` at 15% is seeded so the system works, not because 15% is
> confirmed. Check the rate with your accountant and add the real one with an `effective_from` date
> rather than editing the seeded row — old invoices must keep the rate they used (ADR-0004, and the
> open item in `docs/ADR.md`).

### 9.2 Create the branch, the warehouse and a price list

```sql
-- branch: a shop or a legal selling location. Unique per org by slug.
insert into public.branches (org_id, name, slug)
values ('<ORG_ID>', 'Head office', 'hq');

-- warehouse: where stock physically sits. Branch-scoped.
insert into public.warehouses (org_id, branch_id, code, name)
values ('<ORG_ID>', '<BRANCH_ID>', 'W1', 'Main store');

-- price list: the retail price list the till reads.
insert into public.price_lists (org_id, name, kind)
values ('<ORG_ID>', 'Retail', 'retail');
```

`allow_negative_stock` defaults to `false` on a warehouse. Leave it that way unless you have a
specific reason: negative stock is the symptom that hides a receiving mistake.

### 9.3 Add a product with a barcode

The SKU comes from the `SKU` number series, generated in SQL. Do not invent one in application code.

```sql
with p as (
  insert into public.products (org_id, sku, name)
  values ('<ORG_ID>', app.next_number('<ORG_ID>', 'SKU'), 'Test widget')
  returning id
)
insert into public.product_variants (org_id, product_id, sku, name, barcode)
select '<ORG_ID>', p.id, app.next_number('<ORG_ID>', 'SKU'), 'Standard', 'GOLIVE-1'
from p
returning id;

-- price it on the retail list
insert into public.price_list_items (org_id, price_list_id, variant_id, price)
values ('<ORG_ID>', '<PRICE_LIST_ID>', '<VARIANT_ID>', 25.0000);
```

For a real catalogue, do not type this in by hand: `POST /api/import/*` (CSV chunk, map, commit) is
the bulk path, and the admin console at `/admin/products` is the interactive one.

### 9.4 Receive stock

Stock enters through a receipt, which writes an inbound FIFO layer **and** a balanced journal in one
transaction (Dr Inventory, Cr Accounts Payable):

```sql
select app.post_receipt(
  '<ORG_ID>', '<BRANCH_ID>', '<WAREHOUSE_ID>',
  '<PRODUCT_ID>', '<VARIANT_ID>',
  10,            -- quantity
  12.0000,       -- unit cost
  current_date   -- posting date
);
```

Nothing can be sold before this. A sale with no layer behind it is rejected, not back-ordered.

### 9.5 Add the first owner

Follow `howto.md` §5 (Option B). It creates the `auth.users` row, sets a bcrypt password through
`app.upsert_user_credentials`, and inserts the membership that sign-in reads:

```sql
insert into public.memberships (org_id, user_id, role, branch_ids)
values ('<ORG_ID>', '<USER_ID>', 'owner', array['<BRANCH_ID>']::uuid[])
on conflict (org_id, user_id) do update
  set role = excluded.role, branch_ids = excluded.branch_ids, is_active = true;

select app.login_context('<USER_ID>');   -- the exact claims the token will carry
```

`login_context` returning `org_id` and `branch_ids` is the check that matters. If `org_id` is null,
every RLS policy will return zero rows and the app will look broken when it is not.

After that, add everyone else through the invite flow (`howto.md` §4): a token that is stored hashed,
single use, and expires after 72 hours.

### 9.6 Open a shift and make the first sale

A till works in a shift. Open one for `TILL-1` with an opening float, then sell.

```bash
# open the shift (opening float is cash in the drawer at start of day)
curl -s -X POST https://your-host/api/pos/shifts \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"till_id":"TILL-1","opening_float":"100.00"}'

# sell one widget for cash
curl -s -X POST https://your-host/api/pos/sales \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"warehouse_id":"<WH>","shift_id":"<SHIFT>","client_sale_id":"<fresh-uuid>",
       "lines":[{"barcode":"GOLIVE-1","qty":"1"}],
       "tenders":[{"method":"cash","currency":"USD","amount_tendered":"30.00"}]}'
```

A good response carries an `invoice_no` (starting at `000001` for a new org) and a `sale_id`.

`client_sale_id` is the idempotency key. Reuse the same one on a retry and you get the original sale
back instead of a second one — which is exactly what an offline till does when it reconnects.

The same thing through the SQL API, if you are checking the engine rather than the HTTP layer:

```sql
select app.create_invoice('<ORG_ID>', '<BRANCH_ID>', null, current_date,
  jsonb_build_array(jsonb_build_object(
    'product_id', '<PRODUCT_ID>', 'variant_id', '<VARIANT_ID>', 'warehouse_id', '<WAREHOUSE_ID>',
    'qty', 2, 'unit_price', 25.0000, 'tax_rate_code', 'VAT15')));
```

That returns `{"invoice_no":"000001","subtotal":50.0000,"tax_total":7.5000,"total":57.5000,…}` and
posts the full invoice journal — Dr AR, Cr Revenue, Cr VAT Output, Dr COGS, Cr Inventory — in the
same transaction as the stock movement.

### 9.7 Confirm it actually posted

Do not trust the HTTP 200. These four queries prove the ledger and the stock are consistent:

```sql
-- the journals exist and are labelled
select source_type, memo from public.journals
 where org_id = '<ORG_ID>' order by created_at;

-- the ledger balances: dr must equal cr
select sum(base_debit) as dr, sum(base_credit) as cr
  from public.journal_lines where org_id = '<ORG_ID>';

-- stock moved: the receipt in, the sale out
select qty, unit_cost from public.stock_ledger
 where org_id = '<ORG_ID>' order by created_at;

-- FIFO recorded which layer the sale consumed, at the layer's cost
select qty_consumed, unit_cost from public.stock_consumptions
 where org_id = '<ORG_ID>' order by created_at;
```

On the run used for this guide: two journals (`receipt`, `invoice 000001`), `dr = cr = 201.5000`, a
10-unit inbound ledger row at cost 12.0000 and a 2-unit outbound row, and the consumption recorded
against the original 12.0000 layer.

If `dr <> cr`, stop and investigate before trading. That is the one invariant this system is built to
guarantee, and a mismatch means something bypassed `app.post_journal`.

### 9.8 Before the first real customer

- [ ] Set the real VAT rate with an `effective_from` date; leave `VAT15` in place for history.
- [ ] Replace the demo chart of accounts if your accountant wants a different structure.
- [ ] Load the real catalogue through the import path, not by hand.
- [ ] Receive opening stock through `post_receipt` so FIFO has real layers and costs.
- [ ] Add real users via invites; give each one the least role that works.
- [ ] Schedule `app.ensure_partitions(2)` (§11) — a month with no partition rejects writes.
- [ ] Confirm the backup and restore actually work (§11), not just that a backup job runs.
- [ ] On a branch, confirm `GET /api/branch/health` reports `branch_up: true`.
- [ ] Record the open items: ZWG vs ZWL, and ZIMRA fiscalisation requirements (`docs/ADR.md`).

## 10. Verify a deployment

Run these against the deployed database and app. All five are what the repo's own gate checks.

```bash
# 1. Invariants: both must print (0 rows)
psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql

# 2. Partitions exist for this month and the next two
psql "$DATABASE_URL" -c "select inhrelid::regclass from pg_inherits
  where inhparent = 'public.journals'::regclass order by 1;"

# 3. The app answers, and signs a user in
curl -s -o /dev/null -w '%{http_code}\n' https://your-host/api/branch/config
curl -s https://your-host/api/auth/me -H "authorization: Bearer $TOKEN"

# 4. A real posting path works end to end (adjust the ids for your tenant)
curl -s -X POST https://your-host/api/pos/sales \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"warehouse_id":"<wh>","client_sale_id":"<uuid>","lines":[{"barcode":"<sku>","qty":"1"}],
       "tenders":[{"method":"cash","currency":"USD","amount_tendered":"10.00"}]}'
```

The sale must return an `invoice_no` and a `sale_id`. If it returns `{"error":"internal error"}`,
check the app log. Two causes were reproduced while writing this guide: a Redis connection failure on
the **cloud** path (the POS rate limiter runs before the sale posts — with Redis down the same request
returns HTTP 500, and the same sale succeeds once Redis is back), and a missing `auth` schema grant on
a self-managed Postgres (`permission denied for schema auth`, raised inside the RLS helper).

A **branch** has no Redis and does not hit the first cause: the same sale was verified returning HTTP
200 with `BRANCH_MODE=branch` and no Redis running at all.

For the branch, `GET /api/branch/health` is the readiness probe. It reports the branch's own database
and its stored observation of the cloud:

```bash
curl -s https://branch-host:3000/api/branch/health
# {"mode":"branch","branch_up":true,"database_up":true,"cloud_status":"offline",…}
```

`cloud_status: "offline"` with `branch_up: true` is a healthy branch that cannot reach the cloud —
exactly what a shop with a dead uplink should show.

## 11. Operating it: partitions, backups, fiscal

### Partitions

`journals`, `journal_lines`, `stock_ledger`, `stock_consumptions` and `audit_logs` are RANGE
partitioned monthly on `created_at`, with no default partition. The migrations create the current
month and the next two. A month with no partition rejects inserts loudly rather than silently landing
in a catch-all, so **run this on a schedule**:

```sql
select app.ensure_partitions(2);   -- current month plus two ahead; idempotent
```

Daily, from `pg_cron` if your Postgres has it (Supabase does), or from any scheduler:

```sql
select cron.schedule('ensure-partitions', '0 3 * * *', $$select app.ensure_partitions(2)$$);
```

Verify at any time with the `pg_inherits` query in §10.

### Backups

The cloud database is your backup surface; use your provider's PITR.

A branch has its own encrypted nightly backup:

```bash
BRANCH_MODE=branch BRANCH_ORG_ID=<org> BRANCH_ID=<branch> \
BRANCH_BACKUP_KEY=<64 hex chars> npm run branch:backup
```

It dumps the branch Postgres, encrypts with AES-256-GCM in memory, uploads only the ciphertext (to
`BRANCH_BACKUP_UPLOAD_URL` if set, else `BRANCH_BACKUP_DIR`, default `./.branch-backups`), and records
the run and the sha256 of the encrypted file in `public.sync_backups`. **Keep `BRANCH_BACKUP_KEY`
somewhere other than the branch box.** A backup you cannot decrypt is not a backup.

### Redis

Redis holds only counters and cache entries; it is never a source of truth. Losing it loses a rate
limit window and forces a promotion-candidate refill. The ledger is unaffected. On a branch it is not
used at all.

## 12. Upgrading an existing deployment

The rule from `AGENTS.md` is that an applied migration is never edited. A change is a **new**
migration.

```bash
git pull
npm ci
npm run build            # catch a type error before touching the database
npx supabase db push     # applies only the new migrations
npm start                # or restart the branch service
```

`db push` refuses to proceed when local migrations are missing from the remote history; that is the
signal that someone edited an applied migration, and the fix is to restore it, not to force.

Order matters on the cloud: migrate first, then roll the app. A new migration is additive by
convention, so the old app keeps working against the new schema for the length of the rollout. A
branch can be upgraded independently of the cloud, but check the protocol version —
`app.branch_protocol_version()` and `BRANCH_PROTOCOL_VERSION` must match, or the branch refuses to
push and shows a warning while still selling (ADR-0025).

## 13. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `function auth.jwt() does not exist` during `db push` | Plain Postgres, no Supabase `auth` schema | `psql "$DATABASE_URL" -f scripts/bootstrap-postgres.sql`, then push again |
| `relation "auth.users" does not exist` | Same | Same script |
| `permission denied for schema auth` on the first query | Bootstrapped before the grants were added, or granted by hand | Re-run the bootstrap; it grants `USAGE` on `auth` and `extensions` to `anon`, `authenticated`, `service_role` |
| `db push` applies nothing on a fresh database | The remote history table already lists the migrations | Only if you are sure, `--include-all`; otherwise check `supabase_migrations.schema_migrations` |
| `supabase db push` says the project is not linked | No `supabase link`, no access token | `supabase login && supabase link --project-ref <ref>`, or pass `--remote <url>` |
| Every RLS policy returns zero rows | The token carries no `org_id` | Enable the custom access token hook (hosted), or sign in through `POST /api/auth/login` so the app mints the claims |
| Membership change does not take effect | Claims are baked into the token | Refresh the token; sign in again |
| Till shows the email/password form on a branch | `BRANCH_MODE` was not set at **build** time | Rebuild with `BRANCH_MODE=branch` (§7.1) |
| `branch cashiers are only available in branch mode` | Built as cloud, started as branch | Rebuild with `BRANCH_MODE=branch` |
| Branch server unreachable on the LAN | `HOSTNAME` inherited from the shell bound it to one interface | Start with `HOSTNAME=0.0.0.0` |
| `{"error":"internal error"}` on a POS sale | Redis unreachable on the cloud path | Start Redis or fix `REDIS_URL`; a sale is rate limited per cashier before it posts |
| `Missing required environment variable: SUPABASE_JWT_SECRET` | Not set on the server | Set it; it must match the value the tokens were signed with |
| `insert` fails with "no partition of relation … found for row" | Partitions ran out | `select app.ensure_partitions(2);` and schedule it |
| Tests fail with `ECONNREFUSED 127.0.0.1:54322` | Local stack not running | `supabase start` |
| Three test files fail with Redis errors | No Redis on 6379 | `docker run -d -p 6379:6379 redis:7-alpine` |

## See also

- [`README.md`](../README.md) — the design, the data model, the indexing strategy and the extensions.
- [`howto.md`](../howto.md) — adding users: invites, direct setup, a second organisation, PIN users.
- [`docs/ADR.md`](ADR.md) — every decision, including the open items (ZWG vs ZWL, ZIMRA fiscalisation).
- [`PROGRESS.md`](../PROGRESS.md) — milestone status and gate evidence.
- [`docs/CORE_INTERFACE.md`](CORE_INTERFACE.md) — the contract a vertical module builds on.
- [`AGENTS.md`](../AGENTS.md) — hard-won facts that save a future change a day of discovery.
