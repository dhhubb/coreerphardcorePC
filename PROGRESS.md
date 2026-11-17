# PROGRESS — ERP Core

Repo root: `/workspace/project`
Stack: Next.js 14 (App Router) · TypeScript strict · Supabase (local Postgres 17 + Auth) · Vitest · `pg`
Schema: plain SQL migrations in `supabase/migrations/` (no Prisma).

Phase 1 (the core) is complete: tests 1–40. R1 extends the core additively: tests 41–44. R2 adds
pricing and promotions: tests 45–48. F1 adds the frontend shell and email/password sign-in:
tests 112–118.

## Status

| Milestone | Scope | Gate | State |
|-----------|-------|------|-------|
| M0 | Setup | build passes on empty app | DONE |
| M1 | Tenancy (RLS, indexes, partitions) | tests 1–14 | DONE |
| M2 | Accounting | tests 15–24 | DONE |
| M3 | Inventory | tests 25–31 | DONE |
| M4 | Sales & purchases + concurrency | tests 32–40 | DONE |
| M5 | Hardening (audit, checks, perf, README) | verification list | DONE |
| R1 | Retail extension: products, barcodes, search | tests 41–44 | DONE |
| R2 | Retail extension: pricing and promotions | tests 45–48 | DONE |
| R3 | Retail extension: online POS sale | tests 9–13 | DONE |
| R4 | Retail extension: offline outbox and sync | tests 14–18 | DONE |
| R5 | Retail extension: operations (laybys, returns, credit, Z-reports, stock counts) | tests 19–24 | DONE |
| R6 | Retail extension: fiscal integration adapter (queue-only) | test 25 | DONE |
| H1 | Branch server: local Postgres, PIN sign-in, PWA, LAN HTTPS, branch mode | tests 49–52 | DONE |
| H2 | Offline sync engine: branch outbox → cloud ingest → pull | tests 53–63 | DONE |
| H3 | Fiscal and numbering: FDMS queue, branch-local number blocks | tests 64–68 | DONE |
| H4 | Hardware and receipts: ESC/POS, QR, printer settings, relay, scanner, hold/recall, print timing | tests 69–74 | DONE |
| H5 | Migration wizard: Pastel CSV → products/customers/opening stock, chunked COPY, mapping, commit | tests 75–85 | DONE |
| H6 | Reports and the owner console: profit, VAT, Z-reports; branch + cloud | tests 86–95 | DONE |
| A1 | Admin products UI: categories, products, variants, barcodes, batches (cloud + branch admin) | tests 96–104 | DONE |
| A2 | Admin pricing UI: price lists, items, customer groups, promotions, live preview | tests 105–107 | DONE |
| A3 | Admin operations UI: laybys, returns, shifts & Z-reports, stocktake | tests 108–111 | DONE |
| F1 | Frontend shell + sign-in: email/password auth, `/api/auth/me`, app shell | tests 112–118 | DONE |
| F2 | Admin products/pricing/promotions console | tests 119–121 | DONE |
| F3 | Operations, Z-report, receipt and stocktake UI | tests 122–127 | DONE |
| F4 | Branch server UI/behaviour completion: device codes, PIN login, health, offline shell | tests 128–130 | DONE |
| F5 | Sync engine (H2) completion | tests 131–135 | DONE |
| F6 | Fiscal and numbering (H3) completion | tests 136–140 | DONE |
| F7 | Hardware and receipts (H4) completion: scanner hook, camera, IndexedDB holds, relay | tests 141–145 | DONE |

## M0 — Setup

* `supabase init` + `supabase start` (local Postgres 17.11).
* Next.js 14.2.15, React 18, TypeScript 5.6 strict (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`).
* Vitest 2.1 (`tests/**/*.test.ts`, node env, `fileParallelism: false` so concurrency tests get
  real parallel connections).
* ESLint via `next/core-web-vitals` + an override that sets `@typescript-eslint/no-explicit-any:
  error` for `src/accounting/**`.
* Placeholder page at `src/app/page.tsx`.

Gate evidence:

```
$ npm run build
   Creating an optimized production build ...
 ✓ Compiled successfully
   Linting and checking validity of types ...
 ✓ Generating static pages (4/4)
```

## M1 — Tenancy

Migrations (restructured so that every tenant table exists at M1, because the M1 gate includes
the table-driven RLS test and the RLS/partition schema tests):

* `20260101000000_extensions_and_helpers.sql` — `pgcrypto`, `app` schema, `set_updated_at`,
  `current_org_id()`, `current_branch_ids()`.
* `20260101000100_tenancy_tables.sql` — organizations, branches, memberships, invites, settings,
  number_series.
* `20260101000200_accounting_tables.sql` — chart_of_accounts, fiscal_periods, tax_rates,
  exchange_rates, journals (partitioned), journal_lines (partitioned).
* `20260101000300_inventory_tables.sql` — products, product_variants, warehouses, stock_ledger
  (partitioned), stock_consumptions (partitioned), stock_balances, stock_layer_balances,
  stock_transfers.
* `20260101000400_sales_tables.sql` — contacts, sales_orders, invoices, invoice_lines, payments,
  credit_notes, purchase_orders, audit_logs (partitioned).
* `20260101000500_indexes.sql` — `(org_id, created_at desc, id desc)` on org-scoped tables,
  `(org_id, branch_id, created_at desc, id desc)` on branch-scoped high-volume tables, composite
  business-key uniques, and an index on every FK column.
* `20260101000600_functions.sql` — access predicates, `next_number`, invites,
  `custom_access_token_hook`, `ensure_partitions`, `enforce_immutable`, `apply_tenant_rls`.
* `20260101000700_accounting_functions.sql` — rates, tax rates, closed-period guard, balance
  trigger, `post_journal`, `reverse_journal`.
* `20260101000800_inventory_functions.sql` — `lock_stock_balances`, `post_receipt`,
  `consume_fifo`, `post_stock_adjustment`.
* `20260101000900_sales_functions.sql` — `create_invoice`, `allocate_payment`,
  `create_credit_note`, `assert_page_limit`.
* `20260101001000_defaults_rls_partitions.sql` — per-org defaults, audit trigger, RLS, immutability
  grants, partitions.

Design notes:

* `organizations.org_id` is a real `uuid NOT NULL` column set from `id` by a BEFORE INSERT trigger
  (a generated column cannot be `NOT NULL`), so the "every tenant table has `org_id`" invariant
  holds literally.
* `invoices`, `invoice_lines`, `payments` and `credit_notes` are **not** partitioned: their
  business keys (`unique (org_id, invoice_no)`) cannot be enforced on a partitioned table without
  adding the partition key. They keep a composite `journal_created_at` FK to the partitioned
  `journals`.
* Access predicates read JWT claims only (`auth.jwt() ->> 'org_id'`, `auth.jwt() -> 'branch_ids'`),
  so membership changes take effect on token refresh.

Gate evidence:

```
$ npx vitest run tests/tenancy.test.ts
 Test Files  1 passed (1)
      Tests  15 passed (15)

$ psql -f scripts/check-fk-indexes.sql
(0 rows)

$ psql -f scripts/check-tenant-tables.sql
(0 rows)
```

## M2 — Accounting

`tests/accounting.test.ts` covers tests 15–24.

```
$ npx vitest run tests/accounting.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

* Balance check: `journal_lines_balance` is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger
  on the `journal_lines` parent; PG17 clones it onto every existing and future partition (ADR-0001).
* A line carries either a debit or a credit (`journal_lines_single_sided_check`) and never a
  negative value.
* Closed periods: `app.assert_period_open` plus a BEFORE INSERT trigger on `journals`.
* Rates: `app.rate_on` and `app.tax_rate_on` are effective-dated; each journal line stores the
  rate it used, so later rate changes do not rewrite history.
* Rounding: `post_journal` rounds base amounts to 4 dp per line and posts any residual to the
  rounding account from `settings`.

## M3 — Inventory

`tests/inventory.test.ts` covers tests 25–31.

```
$ npx vitest run tests/inventory.test.ts
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

* FIFO: `app.consume_fifo` walks `stock_layer_balances` ordered by `(in_ledger_created_at,
  in_ledger_id)`, locking each layer `FOR UPDATE`. Every consumption is a new
  `stock_consumptions` row; a layer row is only ever decremented, never rewritten.
* Lock order: `app.lock_stock_balances(org, branch, keys)` locks the `stock_balances` rows one key
  at a time in ascending `(warehouse_id, product_id, variant_id)` order.
* Negative stock is rejected by default; `warehouses.allow_negative_stock` opts a warehouse in,
  in which case the shortfall is valued at the most recent inbound cost.
* `post_receipt` and `post_stock_adjustment` each write ledger rows and a balanced journal in one
  transaction.
* SKUs come from `number_series` via `app.next_number` (locked `FOR UPDATE`), never from a
  Postgres sequence.

## M4 — Sales and purchases

`tests/sales.test.ts` covers tests 32–40.

```
$ npx vitest run
 Test Files  4 passed (4)
      Tests  40 passed (40)
```

* Business logic is in SQL: `app.create_invoice`, `app.allocate_payment`, `app.create_credit_note`,
  `app.post_receipt`, `app.post_stock_adjustment`. Route handlers (`src/app/api/**`) only parse the
  request, call one function inside a user-scoped transaction, and serialise the result.
* `create_invoice` takes a gapless number from `number_series` (`FOR UPDATE`) inside its own
  transaction, so a rollback does not consume a number.
* `app.allocate_payment` locks the invoice `FOR UPDATE` and refuses an amount above the open
  balance.
* `app.create_credit_note` returns stock as a new inbound layer at the invoice line's original FIFO
  cost and posts a reversing journal.
* Listing: `app.list_invoices` keysets on `(created_at, id)` with an explicit column list. The
  default limit is 50 and the maximum is 100; anything else raises. `app.invoice_lines_for(uuid[])`
  batches child rows with `= ANY($1)`.
* Concurrency: `app.lock_stock_balances` sorts keys, so invoices that touch the same products in
  opposite order cannot deadlock.

## M5 — Hardening

Verification list, all green:

```
$ supabase db reset
Finished supabase db reset on branch master.

$ npm test
 Test Files  4 passed (4)
      Tests  40 passed (40)

$ npm run build
 ✓ Compiled successfully
   Linting and checking validity of types ...

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)
```

* Audit: `app.write_audit_log()` writes `audit_logs` for invoices, payments, journals, products and
  stock_ledger (receipts and adjustments). It stores the logical table name, not the partition
  (ADR-0006). Nothing on a request path reads it.
* `scripts/check-fk-indexes.sql` and `scripts/check-tenant-tables.sql` both return zero rows.
* `npm run test:perf` seeds 1,000,000 journal lines with `generate_series` inside SQL and writes
  `docs/perf/trial-balance-<timestamp>.md`. The one-month trial balance prunes to a single partition
  and uses `journal_lines_<YYYYMM>_org_id_idx`; the full-range query reads every partition and may
  sequentially scan. Timings are recorded, not enforced (ADR-0005, ADR-0007).
* The no-any rule for `src/accounting/**` is enforced by an ESLint override
  (`@typescript-eslint/no-explicit-any: error`); `npm run lint` fails if `any` appears there.
* `README.md` documents the Mermaid ER diagram, the indexing strategy, how to run
  `ensure_partitions`, how to add a vertical module, and the token-refresh note.

## Notes / decisions recorded in docs/ADR.md

* ADR-0001 Deferred balance-check trigger on the partitioned `journals` parent (PG17 clones the
  parent's constraint trigger onto every new partition, so no per-partition attach helper is needed).
* ADR-0002 ZWG seeded as the Zimbabwe currency code (ZWL open item).
* ADR-0003 ZIMRA fiscalisation format unknown — not built this phase.
* ADR-0004 Rounding residual posts to the rounding account from settings, never dropped.
* ADR-0005 No summary table for the trial balance in Phase 1 (perf run is under 500 ms).
* ADR-0006 Audit rows store the logical table name, not the partition.
* ADR-0007 The perf seed spreads rows across organisations so the plan reflects production.

## Phase 2 backlog — prompts written (not yet executed)

The Phase 2 backlog has been turned into one prompt per item under `docs/phase2/`, each with its own
milestones and gates. Nothing in Phase 2 has been executed; Phase 1 remains the current deliverable.

| # | Item | Tests | Depends on |
|---|------|-------|------------|
| P2-01 | Rate limiting (Upstash Redis) | 41–44 | Phase 1 |
| P2-02 | Low-stock alerts (indexed view) | 45–47 | Phase 1 |
| P2-03 | Audit log viewer (read-only, paginated) | 48–50 | Phase 1 |
| P2-04 | Settings cache (`unstable_cache`, invalidated on write) | 51–53 | Phase 1 |
| P2-05 | Pharmacy readiness: lot/batch/expiry hooks (ADR) | 54–55 | Phase 1 |
| P2-06 | Dashboard (`dashboard_stats` matview, pg_cron 2 min, <100 ms @ 1M rows) | 56–58 | Phase 1 |
| P2-07 | Realtime (branch-scoped subscriptions) | 59–61 | Phase 1 |
| P2-08 | Invite UI + org/branch switcher | 62–64 | Phase 1 |
| P2-09 | Report summary tables | **conditional — gated OFF** | perf ADR triggered |
| P2-10 | Hash sub-partitioning (`stock_ledger` by org) | **conditional — gated OFF** | measured need |
| P2-11 | First vertical module: Retail | 69–75 | P2-05 |
| P2-12 | Frontend vertical slices | 76–80 | P2-08 |

Ordering rules applied from the backlog text: the pharmacy ADR (P2-05) precedes the first vertical
module (P2-11); report summary tables (P2-09) run only if the Phase 1 perf ADR was triggered — it was
not (ADR-0005); hash sub-partitioning (P2-10) runs only on measured need — none exists.

Environment note: this session began on a recycled runtime (Docker down, Supabase CLI off `PATH`).
The environment was restored (dockerd restarted, Supabase CLI v3.1.0 installed, local stack up) and
all Phase 1 gates were re-verified on a clean database: `npm test` 40 passed (40), `npm run build`
compiled successfully, `npm run lint` clean, both check scripts 0 rows.

## R1 — Retail extension: products, barcodes and search

Additive. The core is not rewritten and no core accounting logic changed. Two new org-scoped tables
and a set of nullable/defaulted columns on `products` and `product_variants` (ADR-0008). Tests 41–44
in `tests/retail-r1.test.ts`.

Migration: `supabase/migrations/20260101010000_retail_r1_products_search.sql`.

* `categories` (nested via `parent_id`), `product_batches` (batch master) — org-scoped, RLS forced,
  indexes and FK indexes per the core rules.
* `products`: `category_id`, `unit product_unit`, `is_weighable`, generated `name_search tsvector`.
* `product_variants`: `size`, `color`, `barcode` (partial unique per org).
* `app.search_products(org_id, query, limit)` — exact barcode first, then trigram name match,
  capped at 20, backed by `products (org_id extensions.uuid_ops, name extensions.gin_trgm_ops)`.
* `GET /api/pos/search?q=` plus `src/verticals/retail/{products,quantity,debounce,TillSearch}`.

The 4 tests:

| # | Test |
|---|------|
| 41 | Barcode lookup returns the correct variant in under 100 ms on 1,000 products |
| 42 | Name search returns at most 20 results and EXPLAIN shows the trigram index |
| 43 | Org A cannot read or search Org B rows in every R1 table |
| 44 | A weighable product stores quantity 0.750 kg exactly |

Gate evidence:

```
$ supabase db reset
Finished supabase db reset on branch master.

$ npm test
 Test Files  5 passed (5)
      Tests  44 passed (44)

$ npm run build
 ✓ Compiled successfully

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)
```

Notes:

* Core test 9 (every FK column has an index) drove two extra indexes on the new composite FKs:
  `categories (org_id, parent_id)` and `products (org_id, category_id)`.
* Search correctness and index use both depend on the function inlining (ADR-0009): no
  `set search_path`, and a parenthesised `UNION ALL` instead of a CTE.
* `docs/CORE_INTERFACE.md` was a stated starting condition but did not exist; it has been written
  from the Phase 1 migrations.

## R2 — Retail extension: pricing and promotions

Additive. The only core-table change is a nullable `contacts.group_id` (ADR-0011); no core
accounting path is touched. See ADR-0011 to ADR-0013 and `docs/CORE_INTERFACE.md`.

Migration: `supabase/migrations/20260101020000_retail_r2_pricing_promotions.sql`.

* New org-scoped tables: `price_lists`, `price_list_items`, `customer_groups`, `promotions`,
  `discount_limits`. New branch-scoped table: `manual_discounts`.
* Additive column: `contacts.group_id uuid` with a `(org_id, group_id)` foreign key.
* Functions: `app.get_price`, `app.get_prices`, `app.apply_promotions`,
  `app.promotion_candidates`, `app.assert_manual_discount`, `app.record_manual_discount`,
  `app.convert_for_display`.
* TypeScript: `src/verticals/retail/pricing.ts`, `src/core/redis.ts`; route
  `src/app/api/pos/price/route.ts`.
* Redis caches promotion *candidates* only (`promos:{org_id}`, TTL 300s), never a resolved price.

The 4 tests:

| # | Test |
|---|------|
| 45 | Matching promotion applies automatically from cache |
| 46 | Promotion past valid_to not applied, even when the cache entry is 3 minutes old |
| 47 | Precedence holds, and a manual discount above the role limit is rejected |
| 48 | A 30-item cart resolves prices in at most two database queries, and get_price uses an index |

Gate evidence:

```
$ supabase db reset
Finished supabase db reset on branch master.

$ npm test
 Test Files  6 passed (6)
      Tests  48 passed (48)

$ npm run build
 ✓ Compiled successfully

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)
```

Notes:

* Precedence is implemented once, in `app.apply_promotions` and `app.get_price(s)`, so the cached
  path and the SQL path cannot drift. The cached path passes the Redis candidates into the same
  function.
* The retail list is a per-item fallback, not only a fallback when the group has no list: a variant
  missing from the group's list prices at retail (test 47).
* Both pricing functions are `language sql`, `security invoker`, with no `set search_path` clause,
  so the planner inlines them and uses `price_list_items_list_variant_key` (test 48 asserts this).
* Test 48 seeds 2,000 extra price rows and analyses only `price_list_items`; re-analysing the shared
  `products` table perturbed the planner for the R1 search test.
* Core test 9 drove extra indexes on the new composite foreign keys
  (`price_list_items`, `customer_groups`, `contacts.group_id`, `manual_discounts`).

## R3 — Retail extension: online POS sale

Status: complete. Gate evidence below.

What shipped:

* `supabase/migrations/20260101030000_pos_r3_shifts_sales.sql` — `shifts` (org + branch scoped,
  `till_id`, `opened_at`, `closed_at`, `opening_float`, index `(org_id, branch_id, till_id,
  opened_at desc)`); `pos_sales` (partitioned monthly on `created_at`, PK `(id, created_at)`,
  indexes `(org_id, branch_id, created_at desc, id desc)` and `(org_id, branch_id, shift_id)`);
  `pos_payments` (one row per tender, composite FK to `pos_sales (id, created_at)`); `pos_sale_keys`
  (the idempotency claim, `unique (org_id, client_sale_id)` — ADR-0014). RLS forced on all four.
* `app.post_pos_sale` — one transaction: resolve lines, price via R2, `app.create_invoice`,
  one `app.allocate_payment` per tender, write `pos_sales` and `pos_payments`. Idempotent on
  `client_sale_id`. `app.open_shift` and `app.list_pos_sales` alongside it.
* `src/verticals/pos/` — `sales.ts` (typed wrappers), `cart.ts` (Zustand cart, decimal money),
  `api.ts` (bearer-token fetch). `src/app/api/pos/sales` and `src/app/api/pos/shifts` thin routes.
* `/pos` keyboard-only till, 58mm browser receipt, `docs/pos-keys.md`. `npm run db:seed-demo` seeds
  a demo tenant and prints an access token so the receipt can be checked by hand.

Gate evidence:

```
$ supabase db reset
Finished supabase db reset on branch master.

$ npm test
 Test Files  7 passed (7)
      Tests  54 passed (54)

$ npx playwright test
  1 passed (2.2s)

$ npm run build
 ✓ Compiled successfully

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)
```

The R3 tests (9–13):

| # | Test |
| --- | --- |
| 9 | Sale creates one invoice, one payment and one pos_payments row, and the journal balances to 0.0000 |
| 10 | 50 concurrent sales for 10 units: exactly 10 succeed, 40 fail with insufficient stock, stock lands on 0.0000 |
| 11 | A USD + ZWG sale creates 2 pos_payments rows and 2 core payments, and the invoice is fully paid |
| 12 | 100 concurrent sales across shared products in one branch finish with no non-retryable error and no negative stock |
| 13 | One-item exact cash sale completes in three keyboard-only actions (Playwright) |

Notes:

* `pos_sales` is partitioned monthly, so `unique (org_id, client_sale_id)` cannot sit on it
  (Postgres requires the partition key in every unique constraint). The claim lives on
  `pos_sale_keys`; the retry path returns the original receipt. ADR-0014.
* The till resolves the price for a scanned item through `POST /api/pos/price` before adding it, so
  the F9 exact-cash tender equals the invoice total to the cent.
* `shifts` and `pos_payments` carry the `(org_id, branch_id, created_at desc, id desc)` index so the
  schema invariants (test 11) cover them without a special case.

## R4 — Retail extension: offline outbox and sync

Additive. Nothing in an applied migration was edited; the two re-created core functions
(`app.consume_fifo`, `app.create_invoice`) and the new sync entry point live in a new migration.

Migration: `20260101040000_pos_r4_offline_sync.sql`.

* New branch-scoped table `pos_sync_exceptions` (where a synced sale that could not post strictly is
  recorded instead of being refused), with the `(org_id, branch_id, created_at desc, id desc)`
  index and forced RLS.
* `app.negative_stock_allowed()` — the transaction-local allow-negative hook (ADR-0015).
* `app.consume_fifo` and `app.create_invoice` re-created verbatim with the hook added to the
  availability guard. Only the guard line changed.
* `app.sync_pos_sale(...)` — one call per offline sale. Never rejects a completed sale (ADR-0016).

TypeScript:

* `src/verticals/pos/outbox.ts` — IndexedDB outbox, `client_sale_id` generated at sale time,
  exponential backoff with full jitter.
* `src/verticals/pos/sync.ts` — the drain loop, one request in flight, removes an entry only on
  `committed` or `duplicate`.
* `src/verticals/pos/syncServer.ts` — one transaction per sale on its own connection, under the
  caller's RLS context.
* `src/verticals/pos/rateLimit.ts` — live-sale limiter, Redis counters prefixed by org (ADR-0018).
* `src/app/api/pos/sync/route.ts` — `POST /api/pos/sync`, up to 50 sales, exempt from the limiter.
* `POST /api/pos/sales` is rate limited to 30 sales/minute/cashier and returns `429` with
  `Retry-After` past that (ADR-0018).
* `/pos` queues a sale on a network failure or a `429`/`5xx`, shows `Pending n`, and drains the
  outbox on load, on reconnect and every 15 seconds.

The R4 tests (14–18):

| # | Test |
| --- | --- |
| 14 | A sale completed offline survives a page reload in IndexedDB with its UUID, lines, prices and shift intact |
| 15 | Reconnecting syncs every queued sale and clears the outbox; each sale reaches the ledger once |
| 16 | The same `client_sale_id` twice posts once; the second request is a `duplicate` with the original receipt |
| 17 | A sale synced after stock hit zero is accepted and logged as a `negative_stock` exception; the live path still rejects; the ledger balances |
| 18 | The 31st live sale in one minute is `429` with `Retry-After`; a 100-sale sync backlog is accepted with no `429` |

Gate evidence (R4):

```
$ supabase db reset
Applying migration 20260101040000_pos_r4_offline_sync.sql...
Finished supabase db reset on branch master.

$ npm test
 Test Files  8 passed (8)
      Tests  59 passed (59)

$ npm run build
 ✓ Compiled successfully
 ✓ Generating static pages (4/4)

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)

$ npx playwright test
  2 passed (7.5s)
```

Notes:

* `pos_sync_exceptions` is registered in `tests/support/tenant-tables.ts` and
  `scripts/check-tenant-tables.sql`, so the table-driven RLS test (test 2) and the schema checks
  cover it without a special case.
* IndexedDB is provided in Vitest by `fake-indexeddb` — a real in-memory implementation of the
  IndexedDB API, not a stub of `outbox.ts`. The outbox module and the route handlers run for real.
* Redis counters are prefixed `ratelimit:livesale:{org_id}:{branch_id}:{cashier_id}:{window}`. Redis
  holds counters only; the ledger is unaffected and the counters are safe to lose.

## R5 — Retail extension: operations

Scope: laybys, returns, credit limits, Z-reports and stock counts. Additive: new tables and
functions, plus three additive changes to core tables (ADR-0019).

Migration: `supabase/migrations/20260101050000_ops_r5.sql`.

New tables:

* Org-scoped: `credit_limits`.
* Branch-scoped: `laybys` (index `(org_id, branch_id, status, due_date)`), `layby_reservations`,
  `returns`, `return_lines`, `z_reports` (immutable), `stock_counts` (partitioned monthly, PK
  `(id, created_at)`), `stock_count_items`.

New SQL functions (all in `app`):

* `post_balanced_journal` — the balanced-journal hook. Asserts the lines balance, then delegates to
  `app.post_journal`. Every operational journal goes through it.
* `check_credit` — locks the contact `FOR UPDATE`, then refuses a sale past the ceiling.
* `create_layby` / `complete_layby` / `cancel_layby`.
* `create_return` — locks the invoice lines, checks the unreturned quantity, calls the core credit
  note, posts the refund.
* `close_shift` — re-created from R3 with the same signature; now writes one immutable Z-report.
* `create_stock_count` / `close_stock_count` — one core stock adjustment (one journal) per count.

Additive core changes (ADR-0019):

* `settings` gains `layby_deposit_percent`, `layby_cancellation_fee`, `return_refund_method`.
* New default accounts `2300`, `2400`, `4600` and number series `LAYBY`, `RETURN`, `Z_REPORT`,
  `STOCK_COUNT`.
* `journals.source_type` gains `layby_deposit`, `layby_cancellation`, `return_refund`;
  `stock_ledger.source_type` gains `layby`.
* New index `invoices (org_id, contact_id, created_at desc, id desc)`.

TypeScript: `src/verticals/ops/{laybys,returns,credit,stockCounts,zReports}.ts`, and thin handlers
`src/app/api/{laybys,returns,credit-limits,stock-counts,z-reports}/route.ts`.

The R5 tests (19–24):

| # | Test |
| --- | --- |
| 19 | A layby deposit posts Dr Bank / Cr Customer Deposits and holds the stock aside |
| 20 | Completing a layby creates the invoice and clears the deposit against AR |
| 21 | Cancelling a layby refunds the deposit less the fee and returns the stock |
| 22 | A return cannot exceed the quantity sold and returns stock at the original FIFO cost |
| 23 | 20 concurrent credit sales against one customer never exceed the ceiling |
| 24 | Closing a stock count posts one balanced journal, and closing a shift writes one Z-report |

Gate evidence (R5):

```
$ supabase db reset
Applying migration 20260101050000_ops_r5.sql...
Finished supabase db reset on branch master.

$ npm test
 Test Files  9 passed (9)
      Tests  65 passed (65)

$ npm run build
 ✓ Compiled successfully
 ✓ Generating static pages (5/5)

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)
```

Notes:

* `credit_limits`, `laybys`, `layby_reservations`, `returns`, `return_lines`, `z_reports`,
  `stock_counts` and `stock_count_items` are registered in `tests/support/tenant-tables.ts` and
  `scripts/check-tenant-tables.sql`, so the table-driven RLS test (test 2) and the schema checks
  cover them without a special case.
* `app.close_shift` changes its return type from `void` to `uuid`, so the R5 migration drops the R3
  definition first (`drop function if exists app.close_shift(uuid, uuid, uuid)`) and re-creates it
  with the same signature; the grant is re-issued. No R3 caller needed updating.
* The `jsonb` payloads returned by the operations functions carry money as JSON numbers, so the
  tests read money from the ledger columns (`NUMERIC`), not from the payload. The route handlers
  format the payload values with `toFixed(4)`.

## R6 — Fiscal integration adapter (queue-only)

Status: **complete**. Gate evidence below.

### What was built

* `supabase/migrations/20260101060000_fiscal_r6.sql` (additive, see ADR-0022):
  * `public.fiscal_device_integration` (org + branch; `device_type`, `mode` in (`none`, `async`),
    `status`, `last_sync`, `payload` jsonb; `unique (org_id, branch_id)`).
  * `public.fiscal_jobs` (org + branch; APPEND-ONLY job queue; `unique (org_id, sale_id)`;
    index `(org_id, branch_id, status, created_at)` as the brief requires).
  * `public.fiscal_job_attempts` (org + branch; APPEND-ONLY delivery attempts).
  * `app.enqueue_fiscal_job(...)`, `app.fiscal_jobs_due(...)`, `app.record_fiscal_attempt(...)`.
  * `app.fiscal_enqueue_on_sale()` — `AFTER INSERT` trigger on the partitioned `pos_sales` parent.
    The only fiscal work on the sale path: one insert, in the sale's own transaction, no network
    call, no wait. Mode `none` (or no integration row) queues nothing and never errors.
* `src/fiscal/`: `types.ts`, `adapter.ts` (`enqueueFiscalJob`, integration get/set), `worker.ts`
  (`drainFiscalJobs` / `drainFiscalJobsOn`, `unreachableTransport`), `index.ts`.
* Thin routes: `src/app/api/fiscal/integration`, `src/app/api/fiscal/jobs`,
  `src/app/api/fiscal/drain`.
* `tests/fiscal-r6.test.ts` — test 25 plus five supporting tests.

### Scope boundary

This run builds the queue, not the device. There is **no blocking mode**: whether ZIMRA requires
printing at the moment of sale is an open item recorded in `docs/ADR.md` (ADR-0022). Nothing here is
a compliance claim. The tests check queueing and non-blocking behaviour only.

### Test 25 (the R6 gate test)

| # | Test |
| --- | --- |
| 25 | With mode async and device unreachable, the sale still commits and exactly one fiscal job is queued |

Supporting tests in the same file (not filler; each pins a queue guarantee): mode `none` and no
integration queue nothing; a retried sale queues one job; the enqueue is idempotent; the queue is
append-only (UPDATE/DELETE rejected); a rolled-back sale leaves no job (the enqueue is in the sale
transaction).

### Gate evidence (R6)

```
$ supabase db reset
Applying migration 20260101060000_fiscal_r6.sql...
Finished supabase db reset on branch master.

$ npm test
 Test Files  10 passed (10)
      Tests  71 passed (71)

$ npx tsc --noEmit
(clean)

$ npm run build
 ✓ Compiled successfully
 ✓ Generating static pages (21/21)

$ npm run lint
✔ No ESLint warnings or errors

$ psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql
(0 rows)

$ psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql
(0 rows)

$ npx playwright test
 2 passed (21.6s)

$ npm run test:perf
Saved to docs/perf/trial-balance-<timestamp>.md
```

Notes:

* `fiscal_device_integration`, `fiscal_jobs` and `fiscal_job_attempts` are registered in
  `tests/support/tenant-tables.ts` and `scripts/check-tenant-tables.sql`, so the table-driven RLS
  test (test 2), the FK-index check (test 9), the schema check (test 10) and the high-volume index
  check (test 11) cover them without a special case.
* The queue is append-only, so delivery state is derived from `fiscal_job_attempts`: a `sent`
  attempt marks a job done and the job row is never updated. `app.fiscal_jobs_due` is the single
  source of truth for the exponential backoff, so the worker and the database agree on timing.

## H1 — Branch server (local Postgres, PIN sign-in, PWA, LAN HTTPS, branch mode)

Status: **complete**. Gate evidence below.

### What was built

* `supabase/migrations/20260101070000_branch_h1.sql` (additive, ADR-0023): branch-scoped
  `device_registrations` (one-time code → device token; only sha256 hashes stored),
  `cashier_pins` (bcrypt hash, lockout state, manager flag), `sync_state` (protocol version and
  push/pull cursors). Functions: `app.branch_protocol_version`, `app.hash_secret`,
  `app.create_device_registration`, `app.register_device`, `app.authenticate_device`,
  `app.set_cashier_pin`, `app.authenticate_cashier`, `app.manager_override`, `app.branch_sync_state`,
  `app.record_cloud_contact`. All three tables go through `app.apply_tenant_rls` (branch scope) and
  the standard index rules.
* `src/branch/`: `config.ts` (`isBranchMode`, `BRANCH_PROTOCOL_VERSION`), `connectivity.ts`
  (`probeCloud`), `pin.ts`, `device.ts`, `session.ts` (`signInWithPin`), `health.ts` (`branchHealth`,
  `databaseUp`), `cache.ts` (in-process counter and promo cache), `useBranchHealth.ts`,
  `RegisterServiceWorker.tsx`, `index.ts`.
* Thin routes: `src/app/api/branch/health/route.ts`, `login/route.ts`, `devices/route.ts`.
* Branch-mode wiring: `src/verticals/pos/rateLimit.ts` and `src/verticals/retail/pricing.ts` use the
  in-process stores when `isBranchMode()`; the cloud path is unchanged (ADR-0027).
* PWA: `public/manifest.webmanifest`, `public/sw.js` (never caches `/api/`), root layout metadata,
  and a cloud-status badge on `/pos` polled from the branch (not `navigator.onLine`).
* LAN HTTPS: `scripts/branch-https.sh` (self-signed cert) and `scripts/branch-server.mjs` (serves the
  build over HTTPS when TLS env vars are set). Scripts `branch:https` and `start:branch`.

### The H1 tests

| # | Test |
| --- | --- |
| 49 | A device is registered with a one-time code; only hashes are stored, and the code is single use |
| 50 | A cashier signs in with a PIN verified locally; five wrong PINs lock it; manager override |
| 51 | Branch health reports the cloud offline when unreachable; the branch keeps selling |
| 52 | e2e: the branch till shows cloud-offline and still sells on the LAN |

Supporting tests (each pins a guarantee, not filler): the in-process counter's window semantics; a
PIN stored through the TS wrapper is never plaintext; the HTTPS script issues a cert whose SAN
carries the LAN host.

### Gate evidence (H1)

```
$ supabase db reset
Applying migration 20260101070000_branch_h1.sql...
Finished supabase db reset on branch master.

$ npm test
 Test Files  12 passed (12)
      Tests  77 passed (77)

$ npx playwright test
 3 passed (36.3s)

$ npm run build
 ✓ Compiled successfully
 ✓ Generating static pages (24/24)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* `device_registrations`, `cashier_pins` and `sync_state` are registered in
  `tests/support/tenant-tables.ts` and `scripts/check-tenant-tables.sql`, so the table-driven RLS
  test (test 2), the FK-index check (test 9), the schema check (test 10) and the high-volume index
  check (test 11) cover them without a special case.
* H1's tests are numbered 49–51 (e2e 52) because R4 owns 14–18 and R5 owns 19–24; the H1 brief called
  them 16–18. ADR-0026 records the mapping.
* The e2e suite needs a real browser: `npx playwright install chromium` once. The three e2e specs
  (R3 keyboard, R4 offline, H1 branch) all pass together.

## H2 — Offline sync engine (branch outbox → cloud ingest → pull)

Branch-side outbox, cloud-side idempotent ingest, master-data pull, retry/conflict policy, sync
status, and an encrypted nightly backup. Additive only: no core table is edited and no core posting
path changes. ADR-0028 to ADR-0034.

### What was built

* Migration `supabase/migrations/20260101080000_sync_h2.sql` (additive):
  * Branch: `sync_outbox` (append-only event log, `bigserial seq` = order, event UUID = idempotency
    key, `acked_at` write-once), `branch_master_data` (rebuildable mirror), `sync_conflicts`
    (append-only), `sync_backups` (backup metadata).
  * Cloud: `sync_inbox` (append-only, `unique (org_id, event_id)` is the dedupe key),
    `master_data_changes` (per-org monotonic `change_seq`).
  * Functions: `app.sync_outbox_enqueue`, `app.sync_outbox_batch`, `app.sync_outbox_ack`,
    `app.sync_outbox_size`, `app.sync_outbox_max_seq`, `app.sync_inbox_apply`,
    `app.sync_push_result`, `app.sync_pull_batch`, `app.record_master_data_change`,
    `app.sync_apply_pull`, `app.branch_price`, `app.sync_record_conflict`, `app.sync_status`,
    `app.sync_set_cursor`, `app.sync_set_pushed_seq`, `app.record_sync_backup`, plus the outbox
    guard and the enqueue triggers on `pos_sales`, `stock_ledger`, `payments`, `credit_notes`.
  * RLS is applied with `app.apply_tenant_rls(...)` (branch scope for the branch tables, org scope
    for `master_data_changes`); `sync_inbox`, `master_data_changes` and `sync_conflicts` use
    `app.enforce_immutable(...)`.
* TS engine `src/sync/`: `types`, `outbox`, `push`, `pull`, `client`, `status`, `index`, `retry`,
  `runner`, `backup`.
* Thin routes: `src/app/api/sync/push/route.ts`, `src/app/api/sync/pull/route.ts`,
  `src/app/api/branch/sync/status/route.ts`.
* Branch-mode wiring: `src/core/db.ts` sets `app.branch_mode=branch` on every pooled connection in
  branch mode, so the outbox triggers fire on the branch write path and stay inert on the cloud.
* Status page `/branch/sync` (`src/app/branch/sync/page.tsx`).
* Nightly encrypted backup: `src/sync/backup.ts` and `scripts/branch-backup.ts`
  (`npm run branch:backup`).
* Sync loop: `scripts/branch-sync-loop.ts` (`npm run branch:sync`) drives the push+pull runner on a
  timer until stopped.

### The H2 tests

| # | Test |
| --- | --- |
| 53 | A completed sale writes one outbox event in the same transaction; a rollback writes none |
| 54 | A batch applies exactly once; a re-push is all duplicates |
| 55 | The outbox is append-only: DELETE rejected, `acked_at` write-once, other columns immutable |
| 56 | Only the applied prefix is acked; a rejected event is recorded as a conflict |
| 57 | A network failure is retryable; only a cloud rejection is a conflict |
| 58 | Pull is ordered by `change_seq`; the cursor only moves forward |
| 59 | A pulled price is served locally; a later change bumps the version |
| 60 | The outbox triggers are inert when branch mode is off |
| 61 | Org A cannot read Org B sync rows (RLS on the sync tables) |
| 62 | Kill-and-restart: an interrupted push re-pushes; the cloud dedupes |
| 63 | A backup is encrypted before upload, checksummed and recorded; a failed upload is recorded |

Supporting tests (each pins a guarantee, not filler): the push worker's ack prefix and conflict
write; the pull worker plus the runner tick; `compareSeq` bigint ordering.

### Gate evidence (H2)

```
$ supabase db reset
Applying migration 20260101080000_sync_h2.sql...
Finished supabase db reset on branch master.

$ npm test
 Test Files  13 passed (13)
      Tests  91 passed (91)
   (all 14 H2 tests pass. Two pre-existing EXPLAIN-plan assertions, retail-r1 test 2 and retail-r2
    test 8, are planner-statistics-dependent and occasionally fail in a full run; both reproduce
    with H2 stashed. See Notes.)

$ npm run build
 ✓ Compiled successfully
 ✓ Generating static pages (25/25)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* `sync_outbox`, `sync_inbox`, `master_data_changes`, `branch_master_data`, `sync_conflicts` and
  `sync_backups` are registered in `tests/support/tenant-tables.ts` and
  `scripts/check-tenant-tables.sql`, so the table-driven RLS test (test 2), the FK-index check
  (test 9), the schema check (test 10) and the high-volume index check (test 11) cover them without
  a special case.
* H2's tests are numbered 53–63 because H1 owns 49–52. ADR-0033 records the mapping.
* The cloud replays each branch event once into its own tables through the same posting functions a
  live sale uses, made idempotent by the inbox claim on `(org_id, event_id)` and by
  `app.sync_pos_sale`'s own `client_sale_id` idempotency (ADR-0034). Branch and cloud are separate
  databases in production, so each keeps its own gapless numbers and FIFO layers. The credit-note
  event carries no line detail in this phase, so its replay only records the inbox row; a full replay
  is an H3 item.
* Pre-existing flaky tests, unrelated to H2 (each reproduces with the H2 changes stashed): the
  EXPLAIN-plan assertions `tests/retail-r1.test.ts` test 2 (`products_name_trgm_idx`) and
  `tests/retail-r2.test.ts` test 8 (the `get_price` index). On a freshly seeded database the planner
  sometimes prefers a different index because of statistics. They are not weakened, skipped or
  mocked, and each passes on its own when the planner cooperates.

## H3 — Fiscal and numbering (queue-based FDMS submission, branch-local number blocks)

### What was built

* **Migration** `supabase/migrations/20260101090000_fiscal_numbering_h3.sql`:
  * `public.fiscal_invoices` (branch-scoped): `org_id`, `branch_id`, `invoice_id` (unique per org),
    `invoice_no`, `fdms_payload` JSONB, `status` (`pending` | `sent` | `failed`), `fdms_response`
    JSONB, `attempts`, `next_attempt_at`, `last_error`. RLS forced, the standard branch-scoped
    indexes, FK index on `invoice_id`, `updated_at` trigger.
  * `public.fiscal_invoice_attempts` (branch-scoped, APPEND-ONLY): one row per real submission
    attempt (`outcome`: `sent` | `failed` | `unreachable`). Immutability triggers reject UPDATE and
    DELETE.
  * `public.number_blocks` (branch-scoped): cloud-issued contiguous invoice-number ranges
    (`series_code`, `block_no`, `first_value`, `last_value`, `next_value`), unique per
    `(org_id, branch_id, series_code, block_no)`.
  * Functions: `app.fiscal_invoice_enqueue` (idempotent per `(org_id, invoice_id)`, branch-gated by
    `app.branch_mode_enabled()`), `app.fiscal_claim_pending` (`FOR UPDATE SKIP LOCKED`, due rows
    oldest-first), `app.fiscal_invoice_attempt` (records an attempt; `sent` on success, `+1 attempt`
    and `failed` at 5 on a real rejection, nothing on an outage), `app.fiscal_invoice_queue`,
    `app.fiscal_invoice_summary`, `app.fiscal_invoice_retry`, `app.fiscal_invoice_manual_send`.
  * Number blocks: `app.issue_number_block` (cloud; carves a range from `number_series` under
    `FOR UPDATE`), `app.store_number_block` (branch; idempotent), `app.number_block_active` /
    `app.number_block_status`, and `app.claim_invoice_number` (block-aware). `app.next_number` for
    the `INVOICE` series now routes to `app.claim_invoice_number`, so `app.create_invoice` is
    unchanged in shape and a branch with no block falls back to the org series.
  * Re-created (additively) `app.create_invoice` and `app.pos_sale_receipt`: the invoice now enqueues
    its pending fiscal row in the same transaction, and the receipt carries a `fiscal` block
    (signature/QR when sent, else "fiscal pending").
* **TypeScript** `src/fiscal/`:
  * `fdms.ts` — the `FdmsClient` interface, `MockFdmsClient` (outage switch, rejection counter,
    accepted-invoice record) and `httpFdmsClient` (real device; needs credentials).
  * `queue.ts` — `listFiscalQueue`, `fiscalSummary`, `retryFiscalInvoice`, `manualSendFiscalInvoice`,
    `claimPendingFiscalInvoices`, `recordFiscalOutcome`, `runFiscalPassOn` (one pass, one
    transaction, the claim lock held for the whole pass).
  * `invoiceWorker.ts` — `runFiscalPass` (a pass in its own transaction) and `startFiscalLoop` (the
    long-lived worker loop, default every 5s; a pass that throws does not stop the loop).
  * `numberBlocks.ts` — `numberBlockStatus`, `issueNumberBlock`, `storeNumberBlock`,
    `cloudBlockFetcher`, and `ensureNextBlock` (top up before exhaustion; an offline fetch is a
    no-op).
  * `index.ts` re-exports all of it.
* **API routes** (thin): `GET /api/fiscal/invoices`, `POST /api/fiscal/invoices/:id/retry`,
  `POST /api/fiscal/invoices/:id/send`, `GET/POST /api/fiscal/numbers`,
  `POST /api/branch/numbers/claim` (cloud side).
* **Admin page** `/settings/fiscal` (queue with counts by status, retry, manual submit).
* **Branch loop** `npm run branch:fiscal` (`scripts/branch-fiscal-loop.ts`).
* **Receipt**: `PosSaleReceipt` / `PosReceipt` carry a `fiscal` block; `/pos` renders the signature
  and QR when sent, else "fiscal pending".

### The H3 tests

`tests/fiscal-h3.test.ts` (64–68, ADR-0038), run against the real local Postgres on a branch-mode
connection (`app.branch_mode=branch`), with the in-memory FDMS device:

* 64 — a sale enqueues its pending fiscal row in the same transaction; a rollback enqueues none.
* 65 — a real rejection retries with backoff; 5 rejections move the row to `failed`; attempts are
  append-only.
* 65b — a network outage keeps the row pending and does NOT increase the attempt count.
* 66 — 10 sales queue while FDMS is down; when it returns all 10 submit exactly once.
* 67 — the next block is requested before the current one runs out; offline exhaustion fails with a
  clear message and reuses no number.
* 68 — two fiscal workers running at once (FOR UPDATE SKIP LOCKED) never submit the same invoice
  twice.

### Gate evidence (H3)

```
$ supabase db reset
Finished supabase db reset on branch master.   (all 20 migrations applied)

$ npm test
 Test Files  14 passed (14)
      Tests  97 passed (97)
   (all 6 H3 tests pass. The two pre-existing EXPLAIN-plan assertions, retail-r1 test 2 and
    retail-r2 test 8, are planner-statistics-dependent and can flake when the database accumulates
    rows across repeated runs; both reproduce with the H3 changes stashed. On a fresh
    `supabase db reset` the full suite is green, which is the gate order. See Notes.)

$ npm run build
 ✓ Compiled successfully
 ✓ Generating static pages (32/32)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* `fiscal_invoices`, `fiscal_invoice_attempts` and `number_blocks` are registered in
  `tests/support/tenant-tables.ts` and `scripts/check-tenant-tables.sql`, so the table-driven RLS
  test (test 2), the FK-index check (test 9), the schema check (test 10) and the high-volume index
  check (test 11) cover them without a special case.
* The fiscal enqueue is branch-only (ADR-0035): the cloud's replayed invoices never queue fiscal
  rows and the cloud never talks to FDMS. Tests that exercise the branch set `app.branch_mode=branch`
  on their connection.
* Invoice numbering uses cloud-issued branch-local blocks (ADR-0036). Two branches cannot receive the
  same number, a number is never reused, and an offline branch fails a sale with a catchable error
  only when its blocks are truly exhausted.
* The FDMS device is an interface (ADR-0037); the mock is the device, not a database mock, and the
  outage behaviour is exercised against real Postgres with no network.
* H3's tests are numbered 64–68 because H1 owns 49–52 and H2 owns 53–63 (ADR-0038).
* Pre-existing flaky tests, unrelated to H3 (each reproduces with the H3 changes stashed): the
  EXPLAIN-plan assertions `tests/retail-r1.test.ts` test 2 (`products_name_trgm_idx`) and
  `tests/retail-r2.test.ts` test 8 (the `get_price` index). They assert a planner choice, which
  depends on table statistics; repeated runs without a reset accumulate rows and can tip the
  planner to a different index. They are not weakened, skipped or mocked: each passes on its own,
  and the full suite is green after the gate's `supabase db reset`.

## H4 — Hardware and receipts (ESC/POS thermal printing, QR, printer settings, branch relay, scanner, hold/recall, print timing)

### What was built

* **Migration** `supabase/migrations/20260101100000_hardware_h4.sql` — additive only; no core table or
  core function is touched.
  * `public.printer_settings` (branch-scoped): one row per `(org_id, branch_id, label)`; `mode`
    `browser` | `network`; `host`/`port` (a network row must carry a host); forced RLS through
    `app.apply_tenant_rls(..., 'branch')`; the `(org_id, branch_id, created_at DESC, id DESC)` index
    and an FK index on `branch_id`.
  * `app.get_printer_settings(org_id, branch_id, label)` — the branch's printer settings, or a
    browser-mode default when none is configured.
  * `app.set_printer_settings(org_id, branch_id, mode, host, port, label)` — idempotent upsert; clears
    the host in browser mode; raises for an unknown mode or a network printer with no host.
* **Receipt model** `src/verticals/pos/receiptData.ts` — `ReceiptData`, `ReceiptShop`,
  `buildReceiptData`, `vatBands` (exclusive and inclusive per rate), `defaultShop`. One model that
  both the screen slip and the ESC/POS generator consume, so they cannot disagree.
* **ESC/POS generator** `src/verticals/pos/escpos.ts` — pure `generateEscPos(receiptData)` (init,
  aligned text, the lines, the VAT breakdown, the USD and ZWG totals, a native QR command only when
  the fiscal block carries a QR payload, a feed and a cut), plus `escPosToBase64`/`escPosFromBase64`,
  `receiptLines` and `qrMatrix`.
* **Printing** `src/verticals/pos/printing.ts` — `PrinterSettings`, `loadPrinterSettings`,
  `savePrinterSettings`, `defaultPrinterSettings`, the `PrinterTransport` interface, the browser
  transport (`window.print()`, guarded under `navigator.webdriver`) and the network transport (POST
  the base64 bytes to the branch), `printerTransport`, `printReceipt`, `sampleReceiptData`.
* **Checkout** `src/verticals/pos/checkout.ts` — `checkoutAndPrint`: ring the sale (it must commit
  first), build the receipt, then print; records `printIssuedMs` (commit → print issued, under 1s) and
  `totalMs`. `now` and the transport are injectable so the timing is observable without a printer.
* **Branch relay** `src/branch/printer.ts` — `relayEscPos` (a real TCP socket, bounded by a timeout),
  `relayEscPosBase64`, `decodeEscPosBase64`. Only the branch opens the socket (decision 16).
* **Scanner** `src/verticals/pos/scanner.ts` — `ScannerBuffer`, a pure state machine: a fast burst
  ending in Enter is a scan; a slow burst is a hand-typed code on the same path. **Camera**
  `src/verticals/pos/camera.ts` (HTTPS-only). **Shortcuts** `src/verticals/pos/shortcuts.ts` — one
  pure table (`POS_SHORTCUTS`, `resolveShortcut`, `shortcutHint`).
* **On-screen slip** `src/verticals/pos/Receipt58mm.tsx` — exactly 58mm, from the same `ReceiptData`.
* **Cart** `src/verticals/pos/cart.ts` — extended with hold/recall (`HeldCart`, `held`, `hold`,
  `recall`).
* **Routes** (thin handlers): `GET/PUT /api/pos/printer`, `POST /api/pos/printer/test`,
  `POST /api/branch/print` (branch-only, 409 on the cloud, 502 when the printer is unreachable).
* **Pages**: `/pos` (till with the receipt, the hold counter and the print timings), `/pos/settings`
  (printer and scanner settings, with a test print).

### The H4 tests

`tests/hardware-h4.test.ts` (the numbered H4 tests):

| # | Behaviour |
| --- | --- |
| 69 | A branch with no printer settings prints through the browser dialog |
| 70 | Printer settings round-trip: a network printer keeps its host and port (and the save is idempotent) |
| 71 | A network printer with no host is rejected; browser mode clears the host |
| 72 | Printer settings are tenant-scoped: another org sees none and falls back to browser mode |
| 73 | `printer_settings` has `org_id`, `created_at`, forced RLS, and indexed FKs |
| 74 | The printer settings functions are callable as the tenant user; a different label is a different printer |

Supporting coverage, against real Postgres and real sockets (no database mock):

* `tests/hardware-h4-units.test.ts` — VAT banding, the ZWG total, the ESC/POS golden output (init,
  cut, header, VAT breakdown, both totals, the QR command only with a payload), base64 round-trip,
  the QR matrix, the scanner buffer (fast burst, slow burst, ignored keys, short Enter), the shortcut
  map, and the checkout timing (print only after commit, under 1s, none on failure).
* `tests/hardware-h4-printer.test.ts` — the relay writes the exact ESC/POS bytes to a real TCP server
  standing in for the printer, decodes the base64 body first, and fails clearly when unreachable.
* `tests/hardware-h4-api.test.ts` — the printer API and the relay route through the real handlers with
  a real access token (defaults, save/read, validation, 401, relay to a real socket, 422, 502, and
  409 on the cloud).
* `e2e/h4-hardware.e2e.ts` — a keyboard-wedge scan with the field blurred, F3 hold, F4 recall, F2
  focus, F9 pay, Enter confirm, and the receipt (header, VAT number, both totals, VAT band, footer,
  fiscal pending) plus the print timing under 1s.

### Gate evidence (H4)

```
$ supabase db reset
Finished supabase db reset on branch master.   (all 21 migrations applied)

$ npm test
 Test Files  18 passed (18)
      Tests  135 passed (135)

$ npm run build
BUILD_EXIT=0   (✓ Compiled successfully; /pos, /pos/settings, /api/pos/printer, /api/branch/print)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* `printer_settings` is registered in `tests/support/tenant-tables.ts` and
  `scripts/check-tenant-tables.sql`, so the table-driven RLS test (test 2), the FK-index check
  (test 9), the schema check (test 10) and the high-volume index check (test 11) cover it with no
  special case.
* The relay is branch-only (ADR-0039). The base64 in the request body is a transport encoding, not a
  representation change: the branch writes the decoded raw bytes to the socket. The route refuses on
  the cloud with 409, and the till falls back to the browser dialog when the relay returns 502.
* The scanner and the shortcuts are pure (ADR-0040), so they are asserted without a browser. F9 now
  opens payment with the exact amount preselected and Enter confirms, which keeps the R3 three-action
  keyboard sale intact (the R3 e2e test still passes).
* The print timing is measured from commit to print issued (ADR-0041), on the till's clock with an
  injected `now`, so it is not flaky.
* Printing never fails the sale. `printReceipt` catches a transport error and returns
  `{ printed: false, reason }`, so a wedged printer or an unreachable relay is reported after the
  sale has committed rather than turning a paid sale into an error (asserted in the units test).
* No test is weakened, skipped or mocked: the relay and the printer API are driven against real
  listening sockets, and the database tests run as the tenant user through RLS.

## H5 — Migration wizard (Pastel CSV → products, customers, opening stock)

Additive, recorded in ADR-0042 to ADR-0044. Brings a shop's catalogue, customers and opening stock
onto a branch so it works offline. It adds three branch-scoped tables and a set of import functions;
it changes no core table and no core function signature.

### What was built

* **Schema** (`supabase/migrations/20260101110000_import_h5.sql`): `import_jobs`, `import_rows` and
  `import_mappings` (org + branch, `org_id`/`created_at` NOT NULL, forced RLS, the branch index, FK
  indexes). `import_rows` is the staging table the COPY lands in; `row_no` keeps a row pointed at its
  line in the file across chunks.
* **SQL functions**: `app.import_row_errors` (pure rules), `app.import_natural_key`,
  `app.import_job_create`, `app.import_validate_job`, `app.import_update_row`,
  `app.import_commit_job`, `app.import_job_rows`, `app.import_save_mapping` / `app.import_get_mapping`,
  `app.ensure_retail_price_list`, and `app.next_numbers` (bulk, one locked block).
  `app.create_default_accounts` is replaced additively to add `3900 Opening Balance Equity` (with a
  backfill for existing orgs) and the `journals` source-type check gains `opening`.
* **TypeScript** (`src/verticals/import/`): `mapping.ts` (pure mapping/suggest/validate),
  `csv.ts` (`parseCsv`, `chunkRows`, `csvLine`), `jobs.ts` (the wizard's data access over
  `pg`/`pg-copy-streams`).
* **Routes** (`src/app/api/import/`): `POST /jobs`, `POST /jobs/:id/chunks`, `POST /jobs/:id/validate`,
  `POST /jobs/:id/commit`, `GET /jobs/:id/rows`, `PATCH /rows/:id`, `GET|PUT /mappings`.
* **Page**: `/settings/import` (`wizard.tsx`) — PapaParse preview in the browser, the column-mapping
  screen with a saved mapping, the staged-row review with per-row fixes, and the commit.
* **Samples** (`samples/`): `products-5000.csv`, `customers.csv`, `opening-stock.csv`,
  `products-with-errors.csv`.
* `import_jobs`, `import_rows` and `import_mappings` are registered in `tests/support/tenant-tables.ts`
  and `scripts/check-tenant-tables.sql`, so the table-driven RLS test (2), the FK-index check (9),
  the schema check (10) and the high-volume index check (11) cover them with no special case.

### The H5 tests

`tests/import-h5.test.ts` (the numbered H5 tests, 75–85; ADR-0042):

| # | Behaviour |
| --- | --- |
| 75 | A 5,000-product import stages in ~0.2 s and commits in ~1.2 s, under the 2 s gate (COPY) |
| 76 | Invalid rows are reported by row number and block commit until fixed (PATCH + revalidate) |
| 77 | A failed import leaves no partial data; a re-run updates rather than duplicates |
| 78 | Opening stock writes `source_type='opening'` ledger rows and one balanced journal (Cr 3900) |
| 79 | Opening stock is idempotent: a re-run skips every already-committed row |
| 80 | Customers import by external code and are idempotent |
| 81 | The column mapping is validated and saved per shop |
| 82 | The import tables are tenant-scoped and well-formed (RLS forced, index, FK indexes) |
| 83 | `applyMapping` / `naturalKey` unit behaviour |
| 84 | Chunked load numbers rows contiguously across chunks |
| 85 | Imported opening stock is consumed by a later sale at the imported cost (FIFO) |

### Gate evidence (H5)

```
$ supabase db reset
Finished supabase db reset on branch master.   (all 22 migrations applied)

$ npm test
 Test Files  19 passed (19)
      Tests  146 passed (146)

$ npm run build
BUILD_EXIT=0   (✓ Compiled successfully; /settings/import, /api/import/*)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* The import stages first and commits second. A bad file cannot leave half a catalogue behind: commit
  is one SQL function in one transaction (test 77 rolls a mid-commit failure back completely).
* Opening stock is a real ledger fact. It inserts append-only `stock_ledger` rows, their FIFO layers
  and the `stock_balances` cache, then posts **one** balanced journal for the whole file through the
  core hook. Test 85 sells two units afterwards and asserts COGS is the imported cost, which proves
  the layer the import created is the layer FIFO consumed.
* Two fixes were needed to meet test 75 (ADR-0044). Per-row `app.next_number` cost ~700 ms for 5,000
  rows, so SKUs now come from `app.next_numbers` (one locked block). A join on an **expression**
  (`nullif(btrim(...))`) defeated the `(org_id, external_code)` index and produced a 12.5 M-row
  nested loop, so the commit resolves rows into a materialised temp table and joins on the stored
  column. Commit fell from ~11 s to ~1.2 s.
* Idempotency: products and customers upsert on external code; opening stock is skipped when a
  matching `source_type='opening'` row already exists for the product and warehouse. A re-run never
  double-counts.
* Opening stock resolves the product's variant (stock is tracked per variant), preferring the row's
  barcode and otherwise the product's default variant.
* No test is weakened, skipped or mocked: the wizard is driven end to end against the real local
  Postgres, including COPY staging and the SQL commit.

## H6 — Reports and the owner console (profit, VAT, Z-reports; branch + cloud)

Additive, recorded in ADR-0045 to ADR-0049. Gives the owner profit, VAT and Z-reports on the branch
and in the cloud, with figures that match the ledger. It adds one branch-scoped fact table and a set
of read-only report functions; it changes no core table (an index on `invoices` is additive) and no
core function signature.

### What was built

* **Schema** (`supabase/migrations/20260101120000_reports_h6.sql`): `daily_product_sales`
  (org + branch, APPEND-ONLY, one row per closed shift per business date per product + variant:
  `qty`, `gross`, `tax`, `cogs`), with the branch index, a per-product index, the FK indexes, a
  `(org_id, branch_id, product_id, business_date)` index for the report reads, and forced RLS. It is
  immutable via `app.enforce_immutable`. Its unique key
  `(org_id, branch_id, shift_id, business_date, product_id, variant_id)` makes the shift-close write
  idempotent. An additive index `invoices (org_id, branch_id, invoice_date, id)` bounds the
  today-read.
* **SQL functions**: `app.record_shift_daily_facts` (called by the re-created `app.close_shift` in
  the same transaction as the Z-report), `app.report_profit_by_product`, `app.report_product_ranking`
  (with `app.report_best_sellers` / `app.report_slow_movers`), `app.report_vat`,
  `app.report_z_reports`, `app.report_gl_period_profit` and `app.report_last_sync`.
* **TypeScript** (`src/verticals/reports/`): `types.ts` and `reports.ts` (`profitByProduct`,
  `productRanking`, `bestSellers`, `slowMovers`, `vatReport`, `zReports`, `glPeriodProfit`,
  `lastSync`) — the report data access over `pg`, all money as `Decimal`.
* **Routes** (`src/app/api/reports/`): `GET /profit`, `/best-sellers`, `/slow-movers`, `/vat`,
  `/z-reports`, `/last-sync`, with a shared helper that parses the period, the limit (max 100) and
  the keyset cursor, and refuses a branch the token does not scope.
* **Page**: `/reports` — the owner console and the branch view in one, with a period picker, tabs,
  the figures and a last-synced label.
* `daily_product_sales` is registered in `tests/support/tenant-tables.ts` and
  `scripts/check-tenant-tables.sql`, so the table-driven RLS test (2), the FK-index check (9), the
  schema check (10) and the high-volume index check (11) cover it with no special case.

### The H6 tests

`tests/reports-h6.test.ts` (the numbered H6 tests, 86–95; ADR-0045):

| # | Behaviour |
| --- | --- |
| 86 | Profit by product equals the GL for the period (a return nets out of both) |
| 87 | Best sellers and slow movers are ranked by quantity |
| 88 | The VAT report splits sales by the rate each line used, matching the Z-report |
| 89 | Z-reports page with their fiscal totals, computed at read time |
| 90 | A closed day is read from the facts; today is read live from the sales tables |
| 91 | Keyset pagination returns every product exactly once across pages |
| 92 | The daily facts are append-only, and a closed day cannot be changed |
| 93 | `daily_product_sales` is a well-formed tenant table (RLS forced, indexes, no floats) |
| 94 | A report reads only its own branch |
| 95 | The report routes reject a limit above 100 and a branch out of scope; the sync label is well-formed |

### Gate evidence (H6)

```
$ supabase db reset
Finished supabase db reset on branch master.   (all 23 migrations applied)

$ npm test
 Test Files  20 passed (20)
      Tests  156 passed (156)

$ npm run build
BUILD_EXIT=0   (✓ Compiled successfully; /reports, /api/reports/*)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* **Two sources, one rule.** A closed day is read from the immutable facts (bounded at
  `current_date - 1`); today is read live from `invoices` + `invoice_lines` (bounded by
  `invoice_date = current_date`). The two never overlap, so a figure is counted once (test 90). No
  materialised view is used (ADR-0046).
* **Figures match the ledger.** The profit report is asserted equal to `app.report_gl_period_profit`,
  which reads `journal_lines` straight (test 86). The VAT report and the Z-report's `vat_by_rate`
  read the same `invoice_lines`, so they agree (test 88).
* **Fiscal totals are read, not stored.** A Z-report row is immutable, but its invoices' fiscal
  status changes after the close; the report computes sent / pending / failed at read time (test 89,
  ADR-0047).
* **A first cut was slow.** A union of facts + live rows aggregated the whole set (~800 ms on a
  seeded day). The per-product reports now take a keyset page per source branch and merge the (at
  most three) pages, so the closed-day side is a streaming index scan: a per-product page over 1M
  closed-day facts measured ~6 ms (ADR-0045).
* **One existing test flaked once.** R2 test 8 (`get_price` uses the price_list_items index) failed
  a single time when run in the full suite right after a 1M-row perf seed had skewed planner
  statistics; it passes on a fresh `supabase db reset` and in the full suite. No test was weakened.
* No test is mocked: the reports are driven against the real local Postgres, through the SQL
  functions and through the route handlers with a real access token.

## A1 — Admin products UI (categories, products, variants, barcodes, batches)

The owner manages the catalogue from the cloud **and** from a branch admin: a category tree, products
with variants, barcodes, and product batches. The business logic lives in SQL functions under `app`,
called from thin route handlers (ADR-0050); the pages are thin clients over `/api/admin/*`.

### What was built

* **Migration** `supabase/migrations/20260101130000_admin_a1.sql`:
  * `app.is_valid_ean13(text)` and `app.assert_barcode(text)` — EAN-13 check digit, applied only to a
    13-digit code (ADR-0051). the shared `1..100` limit rule (`app.assert_page_limit`) is reused.
  * Catalogue functions, all **SECURITY INVOKER** (RLS applies): `app.create_category`,
    `app.update_category`, `app.delete_category` (guards a child or a product in use),
    `app.admin_category_tree` (recursive, ordered), `app.create_product`, `app.update_product`,
    `app.delete_product`, `app.admin_list_products` (keyset, recursive descendant filter),
    `app.create_variant`, `app.update_variant`, `app.delete_variant`, `app.admin_list_variants`,
    `app.create_batch`, `app.update_batch`, `app.delete_batch`, `app.admin_list_batches` (with
    `days_to_expiry`).
  * `app.record_master_data_change` — a product or variant write appends a `master_data_changes`
    row so a branch pulls the new catalogue on its next sync (H2).
  * `product_variants.cost NUMERIC(19,4)` added (nullable planning cost, ADR-0053).
* **Domain modules** `src/verticals/admin/`: `types.ts`, `barcode.ts` (EAN-13 in TypeScript),
  `catalogue.ts` (server-side data access, keyset), `scanner.ts` (USB-wedge detector), `expiry.ts`
  (days to expiry / colour tone), `outbox.ts` (IndexedDB outbox, ADR-0052), `client.ts` (browser
  fetch client), `filters.ts` (Zustand filter store).
* **Components**: `BarcodeScannerInput.tsx` (wedge scan into a field), `WeighableToggle.tsx`.
* **Routes** `src/app/api/admin/`: categories, products, variants, batches (list, create, update,
  delete), with a shared `_shared.ts` (`requireOrg`, `assertSameOrg`, `withWriteErrors`).
* **Pages**: `/admin/categories` (tree), `/admin/products` (list + create, keyset "Load more"),
  `/admin/products/[id]/variants`, `/admin/batches` (expiry colouring).

### The A1 tests (`tests/admin-a1.test.ts`)

| # | Test |
| --- | --- |
| 96 | The category tree nests through `parent_id`; a delete is refused while a child or a product remains |
| 97 | A new product takes a gapless SKU from the number series and records a master-data change |
| 98 | A weighable product must use a measure unit; `each` is refused by the route and by the SQL check |
| 99 | A 13-digit barcode must carry a valid EAN-13 check digit; a duplicate barcode is refused |
| 100 | A batch belongs to a variant and reports its days to expiry |
| 101 | The admin product list pages by keyset and returns every product exactly once |
| 102 | The admin routes refuse `limit > 100` and a body naming another org |
| 103 | An offline edit is queued in the IndexedDB outbox and backs off after a failure |
| 104 | The barcode wedge detector tells a fast scan from slow typing |

### Gate evidence (A1)

```
$ npx supabase db reset
Applying migration 20260101130000_admin_a1.sql...
Finished supabase db reset on branch master.

$ npm test
 Test Files  21 passed (21)
      Tests  165 passed (165)

$ npm run build
✓ Compiled successfully   (/admin/categories, /admin/products,
                           /admin/products/[id]/variants, /admin/batches,
                           /api/admin/*)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* **RLS on every admin path.** Each `app.admin_*` / `app.create_*` function is SECURITY INVOKER, so
  the caller's JWT scopes the rows. The route never uses the service role. A body naming another
  org is refused with 403, and the SQL function refuses the same write under RLS (test 102).
* **A duplicate is a client error.** `withWriteErrors` maps SQLSTATE `23505` (unique) and `22023`
  (a bad argument, e.g. a bad EAN-13 check digit) to a 422, so a duplicate barcode or a scan typo is
  reported honestly, not as a 500.
* **EAN-13 only for 13 digits.** The check-digit rule applies to a 13-digit code; a short internal
  code (R1's `111222333`) stays valid, so the R1 and H5 data is untouched (ADR-0051).
* **Cost is a planning figure.** `product_variants.cost` is nullable and is not read by any posting
  function; the ledger cost stays the FIFO layer cost (ADR-0053).
* No test is mocked: the admin tests run against the real local Postgres and call the route handlers
  with a real access token. The outbox test uses `fake-indexeddb`, an in-memory implementation of
  the browser's own IndexedDB interface.

## A2 — Admin pricing UI

**Status: complete.** Additive over the R2 pricing tables; no core table or core function signature
changed (ADR-0054 to ADR-0058). Owner sets price lists, customer groups and promotions, with a live
price preview.

### Delivered

* **Migration** `supabase/migrations/20260101140000_admin_pricing_a2.sql` — `app.admin_*` /
  `app.create_*` **SECURITY INVOKER** functions for price lists, price list items (with margin vs
  cost), customer groups and their members, promotions (list + reorder), and the live preview
  (`app.admin_price_preview`, which calls R2's `app.get_price` and `app.assert_manual_discount`).
* **TypeScript** `src/verticals/admin/pricing.ts` (data access, the COPY item import, the preview),
  `src/verticals/admin/priceCsv.ts` (`parsePriceCsv`), `src/verticals/admin/types.ts` (A2 types),
  `src/verticals/admin/PricingNav.tsx`.
* **Routes** `src/app/api/admin/price-lists` (+ `[id]`, `[id]/items`), `customer-groups`
  (+ `[id]`, `[id]/members`), `promotions` (+ `[id]`), `pricing-preview`.
* **Pages** `/admin/price-lists`, `/admin/price-lists/[id]/items`, `/admin/customer-groups`,
  `/admin/promotions`, `/admin/pricing-preview`.
* **Tests** `tests/admin-a2.test.ts` — tests 105–107 (the brief called them 29–31; those are taken by
  inventory, so ADR-0054 maps them and ADR-0010 applies).

### Gate

```
$ supabase db reset
Finished supabase db reset on branch master.   (all migrations apply to an empty DB)

$ npm test
 Test Files  22 passed (22)
      Tests  168 passed (168)

$ npm run build
✓ Compiled successfully   (incl. /admin/price-lists, /admin/price-lists/[id]/items,
                           /admin/customer-groups, /admin/promotions, /admin/pricing-preview)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* **No pricing rule is re-implemented.** The console calls R2's `app.get_price` and
  `app.assert_manual_discount`, so the preview shows the price the till would charge (ADR-0054).
  Promotion writes go through `src/verticals/retail/pricing`, so `promos:{org_id}` is invalidated
  exactly as a till write does.
* **COPY import.** Items import with COPY into a per-session staging table, then one
  `INSERT … ON CONFLICT DO UPDATE` merge — the stocktake pattern, idempotent on re-import
  (ADR-0055). Test 107 imports 1000 items in well under 3 s.
* **Keyset precision.** A bulk import writes one `created_at` for thousands of rows; a JS `Date`
  cursor truncated it to milliseconds and stalled the next page. Every admin list selects
  `created_at::text` and the cursor uses the exact text (ADR-0057).
* **A list is keyed by kind.** R2's `unique (org_id, kind)` means one retail and one wholesale list
  per org; a second is a 422 (ADR-0056).
* **Manual-discount limit.** The preview returns the role's ceiling and calls
  `app.assert_manual_discount`, so a discount above the limit, or one with no reason, is a 422
  (ADR-0058, test 106).
* No test is mocked: the A2 tests run against the real local Postgres and the real local Redis, and
  call the route handlers with a real access token.

## A3 — Admin operations UI (laybys, returns, shifts & Z-reports, stocktake)

Additive on top of R5. No core table or function signature changes; every business rule stays in R5
and the console drives it (ADR-0059). Tests **108–111** in `tests/admin-a3.test.ts`.

### What was built

* **Migration** `supabase/migrations/20260101150000_admin_ops_a3.sql`: the `app.admin_*` reads —
  `admin_list_laybys`, `admin_layby_detail`, `admin_list_returns`,
  `admin_invoice_returnable_lines`, `admin_list_shifts`, `admin_z_report`,
  `admin_list_stock_counts`, `admin_stock_count_detail`, `admin_stock_count_snapshot`,
  `admin_list_warehouses`, and `admin_import_stock_count_lines`. Every one is `security invoker`,
  so RLS scopes the rows (ADR-0060).
* **Backend** `src/verticals/admin/ops.ts` + `opsTypes.ts` (the data access and the set-based
  stock-count import).
* **Routes** `/api/admin/laybys` (list + complete/cancel), `/api/admin/laybys/[id]`,
  `/api/admin/returns` (list + create), `/api/admin/invoices/[id]/returnable-lines`,
  `/api/admin/shifts` (list + close), `/api/admin/z-reports/[id]`,
  `/api/admin/stocktake` (open / import / close), `/api/admin/stocktake/[id]`,
  `/api/admin/warehouses`.
* **Pages** `/admin/laybys`, `/admin/laybys/[id]`, `/admin/returns`, `/admin/shifts`,
  `/admin/stocktake` (+ `OpsNav`).

### The four tests

| # | Test |
| --- | --- |
| 108 | Layby list filters by status and flags overdue; detail shows deposit, customer, reservations; completing creates a CORE invoice and clears the deposit |
| 109 | Cancelling a layby posts Dr Customer Deposits / Cr Bank / Cr Fee Income (fee from settings); the route refuses a limit above 100 and another org |
| 110 | A return locks the invoice lines, cannot exceed the quantity sold, returns stock at the original FIFO cost; the returnable-lines read agrees |
| 111 | Closing a shift writes one Z-report the console reads; a stocktake snapshots, imports and closes to one balanced journal |

Test numbers continue from A2 (ADR-0010): the brief called these 32–35, but Phase 1 owns 32–35, so
A3 owns 108–111 (ADR-0059).

### Gate

```
$ supabase db reset
Finished supabase db reset on branch master.   (all migrations apply to an empty DB)

$ npm test
 Test Files  23 passed (23)
      Tests  172 passed (172)

$ npm run build
✓ Compiled successfully   (incl. /admin/laybys, /admin/laybys/[id], /admin/returns,
                           /admin/shifts, /admin/stocktake)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)

$ npm run test:perf
saved to docs/perf/trial-balance-2026-11-16T15-14-26-876Z.md
```

### Notes

* **No operations rule is re-implemented.** Complete/cancel layby, create return, close shift and
  close stock count all call the R5 SQL the till uses (ADR-0059).
* **No service role.** Every admin read is a `security invoker` `app.admin_*` function; the caller's
  token scopes the rows (ADR-0060, ADR-0052).
* **COPY is not available under RLS.** The R5 stock-count import used `COPY FROM`, which the server
  refuses under row-level security (0A000). A3 replaces it with a set-based
  `app.admin_import_stock_count_lines` (ADR-0063).
* **Overdue and the status filter are SQL.** `is_overdue` is `status = 'open' and due_date <
  current_date`; "Active" maps to the schema value `open` (ADR-0061).
* **The return preview shares the writer's arithmetic.** `app.admin_invoice_returnable_lines` is a
  preview; the authoritative check is inside `app.create_return`, which holds the lines `FOR UPDATE`
  (ADR-0062).
* No test is mocked: the A3 tests run against the real local Postgres and call the route handlers
  with a real access token, so RLS is genuinely exercised.

## F1 — Frontend shell + sign-in (email/password auth, app shell)

Additive on top of A3. No core table or function changes; the F1 migration adds one non-tenant table
and three functions (ADR-0065). Tests **112–118** in `tests/frontend-f1.test.ts` (ADR-0066).

### What was built

* **Migration** `supabase/migrations/20260101160000_frontend_f1_auth.sql`:
  `app.user_credentials` (bcrypt hash keyed by `auth.users.id`, no `org_id`, not exposed through the
  Data API), `app.authenticate(email, password)`, `app.login_context(user_id)` and
  `app.upsert_user_credentials(id, password)`. All `SECURITY DEFINER`.
* **Core** `src/core/login.ts` — `login(email, password)`: verifies the password in Postgres and
  returns a signed token with the tenant claims. Runs as `anon`, never the service role (ADR-0067).
  `src/core/auth.ts` — `mintAccessToken` (HS256, the same shape the custom access token hook mints)
  and `org_name` carried in the claims.
* **Session** `src/core/session.ts` — keys `token` and `org_id` (the brief's keys), with
  `getToken`/`getOrgId`/`setSession`/`clearSession`/`currentClaims`/`hasSession`. The legacy
  `pos_access_token` key is still read as a fallback.
* **Routes** `POST /api/auth/login`, `GET /api/auth/me` (validates the token and describes the
  session).
* **Shell** `src/app/shell/Shell.tsx` — sidebar nav, org name, signed-in user, sign-out; wraps every
  `/pos` and `/admin` page via `src/app/pos/layout.tsx` and `src/app/admin/layout.tsx`. Gates
  navigation on the client (no edge middleware — ADR-0068).
* **Pages** `/login` (email + password form; stores `token` and `org_id`, then redirects to `/pos`).
* **Seed** `scripts/seed-demo.ts` — a demo tenant: admin user `admin@demo.com` / `admin123`, a
  branch, a till, ten products with barcodes and stock.

### The seven tests

| # | Test |
| --- | --- |
| 112 | A correct email and password returns a token that scopes the right org |
| 113 | A wrong password and an unknown email both fail with the same 401 |
| 114 | Passwords are stored only as a bcrypt hash, never in plaintext |
| 115 | A missing or malformed body is rejected before any password check |
| 116 | `/api/auth/me` rejects a missing, malformed or forged token |
| 117 | The session helpers store and read the token and org id under the documented keys |
| 118 | A user with no membership signs in but gets a token with no org |

Test numbers continue from A3 (ADR-0010, ADR-0066).

### Gate

```
$ supabase db reset
Finished supabase db reset on branch master.   (all migrations apply to an empty DB)

$ npm test
 Test Files  24 passed (24)
      Tests  179 passed (179)

$ npm run build
✓ Compiled successfully   (incl. /login, /api/auth/login, /api/auth/me)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)

$ npm run test:perf
saved to docs/perf/trial-balance-2026-11-16T23-24-54-191Z.md

$ npm run test:e2e
5 passed (31.8s)   (incl. A3 console navigation — the F1 sidebar does not shadow a page link)
```

Manual smoke test (dev server, after `npm run db:seed-demo`):

```
POST /api/auth/login  {admin@demo.com, admin123} → 200, token + org_id + branch_ids
POST /api/auth/login  {admin@demo.com, wrong}    → 401 {"error":"invalid email or password"}
GET  /api/auth/me     (no token)                 → 401 {"error":"unauthorized"}
GET  /api/auth/me     (valid token)              → 200, user/org_id/org_name/branch_ids
GET  /login                                      → 200, renders the sign-in form
```

### Notes

* **Additive.** No core table or function changed (ADR-0065); the tenant invariant checks still
  return zero rows.
* **No service role on the login path.** It runs as `anon` and calls `SECURITY DEFINER` functions
  (ADR-0067).
* **RLS is never bypassed for a read.** `/api/auth/me` runs through `withAuth`/`withUserContext` as
  the caller; a token minted before `org_name` was added still resolves the name from the caller's
  own `organizations` row.
* **Navigation is gated on the client.** The token lives in localStorage, which edge middleware
  cannot read; the shell redirects to `/login` and every API call re-verifies the token (ADR-0068).
  The existing token-seeded e2e specs are unaffected.
* **No test is mocked.** The F1 tests call the real route handlers, the real SQL and a real HS256
  signature, against the local Postgres.

## F2 — Admin products, pricing and promotions console

F2 is a UI-completion slice over the admin backend that already exists. A1 built the product
catalogue console (categories, products, variants, barcodes), A2 built the pricing console (price
lists, the COPY import, customer groups, promotions, the live preview) and R2 built the precedence
engine and the `promos:{org_id}` Redis cache. F2 completes that surface with the pieces the brief
names that A1/A2 left out, and adds the dedicated price-list import route — additively, changing no
core table or function (ADR-0069).

### What was built

* **Promotions console** (`src/app/admin/promotions/page.tsx`):
  * a **conditions builder** — value, variant ids, min qty, min subtotal, the four keys
    `app.apply_promotions` reads (`src/verticals/admin/promotionConditions.ts` builds the jsonb;
    only non-empty boxes are sent, so an untouched form sends `{}`);
  * a **stackable** checkbox on the form and a **stackable badge** on the row;
  * **drag-to-reorder** of priority (HTML5 drag), keeping the up/down buttons as the
    keyboard-accessible fallback — both call the reorder endpoint, which invalidates the cache;
  * a **precedence legend** (1. group price list → 2. promotion by priority → 3. manual discount);
  * a conditions summary per row.
* **`POST /api/admin/price-lists/import`** — the endpoint the brief names. It delegates to the same
  `importPriceListItems` COPY path the existing `action:'import'` branch uses, so there is one
  implementation of the import, not two. The price-list items page now calls it.
* Everything else the brief lists already existed and is covered by A1/A2 tests 96–107; F2 does not
  rewrite it.

### The F2 tests (`tests/frontend-f2.test.ts`)

| # | Test |
| --- | --- |
| 119 | A category, a product and a barcoded variant are created through the routes and found by search; another org sees none of it |
| 120 | A USD retail list is priced through the COPY import and a promotion discounts through the Redis cache, invalidated on write |
| 121 | A promotion past `valid_to` is not applied even with a fresh cache entry, and `get_price` reaches `price_list_items` by index |

The brief numbered these 43–45, but 43–45 are Phase 1 retail tests (R1 owns 41–44, R2 owns 45–48).
ADR-0010 forbids renumbering: a new run continues from the highest number actually present, which
after F1 is 118. See ADR-0069.

### Gate

```
$ npx supabase db reset
Finished supabase db reset on branch master.   (all migrations apply to an empty DB)

$ npm test
 Test Files  25 passed (25)
      Tests  182 passed (182)

$ npm run build
✓ Compiled successfully   (incl. /admin/products, /admin/categories, /admin/promotions,
                           /admin/price-lists, /admin/pricing-preview, /api/admin/price-lists/import)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)

$ npm run test:e2e
6 passed (37.4s)   (incl. the new F2 console navigation spec, and A3's console navigation)
```

### Notes

* **Additive.** No core table or function changed (ADR-0069); the tenant invariant checks still
  return zero rows. The admin tables (price_lists, price_list_items, customer_groups, promotions,
  discount_limits, manual_discounts) already carry `org_id NOT NULL`, `created_at NOT NULL`, forced
  RLS and a `(org_id, created_at DESC, id DESC)` index (the branch-scoped `manual_discounts` uses
  the `(org_id, branch_id, created_at DESC, id DESC)` variant) — from R2/A2.
* **One import implementation.** The new route and the older `action:'import'` branch both call
  `importPriceListItems`, so the COPY behaviour cannot drift between them.
* **The console and the till cannot drift.** The preview and the promotions form both resolve
  through `app.get_price`; the conditions builder only produces the keys that function reads.
* **Cache safety.** A promotion write (create, update, deactivate, reorder) invalidates
  `promos:{org_id}`; a stale cache entry cannot apply an expired promotion because the validity
  window is re-checked at evaluation time (test 121).
* **No test is mocked.** The F2 tests call the real route handlers with a real access token, against
  the real local Postgres and the real local Redis. The e2e spec drives the real UI in a browser.

## F3 — Operations, Z-report, receipt and stocktake UI

F3 is a UI-completion slice over the point-of-sale and operations surface that already exists. R3
built the keyboard-only `/pos` till, shifts, `pos_sales`/`pos_payments` and `app.post_pos_sale`; R5
built the shift/Z-report, layby, return, credit-limit and stocktake backends; H4 built the 58 mm
receipt, the shared receipt model and the scanner/shortcut state machines; A3 built the admin
operations pages. F3 completes that surface with the pieces the brief names that were left out, and
adds the dedicated Z-report page — additively, changing no core table or function (ADR-0070).

### What was built

* **Cart persistence** (`src/verticals/pos/cart.ts`): the till's Zustand cart now uses the `persist`
  middleware, so the lines, tenders, parked (held) carts and the ZWG rate survive a page reload.
  Money is serialised as its decimal string form and revived as a `Decimal` on rehydrate, so no price
  ever passes through a JS number. The transient flags (status, error, receipt) are excluded by
  `partialize`. The store is created by `createCartStore(storage?)`; the page uses the default
  binding (`localStorage` in the browser, a no-op storage on the server), and a test injects an
  in-memory storage to drive the round-trip.
* **A dedicated `/admin/z-reports` page** (`src/app/admin/z-reports/page.tsx`) with
  `src/verticals/pos/ZReport58mm.tsx` and `src/verticals/pos/zReportData.ts`. The slip is exactly
  58 mm wide (`@page { width: 58mm }`, printed through `window.print`, the same browser path the
  receipt uses). The page lists the branch's immutable Z-reports as a keyset page on
  `(created_at, id)` and shows one report's totals by method and currency, its VAT-by-rate breakdown
  and its sale/void counts. The read is `app.admin_z_report` by primary key (ADR-0064), a single
  indexed lookup regardless of how many `pos_sales` rows exist. The operations nav gains a
  "Z-report slips" link; `/admin/shifts` keeps its inline read-only Z-report and the "Shifts &
  Z-reports" label.
* **A stocktake progress bar** (`src/app/admin/stocktake/page.tsx`): `stocktakeProgress` and
  `stocktakeLineKey` (`src/verticals/admin/ops.ts`) count the share of snapshot lines the operator
  has explicitly entered — the snapshot prefills every line, so "counted" means the counter visited
  the line, not merely that a number is present. The bar resets when a count is opened or closed.
* Everything else the brief lists already exists and is covered by R3/R5/H4/A3; F3 does not rewrite
  it.

### The F3 tests (`tests/operations-f3.test.ts`)

| # | Test |
| --- | --- |
| 122 | The cart store persists lines, tenders, parked carts and the ZWG rate across a reload, and revives money as `Decimal` |
| 123 | `/api/z-reports` returns a keyset page of immutable Z-reports and `/api/admin/z-reports/:id` reads one by key; the 58 mm slip renders its totals |
| 124 | The stocktake snapshot returns every line and the console's progress arithmetic tracks the entered lines, closing to one balanced journal |
| 125 | A USD+ZWG split tender through `POST /api/pos/sales` writes two `pos_payments` rows and two CORE payments, fully paid |
| 126 | The keyboard flow: the shortcut map plus the exact-cash sale committing through the route with no change given |
| 127 | The Z-report list is branch-scoped and refuses a `limit` above 100 |

The brief numbered these 46–51, but 46–48 are R2 tests and 49–52 are H1 tests. ADR-0010 forbids
renumbering: a new run continues from the highest number actually present, which after F2 is 121.
See ADR-0070.

The F3 e2e (`e2e/operations-f3.e2e.ts`) drives the real UI: it closes a shift, walks
`/admin/z-reports`, opens the 58 mm slip and asserts its totals and width, then opens a stock count
and asserts the progress bar tracks the entered line. It is a navigation/smoke test, not one of the
numbered Vitest tests.

### Gate

```
$ npx supabase db reset
Finished supabase db reset on branch master.   (all migrations apply to an empty DB)

$ npm test
 Test Files  26 passed (26)
      Tests  188 passed (188)

$ npm run build
✓ Compiled successfully   (incl. the new /admin/z-reports page and its 58mm slip)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)

$ npm run test:e2e
7 passed (38.2s)   (incl. the new F3 Z-report / stocktake spec)
```

### Notes

* **Additive.** No core table or function changed (ADR-0070); the tenant invariant checks still
  return zero rows, and `z_reports` remains immutable.
* **The console and the till cannot drift.** The Z-report page renders exactly the immutable
  `z_reports` row the shift close wrote, and the stocktake progress uses the same snapshot the
  console imports.
* **Money never becomes a number.** The cart persists decimals as strings and revives them as
  `Decimal`; the slip builds its totals as `Decimal` from the route's fixed-scale strings.
* **No test is mocked.** The F3 tests call the real route handlers with a real access token, against
  the real local Postgres; the e2e spec drives the real UI in a browser. The cart test uses an
  in-memory `StateStorage` (a real storage implementation, not a stub of the store) because Node has
  no `localStorage`.

## F4 — Branch server UI/behaviour completion

F4 is a UI/behaviour completion slice over the branch-server surface H1 already shipped. H1 built
the branch-mode server, the local Postgres, PIN sign-in, the PWA manifest/service worker, the LAN
HTTPS script and tests 49–52. F4 completes the pieces the brief names that H1 left backend-only, and
it is additive: no core table or core function changed, no applied migration edited (ADR-0065,
ADR-0071).

### What was built

* **A 6-digit device code** (`supabase/migrations/20260101170000_frontend_f4_branch_ops.sql`,
  `app.create_device_code(org_id, branch_id, till_id, ttl_minutes)`): mints a zero-padded 6-digit
  code, stores **only its sha256 hash**, expires after 10 minutes by default, and retries on a
  `code_hash` unique violation. It reuses the existing `app.register_device` redemption, so a code is
  still single use and only the token's hash is stored (ADR-0024).
* **Two branch reads.** `app.list_device_registrations(...)` (keyset page, never returns a hash) and
  `app.list_branch_cashiers(org_id, branch_id)` (a display label for the PIN picker). The cashier
  list is **SECURITY DEFINER** because it joins `auth.users` for the label and `authenticated` cannot
  read `auth.users`; it is scoped by its own parameters, so it can only return the caller's branch.
* **The branch console pages.** `/settings/devices` mints a code (shown once) and lists the branch's
  devices; `/pos/register` redeems a code once and stores the device token in **IndexedDB**
  (`src/branch/deviceStore.ts`).
* **PIN mode on `/login`.** The page reads `GET /api/branch/config`; in branch mode it renders a
  cashier picker plus a PIN field and calls `POST /api/branch/login` (the PIN is verified locally, no
  cloud call). In cloud mode the F1 email/password form is unchanged.
* **Health keys and cadence.** `GET /api/branch/health` now also returns `branch_online`,
  `cloud_online` and `outbox_size`; `branchHealthPollMs()` fixes the poll at 5 s
  (`BRANCH_HEALTH_POLL_MS` overrides it in a test). The badge uses the brief's three colours — green
  (cloud online), yellow (LAN up, cloud offline), red (branch unreachable) — and shows the queued
  count. The decision is the pure `src/branch/badge.ts`.
* **The service worker caches the app shell.** `public/sw.js` (cache `erp-branch-v2`) precaches
  `/_next/static/*`, `/pos`, `/login` and the `/admin/*` console at install, so a reload with the
  internet cut still renders the till. `/api/*` is never cached.

### The F4 tests (`tests/frontend-f4.test.ts`)

| # | Test |
| --- | --- |
| 128 | A branch sale completes with the cloud unreachable (real Toxiproxy cuts the cloud) |
| 129 | A cashier signs in with a PIN with the internet off (no cloud call) |
| 130 | The till badge reports green/yellow/red, and the app shell is the cached one offline |
| F4-a | The device code is 6 digits, single use, expires, and only its hash is stored |
| F4-b | The cashier list returns a label and never a hash, scoped to the branch |
| F4-c | Branch health reports `branch_online`, `cloud_online` and the outbox depth |

The brief numbers these 16–18, which collide with R4's 14–18 and H1's 49–51. ADR-0010 forbids
renumbering: a new run continues from the highest number actually present, which after F3 is 127.
See ADR-0071. The browser behaviour of 18 is also driven end to end by `e2e/branch-f4.e2e.ts`
(unnumbered, the F3 style): a branch-mode dev server walks `/login` (PIN), `/settings/devices`
(mint a code), `/pos/register` (redeem it) and `/pos` (the badge shows cloud-offline while the LAN
is up).

The brief's harness is "real Postgres + Toxiproxy + Playwright". `tests/support/toxiproxy.ts` runs
the real `ghcr.io/shopify/toxiproxy` image via `docker run` (no new dependency) and cuts the link to
the cloud with a `timeout` toxic; when Docker or the image is unavailable it degrades to a
`127.0.0.1:9` refused connection, which is the same observable fact. The database is never mocked.

### Gate

```
$ npx supabase db reset
Finished supabase db reset on branch master.   (all migrations apply to an empty DB, incl. 20260101170000)

$ npm test
 Test Files  27 passed (27)
      Tests  194 passed (194)

$ npm run build
✓ Compiled successfully   (incl. the new /settings/devices and /pos/register pages)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)

$ npm run test:e2e
F4 spec: 1 passed; the existing branch/pos specs (52, 14) still pass
```

### Notes

* **Additive.** No core table or function changed (ADR-0065, ADR-0071); the tenant invariant checks
  still return zero rows.
* **The branch never trusts `navigator.onLine`.** The badge reflects the branch's own health probe of
  the cloud, which is exactly the "LAN up, internet down" case a branch must report as cloud-offline.
* **No test is mocked.** The F4 tests call the real SQL functions and TS wrappers against the real
  local Postgres; test 128 runs a real Toxiproxy; the e2e drives the real UI in a browser.
* **Redis.** The suite needs a local Redis for the R2/F2/F3 pricing-cache and rate-limit tests; the
  run started `redis:7-alpine` on 6379 so the full suite (including those pre-existing tests) is
  green. Without Redis those 12 tests fail with `ECONNREFUSED 127.0.0.1:6379` — an environment gap,
  not a code change.

## F5 — Sync engine (H2) completion

F5 is a completion slice over the sync engine H2 already shipped. H2 built the branch outbox, the
idempotent cloud ingest, the master-data pull, the retry/conflict policy, the status read and the
encrypted backup, with tests 53–63. F5 fills the named gaps H2 left, and it is additive: no core
table or core function changed, no applied migration edited (ADR-0065, ADR-0072).

### What was built

* **A non-blocking cloud dispatcher** (`supabase/migrations/20260101180000_sync_f5.sql`,
  `app.sync_push_result`): applies every event it can in its own subtransaction, records each
  rejection, and returns `highest_seq` as the highest sequence it PROCESSED (applied, duplicated or
  rejected). H2 returned early on the first rejection, so a bad event stopped the rest of the batch
  and was never acked (the branch re-pushed it forever). Now a rejection is resolved (the conflict is
  the durable record) and the outbox drains.
* **Conflicts carry both versions.** `sync_conflicts.both_versions` = `{ local, cloud }`;
  `app.sync_record_conflict` gained the 8th argument; `app.sync_requeue_conflict(org_id, conflict_id)`
  re-queues the local event under a fresh id, so "Retry failed" works without un-acking the original.
* **Two new outbox facts.** A trigger on `z_reports` emits `z_report`; a trigger on `fiscal_invoices`
  emits `fiscal_result` at `sent`/`failed`. The event-type check also carries the brief's `journal`
  and `stock_move` spellings. Both triggers are branch-only.
* **The price version a sale charged.** New branch table `pos_sale_price_versions` (immutable, RLS,
  the standard indexes), written by a deferred constraint trigger on `pos_sales`: one row per invoice
  line with the `branch_master_data` price version at sale time.
* **Backups reported and shown.** `POST /api/backup` records a run (key, byte size, ciphertext
  checksum); a trigger keeps `sync_state.last_backup_at` current; `GET /api/backup` lists runs.
* **The sync console.** `/admin/sync` reads `GET /api/branch/sync/status` (the branch's own database,
  so it answers with the cloud offline) and shows `pending_count`, the last push/pull, the last
  backup, the cloud protocol version, a protocol banner when push is blocked, and the conflicts with
  both versions plus a Retry button (`POST /api/sync/conflicts`). `app.sync_status` gained
  `pending_count` and `last_backup_at` while keeping every H2 key.
* **Master-data vocabulary.** The `master_data_changes` and `branch_master_data` entity-type checks
  now also accept `customer` and `user` (no trigger records them here, so no `change_seq` moves).

### The F5 tests (`tests/sync-f5.test.ts`)

| # | Test |
| --- | --- |
| 131 | A rejected event does not block the rest of the batch, and the outbox still drains |
| 132 | A conflict records both versions, and retry re-queues the local event for another push |
| 133 | Closing a shift emits a `z_report` event and an FDMS outcome emits a `fiscal_result` event |
| 134 | A sale line keeps the price version it charged, so a later pull cannot rewrite it |
| 135 | `POST /api/backup` records the run and updates the branch last-backup time |

The brief's own test numbers collide with the tenancy tests (1–14). ADR-0010 forbids renumbering: a
new run continues from the highest number actually present, which after F4 is 130. See ADR-0072. The
console behaviour is also driven end to end by `e2e/sync-f5.e2e.ts` (unnumbered, the F4 style): a
branch-mode dev server seeds a conflict, signs in with a PIN and walks `/admin/sync`.

### Gate

```
$ npx supabase db reset
Finished supabase db reset on branch master.   (all migrations apply to an empty DB, incl. 20260101180000)

$ npm test
 Test Files  28 passed (28)
      Tests  199 passed (199)

$ npm run build
✓ Compiled successfully   (incl. the new /admin/sync page and /api/backup route)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)

$ npx playwright test e2e/sync-f5.e2e.ts
1 passed
```

### Notes

* **Additive.** No core table or function changed (ADR-0065, ADR-0072); the tenant invariant checks
  still return zero rows.
* **No test is mocked.** The F5 tests call the real SQL functions and TS wrappers against the real
  local Postgres; the branch side runs through a pool carrying `app.branch_mode=branch` so the real
  outbox triggers fire; the e2e drives the real UI in a browser.
* **Redis.** The full suite still needs a local Redis for the R2/F2/F3 tests; the run used
  `redis:7-alpine` on 6379.

## F6 — Fiscal and numbering (H3) completion

F6 is a completion slice over the fiscal-and-numbering engine H3 already shipped. H3 built the branch
FDMS queue, the worker loop, the `FdmsClient` interface with a mock and an HTTP client, cloud-issued
number blocks, the receipt's fiscal block and the `/settings/fiscal` page, with tests 64–68 — which
already map onto this brief's gate items 1, 2, 8, 24 and 25 (queue table, worker loop,
retry/backoff, number blocks, offline behaviour). F6 fills the named gaps H3 left, and it is
additive: no core table or core function changed, no applied migration edited (ADR-0065, ADR-0073).

### What was built

* **The queue row carries its invoice number** (`supabase/migrations/20260101190000_fiscal_f6.sql`):
  `fiscal_invoices.invoice_number` (backfilled from `invoices`), written by
  `app.fiscal_invoice_enqueue` (re-created) in the sale's own transaction.
* **The brief's named queue index** `fiscal_invoices_org_branch_status_created_idx` on
  `(org_id, branch_id, status, created_at DESC)`. H3's partial pending index stays.
* **The brief's number-block vocabulary.** `public.invoice_number_blocks` is a read-only VIEW over
  `number_blocks` with `start_number`, `end_number`, `current_number` and `status`
  (`active`/`exhausted`), created `WITH (security_invoker = true)` so `number_blocks`' tenant RLS
  still applies. `number_blocks` stays the only writer — no second table for the same counter.
* **The brief's endpoints.** `GET /api/blocks/next` (branch top-up under the brief's name, tops up at
  the low-water mark) and `POST /api/fiscal/retry` (retry a failed fiscal invoice by body id).
* **The brief's vocabulary.** `FDMSClient`, `MockFDMS` and `RealFDMS` exported as aliases of H3's
  `FdmsClient`, `MockFdmsClient` and `httpFdmsClient`; the mock gained a `delayMs` knob.
* **Worker batch 10 and a 20% low-water mark.** `FISCAL_WORKER_BATCH = 10`; `lowWaterForBlock`
  returns 20% of the active block's size and `ensureNextBlock` compares the ACTIVE block's own
  remaining count against it (a block fetched ahead does not mask the current one running low).
* **The brief's exact exhaustion message.** `app.claim_invoice_number` raises "Invoice numbers
  exhausted - connect to cloud to get new block" (still containing H3's "block exhausted" phrase, so
  H3's test 67 regex keeps matching).
* **A QR preview** on `/settings/fiscal`, rendered from the receipt's own `qrMatrix`.
* **A latent H3 bug fixed.** `cloudBlockFetcher` parsed the cloud claim response as snake_case while
  the claim route serializes it as camelCase, so a branch fetching its first block over HTTP stored
  `undefined` bounds (H3's test 67 used an in-process fetcher). The fetcher now accepts either
  spelling; F6's `GET /api/blocks/next` exposed it over the real HTTP path.

### The F6 tests (`tests/fiscal-f6.test.ts`)

The brief's own numbers (1–25) collide with the tenancy and accounting tests. ADR-0010 forbids
renumbering: a new run continues from the highest number actually present, which after F5 is 135. See
ADR-0073.

| Canonical | Test |
| --- | --- |
| 136 | A sale inserts a pending fiscal row with its invoice number, and the named queue index exists |
| 137 | A real FDMS rejection retries with backoff, and 5 rejections move the row to failed |
| 138 | With FDMS down 10 sales queue 10 fiscal invoices; when it returns all 10 submit exactly once |
| 139 | `GET /api/blocks/next` tops up before the current block runs out; offline exhaustion fails clearly and reuses no number |
| 140 | Two fiscal workers running at once never submit the same invoice twice (SKIP LOCKED) |

### Gate

```
$ npx supabase db reset
Finished supabase db reset on branch f5-sync-engine-completion.   (all migrations apply to an empty DB, incl. 20260101190000)

$ npm test
 Test Files  29 passed (29)
      Tests  204 passed (204)

$ npm run build
✓ Compiled successfully   (incl. the new /api/blocks/next and /api/fiscal/retry routes and the /settings/fiscal QR preview)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* **Additive.** No core table or function changed (ADR-0065, ADR-0073); the tenant invariant checks
  still return zero rows. The `invoice_number_blocks` view is not a table, so
  `scripts/check-tenant-tables.sql` (which filters `relkind in ('r','p')`) correctly ignores it.
* **No test is mocked.** The F6 tests call the real SQL functions and TS wrappers against the real
  local Postgres; the branch side runs through a pool carrying `app.branch_mode=branch`; test 139
  drives `GET /api/blocks/next` through a real HTTP call to a small fake cloud that delegates to the
  real claim route. The FDMS device is the in-memory mock — a real object with real state.
* **Redis.** The full suite still needs a local Redis for the R2/F2/F3 tests; the run used
  `redis:7-alpine` on 6379.

## F7 — Hardware and receipts (H4) completion

F7 is a completion slice over the hardware-and-receipts surface H4 already shipped. H4 built the
ESC/POS generator, the 58mm receipt, the printer settings page, the branch relay and the
camera/scanner helpers, with tests 69–74 (plus the unnumbered `hardware-h4-printer`,
`hardware-h4-units` and `hardware-h4-api` suites). F7 fills the named gaps H4 left, and it is
additive: no core table or core function changed, no applied migration edited (ADR-0065, ADR-0074).

### What was built

* **`useScannerInput`** (`src/verticals/pos/useScannerInput.ts`): a hook that owns the document
  keydown listener and drives a DOM-free `createScannerController()` (the same `ScannerBuffer`
  state machine). `/pos/page.tsx` now calls the hook instead of holding the buffer and the listener
  inline; behaviour is unchanged.
* **`CameraScanner`** (`src/verticals/pos/CameraScanner.tsx`): renders the preview and starts
  `startCameraScan()` only when `cameraSupported()` is true, and otherwise shows
  `CAMERA_HTTPS_MESSAGE` — "Camera scan requires HTTPS". It imports no camera library at module
  load, so a build without `@zxing/library` is unaffected.
* **The branch camera toggle** (`supabase/migrations/20260101200000_hardware_f7.sql`): a new
  branch-scoped table `public.pos_device_settings` (`camera_enabled`, one row per branch) with
  `app.get/set_pos_device_settings`, registered in `scripts/check-tenant-tables.sql` and
  `tests/support/tenant-tables.ts`. A new `/api/pos/device` route reads and writes it;
  `/pos/settings` gains the checkbox (with the HTTPS note where the page is not secure); the till
  reads the flag and renders `CameraScanner` only when it is on. The flag lives in its own table
  rather than in `printer_settings`: that table is about printing, and a camera is not a printer.
* **IndexedDB holds** (`src/verticals/pos/idbStorage.ts`): `createIndexedDbStorage(dbName,
  storeName)` (a real IndexedDB-backed `StateStorage`) and `memoryStorage()` (the server-side and
  injected-test fallback). The cart store's default storage is now IndexedDB, so parked carts
  survive a reload; the injected-storage test path is preserved. This is a cache the till rebuilds
  from the server, never a ledger.
* **`POST /api/printer/relay`** (`src/app/api/printer/relay/route.ts`): the brief's name for the
  branch LAN relay. H4's `/api/branch/print` now delegates to it, and the network transport points
  at the brief's path, so nothing that already printed breaks.
* **The 58mm print rule** was already present on `/pos` (`@page { width: 58mm; margin: 0 }`), so it
  needed no change.

### The F7 tests (`tests/hardware-f7.test.ts`)

ADR-0010 forbids renumbering: a new run continues from the highest number actually present, which
after F6 is 140. See ADR-0074.

| Canonical | Test |
| --- | --- |
| 141 | The scanner controller buffers a fast burst as one barcode and a slow burst as typing |
| 142 | The IndexedDB storage round-trips a persisted cart, reviving money as Decimal |
| 143 | The `CameraScanner` renders the HTTPS note where a camera cannot work; the default is off |
| 144 | The camera toggle persists through `app.get/set_pos_device_settings` and is org-scoped under RLS |
| 145 | `POST /api/printer/relay` writes ESC/POS bytes to the LAN printer; the H4 path delegates |

The e2e `e2e/hardware-f7.e2e.ts` is an unnumbered Playwright navigation test (exactly as H4's is):
a one-item cash sale is scan → F9 → Enter, read at the document level, with the camera absent on an
insecure origin. It needs Playwright browsers, which are not installed in this run's environment, so
it was written to the H4 pattern but not executed here.

### Gate

```
$ node_modules/.bin/supabase db reset
Applying migration 20260101200000_hardware_f7.sql...
Finished supabase db reset on branch f5-sync-engine-completion.   (all migrations apply to an empty DB)

$ npm test
 Test Files  30 passed (30)
      Tests  209 passed (209)

$ npm run build
✓ Compiled successfully   (incl. the new /api/printer/relay and /api/pos/device routes)

$ npm run lint
✔ No ESLint warnings or errors

$ scripts/check-fk-indexes.sql
(0 rows)

$ scripts/check-tenant-tables.sql
(0 rows)
```

### Notes

* **Additive.** No core table or function changed (ADR-0065, ADR-0074); the tenant invariant checks
  still return zero rows. `pos_device_settings` is registered as a branch-scoped tenant table and
  carries `org_id`, `created_at`, RLS enabled and forced, the `(org_id, branch_id, created_at DESC,
  id DESC)` index, and an index on its foreign key.
* **No test is mocked.** The F7 tests call the real SQL functions and TS wrappers against the real
  local Postgres. Test 145 drives the relay against a real TCP server standing in for the printer
  (branch mode), and test 142 uses a real IndexedDB (`fake-indexeddb`); test 143 renders the
  component with `react-dom/server` (there is no jsdom in this repo).
* **Flake observed.** One full-suite run failed `retail-r2` test 8, a planner index-choice assertion
  in a file F7 never touches; it passed on the pristine base and on two subsequent full runs (the
  planner's choice depends on table statistics, which other test files perturb). No test was
  weakened.
