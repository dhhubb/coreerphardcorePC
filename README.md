# ERP Core — Phase 1 (Backend)

The multi-tenant core that the Retail, Pharmacy, Hardware and School verticals will sit on. This
repository contains the backend only.

- Next.js 14 (App Router), TypeScript in strict mode
- Supabase (Postgres and Auth) with plain SQL migrations
- Vitest, running against a real local Postgres
- `pg` (node-postgres) for data access
- Money is `NUMERIC(19,4)` in Postgres and a `decimal.js` decimal in TypeScript

Prisma is deliberately not used. The schema lives in plain SQL migrations under
`supabase/migrations/`, because triggers, partitions, RLS and functions do not map onto Prisma
migrations, and Prisma usually connects as a role that bypasses RLS.

## Contents

- [Getting started](#getting-started)
- [Data model](#data-model)
- [Tenancy and RLS](#tenancy-and-rls)
- [Indexing strategy](#indexing-strategy)
- [Partitioning](#partitioning)
- [Accounting engine](#accounting-engine)
- [Inventory](#inventory)
- [Sales and purchases](#sales-and-purchases)
- [Retail extension (R1)](#retail-extension-r1)
- [Retail extension (R2)](#retail-extension-r2)
- [Retail extension (R3)](#retail-extension-r3)
- [Retail extension (R4)](#retail-extension-r4)
- [Retail extension (R5)](#retail-extension-r5)
- [Retail extension (R6)](#retail-extension-r6)
- [Branch server (H1)](#branch-server-h1)
- [Offline sync engine (H2)](#offline-sync-engine-h2)
- [The frontend shell and sign-in (F1)](#the-frontend-shell-and-sign-in-f1)
- [The admin products / pricing / promotions console (F2)](#the-admin-products--pricing--promotions-console-f2)
- [Adding a vertical module](#adding-a-vertical-module)
- [Tests, checks and the perf run](#tests-checks-and-the-perf-run)

## Getting started

Docker must be running.

```bash
supabase start        # local Postgres and Auth
supabase db reset     # apply every migration to an empty database
cp .env.example .env.local   # if you do not have one yet
npm install
npm test              # the 40 tests, against the real local database
npm run build
```

`supabase status` prints the connection URLs. `DATABASE_URL` and `TEST_DATABASE_URL` both point at
the local database; no hosted Supabase project, Upstash or Redis is needed in this phase.

Business logic lives in SQL functions under the `app` schema. TypeScript route handlers in
`src/app/api/**` stay thin: they parse the request, call one function inside a user-scoped
transaction, and serialise the result. The domain modules in `src/core` and `src/accounting` are
typed wrappers over those functions.

## Data model

```mermaid
erDiagram
    organizations ||--o{ branches : has
    organizations ||--o{ memberships : has
    organizations ||--o{ invites : has
    organizations ||--|| settings : has
    organizations ||--o{ number_series : has
    organizations ||--o{ chart_of_accounts : has
    organizations ||--o{ fiscal_periods : has
    organizations ||--o{ tax_rates : has
    organizations ||--o{ exchange_rates : has
    organizations ||--o{ products : has
    organizations ||--o{ product_variants : has
    organizations ||--o{ contacts : has

    branches ||--o{ warehouses : has
    branches ||--o{ journals : has
    branches ||--o{ stock_ledger : has
    branches ||--o{ sales_orders : has
    branches ||--o{ invoices : has
    branches ||--o{ payments : has
    branches ||--o{ credit_notes : has
    branches ||--o{ purchase_orders : has
    branches ||--o{ stock_transfers : has
    branches ||--o{ audit_logs : has

    products ||--o{ product_variants : has
    warehouses ||--o{ stock_ledger : holds
    warehouses ||--o{ stock_balances : caches
    products ||--o{ stock_ledger : moves
    products ||--o{ stock_balances : caches

    stock_ledger ||--o{ stock_consumptions : consumed_by
    stock_ledger ||--|| stock_layer_balances : remaining
    warehouses ||--o{ stock_layer_balances : holds

    journals ||--|{ journal_lines : contains
    chart_of_accounts ||--o{ journal_lines : posts_to
    journals ||--o| journals : reverses

    invoices ||--|{ invoice_lines : contains
    invoices ||--o{ payments : settled_by
    invoices ||--o{ credit_notes : credited_by
    invoices ||--o{ manual_discounts : discounted_by
    contacts ||--o{ invoices : billed_to
    contacts ||--o{ purchase_orders : ordered_from
    contacts }o--o| customer_groups : belongs_to
    journals ||--o| invoices : posts_for

    organizations ||--o{ price_lists : has
    price_lists ||--o{ price_list_items : lists
    product_variants ||--o{ price_list_items : priced_by
    organizations ||--o{ customer_groups : has
    customer_groups }o--o| price_lists : prices_at
    organizations ||--o{ promotions : has
    organizations ||--o{ discount_limits : caps

    organizations ||--o{ credit_limits : caps
    contacts ||--o| credit_limits : limited_by
    branches ||--o{ laybys : has
    contacts ||--o{ laybys : places
    laybys ||--|{ layby_reservations : reserves
    laybys ||--o| invoices : collected_as
    branches ||--o{ returns : has
    invoices ||--o{ returns : returned_from
    returns ||--|{ return_lines : contains
    return_lines }o--|| invoice_lines : returns
    branches ||--o{ z_reports : summarises
    shifts ||--o| z_reports : closed_as
    branches ||--o{ stock_counts : has
    stock_counts ||--|{ stock_count_items : counts

    organizations {
        uuid id PK
        uuid org_id
        text name
        text slug
        text base_currency
        timestamptz created_at
    }
    branches {
        uuid id PK
        uuid org_id FK
        text name
        text slug
        timestamptz created_at
    }
    memberships {
        uuid id PK
        uuid org_id FK
        uuid user_id FK
        text role
        uuid[] branch_ids
        timestamptz created_at
    }
    journals {
        uuid id PK
        timestamptz created_at PK
        uuid org_id FK
        uuid branch_id FK
        date posting_date
        text source_type
        uuid reversal_of FK
    }
    journal_lines {
        uuid id PK
        timestamptz created_at PK
        uuid journal_id FK
        timestamptz journal_created_at FK
        uuid account_id FK
        numeric debit
        numeric credit
        numeric exchange_rate
        numeric base_debit
        numeric base_credit
    }
    stock_ledger {
        uuid id PK
        timestamptz created_at PK
        uuid warehouse_id FK
        uuid product_id FK
        text direction
        numeric qty
        numeric unit_cost
    }
    stock_consumptions {
        uuid id PK
        timestamptz created_at PK
        uuid out_ledger_id FK
        uuid in_ledger_id FK
        numeric qty
    }
    invoices {
        uuid id PK
        uuid branch_id FK
        text invoice_no
        numeric total
        uuid journal_id FK
    }
    audit_logs {
        uuid id PK
        timestamptz created_at PK
        text table_name
        uuid record_id
        text action
    }
    laybys {
        uuid id PK
        uuid org_id FK
        uuid branch_id FK
        uuid contact_id FK
        text layby_no
        text status
        date due_date
        numeric total
        numeric deposit_paid
        numeric cancellation_fee
    }
    layby_reservations {
        uuid id PK
        uuid org_id FK
        uuid branch_id FK
        uuid layby_id FK
        uuid product_id FK
        numeric qty
        numeric unit_cost
        text status
    }
    returns {
        uuid id PK
        uuid org_id FK
        uuid branch_id FK
        uuid original_invoice_id FK
        text return_no
        text refund_method
        numeric total
    }
    z_reports {
        uuid id PK
        uuid org_id FK
        uuid branch_id FK
        uuid shift_id FK
        text z_no
        numeric gross_sales
        numeric tax_total
        jsonb vat_by_rate
    }
    stock_counts {
        uuid id PK
        timestamptz created_at PK
        uuid org_id FK
        uuid branch_id FK
        uuid warehouse_id FK
        text count_no
        text status
    }
    fiscal_device_integration {
        uuid id PK
        uuid org_id FK
        uuid branch_id FK
        text device_type
        text mode
        text status
        timestamptz last_sync
        jsonb payload
        timestamptz created_at
    }
    fiscal_jobs {
        uuid id PK
        uuid org_id FK
        uuid branch_id FK
        uuid sale_id FK
        uuid invoice_id FK
        text status
        jsonb payload
        timestamptz created_at
    }
    fiscal_job_attempts {
        uuid id PK
        uuid org_id FK
        uuid branch_id FK
        uuid job_id FK
        int attempt_no
        text outcome
        text error
        timestamptz attempted_at
        timestamptz created_at
    }
    branches ||--o| fiscal_device_integration : configures
    branches ||--o{ fiscal_jobs : queues
    fiscal_jobs ||--o{ fiscal_job_attempts : attempts
```

## Tenancy and RLS

Every tenant table has `org_id uuid NOT NULL` and `created_at timestamptz NOT NULL DEFAULT now()`.

- Org-scoped tables: `organizations` (its `id` is the `org_id`), `branches`, `memberships`,
  `invites`, `settings`, `number_series`, `products`, `product_variants`, `contacts`,
  `chart_of_accounts`, `tax_rates`, `exchange_rates`, `fiscal_periods`.
- Branch-scoped tables, which also carry `branch_id`: `warehouses`, `stock_ledger`,
  `stock_consumptions`, `stock_balances`, `stock_layer_balances`, `stock_transfers`, `journals`,
  `journal_lines`, `sales_orders`, `invoices`, `invoice_lines`, `payments`, `credit_notes`,
  `purchase_orders`, `audit_logs`.

RLS is enabled and forced on every tenant table. Policies read the JWT through `auth.jwt()`:

- Org-scoped policies compare `org_id` with `auth.jwt() ->> 'org_id'` (the key must be quoted).
- Branch-scoped policies also check `branch_id` against `auth.jwt() -> 'branch_ids'`.

A Supabase custom access token hook (`app.custom_access_token_hook`) adds `org_id` and
`branch_ids` to the token when it is minted.

> **Membership changes take effect when the token refreshes.** Policies read the claims baked into
> the current access token, never the `memberships` table. Adding or removing a membership does not
> change what an already-issued token can see. The user must refresh the token (sign in again, or
> wait for the refresh) before the change applies. Test 6 asserts exactly this.

Invites store only a SHA-256 hash of the token. A token is single use and expires after 72 hours.
The plaintext token is returned once, to the caller that created the invite, and never stored.

Application request paths run as the caller. `withUserContext` opens a transaction, runs
`SET LOCAL ROLE authenticated`, and sets `request.jwt.claims`, so RLS is genuinely enforced. The
service role key is never used on a request path.

Tests act as a user the same way: inside a transaction they set the role and the claims. No test
runs as the `postgres` superuser for an RLS assertion.

## Indexing strategy

- Branch-scoped high-volume tables get `(org_id, branch_id, created_at DESC, id DESC)`. That index
  serves both the RLS predicate and keyset pagination on `(created_at, id)`.
- Org-scoped tables get `(org_id, created_at DESC, id DESC)`.
- Business keys get composite uniques: `UNIQUE(org_id, slug)` on `branches`, `UNIQUE(org_id, sku)`
  on `products`, `UNIQUE(org_id, code)` on `chart_of_accounts`, and so on.
- Every foreign key column gets an index.

Two scripts prove the invariants hold:

```bash
psql "$DATABASE_URL" -f scripts/check-fk-indexes.sql      # zero rows
psql "$DATABASE_URL" -f scripts/check-tenant-tables.sql   # zero rows
```

`check-fk-indexes.sql` returns one row per foreign key with no index whose leading columns match
the FK columns in order. `check-tenant-tables.sql` returns one row per tenant table missing
`org_id`, `created_at`, or RLS enabled and forced.

## Partitioning

`journals`, `journal_lines`, `stock_ledger`, `stock_consumptions` and `audit_logs` are
RANGE-partitioned monthly on `created_at`.

- Primary keys include `created_at`, for example `(id, created_at)`.
- Child rows carry the parent's partition key (`journal_created_at`, `out_ledger_created_at`,
  `in_ledger_created_at`) so the composite foreign key works.
- Migrations create partitions for the current month and the next two.
- There are no default partitions.

`app.ensure_partitions(months_ahead)` creates any missing partition for the current month plus
`months_ahead` months. Run it ahead of time, for example from a scheduled job:

```sql
select app.ensure_partitions(2);
```

It is safe to run repeatedly: it only creates partitions that do not exist yet.

## Accounting engine

Tables: `chart_of_accounts`, `fiscal_periods`, `tax_rates`, `exchange_rates`, `journals`,
`journal_lines`.

Each journal line stores `debit`, `credit`, `currency`, `exchange_rate`, `base_debit` and
`base_credit`. A line has either a debit or a credit, never both, and never a negative value.

- **Balance check.** A `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `journal_lines`
  verifies at commit that each journal has at least two lines and that `sum(base_debit)` equals
  `sum(base_credit)`. See `docs/ADR.md` (ADR-0001) for why the trigger sits on the partitioned
  parent.
- **Rounding.** Base amounts are rounded to four decimal places per line. Any residual difference
  posts to the rounding account named in `settings`, never dropped silently.
- **Immutability.** Triggers reject `UPDATE` and `DELETE` on `journals`, `journal_lines`,
  `stock_ledger`, `stock_consumptions` and `audit_logs`, and the privileges are revoked from
  `authenticated`. A correction is a reversing journal whose `reversal_of` points at the original.
- **Closed periods.** A journal dated inside a closed `fiscal_periods` row is rejected.
- **Rates.** Exchange rates and VAT rates are effective-dated. Each journal line and each invoice
  line stores the rate it used, so a later rate change never rewrites history. Posting reads rates
  from the database inside its own transaction.
- **Reports.** Trial balance, P&L and balance sheet query `journal_lines` directly with indexed
  date-range predicates. There are no materialized views or summary tables in this phase.

`app.post_journal` is the single posting entry point, and `app.reverse_journal` posts the mirror
image of an existing journal.

## Inventory

Tables: `products`, `product_variants`, `warehouses`, `stock_ledger` (append-only movements),
`stock_consumptions` (which inbound layer each outbound movement consumed, and how much),
`stock_balances` (a mutable cache of on-hand quantity and value) and `stock_layer_balances` (a
mutable cache of remaining quantity per inbound layer).

- **FIFO.** `app.consume_fifo` consumes the oldest layer first and records every consumption as a
  new `stock_consumptions` row. A layer row is only ever decremented, never rewritten.
- **Lock order.** `app.lock_stock_balances` locks `stock_balances` rows one key at a time in
  ascending `(warehouse_id, product_id, variant_id)` order, which is what keeps concurrent
  transactions from deadlocking.
- **Negative stock** is rejected by default. `warehouses.allow_negative_stock` opts a warehouse in.
- `stock_balances` and `stock_layer_balances` are the only mutable caches, and both can be rebuilt
  from the immutable `stock_ledger`.

## Sales and purchases

- `app.post_receipt` — inbound stock layer plus journal (Dr Inventory, Cr Accounts Payable).
- `app.create_invoice` — takes a gapless number, locks stock in sorted order, checks availability,
  consumes FIFO layers, inserts the invoice and its lines, and posts the journal (Dr AR, Cr Revenue,
  Cr VAT Output, Dr COGS, Cr Inventory). All or nothing.
- `app.allocate_payment` — applies a payment to an invoice. It cannot exceed the open balance, and
  posts Dr Bank, Cr AR.
- `app.create_credit_note` — reverses revenue, VAT and AR, returns stock at the original FIFO cost,
  and posts a reversing journal.
- `app.post_stock_adjustment` — as described under [Inventory](#inventory).

Invoice numbers are gapless. They come from a `number_series` row locked with `SELECT ... FOR
UPDATE` inside the invoice transaction, so a rollback does not consume a number. SKUs also come
from `number_series`, generated in SQL. Postgres sequences are not used for either.

List endpoints use keyset pagination on `(created_at, id)`. The default limit is 50 and the maximum
is 100; anything else is rejected. `OFFSET` is never used. Queries use explicit column lists, never
`SELECT *`, and batch child rows with `= ANY($1)`, so there are no N+1 queries.

A generic trigger writes `audit_logs` for `invoices`, `payments`, `journals`, `products` and
`stock_ledger` (receipts and adjustments). Nothing on a request path reads it.

## Retail extension (R1)

R1 is the first additive extension of the core. It adds the product, barcode and search surface a
till needs, without touching a core accounting path. See `docs/ADR.md` (ADR-0008, ADR-0009) and
`docs/CORE_INTERFACE.md`.

- **New tables.** `categories` (nested through `parent_id`, org-scoped) and `product_batches`
  (batch master: `batch_no`, `expiry_date`). Both use the standard RLS, index and check rules.
- **New columns.** `products` gains `category_id`, `unit` (the `product_unit` enum), `is_weighable`
  and a generated `name_search tsvector`. `product_variants` gains `size`, `color` and `barcode`.
  Every column is nullable or defaulted, so existing rows and core code are unaffected.
- **Barcodes** live on the variant and are unique within an org only when present, enforced by a
  partial unique index `product_variants (org_id, barcode) where barcode is not null`.
- **Weighable items** accept a decimal quantity (for example `0.750` kg); everything else accepts
  whole units only. `src/verticals/retail/quantity.ts` normalises a till quantity to `NUMERIC(19,4)`
  and rejects anything else.
- **Search.** `app.search_products(org_id, query, limit)` matches an exact barcode first, then a
  trigram name match, ordered by relevance and capped at 20 rows. It is backed by a single combined
  GIN index `products (org_id extensions.uuid_ops, name extensions.gin_trgm_ops)`, so the org
  predicate and the trigram predicate use one index. An empty query returns nothing: the till never
  loads the catalogue at startup.
- **Endpoint.** `GET /api/pos/search?q=` is a thin handler over `src/verticals/retail/products.ts`.
- **Client.** `src/verticals/retail/TillSearch.tsx` debounces input by 150 ms, so one request goes
  out after the cashier stops typing, and fetches nothing on mount.

To keep the name search an index scan, the SQL function is inlined: it carries no `set search_path`
clause (that clause blocks inlining) and its body is a parenthesised `UNION ALL` rather than a CTE
(a CTE is materialised, which hides the constant term from the planner). Every object is
schema-qualified, so inlining is safe.

## Retail extension (R2)

R2 adds pricing and promotions. It is additive: the only core-table change is a nullable
`contacts.group_id`, recorded in ADR-0011. See ADR-0011 to ADR-0013 and `docs/CORE_INTERFACE.md`.

- **Price lists.** `price_lists` (one `retail`, one `wholesale` per org) and `price_list_items`
  (unique per list and variant). A `customer_groups` row may point at a wholesale list.
- **Promotions.** `promotions` carries `type` (`bogo`, `percent`, `fixed`), a `valid_from` /
  `valid_to` window, a `priority`, a `stackable` flag and a `conditions` object
  (`variant_ids`, `min_qty`, `min_subtotal`, `value`).
- **Manual discounts.** `discount_limits` caps a discount per role (a role with no row has a limit
  of zero, so a manual discount is opt-in). `manual_discounts` records every discount with its
  reason.
- **Precedence**, enforced in one place (`app.get_price` / `app.get_prices`):
  1. the customer group's price list, falling back to the retail list per item;
  2. active promotions by priority, stacking only when both the primary and the follower are
     stackable;
  3. a manual discount for a role that is allowed one, with a reason.
- **Endpoints.** `POST /api/pos/price` resolves a whole cart in one round trip over
  `src/verticals/retail/pricing.ts`. A 30-item cart costs one batched query (plus one candidates
  read on a cold cache), never one query per item.
- **Redis.** Promotion *candidates* are cached under `promos:{org_id}` with a 300-second TTL, never
  a resolved price. Every evaluation re-checks the validity window in SQL, so a stale entry cannot
  apply an expired promotion; the cache is rebuildable and losing it costs one read. A write to
  `promotions` invalidates the key.

## Retail extension (R3)

R3 adds the online POS till. It is additive: it adds `shifts`, `pos_sales`, `pos_payments` and the
small `pos_sale_keys` claim table, and it adds no column to a core table. See ADR-0014.

- **A sale is a core invoice plus core payments, in one transaction.** `app.post_pos_sale` resolves
  each scan to a variant (by barcode or id), prices it through the R2 pricing functions when no
  price is given, calls `app.create_invoice` (gapless number, sorted stock locks, FIFO consumption,
  balanced journal), then calls `app.allocate_payment` once per tender, then writes `pos_sales` and
  `pos_payments`. The core balance check runs at commit. There is no async posting.
- **Tenders.** `pos_payments` holds one row per tender. A sale may take USD and ZWG together; each
  tender gets its own `pos_payments` row, its own core payment (Dr Bank, Cr AR), and the rate it
  used. Change is recorded in the currency that was given.
- **Idempotency.** `client_sale_id` makes a retried sale safe. The claim lives on the
  non-partitioned `pos_sale_keys` table with `unique (org_id, client_sale_id)`, because Postgres
  requires every unique constraint on a partitioned table to include the partition key (ADR-0014).
  A retry returns the original receipt and consumes no invoice number.
- **Shifts.** `shifts` is org and branch scoped, keyed by `till_id`, with `opened_at`, `closed_at`
  and `opening_float`. The index `(org_id, branch_id, till_id, opened_at desc)` finds the open
  shift for a till.
- **The till is keyboard only** at `/pos`. A scan is one action (barcode + Enter), F9 tenders exact
  cash, Enter confirms and prints. A one-item exact cash sale is three actions. The key script is in
  `docs/pos-keys.md`.
- **The cart is Zustand state**, never a server round trip, so scanning stays instant. Money is a
  decimal string end to end.
- **The receipt is 58mm, rendered in the browser** (`@page { width: 58mm }`), with no server call.
  It shows the lines, the VAT breakdown by rate, the tenders with change, and the core invoice
  number.
- **Endpoints.** `POST /api/pos/sales` rings a sale, `GET /api/pos/sales` lists a shift's sales with
  keyset pagination, `GET /api/pos/shifts` returns the till's context (open shift, default
  warehouse, VAT rate), `POST /api/pos/shifts` opens a shift. All thin, all through `src/verticals/pos`.

## Retail extension (R4)

R4 makes the till work offline. It is additive: it adds `pos_sync_exceptions` and re-creates two
core functions with a hook. See ADR-0015, ADR-0016, ADR-0017 and ADR-0018.

- **The outbox is IndexedDB** (`src/verticals/pos/outbox.ts`). A sale that cannot reach the server
  is written to the store before anything else, so it survives a reload or a crash. Each entry
  carries the `client_sale_id` generated at sale time, the `shift_id`, the till's local timestamp,
  the lines with the prices actually charged, the promotions that applied, and the tenders.
- **Sync delivers in batches.** `POST /api/pos/sync` accepts up to 50 sales and runs each in its own
  transaction on its own connection, under the caller's RLS context, so one bad sale cannot block
  the rest. The till's drain loop keeps one request in flight and removes an entry only when the
  server reports `committed` or `duplicate`. Retries use exponential backoff with full jitter.
- **Idempotency is the whole safety net.** The `client_sale_id` is the key on both paths. A duplicate
  returns the original receipt and posts nothing, which is what makes the retries safe.
- **A completed sale is never rejected.** A short-stock sale is retried once with the
  transaction-local allow-negative hook (`app.negative_stock_allowed()`, ADR-0015) and logged as
  `negative_stock`. A moved price or an expired promotion is honoured and logged as
  `price_variance` / `promotion_expired`. Only a malformed sale is reported as `exception`. Every
  exception is a row in `pos_sync_exceptions`.
- **The hook is transaction-local.** `set_config('app.allow_negative_stock', 'on', true)` is set
  only for the retry attempt, so it cannot leak to another request on a pooled connection, and the
  live sale path keeps the strict rule.
- **Live sales are rate limited, the backlog is not.** `POST /api/pos/sales` allows 30 sales per
  minute per cashier and returns `429` with `Retry-After` past that. `POST /api/pos/sync` is exempt,
  so a backlog of completed sales is never throttled away. Counters live in Redis, prefixed by
  `org_id`, and the ledger is unaware of them (ADR-0018).
- **Endpoints.** `POST /api/pos/sync` delivers a backlog; `POST /api/pos/sales` gains the limiter.
  The `/pos` page shows `Pending n` and drains the outbox on load, on reconnect and every 15s.

## Retail extension (R5)

R5 adds the back-office operations the till needs. It is additive: new tables, new functions, and
three additive changes to core tables. See ADR-0019, ADR-0020 and ADR-0021.

- **Laybys** (`laybys`, `layby_reservations`). A layby reserves goods by consuming the FIFO layers
  at creation, so they leave the available pool immediately; the reserved cost is kept on
  `layby_reservations`. The deposit posts through the balanced-journal hook as Dr Bank, Cr Customer
  Deposits — no revenue is recognised until collection. Collection writes the invoice for the
  reserved goods at the reserved cost and clears the deposit against AR. Cancellation returns the
  stock as a new inbound layer and posts Dr Customer Deposits, Cr Bank (refund), Cr Fee Income (the
  cancellation fee, from `settings.layby_cancellation_fee` or an override). Index
  `(org_id, branch_id, status, due_date)`.
- **Returns** (`returns`, `return_lines`). `app.create_return` locks the original invoice lines in
  order, refuses a return beyond the unreturned quantity, calls the core credit note for stock and
  revenue, and posts the refund through the balanced-journal hook (Cr Bank or Cr Store Credit, per
  `settings.return_refund_method`).
- **Credit limits** (`credit_limits`). `app.check_credit` locks the contact row `FOR UPDATE` and
  refuses a sale that would push the open balance past the ceiling. Concurrent checks serialise on
  that lock, so 20 simultaneous sales against one ceiling cannot each read the same headroom.
- **Z-reports** (`z_reports`, immutable). `app.close_shift` writes exactly one Z-report per closed
  shift — sale and void counts, gross sales, VAT, tenders by method and currency, VAT by rate. It is
  the only thing a daily summary reads; there is no materialized view and no running total on each
  sale.
- **Stock counts** (`stock_counts`, partitioned monthly, `stock_count_items`). A count snapshots the
  system quantity; the counted lines are imported with `COPY FROM STDIN`. Closing it posts **one**
  core stock adjustment (one journal) for the whole count, with one ledger row per variance.
- **Endpoints.** `GET/POST /api/laybys` (create, `action: 'complete'`, `action: 'cancel'`),
  `GET/POST /api/returns`, `GET/POST /api/credit-limits`, `GET/POST /api/stock-counts`
  (`action: 'lines'`, `action: 'close'`), `GET/POST /api/z-reports`. Modules under
  `src/verticals/ops/`.

## Retail extension (R6)

R6 adds the fiscal integration adapter. It is additive: new tables, new functions, and one new
trigger. See ADR-0022. It builds the **queue**, not the device — whether ZIMRA requires printing at
the moment of sale is an open item in `docs/ADR.md`.

- **Queue-only, mode per branch.** `fiscal_device_integration` holds one row per branch with the
  device config and a `mode` of `none` or `async`. There is no `blocking` mode in this run; the
  check constraint rejects any other value, so a blocking mode needs a new ADR and a new run.
- **The sale path does one insert.** An `AFTER INSERT` trigger on the partitioned `pos_sales`
  parent calls `app.enqueue_fiscal_job`, which inserts exactly one `fiscal_jobs` row when the branch
  mode is `async`. It makes no network call and waits for nothing. A sale with mode `none`, or with
  no integration row, is untouched and never errors. The trigger runs in the sale's own transaction,
  so a committed sale has queued its job and a rolled-back sale has left none.
- **Append-only, derived state.** `fiscal_jobs` and `fiscal_job_attempts` are immutable, like the
  ledger: no UPDATE, no DELETE, and the privileges are revoked from `authenticated`. A job is born
  `queued` and never changes; each delivery attempt appends a row, and a `sent` attempt marks the
  job done. `unique (org_id, sale_id)` keeps "exactly one job per sale" true even when the enqueue
  is retried.
- **Backoff in SQL.** `app.fiscal_jobs_due` returns the queued, not-yet-sent jobs whose exponential
  backoff (base 30s, capped 1h) has elapsed. An unreachable device records an `unreachable` attempt;
  the job stays queued and becomes due again later. It is never dropped and never blocks anything.
- **Endpoints.** `GET/PUT /api/fiscal/integration`, `GET /api/fiscal/jobs`, `POST /api/fiscal/drain`.
  Modules under `src/fiscal/` (`adapter.ts` for the queue, `worker.ts` for delivery). The `drain`
  route ships the unreachable transport, which performs no network call; a real device transport is
  a future run.

## Branch server (H1)

A branch runs the same codebase and the same migrations as the cloud, on the shop LAN, with the
internet down. `BRANCH_MODE` switches the branch-only behaviour on; the default is `cloud`, so an
unset variable is never branch mode. See ADR-0023 to ADR-0027.

What a branch is:

- **One codebase, one migration set.** A branch runs `supabase/migrations/` unchanged. H1 adds only
  additive tables and functions; no core table is edited. `BRANCH_MODE=branch` gates the branch
  paths (`isBranchMode()`), so the cloud path is untouched.
- **Local Postgres, local sign-in.** A branch runs a local Postgres and a local PIN sign-in. There
  is no Supabase Auth in branch mode: `POST /api/branch/login` verifies a cashier's PIN locally
  (bcrypt hash in `cashier_pins`) and mints a branch access token. Five wrong PINs lock the PIN for
  15 minutes; a manager PIN authorises an override (`app.manager_override`).
- **Device registration.** A till is registered with a one-time code (`app.create_device_registration`)
  that is redeemed once (`app.register_device`) for a device token. Only the sha256 hashes of the
  code and the token are stored — never the plaintext — exactly like an invite token (ADR-0024).
  Endpoints: `POST /api/branch/devices` with `action: create | register | verify`.
- **Connectivity from the branch, not the browser.** The till polls `GET /api/branch/health` and
  shows a badge. It does not trust `navigator.onLine`: a LAN with the internet down reports the
  cloud as offline, which is the truth the till must show. `?probe=1` refreshes the branch's
  observation of the cloud (short timeout; never hangs).
- **A sync protocol version.** The branch and the cloud carry a version
  (`app.branch_protocol_version()` and `BRANCH_PROTOCOL_VERSION`). A reachable cloud on a different
  version is `incompatible`: the branch refuses to push and the till shows a warning, while still
  selling locally (ADR-0025).
- **No Redis on a branch.** Redis is cloud-only. The live-sale rate limiter and the promotion
  candidate cache fall back to in-process stores with the same semantics (ADR-0027); the promotion
  validity window is still re-checked in SQL, so a stale entry cannot apply an expired promotion.
- **HTTPS on the LAN.** A PWA install and IndexedDB need a secure context. `npm run branch:https`
  issues a self-signed certificate for the branch host; `npm run start:branch` serves the build over
  HTTPS when `TLS_CERT_FILE`/`TLS_KEY_FILE` are set, and over HTTP otherwise.
- **Installable till.** `public/manifest.webmanifest` and `public/sw.js` make `/pos` installable. The
  service worker never caches `/api/`; the offline path is the IndexedDB outbox (R4), not a stale
  response.

Run a branch locally:

```bash
npm run build
BRANCH_MODE=branch npm run start:branch        # HTTP on 0.0.0.0:3000
# or, with TLS on the LAN:
npm run branch:https                            # writes certs/branch.{crt,key}
BRANCH_MODE=branch TLS_CERT_FILE=certs/branch.crt TLS_KEY_FILE=certs/branch.key npm run start:branch
```

## Offline sync engine (H2)

H2 moves a branch's facts to the cloud and the cloud's master data back to the branch, with the
cloud offline for as long as it takes. The branch keeps selling; nothing blocks a sale on the cloud.
See ADR-0028 to ADR-0034.

**The outbox (branch → cloud).** Every financial and stock fact the branch writes also appends one
event to `public.sync_outbox`, in the same transaction (triggers on `pos_sales`, `stock_ledger`,
`payments`, `credit_notes`, each gated on `app.branch_mode_enabled()`). A sale is one `sale` event
that carries its lines and its tenders. The outbox is append-only: the only mutable column is
`acked_at`, and it is write-once. Its `bigserial seq` is the order; the event UUID is the idempotency
key.

**Push (branch → cloud).** `POST /api/sync/push` takes a batch, applies it in ONE transaction with a
savepoint per event, and inserts each into `public.sync_inbox` with `ON CONFLICT (org_id, event_id) DO
NOTHING`. The cloud dedupes by event UUID, so a retried push never double-posts. It returns the
highest sequence applied and any rejects. The branch acks only up to the highest applied sequence; a
rejected event is recorded in `public.sync_conflicts` and stops the ack before it.

**Pull (cloud → branch).** The cloud appends each master-data change (products, prices, tax rates)
to `public.master_data_changes` with a per-org monotonic `change_seq`. The branch pulls "changes after
my cursor" (`GET /api/sync/pull`), applies them to `public.branch_master_data`, and advances the
cursor forward-only in `public.sync_state`. The mirror is a rebuildable cache, so a price is served
from the local database with no cloud round trip, and a price row carries a `price_version` so a
later change cannot rewrite the price a past sale charged.

**Retry vs conflict.** A network failure (unreachable, timeout, 5xx) is retried forever with
exponential backoff and full jitter, capped at 5 minutes; it is never a conflict. Only a rejection
from the cloud (a 4xx that names events) is a conflict. `src/sync/retry.ts`.

**Status page.** `GET /api/branch/sync/status` (page `/branch/sync`) reads the branch's own database,
so it answers with the cloud offline: outbox depth, last push and pull, the cloud observation, and
the newest conflicts.

**The loop.** `npm run branch:sync` runs the push+pull runner on a timer (`SYNC_INTERVAL_MS`,
default 15s) until stopped. A tick that cannot reach the cloud backs off and the branch keeps
selling; with no `CLOUD_URL` set the tick is a no-op, which is a valid offline state.

```bash
BRANCH_MODE=branch BRANCH_ORG_ID=<org> BRANCH_ID=<branch> CLOUD_URL=https://cloud.example \
  npm run branch:sync
```

**Nightly encrypted backup.** `npm run branch:backup` dumps the branch's Postgres, encrypts it with
AES-256-GCM (`BRANCH_BACKUP_KEY`) in memory, uploads only the ciphertext (a presigned URL when
`BRANCH_BACKUP_UPLOAD_URL` is set, else `BRANCH_BACKUP_DIR`), and records the run in
`public.sync_backups`. The recorded checksum is the sha256 of the encrypted file, so a truncated or
tampered upload is detected.

```bash
BRANCH_MODE=branch BRANCH_ORG_ID=<org> BRANCH_ID=<branch> \
  BRANCH_BACKUP_KEY=<64-hex-or-base64-32-bytes> npm run branch:backup
```

**The sync tables.** Branch-scoped: `sync_outbox`, `sync_inbox`, `branch_master_data`,
`sync_conflicts`, `sync_backups`. Org-scoped: `master_data_changes`. All carry `org_id`, `created_at`,
forced RLS and the standard indexes, and are registered in `scripts/check-tenant-tables.sql`.

## Fiscal and numbering (H3)

H3 makes a fiscal invoice submit reliably after an outage and makes invoice numbers impossible to
collide or reuse. Nothing here blocks a sale on FDMS or the cloud. See ADR-0035 to ADR-0038.

**The queue (branch only).** A sale's invoice writes one `public.fiscal_invoices` row in the invoice's
OWN transaction, in the same `app.create_invoice` / `app.pos_sale_receipt` call that posts the
journal. The row starts `pending`. The enqueue is gated by `app.branch_mode_enabled()`, so the
cloud's replayed invoices never queue fiscal rows and the cloud never talks to FDMS (ADR-0035). A
rollback of the sale rolls back the fiscal row with it.

**Status and attempts.** `status` is `pending`, `sent` or `failed`. A submission has three outcomes
(ADR-0037):

* `sent` — the device accepted the invoice; its signature and QR are stored on the row and shown on
  the receipt.
* `failed` — a real FDMS rejection. `attempts` increases and the next attempt is scheduled with
  exponential backoff. At 5 rejections the row moves to `failed` and stops being retried.
* `unreachable` — a network outage. The row stays `pending` and `attempts` is NOT touched, so an
  outage never burns the retry budget.

Every real submission appends a row to `public.fiscal_invoice_attempts` (append-only; UPDATE and
DELETE are rejected).

**The worker (a loop, not a cron).** `npm run branch:fiscal` runs `startFiscalLoop`, a long-lived
worker that drains the branch's due rows continuously (default every 5s). Each pass claims with
`FOR UPDATE SKIP LOCKED` and holds the row lock until the outcome is recorded, so two workers running
at once never submit the same invoice twice (test 68). A pass that throws does not stop the loop.

```bash
BRANCH_MODE=branch BRANCH_ORG_ID=<org> BRANCH_ID=<branch> \
  FDMS_ENDPOINT=https://fdms.example FDMS_DEVICE_SERIAL=<serial> npm run branch:fiscal
```

With no FDMS credentials the loop uses a mock device (`FDMS_MOCK=outage` or `FDMS_MOCK=reject:<n>`
select the outage and rejection paths).

**Invoice number blocks.** The cloud issues each branch a contiguous range of invoice numbers
(`app.issue_number_block`, carved from `number_series` under `FOR UPDATE`, so two branches can never
be issued the same number). The branch stores the block in `public.number_blocks` and
`app.claim_invoice_number` takes the next number from its oldest block that still has numbers — so
topping up early never leaves a gap. The branch asks for the next block BEFORE the current one runs
out (`ensureNextBlock`, low-water mark 20); a failed fetch is a no-op, so an offline branch keeps
selling from what it has. When a branch's blocks are truly exhausted, a sale fails with the clear,
catchable error `invoice number block exhausted...` and no number is reused (test 67). A branch that
has never been issued a block falls back to the org's gapless series, so the cloud path is unchanged
(ADR-0036).

```bash
# Cloud: reserve a block for a branch (a branch member's token; org comes from the token)
curl -X POST https://cloud.example/api/branch/numbers/claim \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"branch_id": "<branch>", "series_code": "INVOICE", "size": 200}'
```

**Admin.** `/settings/fiscal` lists the branch's queue with counts by status and offers a retry for
failed rows and a manual submit for pending or failed rows
(`GET /api/fiscal/invoices`, `POST /api/fiscal/invoices/:id/retry`,
`POST /api/fiscal/invoices/:id/send`, `GET/POST /api/fiscal/numbers`).

**The fiscal tables.** Branch-scoped: `fiscal_invoices`, `fiscal_invoice_attempts`, `number_blocks`.
All carry `org_id`, `created_at`, forced RLS and the standard indexes, and are registered in
`scripts/check-tenant-tables.sql`.

## Hardware and receipts (H4)

H4 makes the till usable at the counter: a scanner that works without focus, three shortcuts, and a
receipt that prints within a second of the sale. See ADR-0039 to ADR-0041.

**Keyboard-wedge scanner.** A scanner is a keyboard: it types the barcode and sends Enter. The till
reads keystrokes at the document level (`ScannerBuffer` in `src/verticals/pos/scanner.ts`), so a scan
works no matter what has focus. The same buffer serves a hand-typed barcode plus Enter, so there is
one code path for both. A camera scanner is offered only over HTTPS (a plain-HTTP LAN cannot grant
camera access, so the affordance is hidden rather than shown and failing).

**Shortcuts.** F2 focuses the scan field, F3 holds the cart, F4 recalls it, F9 opens payment with the
exact amount preselected (Enter confirms), F10 pays in ZWG. The mapping is one pure table
(`src/verticals/pos/shortcuts.ts`), so the keys and the actions cannot drift apart.

**Receipt.** `Receipt58mm` renders the 58mm slip on screen from the same `ReceiptData` that
`generateEscPos(receiptData)` turns into ESC/POS bytes, so the screen slip and the printed slip can
never disagree. It shows the shop header (logo, name, address, VAT number), the receipt and invoice
numbers, date and cashier, the lines, the VAT breakdown exclusive and inclusive at each rate, the
totals in USD and ZWG, the fiscal QR when the device returned one, and the footer.

**Printing.** The sale commits first; only then is the print issued. The checkout records two
timings — the delay from commit to print issued (must be under 1s) and the total — and shows them on
the till. Two transports, per branch, stored in `printer_settings`:

* **browser** — `window.print()` with `@page { width: 58mm }`. Works with no configuration.
* **network** — the till generates the ESC/POS bytes and the **branch** relays them to the printer on
  the shop LAN (`host:port`, default 9100). Only the branch opens the socket (decision 16). The bytes
  travel as base64 inside JSON — a transport encoding — and the branch writes the decoded raw bytes
  to the socket (`POST /api/branch/print`).

```bash
# Configure a branch's network printer (a branch member's token; org comes from the token)
curl -X PUT https://cloud.example/api/pos/printer \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"mode": "network", "host": "192.168.1.50", "port": 9100}'

# Print a test slip
curl -X POST https://cloud.example/api/pos/printer/test -H "Authorization: Bearer <token>"
```

**The printer table.** `public.printer_settings` (org + branch) carries `org_id`, `created_at`, forced
RLS and the standard indexes, and is registered in `scripts/check-tenant-tables.sql`.

## Migration wizard (H5)

H5 brings a shop's products, customers and opening stock off Pastel and onto a branch, so the branch
works offline from day one. See ADR-0042 to ADR-0044. It adds no core-table change; opening stock is
posted through the core accounting and inventory functions.

**The page.** `/settings/import` on the branch. Pick what you are importing, choose the CSV, then:

1. **Preview and map.** PapaParse parses the whole file in the browser, so nothing is uploaded until
   you press Start. The wizard guesses a mapping from the Pastel headings (StockCode, Description,
   SellingPrice, ...) and shows the first rows. Correct any column, then **Save this mapping** — it is
   stored per shop and reused next time.
2. **Stage and check.** The parsed rows are sent to the branch in chunks (500 rows each) and land in
   `import_rows` with COPY. Validation is one SQL pass: each row is `valid`, `invalid` (with a
   message against the field) or `skipped` (already imported). Invalid rows are listed by their line
   number in the file and can be fixed in place.
3. **Commit.** One click applies the whole file in one transaction. A single bad row blocks the
   commit, and a failure part-way through rolls the whole job back.

```bash
# Open a job and stage the first chunk (a branch member's token; org and branch come from the token)
curl -X POST https://branch.example/api/import/jobs   -H "Authorization: Bearer <token>" -H 'Content-Type: application/json'   -d '{"kind": "products", "source_name": "products.csv", "mapping": {"StockCode": "external_code"},
       "rows": [{"external_code": "P1", "name": "Widget"}]}'

# Stage more chunks, validate, commit
curl -X POST https://branch.example/api/import/jobs/<id>/chunks   -H "Authorization: Bearer <token>" -H 'Content-Type: application/json'   -d '{"start_row_no": 501, "rows": [...]}'
curl -X POST https://branch.example/api/import/jobs/<id>/validate -H "Authorization: Bearer <token>"
curl -X POST https://branch.example/api/import/jobs/<id>/commit -H "Authorization: Bearer <token>"
```

**Opening stock.** An opening-stock row becomes an append-only `stock_ledger` row with
`source_type = 'opening'`, its FIFO layer and the `stock_balances` cache, and the whole file posts
**one** balanced journal (Dr Inventory 1300, Cr Opening Balance Equity 3900) through the core
balanced-journal hook. A later sale therefore consumes the imported stock at the imported cost.
Re-running the same file skips every row that was already committed, so it never double-counts.

**Products and customers.** Products are upserted by their Pastel code (external code) and get a
default variant and a retail price, so an imported product is sellable at the till immediately.
Customers are upserted by their Pastel code. Both are idempotent: a re-run updates rather than
duplicates.

**Speed.** SKUs are allocated in one locked block (`app.next_numbers`) rather than one
`next_number` call per row, and the commit joins on stored columns so the indexes are used. A
5,000-product file stages in ~0.2 s and commits in ~1.2 s.

**Sample files.** `samples/` carries `products-5000.csv`, `customers.csv`, `opening-stock.csv` and
`products-with-errors.csv`, so the wizard can be exercised end to end.

**The import tables.** `public.import_jobs`, `public.import_rows` and `public.import_mappings` (org +
branch) each carry `org_id`, `created_at`, forced RLS and the standard indexes, and are registered
in `scripts/check-tenant-tables.sql`.

## Reports and the owner console (H6)

H6 gives the owner profit, VAT and Z-reports on the branch **and** in the cloud. See ADR-0045 to
ADR-0049. It adds no core-table change; a report reads the ledger and the sales tables directly.

**Two sources, one rule.** A day that has closed is read from `public.daily_product_sales`, an
append-only fact table written by `app.close_shift` in the same transaction as the immutable
Z-report. Today is read live from `invoices` + `invoice_lines`, bounded by `invoice_date`. The two
never overlap (the facts side stops at `current_date - 1`), so a figure is counted once. The facts
are a rebuildable projection of the immutable sale lines and their FIFO cost — not a second source of
truth — so no materialised view is needed.

**The reports.**

| Report | Function | Endpoint |
| --- | --- | --- |
| Profit by product | `app.report_profit_by_product` | `GET /api/reports/profit` |
| Best sellers | `app.report_best_sellers` | `GET /api/reports/best-sellers` |
| Slow movers | `app.report_slow_movers` | `GET /api/reports/slow-movers` |
| VAT (ZIMRA) | `app.report_vat` | `GET /api/reports/vat` |
| Z-reports | `app.report_z_reports` | `GET /api/reports/z-reports` |
| Last sync | `app.report_last_sync` | `GET /api/reports/last-sync` |
| GL period profit | `app.report_gl_period_profit` | (read by the tests) |

`app.report_gl_period_profit` reads `journal_lines` straight and is what the profit report must
equal. The VAT report and the Z-report's `vat_by_rate` both read `invoice_lines`, so they always
agree. A completed return nets out of the per-product reports as a negative row (ADR-0048).

**The page.** `/reports` is the owner console and the branch view in one. Pick a period (defaults to
the current month), pick a tab, and the page shows the figures plus a **last synced** label from
`app.report_last_sync`, so a stale cloud figure is explained rather than surprising. Every list is a
keyset page: the page asks for the next page with the cursor the previous page returned, never an
offset.

**Pagination and speed.** The per-product reports keyset on `product_id`; the ranked lists keyset on
`(qty, product_id)`; the Z-report list keysets on `(created_at, id)`. Each source branch of the
per-product union is itself a keyset page of at most `limit` products, so the closed-day side is a
streaming index scan: a per-product page over 1M closed-day facts measured ~6 ms (ADR-0045).

**Branch and cloud.** The same page and the same functions serve both deployments, so the console
shows the branch's synced data, from the same code (ADR-0049). A report never reads the service role:
the routes run as the caller, so RLS scopes every row, and a branch a token does not scope is refused.

**The fact table.** `public.daily_product_sales` (org + branch) carries `org_id`, `created_at`, the
high-volume branch index, a per-product index and the FK indexes, is immutable
(`app.enforce_immutable`), and is registered in `scripts/check-tenant-tables.sql`. Its unique key
`(org_id, branch_id, shift_id, business_date, product_id, variant_id)` makes the shift-close write
idempotent.

## The admin console (catalogue management)

The owner manages the catalogue from the cloud **and** from a branch admin. The pages are thin
clients over `/api/admin/*`; the business logic lives in SQL functions under `app`, so RLS scopes
every row and a branch pulls the change on its next sync (ADR-0050).

| Page | Purpose |
| --- | --- |
| `/admin/categories` | The category tree (`parent_id` nesting), create / rename / delete |
| `/admin/products` | The product list (keyset, "Load more") and the create form |
| `/admin/products/[id]/variants` | A product's variants: size, colour, barcode, planning cost |
| `/admin/batches` | Product batches with an expiry countdown (amber ≤ 30 days, red when expired) |
| `/admin/price-lists` | The org's retail / wholesale price lists (USD, ZAR, ZWG) and their item counts |
| `/admin/price-lists/[id]/items` | The editable item table: inline price edit, bulk re-price by category, CSV (COPY) import, margin vs cost |
| `/admin/customer-groups` | Groups mapped to a price list, with their members (contacts) |
| `/admin/promotions` | Promotions by priority (drag-to-reorder, or up/down keys), a conditions builder, a stackable flag, and an active/type filter |
| `/admin/pricing-preview` | Live preview of list price → promotion → manual discount, with the role's limit |
| `/admin/laybys` | Laybys with a status filter; overdue `due_date` in red; complete (CORE invoice) or cancel (refund less fee) |
| `/admin/laybys/[id]` | One layby: the deposit paid, the customer and the reservations held aside |
| `/admin/returns` | Create a return against an invoice (returnable-lines lookup) and list past returns |
| `/admin/shifts` | Till shifts with a status filter; close a shift and read its immutable Z-report |
| `/admin/stocktake` | Open a count, prefill from the snapshot, import the lines and close it (one CORE adjustment) |

**Endpoints.** `GET`/`POST /api/admin/categories`, `PATCH`/`DELETE /api/admin/categories/[id]`, and
the same shape for `products`, `variants` and `batches`. A list is a keyset page on
`(created_at, id)` (default 50, maximum 100); the SQL guards the limit too. A write that names
another org is refused with 403, and a duplicate (SQLSTATE 23505) or a bad argument (22023) is a 422.

**Pricing (A2).** `/api/admin/price-lists`, `/api/admin/price-lists/import`,
`/api/admin/price-lists/[id]/items`, `/api/admin/customer-groups`,
`/api/admin/customer-groups/[id]/members`, `/api/admin/promotions`, and
`/api/admin/pricing-preview`. The console does not re-implement any pricing rule: it calls R2's
`app.get_price` and `app.assert_manual_discount` (ADR-0054), and promotion writes go through
`src/verticals/retail/pricing` so the `promos:{org_id}` cache is invalidated exactly as a till write
does. Items import with COPY into a staging table and one merge (ADR-0055), the same pattern as the
stocktake; both `/api/admin/price-lists/import` and the older `action:'import'` body call the one
`importPriceListItems` implementation (ADR-0069). A list is keyed by `kind` (one retail and one
wholesale per org, ADR-0056), and a keyset cursor keeps microsecond precision so a bulk import pages
correctly (ADR-0057).

**Promotions (F2).** The promotions form builds the `conditions` jsonb the pricing engine reads —
`value`, `variant_ids`, `min_qty`, `min_subtotal` (`src/verticals/admin/promotionConditions.ts`); a
`stackable` checkbox marks a promotion that may stack, shown as a badge on the row. Rows reorder by
drag (HTML5) or by the up/down buttons, and a precedence legend states the order the preview and the
till apply: group price list (fallback retail) → promotion by priority → manual discount. Every
write invalidates `promos:{org_id}`, and the validity window is re-checked at evaluation time, so a
stale cache entry cannot apply an expired promotion (ADR-0069).

**Operations (A3).** `/api/admin/laybys` (list + complete/cancel), `/api/admin/laybys/[id]`,
`/api/admin/returns` (list + create), `/api/admin/invoices/[id]/returnable-lines`,
`/api/admin/shifts` (list + close), `/api/admin/z-reports/[id]`, `/api/admin/stocktake` (open /
import / close), `/api/admin/stocktake/[id]` and `/api/admin/warehouses`. These pages drive the R5
SQL the till already uses (`app.complete_layby`, `app.cancel_layby`, `app.create_return`,
`app.close_shift`, `app.create_stock_count`/`app.close_stock_count`), so the console and the till
cannot drift (ADR-0059). Every read is a `security invoker` `app.admin_*` function, so RLS scopes the
rows and no admin path needs the service role (ADR-0060). The overdue flag and the layby status
filter are computed in SQL (ADR-0061); the returnable-lines preview shares its arithmetic with
`app.create_return`, which still holds the lines `FOR UPDATE` (ADR-0062); the stocktake import is a
set-based insert rather than COPY, which RLS forbids (ADR-0063).

**Barcodes.** A 13-digit barcode must carry a valid EAN-13 check digit, checked in SQL
(`app.is_valid_ean13`) and mirrored in TypeScript (`src/verticals/admin/barcode.ts`). Anything else
(a short internal code, a 12-digit UPC) is accepted as-is, so the R1 and H5 data stays valid
(ADR-0051). Per-org uniqueness is the existing partial unique index on `(org_id, barcode)`.

**Offline.** A branch admin's edit that cannot reach the server is queued in an IndexedDB outbox
(`src/verticals/admin/outbox.ts`) and replayed with a capped backoff, like a till sale but in its own
store (ADR-0052).

## The frontend shell and sign-in (F1)

The app is served behind a small shell rather than a bare page that expects a token pasted into the
console.

**Sign in.** `/login` posts an email and password to `POST /api/auth/login`. The password is checked
in Postgres against a bcrypt hash (`app.authenticate`, a `SECURITY DEFINER` function), and the route
returns a signed access token plus the org it scopes. The login page stores the token under
`localStorage['token']` and the org id under `localStorage['org_id']`, then redirects to `/pos`.
The login path runs as `anon` (ADR-0067), never the service role, and a wrong email and a wrong
password return the same 401 body.

**Validate.** `GET /api/auth/me` re-verifies the bearer token and describes the session (user,
`org_id`, `org_name`, `branch_ids`, role). It is the endpoint the shell uses to confirm a stored
token is still good.

**Shell.** `src/app/shell/Shell.tsx` wraps every `/pos` and `/admin` page (via their route
layouts). It shows the org name and the signed-in user, a sidebar of links, and a sign-out button
that clears the session and returns to `/login`. When there is no token it redirects to
`/login?next=…`; the token is read first from `token` and then from the legacy `pos_access_token`
key, so an existing session keeps working (ADR-0068). Authorisation is never decided on the client:
every API call re-verifies the token on the server.

**Demo data.** `npm run db:seed-demo` creates a demo org, an admin user (`admin@demo.com` /
`admin123`), a branch, a till and ten products with barcodes, and prints the credentials.

## The admin products / pricing / promotions console (F2)

F2 completes the admin console over the catalogue and pricing backend that A1 and A2 built. It is
additive: it changes no core table or function and re-implements no existing admin path (ADR-0069).
The catalogue and pricing pages, their SQL, the COPY import and the live preview already exist
(see [The admin console](#the-admin-console-catalogue-management)); F2 adds:

- **A promotions conditions builder** on `/admin/promotions`, producing the four keys
  `app.apply_promotions` reads (`value`, `variant_ids`, `min_qty`, `min_subtotal`), built in
  `src/verticals/admin/promotionConditions.ts`. Only non-empty boxes are sent, so an untouched form
  sends `{}`.
- **A stackable flag and badge** — a checkbox on the form and a badge on the row.
- **Drag-to-reorder** of promotion priority (HTML5 drag), with the up/down buttons kept as the
  keyboard-accessible fallback. Both call the reorder endpoint, which invalidates `promos:{org_id}`.
- **A precedence legend** stating the order the preview and the till apply: group price list
  (fallback retail) → promotion by priority → manual discount.
- **`POST /api/admin/price-lists/import`** — the brief's import endpoint, delegating to the same
  `importPriceListItems` COPY path as the older `action:'import'` body, so there is one import.

Every list is a keyset page on `(created_at, id)` (default 50, maximum 100); RLS is enforced from
the token's `org_id` on every route, and a body naming another org is refused with 403.

## Adding a vertical module

A vertical (Retail, Pharmacy, Hardware, School) sits on top of the core. It never edits a core
table without an ADR.

1. Give the vertical its own folder, for example `src/verticals/pharmacy/` for TypeScript and
   `supabase/migrations/<timestamp>_pharmacy_*.sql` for its own tables.
2. Depend only on core functions: `app.post_journal`, `app.post_receipt`, `app.create_invoice`,
   `app.allocate_payment`, `app.create_credit_note`, `app.post_stock_adjustment`,
   `app.next_number`, `app.ensure_partitions`. Call them, do not reimplement them. An operational
   journal goes through `app.post_balanced_journal` rather than `app.post_journal` directly, so it
   is balanced by construction (ADR-0019). A pricing-aware
   vertical also uses `app.get_price`, `app.get_prices`, `app.apply_promotions` and
   `app.assert_manual_discount` rather than its own copy of the precedence rules.
3. Scope every new table by `org_id` (and `branch_id` when it is branch-scoped), and apply the same
   RLS, index and partition rules as the core: `select app.apply_tenant_rls('public.your_table',
   'org')` or `'branch'`.
4. Register the table in `scripts/check-tenant-tables.sql` so the invariant checks cover it.
5. If the vertical needs a new column on a core table, write an ADR first and stop for review.

## Tests, checks and the perf run

```bash
npm test          # the tests against the real local database
npm run build     # production build
npm run lint      # ESLint, including the no-any rule for src/accounting
npm run test:perf # seed 1M journal lines, EXPLAIN ANALYZE, write docs/perf/
```

`npm test` runs the tests in `tests/`. The database is never mocked. Tenancy tests act as a user
by setting the role and the JWT claims inside a transaction, never as the `postgres` superuser.

The R2 tests use a real Redis, which must be running (`REDIS_URL`, default
`redis://127.0.0.1:6379`). They are not mocked: the cache assertions read the real key back, and the
"stale promotion" test writes a real Redis key with a real TTL.

`npm run test:perf` seeds 1,000,000 journal lines with `generate_series` inside SQL, then runs
`EXPLAIN ANALYZE` on a one-month trial balance and on a full-range trial balance. The one-month
query must prune to a single partition and use an index; the full-range query may use a sequential
scan. Output is written to `docs/perf/`. The run records timings and does not fail on them.

`src/accounting/**` is checked by an ESLint override that sets
`@typescript-eslint/no-explicit-any` to `error`. `npm run lint` fails if `any` appears there.

### The tests

| Range | Area | File |
| --- | --- | --- |
| 1–8 | Tenancy and RLS | `tests/tenancy.test.ts` |
| 9–14 | Schema and indexes | `tests/tenancy.test.ts` |
| 15–24 | Accounting | `tests/accounting.test.ts` |
| 25–31 | Inventory | `tests/inventory.test.ts` |
| 32–37 | Sales and purchases | `tests/sales.test.ts` |
| 38–40 | Concurrency | `tests/sales.test.ts` |
| 41–44 | R1: products, barcodes, search | `tests/retail-r1.test.ts` |
| 45–48 | R2: pricing and promotions | `tests/retail-r2.test.ts` |
| 9–13 | R3: online POS sale | `tests/pos-r3.test.ts`, `e2e/pos-keyboard.e2e.ts` |
| 14–18 | R4: offline outbox and sync | `tests/pos-r4.test.ts`, `e2e/pos-offline.e2e.ts` |
| 19–24 | R5: operations (laybys, returns, credit limits, Z-reports, stock counts) | `tests/ops-r5.test.ts` |
| 25 | R6: fiscal integration adapter (queue-only) | `tests/fiscal-r6.test.ts` |
| 49–51 | H1: branch server foundation (device, PIN, health) | `tests/branch-h1.test.ts` |
| 52 | H1: branch till shows cloud-offline and still sells (e2e) | `e2e/branch-offline.e2e.ts` |
| 53–63 | H2: offline sync engine (outbox, push, pull, retry, backup) | `tests/sync-h2.test.ts` |
| 64–68 | H3: fiscal and numbering (queue, outage, blocks, exactly-once) | `tests/fiscal-h3.test.ts` |
| 69–74 | H4: hardware and receipts (printer, ESC/POS, relay) | `tests/hardware-h4*.test.ts` |
| 75–85 | H5: migration wizard (products, customers, opening stock) | `tests/import-h5.test.ts` |
| 86–95 | H6: reports and the owner console (profit, VAT, Z-reports) | `tests/reports-h6.test.ts` |
| 96–104 | A1: admin products UI (categories, products, variants, barcodes, batches) | `tests/admin-a1.test.ts` |
| 105–107 | A2: admin pricing UI (price lists, items, customer groups, promotions, preview) | `tests/admin-a2.test.ts` |
| 108–111 | A3: admin operations UI (laybys, returns, shifts & Z-reports, stocktake) | `tests/admin-a3.test.ts` |
| 112–118 | F1: frontend shell and sign-in (email/password, `/api/auth/me`, app shell) | `tests/frontend-f1.test.ts` |
| 119–121 | F2: admin products / pricing / promotions console | `tests/frontend-f2.test.ts` |

H1's tests are numbered 49–51 because R4 already owns 14–18 and R5 owns 19–24; the H1 brief called
them 16–18. H2 continues from 52 (ADR-0033) and H3 from 63 (ADR-0038). ADR-0026, ADR-0033 and
ADR-0038 record the mappings. F2 continues from F1's 118 (ADR-0069); the F2 brief called its tests
43–45, but those are Phase 1 retail tests.

Test 13 is the keyboard-only Playwright run and test 14 is the offline reload-and-reconnect run;
both live in `e2e/`. The admin consoles also carry navigation specs (`e2e/admin-ops.e2e.ts` for A3,
`e2e/admin-products-pricing.e2e.ts` for F2) that walk the real UI. The e2e config starts its own dev
server on port 12100 with its own dist dir (`.next-e2e`), so it never clashes with a running
`npm run dev` and `npm run build` cannot clobber it:

```bash
npm run test:e2e
```

It needs a real browser: `npx playwright install chromium` once.

## Documentation

- `PROGRESS.md` — milestone status and the gate evidence for each milestone.
- `docs/ADR.md` — architecture decision records, including the open items.
- `docs/perf/` — perf run output.
