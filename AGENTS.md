# AGENTS.md — ERP Core

Repository-specific knowledge for future agent runs. Keep it current.

## What this is

Multi-tenant ERP backend core (Phase 1 complete) with additive vertical extensions on top.
Next.js 14 App Router · TypeScript strict · Supabase local Postgres 17 + Auth · Vitest · `pg`.
No Prisma. Schema lives in plain SQL migrations under `supabase/migrations/`.

`docs/CORE_INTERFACE.md` is the contract every extension builds on. Read it first.

## Ground rules (do not revisit; object in docs/ADR.md instead)

* Extend the core, never rewrite it. Never edit an applied migration.
* Never edit a core table without an ADR — additive columns included.
* Money is `NUMERIC(19,4)` + `decimal.js`. No floats in the schema, ever.
* Ledger tables (`journals`, `journal_lines`, `stock_ledger`, `stock_consumptions`, `audit_logs`)
  are immutable. Corrections are reversing rows.
* Business logic lives in SQL functions in schema `app`. Route handlers stay thin.
* Tests run against the real local Postgres. Nothing is mocked. Do not weaken, skip or delete tests.
* No `any` in `src/accounting/**` (ESLint error).
* List endpoints use keyset pagination on `(created_at, id)`, never `OFFSET`.

## Commands

```bash
supabase start                 # local Postgres + Auth (Docker must be running)
redis-server --daemonize yes   # R2 tests need a real Redis (REDIS_URL, default :6379)
supabase db reset              # apply every migration to an empty database
npm test                       # all tests, against real Postgres
npm run build                  # next build
npm run lint                   # includes the no-any rule for src/accounting
npm run test:perf              # 1M-line trial balance; writes docs/perf/
npm run test:e2e               # Playwright (R3 keyboard, R4 offline, H1 branch)
npm run branch:https           # H1: issue a self-signed LAN certificate
BRANCH_MODE=branch npm run start:branch   # H1: serve the build for a branch
psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql     # must be 0 rows
psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql  # must be 0 rows
```

## Hard-won facts (save a future run the discovery time)

* **Adding a table means three edits, not one:** the migration, plus registering the table in
  `scripts/check-tenant-tables.sql` and `tests/support/tenant-tables.ts` (and seeding a row in the
  latter, so core test 2's table-driven RLS check covers it).
* **Composite foreign keys need an index on the leading columns in order**, or core test 9 fails.
  A self-referencing composite FK also needs its referenced `UNIQUE (org_id, id)` to exist at
  `CREATE TABLE` time.
* **A SQL function only inlines if it has no `set search_path` clause.** No inlining means no
  index choice to inspect and, usually, a worse plan. Qualify every object and drop the clause.
* **A CTE in a SQL function is materialised**, which hides a constant term from the planner and
  drops the index. Use a parenthesised `UNION ALL` of branches instead.
* **`pg_trgm` and `btree_gin` live in the `extensions` schema.** The combined GIN index is
  `(org_id extensions.uuid_ops, name extensions.gin_trgm_ops)`; `extensions.gin_uuid_ops` does not
  exist, the name is `extensions.uuid_ops`.
* **The planner only prefers a trigram index once the table is big enough to beat a sequential
  scan** (measured ~15,000 products in one org). Seed that many rows, then `analyze`, before
  asserting an `EXPLAIN` shows the index.
* **`delete` + reinsert bloats a table and makes the planner flip-flop.** Use a fresh table, or
  `vacuum analyze`, when probing plan choices.
* **`ANALYZE` on a shared table leaks across test files.** Re-analysing `products` in one file
  changed the planner for the R1 search test in another. Seed and analyse only the table under
  test; keep the shared-table statistics untouched.
* **R2 caches promotion candidates, never prices.** Redis key `promos:{org_id}`, TTL 300s. Every
  evaluation re-checks the validity window in SQL (`app.apply_promotions`), so a stale entry cannot
  apply an expired promotion. A write to `promotions` invalidates the key, but correctness does not
  depend on it.
* **`language sql` pricing functions must have no `set search_path` clause**, or they will not
  inline and `EXPLAIN` will not show `price_list_items_list_variant_key`.
* **A route file may only export HTTP handlers.** Exporting a plain constant (e.g. a batch size)
  from `src/app/api/**/route.ts` fails `next build` with "is not a valid Route export field". Keep
  such constants in a module the route imports.
* **Re-creating a function is the additive way to change it.** `create or replace function` in a
  new migration leaves the applied migration untouched; the newest definition wins. R4 re-creates
  `app.create_invoice` and `app.consume_fifo` this way, changing only the availability guard.
* **The offline hook is a transaction-local GUC.** `app.negative_stock_allowed()` reads
  `current_setting('app.allow_negative_stock', true)`, set with `set_config(..., true)` only by the
  sync retry. It never leaks to another pooled request, and the live path never sets it.
* **`fake-indexeddb` is a real IndexedDB implementation, not a mock.** Import
  `fake-indexeddb/auto` at the top of a test that uses the outbox; the outbox module runs for real.
  `vi.resetModules()` plus a fresh dynamic `import()` simulates a page reload (only IndexedDB
  carries state).
* **The sync endpoint is exempt from the rate limiter.** `POST /api/pos/sales` is limited per
  cashier; `POST /api/pos/sync` is not, so a backlog is never throttled away.
* **`create or replace function` cannot change a return type.** R5 re-creates `app.close_shift`
  with the same `(uuid, uuid, uuid)` signature but returns `uuid` instead of `void`, so the R5
  migration does `drop function if exists app.close_shift(uuid, uuid, uuid)` first, then
  re-creates it, then re-issues the grant. Overloading with an extra defaulted argument would make
  an uncast call ambiguous (`function ... is not unique`).
* **A jsonb payload carries money as a JSON number, not a fixed-scale string.** `select
  app.create_layby(...)` returns `total` as the number `23`, not `"23.0000"`. Read money from the
  ledger columns (which are `NUMERIC` and come back as strings) in a test, and format payload
  values with `toFixed(4)` in a route handler.
* **A partitioned parent's CHECK constraint covers its partitions.** R5 widens
  `journals.source_type` and `stock_ledger.source_type` with `alter table ... drop constraint` then
  `add constraint` on the parent; existing and future partitions inherit it.
* **Operations post through `app.post_balanced_journal`, not `app.post_journal` directly.** The
  hook asserts the lines balance before delegating, so an operational bug is caught at the call
  site; the deferred commit trigger still runs as the last line of defence (ADR-0019).
* **Credit checks lock the contact row.** `app.check_credit` takes `select ... from contacts ...
  for update` first, so concurrent checks for one customer serialise and cannot each read the same
  headroom (ADR-0020). The lock order is contact then stock.
* **A stock count posts one journal, not one per line.** `app.close_stock_count` writes one ledger
  row per variance but a single aggregated journal (ADR-0021).
* **`COPY FROM STDIN` needs a real stream.** `pg-copy-streams` `from(sql)` returns a writable
  stream; pipe a `Readable` into it and wait for `finish`. It is the import path for stock count
  lines.
* **The fiscal adapter is queue-only, and the sale path does one insert.** An `AFTER INSERT`
  trigger on the partitioned `pos_sales` parent (`app.fiscal_enqueue_on_sale`) calls
  `app.enqueue_fiscal_job`, which inserts exactly one `fiscal_jobs` row when the branch mode is
  `async`. No network call, no wait; mode `none` (or no integration row) queues nothing and never
  errors. The trigger is in the sale's own transaction, so a rolled-back sale leaves no job
  (ADR-0022).
* **The fiscal queue is append-only; delivery state is derived.** `fiscal_jobs` and
  `fiscal_job_attempts` go through `app.enforce_immutable`. A job is born `queued` and never
  updated; each delivery attempt appends a row and a `sent` attempt marks the job done. `unique
  (org_id, sale_id)` keeps "exactly one job per sale" true across retries.
* **Backoff lives in SQL, not in the worker.** `app.fiscal_jobs_due` returns the queued,
  not-yet-sent jobs whose exponential backoff (base 30s, capped 1h) has elapsed, so the worker
  (`src/fiscal/worker.ts`) and the database agree on timing. An unreachable device records an
  `unreachable` attempt and the job becomes due again later — never dropped, never blocking.
* **There is no blocking fiscal mode, on purpose.** The mode check constraint is `mode in ('none',
  'async')`. Whether ZIMRA requires printing at the moment of sale is an open item (ADR-0022); a
  blocking mode is a separate future run with its own ADR. Nothing in R6 is a compliance claim.
* **Branch mode is one codebase and one migration set.** `BRANCH_MODE=branch` (default `cloud`)
  gates every branch path through `isBranchMode()` (`src/branch/config.ts`). A branch runs the same
  migrations and the same posting functions; H1 adds only additive tables and functions, no core
  edits (ADR-0023). The cloud path is byte-for-byte unchanged when the variable is unset.
* **Device codes and tokens are stored hashed, never in plaintext.** `app.create_device_registration`
  stores only the sha256 of the one-time code; `app.register_device` stores only the sha256 of the
  issued token and consumes the code once. `app.hash_secret` is the shared hash (ADR-0024). The test
  asserts the stored values are 64-hex digests and the code is single use.
* **Cashier PINs are bcrypt, checked locally.** `app.set_cashier_pin` stores a bcrypt hash;
  `app.authenticate_cashier` returns jsonb (`ok`, `locked`, `failed_attempts`, `locked_until`,
  `is_manager`) and never raises for a wrong PIN — five wrong attempts lock it for 15 minutes.
  `app.manager_override` is the manager path (ADR-0024). The branch mints its own access token after
  a PIN check; there is no Supabase Auth in branch mode.
* **The till reads connectivity from the branch, not the browser.** `GET /api/branch/health` reports
  the branch's stored observation of the cloud; `navigator.onLine` is wrong on a LAN with the
  internet down. `?probe=1` refreshes the observation with a short timeout (never hangs). A version
  mismatch is `incompatible` and sets `push_blocked` (ADR-0025).
* **Fiscal submission is a branch queue, never on the sale path.** A sale's invoice writes one
  `fiscal_invoices` row in the invoice's own transaction (`app.fiscal_invoice_enqueue`, gated by
  `app.branch_mode_enabled()`), so the cloud's replayed invoices never queue fiscal rows and the
  cloud never talks to FDMS (ADR-0035). `npm run branch:fiscal` runs the worker LOOP (default 5s);
  each pass claims with `FOR UPDATE SKIP LOCKED` and holds the lock until the outcome is recorded,
  so two workers never submit the same invoice twice.
* **A network outage is not a rejection.** `app.fiscal_invoice_attempt` leaves the row `pending` and
  does NOT touch `attempts` on an `unreachable` outcome; only a real `failed` outcome increments the
  attempt count and schedules backoff, moving the row to `failed` at 5 (ADR-0037). The FDMS device is
  an interface (`src/fiscal/fdms.ts`); the gate uses `MockFdmsClient` (a real device object with an
  outage switch and a rejection counter), never a database mock.
* **Invoice numbers come from cloud-issued branch-local blocks.** `app.issue_number_block` carves a
  contiguous range from `number_series` under `FOR UPDATE` (two branches can never get the same
  number); `app.claim_invoice_number` takes the next number from the branch's oldest block with
  numbers, so topping up early never leaves a gap, and raises a clear `'invoice number block
  exhausted...'` error when none is left (ADR-0036). A branch with no block falls back to the org
  series. The branch tops up at a low-water mark (`ensureNextBlock`); an offline fetch is a no-op.
* **Redis is cloud-only.** The live-sale rate limiter and the promotion cache fall back to
  in-process stores in branch mode (`src/branch/cache.ts`); the promotion validity window is still
  re-checked in SQL, so a stale entry cannot apply an expired promotion (ADR-0027).
* **Never join on an expression when an index exists on the stored column.** Joining staged import
  rows to `products` on `nullif(btrim(...))` defeated `(org_id, external_code)` and gave a 12.5 M-row
  nested loop; resolving the rows into a materialised temp table and joining the stored column fixed
  it (ADR-0044). `nullif(btrim(coalesce(x,'')),'')` is also how every optional import cell is
  normalised, so watch for it.
* **Bulk import takes numbers in one block.** One `app.next_number` call per row is one
  `SELECT ... FOR UPDATE` per row (~0.14 ms); 5,000 rows cost ~700 ms. `app.next_numbers(org, code,
  count)` locks once and returns a contiguous gapless block. It reads `number_series` directly, so it
  is only for series without branch blocks (SKU, PO); invoice numbers still use
  `app.next_number` -> `app.claim_invoice_number`.
* **Stock is tracked per variant, not per product.** `create_invoice` matches availability on
  `variant_id is not distinct from ...`, so an opening-stock layer must name a variant or a later
  sale sees zero. The import resolves the row's barcode, else the product's default variant.
* **Staging + one-transaction commit beats per-row writes.** The H5 wizard COPYs rows into
  `import_rows`, validates set-based, then applies the whole file in one SQL function, so a bad file
  cannot leave half a catalogue behind (test 77) and a re-run is idempotent (natural key per kind).
* **A report reads a closed day from the facts and today live.** `daily_product_sales` is written at
  shift close in the same transaction as the Z-report; a report bounds the facts side at
  `current_date - 1` and reads today from `invoices` + `invoice_lines`, so the two never overlap and
  a figure is counted once (ADR-0046). No materialised view.
* **Report reads keyset on the group, not the fact.** The per-product reports take a keyset page per
  source branch (each at most `limit` products, ordered by `product_id`) and merge the pages; the
  smallest `limit` ids of a union lie in the union of the smallest `limit` of each branch, so the
  merge is exact and the closed-day side stays a streaming index scan. A union of facts + live rows
  aggregated the whole set (~800 ms); the keyset page over 1M facts is ~6 ms (ADR-0045).
* **Do not store what changes after an immutable write.** A Z-report row is immutable, but its
  invoices' fiscal status changes after the close, so the report computes sent / pending / failed at
  read time instead of storing them (ADR-0047).
* **Money and reads.** All report money is `Decimal` in TS and NUMERIC(19,4) in PG; use
  `moneyFromSql`/`money` at the boundary, never a JS number.
* **The login path has no user, so it runs as `anon`.** `src/core/login.ts` sets
  `set local role anon` and calls `SECURITY DEFINER` functions (`app.authenticate`,
  `app.login_context`); `anon` can read neither `app.user_credentials` nor a tenant row directly, so
  no service role is needed (ADR-0067). `app.user_credentials` carries no `org_id` (a user may
  belong to several orgs), so it is deliberately NOT a tenant table and is not registered in
  `scripts/check-tenant-tables.sql` or `tests/support/tenant-tables.ts` (ADR-0065).
* **The session key is `token`, not `pos_access_token`.** `src/core/session.ts` owns the read
  (`getToken()`, which falls back to the legacy key); every client that attaches a bearer token
  (till, reports, fiscal, import, admin) calls it rather than reading localStorage directly. The
  e2e specs still seed `pos_access_token` and work through the fallback.
* **A client page that reads `useSearchParams()` needs a `<Suspense>` boundary**, or
  `next build` fails with "useSearchParams should be wrapped in a suspense boundary" (`/login`
  does this).
* **`authenticated` cannot read `auth.users`.** A branch read that needs a cashier's email label
  (`app.list_branch_cashiers`) must be `SECURITY DEFINER`; a plain `select` as `authenticated` fails
  with `permission denied for table users`. Scope it by its own parameters so it can only return the
  caller's branch (ADR-0071).
* **The branch outbox trigger only fires in branch mode.** A test that asserts a sale wrote an
  outbox event must set `app.branch_mode=branch` on the connection (e.g. `pg` pool
  `options: '-c app.branch_mode=branch'`); a plain client writes no outbox row (ADR-0025).
* **The vitest suite needs a local Redis** for the R2/F2/F3 pricing-cache and live-sale rate-limit
  tests; without it those tests fail with `ECONNREFUSED 127.0.0.1:6379`. Start one with
  `docker run -d --name erp-redis -p 6379:6379 redis:7-alpine` (ADR-0027: Redis is cloud-only, so
  this is a test-environment dependency, not a branch one).
* **The Playwright e2e needs its browser installed** (`npx playwright install chromium`) and its
  own dev server; a spec that needs branch-mode pages can spawn a second `npm run dev` with
  `BRANCH_MODE=branch` and its own `NEXT_DIST_DIR` (see `e2e/branch-f4.e2e.ts`).
* **The cloud claim route serializes the number block as camelCase** (`blockNo`, `firstValue`,
  `lastValue`), matching the TS `IssuedBlock` type. A fetcher that parses it as snake_case gets
  `undefined` bounds and silently stores a useless block. `cloudBlockFetcher` now accepts either
  spelling; a test that exercises the real HTTP path (not an in-process fetcher) is what catches it
  (ADR-0073).
* **A number-block top-up must compare the ACTIVE block's own remaining count, not the total
  headroom.** Counting every fetched-ahead block makes the low-water test never fire while the
  current block drains (ADR-0073).
* **There is no jsdom in this repo.** A React component test renders with `react-dom/server` via
  `createElement(Component, props)` — calling `Component(props)` directly runs the hooks outside a
  renderer and throws "Cannot read properties of null (reading 'useState')". `react-dom/server` is
  enough to assert a component's static/HTTPS-gated markup (ADR-0074).
* **A relay/print test must set `process.env.BRANCH_MODE = 'branch'`.** The printer relay routes
  return 409 on the cloud (decision 16), so a test that posts to `/api/printer/relay` or
  `/api/branch/print` sees 409 until branch mode is set (ADR-0074).
* **`fake-indexeddb` is loaded per test file with `import 'fake-indexeddb/auto'`** at the top, so a
  storage test exercises a real IndexedDB open/upgrade/transaction path. `idbStorage`'s default
  `createIndexedDbStorage` is a no-op stub on the server (no `indexedDB`), so a page that imports the
  cart store still builds and SSRs (ADR-0074).
* **`retail-r2` test 8 is planner-statistics dependent** and can fail in a full parallel run (the
  planner picks `price_list_items_org_list_idx` instead of `price_list_items_list_variant_key` after
  other files perturb the stats) while passing in isolation and on a fresh `db reset`. It is not
  related to a vertical slice's changes; re-run the suite to confirm before investigating.

## Test numbering

Phase 1 owns 1–40. R1 owns 41–44 (`tests/retail-r1.test.ts`). R2 owns 45–48
(`tests/retail-r2.test.ts`). R3 owns 9–13 (`tests/pos-r3.test.ts` plus the keyboard e2e). R4 owns
14–18 (`tests/pos-r4.test.ts` plus the offline e2e). R5 owns 19–24 (`tests/ops-r5.test.ts`). R6
owns 25 (`tests/fiscal-r6.test.ts`). H1 owns 49–51 (`tests/branch-h1.test.ts`) and 52
(`e2e/branch-offline.e2e.ts`); the H1 brief called them 16–18, but those are taken — ADR-0026 maps
them. H2 owns 53–63 (`tests/sync-h2.test.ts`, ADR-0033). H3 owns 64–68
(`tests/fiscal-h3.test.ts`, ADR-0038). H4 owns 69–74 (`tests/hardware-h4.test.ts`,
ADR-0041). H5 owns 75–85 (`tests/import-h5.test.ts`, ADR-0042). H6 owns 86–95
(`tests/reports-h6.test.ts`, ADR-0045). A1 (admin products UI) owns 96–104
(`tests/admin-a1.test.ts`, ADR-0050). A2 (admin pricing UI) owns 105–107
(`tests/admin-a2.test.ts`, ADR-0054; the A2 brief called them 29–31, but those are taken by
inventory). A3 (admin operations UI) owns 108–111 (`tests/admin-a3.test.ts`, ADR-0059; the A3 brief
called them 32–35, but those are taken by Phase 1 sales). F1 (frontend shell + sign-in) owns 112–118
(`tests/frontend-f1.test.ts`, ADR-0066). F2 (admin products / pricing / promotions console) owns
119–121 (`tests/frontend-f2.test.ts`, ADR-0069; the F2 brief called them 43–45, but those are taken
by R1/R2). F3 (operations / POS console completion) owns 122–127 (`tests/operations-f3.test.ts`,
ADR-0070; the F3 brief called them 46–51, but those are taken by R2/H1). F4 (branch-server
UI/behaviour completion) owns 128–130 (`tests/frontend-f4.test.ts`, ADR-0071; the F4 brief called
them 16–18, but those are taken by R4/H1). F5 (sync engine completion) owns 131–135
(`tests/sync-f5.test.ts`, ADR-0072; the F5 brief's own numbers collide with the tenancy tests). F6
(fiscal and numbering completion) owns 136–140 (`tests/fiscal-f6.test.ts`, ADR-0073; the F6 brief's
own numbers 1–25 collide with the tenancy and accounting tests). F7 (hardware and receipts
completion) owns 141–145 (`tests/hardware-f7.test.ts`, ADR-0074; the F7 brief's own numbers collide
with the core tests). A new
run continues from the highest number actually present; ranges in `docs/phase2/README.md` are
indicative only (ADR-0010).
