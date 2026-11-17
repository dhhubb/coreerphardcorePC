# Architecture Decision Records — ERP Core

Format: one section per decision. The Phase 1 spec fixes several decisions already; where a
decision was made *during* implementation (or where an open item exists) it is recorded here.

## ADR-0001 — Balance-check trigger attached to the partitioned `journals` parent

**Context.** The spec requires a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on
`journal_lines` that verifies, at commit, that each journal has at least two lines and that
`sum(base_debit) = sum(base_credit)`. `journals` and `journal_lines` are RANGE-partitioned
monthly on `created_at`. Historically, `CREATE CONSTRAINT TRIGGER` on a partitioned table raised
`"constraint triggers are not supported on partitioned tables"`.

**Decision.** Postgres 17 supports `CREATE CONSTRAINT TRIGGER` on a partitioned table, and the
parent's trigger is automatically cloned onto every partition — including partitions created
*after* the trigger (verified against `supabase start`, PG 17.11). We therefore attach the
deferred balance trigger **once, to the `journals` parent**, and do not write a per-partition
attach helper.

**Consequence.** `ensure_partitions()` needs no trigger bookkeeping. The spec's fallback
("attach the trigger to each partition with a helper function") is not required; this ADR records
that choice. If the project is later pinned to a Postgres version without partitioned constraint
triggers, the fallback becomes mandatory.

## ADR-0002 — Zimbabwe currency code seeded as ZWG

**Context.** The spec is ambiguous between `ZWG` (Zimbabwe Gold, introduced 2024) and `ZWL`
(the older Zimbabwe dollar).

**Decision.** Seed `ZWG` as instructed. `ZWL` remains an open item; no ZWL rows are seeded.

## ADR-0003 — ZIMRA fiscalisation not implemented

**Context.** It is unclear whether ZIMRA requires a specific invoice numbering format or fiscal
device integration. Invoice numbers in Phase 1 are gapless integers from `number_series`.

**Decision.** Neither a ZIMRA-specific format nor fiscal device integration is built. The
numbering abstraction (`number_series` + `next_number()` locked with `SELECT ... FOR UPDATE`)
is the single place a future vertical would hook a fiscal format into.

## ADR-0004 — Rounding residual always posts to the rounding account

**Context.** `base_debit`/`base_credit` are rounded to 4 decimal places per line. Foreign-currency
lines can therefore produce a residual that leaves `sum(base_debit) != sum(base_credit)`.

**Decision.** When a document's posted lines do not balance after per-line rounding, the residual
is posted as an extra journal line against the rounding account named in `settings`
(`rounding_account_code`, default `6999`). The residual is never dropped and never absorbed
silently into an existing line. This is implemented in `post_journal()`.

## ADR-0005 — Trial balance over 1M lines: no summary table in Phase 1

**Context.** The spec forbids materialized views / summary tables in Phase 1, but requires an ADR
if the perf run shows a trial balance over 1M lines takes more than 500 ms.

**Decision.** The perf run (`npm run test:perf`, output in `docs/perf/`) seeds 1,000,000 journal
lines and records the plans. The one-month trial balance prunes to a single partition and uses
`journal_lines_<YYYYMM>_org_id_idx`; the full-range query reads every partition. Both are well
under 500 ms, so no summary table is added in Phase 1.

**Consequence.** Reports keep querying `journal_lines` directly with indexed date-range
predicates. If a future dataset pushes the trial balance past 500 ms, a follow-up ADR proposing a
summary table is the next step; it is not added without one.

## ADR-0006 — Audit rows record the logical table name, not the partition

**Context.** The generic audit trigger fires on `journals` and `stock_ledger`, which are
partitioned. In a row-level trigger `tg_table_name` is the partition (`journals_202611`), so audit
rows would name a different table each month.

**Decision.** `app.write_audit_log()` resolves `tg_relid` through `pg_inherits` and stores the
parent's name (`journals`, `stock_ledger`). A non-partitioned table has no `pg_inherits` row, so
its name is stored unchanged.

## ADR-0007 — The perf seed spreads rows across organisations

**Context.** The perf run must show the one-month trial balance pruning to a single partition and
using an index. If one organisation owned an entire partition, `org_id` would not be selective and
the planner would correctly prefer a sequential scan — an artefact of the seed, not of the schema.

**Decision.** `npm run test:perf` seeds 1,000,000 journal lines across several organisations, so the
partition holds realistic multi-tenant data and the measured plan reflects production. With that
distribution the one-month query prunes to one partition and uses
`journal_lines_<YYYYMM>_org_id_idx`. Timings are recorded, not enforced.

## ADR-0008 — R1 adds columns to the core `products` and `product_variants` tables

**Context.** R1 (Retail: products, barcodes, search) needs a unit of measure, a weighable flag, a
category, and a barcode. The core already owns `products` and `product_variants`, and the standing
rule is that a vertical never edits a core table without an ADR. Putting the barcode on a separate
table was considered, but a barcode identifies a sellable unit (a variant), so it belongs with the
variant, and a partial unique index enforces uniqueness only when a barcode is present.

**Decision.** Extend the core tables additively rather than forking them:

* `products` gains `category_id uuid`, `unit product_unit not null default 'each'`,
  `is_weighable boolean not null default false`, and a generated `name_search tsvector`.
* `product_variants` gains `size`, `color` and `barcode`.
* Two new org-scoped tables, `categories` (nested) and `product_batches` (batch master).
* A `(org_id, name gin_trgm_ops)` GIN index on `products.name`, and
  `app.search_products(org_id, query, limit)`.

All new columns are nullable or have a default, so existing rows and existing core code are
unaffected. No core accounting path is touched.

**Consequence.** `docs/CORE_INTERFACE.md` records the additions. A later vertical that needs its own
product attributes should still prefer its own table keyed on `product_id`, and must write its own
ADR before adding another column to `products`.

## ADR-0009 — Search is a GIN trigram index plus an inlined SQL function

**Context.** The till must find a product by exact barcode, or by a partial name, in well under
100 ms, without loading the catalogue at startup. The name search must stay an index scan as the
catalogue grows, and an `EXPLAIN` of the search must show the index in use.

**Decision.**

* The name predicate is `name ILIKE '%term%'`. That is the operator a `gin_trgm_ops` index serves
  directly, so a substring search stays an index scan rather than scanning the org's whole
  catalogue.
* The index is a single combined GIN index `(org_id extensions.uuid_ops, name extensions.gin_trgm_ops)`,
  so the RLS org predicate and the trigram predicate are served by one index.
* `app.search_products` is `language sql`, `security invoker`, with **no `set search_path` clause**.
  A `set` clause stops the planner inlining a SQL function, and an inlined body is what lets
  `EXPLAIN` show the trigram index. Every object in the body is schema-qualified, so inlining is
  safe.
* The body is a parenthesised `UNION ALL` (barcode hit first, then name hits), not a CTE. A CTE is
  materialised, which hides the constant term from the planner and drops the index.

**Consequence.** `tests/retail-r1.test.ts` asserts the plan contains `products_name_trgm_idx`. The
planner only prefers the trigram index once an org's catalogue is large enough to beat a sequential
scan (measured at roughly 15,000 products in one org), so that test seeds 20,000 rows. Relevance is
`extensions.word_similarity(term, name)`, which ranks a term found inside a longer name above a
merely similar one.

## ADR-0010 — R1 test numbering continues from the core's 40

**Context.** Phase 1 owns tests 1–40 and forbids renumbering. The Phase 2 backlog planned tests
41–44 for rate limiting (P2-01), which is not built.

**Decision.** The R1 run (this one) owns tests 41–44 in `tests/retail-r1.test.ts`. A later run that
implements a different Phase 2 item continues from the highest number actually present, not from a
range reserved in the backlog. Ranges in `docs/phase2/README.md` are indicative, as that document
already states.

**Consequence.** Test numbers are allocated in the order items are actually built, so no number is
skipped and no two runs collide.

## ADR-0011 — R2 adds a nullable `contacts.group_id` column

**Context.** R2 (Retail: pricing and promotions) needs a customer to belong to a group so the group
can map to a wholesale price list. The core already owns `contacts`, and the standing rule is that a
vertical never edits a core table without an ADR.

**Decision.** Extend `contacts` additively with one nullable column, `group_id uuid`, plus a
composite foreign key `(org_id, group_id) -> customer_groups (org_id, id) on delete set null`. The
column is nullable, so every existing row and every core code path is unaffected; a contact with no
group simply resolves at the retail price list. All of R2's own tables (`price_lists`,
`price_list_items`, `customer_groups`, `promotions`, `discount_limits`, `manual_discounts`) are new,
so nothing else in the core is touched.

**Consequence.** `docs/CORE_INTERFACE.md` records the addition. A later vertical that needs more
customer attributes should prefer its own table keyed on `contact_id`, and must write its own ADR
before adding another column to `contacts`.

## ADR-0012 — Promotion candidates are cached in Redis, never prices

**Context.** Pricing must read the org's active promotions on every cart. That is a small read but a
hot one, and the brief allows Redis for the promotion cache. The risk of any cache is serving a
value that the ledger no longer agrees with: a promotion that has been deactivated, or whose window
has closed, must not keep applying.

**Decision.** Redis holds the *candidate* list only (id, type, priority, stackable, validity window,
conditions), under the key `promos:{org_id}` with a 300-second TTL. It never holds a resolved price.
Every evaluation re-checks the validity window against the caller's timestamp inside
`app.apply_promotions`, which is the single implementation used by both the cached path and the SQL
path. A write to `promotions` invalidates the key, but correctness does not depend on invalidation:
a stale entry that still names an expired promotion is filtered out at evaluation time. The cache is
therefore rebuildable from the immutable source at any moment, and losing it only costs one read.

**Consequence.** `tests/retail-r2.test.ts` writes a real Redis key with a real 300s TTL containing an
expired promotion and asserts the price is still the full list price. Redis is not a source of
truth, so no posting path reads it.

## ADR-0013 — Pricing precedence is enforced in one SQL function

**Context.** Precedence is: the customer group's price list (falling back to the retail list), then
active promotions by priority, then a manual discount for a role that is allowed one. If the till,
the cart API and any future channel each implement this, they will drift.

**Decision.** `app.get_price` (single variant) and `app.get_prices` (batched cart) own the ordering,
and `app.apply_promotions` owns the promotion rules (highest priority is the primary; further
promotions apply only when both it and the primary are stackable). `app.assert_manual_discount` owns
the manual-discount cap and the reason requirement. The TypeScript layer only marshals input and
formats output. Both pricing functions are `language sql`, `security invoker`, with no
`set search_path` clause, so the planner can inline them and use the `price_list_items` index.

**Consequence.** A cart of N items costs one batched query (plus, on a cold cache, one candidates
read), never N. `tests/retail-r2.test.ts` counts the round trips and asserts `EXPLAIN` shows
`price_list_items_list_variant_key`.

## ADR-0014 — The POS idempotency key lives on a small claim table, not on `pos_sales`

**Context.** R3 asks for a `unique (org_id, client_sale_id)` constraint on `pos_sales` so that a
retried sale (the terminal re-sends after a dropped response) does not ring twice. `pos_sales` is
also required to be partitioned monthly on `created_at`. Postgres requires every unique constraint on
a partitioned table to include all of the partitioning columns, so `unique (org_id, client_sale_id)`
cannot exist on `pos_sales` — it would have to be `unique (org_id, client_sale_id, created_at)`,
which does not prevent a duplicate with a different `created_at`. This was confirmed against the
running Postgres with a probe table.

**Decision.** The claim is enforced on `pos_sale_keys`, a small non-partitioned org-scoped table with
`unique (org_id, client_sale_id)`. `app.post_pos_sale` inserts the claim as its first statement. A
duplicate key raises a unique violation, the function catches it, looks up the original sale through
the claim row and returns the original receipt unchanged. The retry therefore consumes no invoice
number, takes no stock and posts no second journal. `pos_sales` keeps the required indexes
`(org_id, branch_id, created_at desc, id desc)` and `(org_id, branch_id, shift_id)`.

**Consequence.** `tests/pos-r3.test.ts` retries a sale with the same `client_sale_id` and asserts the
same `sale_id` and `invoice_no` come back and that exactly one `pos_sales` row exists. The unique
constraint the brief asks for exists in the schema, on the table where Postgres can enforce it. The
claim table is mutable in the sense that it is inserted once and never updated; it carries no money
and is rebuildable from `pos_sales`.

## ADR-0015 — The allow-negative hook is a transaction-local GUC read by the core posting functions

**Context.** R4 requires that a sale completed offline is never rejected, even when the stock it
sold is gone by the time it syncs. The core rejects an outbound movement beyond available stock
unless the warehouse's `allow_negative_stock` is set, and that setting belongs to the warehouse, not
to a single caller. Flipping it on the warehouse to accept one backlog sale would permanently permit
overselling for every later sale at that till, which is not acceptable.

`app.create_invoice` and `app.consume_fifo` are the two places that raise `insufficient stock`. They
live in applied migrations, and an applied migration is never edited (AGENTS.md).

**Decision.** Add a transaction-local escape hatch read by those functions:

* `app.negative_stock_allowed()` returns true when the GUC `app.allow_negative_stock` is `on`.
* The R4 migration re-creates `app.create_invoice` and `app.consume_fifo` verbatim, changing only
  the availability guard to `not (coalesce(v_allow_neg, false) or app.negative_stock_allowed())`.
* The sync path sets the GUC for its transaction with `set_config('app.allow_negative_stock','on',
  true)` and only for the retry attempt. The live-sale path never sets it, so the live till keeps
  the strict rule.

Re-creating a function in a new migration is additive: the applied migration is untouched, and the
newest definition wins for every later caller.

**Consequence.** A backlog sale always posts, and the shortfall is valued at the most recent inbound
cost (the existing negative branch of `consume_fifo`). The GUC is transaction-local, so it cannot
leak to another request on the same pooled connection. Every accepted shortfall is written to
`pos_sync_exceptions` as `negative_stock`, so the oversell is visible rather than silent.
`tests/pos-r4.test.ts` test 17 proves the live path still rejects and the sync path accepts.

## ADR-0016 — The sync endpoint never rejects a completed sale; it records an exception

**Context.** An offline till can ring a sale the server would refuse today: the price moved, a
promotion expired, or the stock is gone. The brief is explicit: never reject a completed sale. But
accepting it silently would hide a real disagreement between what the customer was charged and what
the server would charge now.

**Decision.** `POST /api/pos/sync` runs each sale in its own transaction and reports it as
`committed`, `duplicate` or `exception`. Within a sale:

1. A `client_sale_id` that already has a posted sale is a `duplicate`; the original receipt is
   returned and nothing is posted (the `pos_sale_keys` claim of ADR-0014).
2. The charged unit price is kept, never re-priced. When it differs from the current price, a
   `price_variance` row is written to `pos_sync_exceptions`.
3. When the charged price is below the current price and an expired promotion would have explained
   it, a `promotion_expired` row is written and the charged price still stands.
4. When stock is short, the sale is retried with the allow-negative hook (ADR-0015) and a
   `negative_stock` row is written.
5. A sale that cannot post for any other reason (unknown barcode, malformed tender) is reported as
   `exception` and a `rejected` row is written in its own transaction, so it survives the rollback.

Only a malformed sale is refused; a sale that is merely out of date is accepted and logged. The
response carries the per-sale outcome and the ids of any exceptions raised.

**Consequence.** The batch is fault-isolated: one bad sale cannot block the other 49. The till
removes an outbox entry only when the server reports `committed` or `duplicate`, so a `rejected`
sale stays queued for the operator. `tests/pos-r4.test.ts` tests 16 and 17 cover the duplicate and
negative-stock paths.

## ADR-0017 — The offline outbox lives in IndexedDB and syncs one sale per transaction

**Context.** The till must keep selling when the network is down. A completed sale has already
taken the customer's cash, so losing it is not an option, and ringing it twice is not an option
either. The server also has to stay the source of truth: stock, prices and the ledger are decided
there, not on the terminal.

**Decision.**

1. **Storage.** Each offline sale is written to an IndexedDB object store (`erp-pos-outbox`,
   `src/verticals/pos/outbox.ts`) before the network call. IndexedDB is transactional and survives a
   reload, a crash or a flat battery; the cart's in-memory state does not. The entry keeps the
   `client_sale_id` generated at sale time, the `shift_id`, the till's local timestamp, the lines
   with the prices actually charged, the promotions that applied, and the tenders.
2. **Delivery.** `POST /api/pos/sync` accepts up to 50 sales per request. Each sale runs in its own
   transaction on its own pooled connection (`src/verticals/pos/syncServer.ts`), under the caller's
   RLS context, so one bad sale cannot roll back the other 49. The till's drain loop
   (`src/verticals/pos/sync.ts`) keeps exactly one request in flight, so two ticks cannot deliver
   the same sale twice.
3. **Idempotency.** The `client_sale_id` is the idempotency key on both paths (ADR-0014). A sale
   that already posted is a `duplicate`; the original receipt is returned and nothing is posted.
4. **Retries.** An entry is removed from the outbox only when the server reports `committed` or
   `duplicate`. Anything else stays queued and is retried with exponential backoff and full jitter,
   capped at five minutes.
5. **Never reject a completed sale.** A sale that the strict rules would refuse (short stock, moved
   price, expired promotion) is accepted and logged (ADR-0016). The live path keeps the strict
   rules; only the sync path relaxes them, and only through the transaction-local hook (ADR-0015).

**Consequence.** The outbox is a durable client-side queue whose entries are removed only on a
positive server acknowledgement, so the design is at-least-once with server-side deduplication
rather than at-most-once. A duplicate delivery is a no-op, which is the property that makes the
retries safe. `tests/pos-r4.test.ts` covers survival across a reload (test 14), a full drain
(test 15), duplicate delivery (test 16) and the oversell path (test 17); `e2e/pos-offline.e2e.ts`
covers the reload-and-reconnect flow end to end.

## ADR-0018 — Live sales are rate limited in Redis; the sync backlog is exempt

**Context.** A runaway till (a stuck key, a retry loop, a script) can hammer `POST /api/pos/sales`.
The brief allows Redis for counters and the promotion cache, with keys prefixed by `org_id`. It also
requires that a backlog of completed sales never be throttled away.

**Decision.** Live sales are limited to 30 per minute per cashier. The counter is a fixed-window
counter in Redis (`ratelimit:livesale:{org_id}:{branch_id}:{cashier_id}:{window}`), incremented with
`INCR` and given a TTL on first increment, so the key is prefixed by the org and Redis holds a
counter and nothing else. A request past the limit gets `429` with `Retry-After` and the existing
`{"error": "..."}` body.

`POST /api/pos/sync` is deliberately exempt. It carries sales that are already complete; refusing a
backlog would strand money that has already changed hands. Only the live path is limited.

**Consequence.** The limit is per cashier, so one cashier cannot exhaust another's budget, and the
ledger is unaware of the limiter. Losing the Redis keys costs at most a fresh window; nothing
durable lives there. `tests/pos-r4.test.ts` test 18 proves the 31st live sale is `429` while a
100-sale backlog syncs with no `429`.

## ADR-0019 — Operations post through a balanced-journal hook, and the core tables get additive changes

**Context.** R5 (Operations) adds laybys, returns, credit limits, Z-reports and stock counts. Three
of these move money: a layby deposit (Dr Bank, Cr Customer Deposits), a layby cancellation (Dr
Customer Deposits, Cr Bank and Cr Fee Income) and a return refund (Dr AR, Cr Bank or Cr Store
Credit). Every one of them must post a balanced journal, and the ledger must balance at commit.

The brief names the hook `balanced-journal…` (the message was truncated). It also requires that an
operational journal not be posted by calling `app.post_journal` ad hoc from each function, because
a single mistyped line would only be caught at commit by the deferred trigger.

**Decision.**

1. **One hook.** `app.post_balanced_journal(org_id, branch_id, posting_date, source_type,
   source_id, memo, currency, lines)` sums the debits and credits of the incoming lines, raises
   `23514` with a clear message when they differ, and then delegates to `app.post_journal`. Every
   operational journal goes through it. It is an *earlier* guard, not a replacement: the deferred
   `journals` balance trigger still runs at commit.
2. **Additive core changes** (all recorded here because they touch shared tables):
   * `settings` gains `layby_deposit_percent`, `layby_cancellation_fee` and `return_refund_method`.
   * Three new default accounts (`2300 Customer Deposits`, `2400 Store Credit`, `4600 Layby
     Cancellation Fees`) and four new number series (`LAYBY`, `RETURN`, `Z_REPORT`,
     `STOCK_COUNT`) are added to the org-creation triggers. Existing orgs keep what they have; this
     phase creates orgs only through `app.create_org`.
   * `journals.source_type` gains `layby_deposit`, `layby_cancellation` and `return_refund`;
     `stock_ledger.source_type` gains `layby`.
   * A new index `invoices (org_id, contact_id, created_at desc, id desc)` for the credit check's
     open-balance sum and a customer's keyset invoice listing.
3. **Z-reports are immutable.** `z_reports` is forced-RLS and passed through
   `app.enforce_immutable`, like the ledger tables. It is the only thing a daily summary reads;
   there is no materialized view and no running total on each sale.

**Consequence.** Every operational journal is balanced by construction, and the deferred trigger
remains the last line of defence. The additive changes are visible to any later phase. Re-creating
`app.create_default_accounts` and `app.create_default_number_series` in the R5 migration is
additive: the applied migrations are untouched and the newest definition wins.

## ADR-0020 — Credit limits serialise on the contact row, not on the invoice sum

**Context.** A credit limit must hold under concurrency: twenty simultaneous credit sales must not
each read the same headroom and each pass. The naive check (`select sum(total - amount_paid) ...`
then insert) is a classic read-then-write race, because two transactions can read the same sum
before either writes.

**Decision.** `app.check_credit` first takes `select ... from contacts where id = $contact for
update`. That row lock serialises every credit check for one customer, so each transaction sees the
sum the previous one committed. The check then compares `open + amount` against the ceiling and
raises `23514` when it would exceed it. A customer with no `credit_limits` row has no ceiling and is
allowed.

**Consequence.** Credit checks for one customer are serialised (a deliberate cost: correctness over
throughput for a single customer), while different customers never block each other. The lock order
is the contact first, then stock, which is a different resource than the stock lock order, so no new
deadlock cycle is introduced. `tests/ops-r5.test.ts` test 23 proves 20 concurrent 10-unit credit
sales against a 100 ceiling leave exactly 10 committed and the open balance at exactly 100.

## ADR-0021 — A layby reserves stock by consuming FIFO at creation; a stock count posts one journal

**Context.** Two R5 operations touch stock in ways the core functions do not cover.

A layby holds goods aside until collection, but the brief says a reservation is a *mutable
operational row*, not a ledger row. Left as a pure reservation, the goods would still be sellable
to someone else, and the layby could not be collected.

A stock count produces one variance per line. The core `app.post_stock_adjustment` posts one journal
per movement, so a 500-line count would post 500 journals, which is neither reviewable nor what the
brief asks for.

**Decision.**

* **Layby reservation.** `app.create_layby` consumes the FIFO layers at creation, in the core's
  ascending `(warehouse_id, product_id)` lock order, and records the reserved cost on
  `layby_reservations`. The goods therefore leave the available pool immediately. Collection
  (`app.complete_layby`) writes the invoice for the reserved goods at that reserved cost — it does
  not call `app.create_invoice`, which would consume FIFO a second time. Cancellation
  (`app.cancel_layby`) returns the stock as a new inbound layer at the reserved cost.
* **One journal per count.** `app.close_stock_count` writes one ledger row per variance (a new
  inbound layer for a surplus, a FIFO consumption for a shortfall) but posts a **single** journal
  for the whole count: Dr/Cr Inventory against Dr/Cr Inventory Adjustment, aggregated over the
  lines.

**Consequence.** A layby's stock cannot be oversold while it is open, and a large stock count is one
reviewable journal. The reservation is still an operational row: it is mutable (its `status` moves
from `reserved` to `collected` or `released`), which is why it lives outside the immutable ledger
and carries a mutable status rather than a reversing entry. `tests/ops-r5.test.ts` tests 19 to 21
and 24 cover the deposit journal, collection, cancellation and the single count journal.

## ADR-0022 — The fiscal adapter is queue-only, and blocking mode is an open item

**Context.** R6 adds the fiscal integration adapter. The brief is explicit that the mode must not be
chosen by assumption: if the ZIMRA rule requires printing at the moment of sale, the adapter must
stop after the queue is built and the question must be recorded as an open item. The brief also
requires that, beyond inserting a job row, the adapter never sits on the critical path of a sale.

ADR-0003 already records that no ZIMRA-specific format or fiscal device integration was built in
Phase 1. R6 builds the *queue*, not the device.

**Decision.**

1. **Queue-only, mode `none` or `async`.** `public.fiscal_device_integration` carries a per-branch
   `mode` whose check constraint is `mode in ('none', 'async')`. There is deliberately **no
   `blocking` mode** in this run. The constraint rejects any other value, so the decision cannot be
   made by accident, and a blocking mode is a separate future run with its own ADR.
2. **The sale path does one insert and nothing else.** An `AFTER INSERT` trigger on the partitioned
   `pos_sales` parent (`app.fiscal_enqueue_on_sale`) calls `app.enqueue_fiscal_job`, which inserts
   exactly one row into `public.fiscal_jobs` when the branch mode is `async`. It makes no network
   call and waits for nothing. A sale with mode `none`, or with no integration row, is untouched and
   never errors. Because the trigger runs in the sale's own transaction, a committed sale has queued
   its job or has none to queue; a rolled-back sale leaves no job.
3. **The queue is append-only, and delivery state is derived.** `public.fiscal_jobs` and
   `public.fiscal_job_attempts` are passed through `app.enforce_immutable`, exactly like the ledger
   tables: no UPDATE, no DELETE, and the privileges are revoked from `authenticated`. A job row is
   born `queued` and never changes; each delivery attempt appends a row, and a `sent` attempt is what
   marks a job done. `unique (org_id, sale_id)` on `fiscal_jobs` makes "exactly one job per sale"
   hold even if the enqueue is retried.
4. **Backoff lives in SQL.** `app.fiscal_jobs_due` returns the queued, not-yet-sent jobs whose
   exponential backoff (base 30s, capped 1h) has elapsed, so the worker (`src/fiscal/worker.ts`) and
   the database agree on when a job is next due. An unreachable device records an `unreachable`
   attempt; the job stays queued and becomes due again later. It is never dropped and never blocks
   anything else.

**Consequence.** A sale never depends on the fiscal device: it commits whether or not the device can
be reached, and whether or not the device exists. `tests/fiscal-r6.test.ts` test 25 proves that with
mode `async` and an unreachable device the sale commits and exactly one job is queued, and the
adapter tests check queueing and non-blocking behaviour only — never compliance.

### Open item — does ZIMRA require printing at the moment of sale?

This is **not** decided here, and the adapter stops short of it. If the ZIMRA rule turns out to
require the fiscal receipt to be printed (or the device to acknowledge) *at the moment of sale*,
then a **blocking mode** is needed: the sale would have to wait for the device before committing.
That is a separate future run. It would add a `blocking` value to the mode constraint, a transport
with a real timeout, and a decision about what a sale does when the device does not answer (refuse
the sale, or fall back to `async`). None of that is built now, and nothing in this run should be read
as a compliance claim. The numbering abstraction (`number_series` + `next_number()`, ADR-0003) and
the job queue built here are the two places such a run would hook into.

## ADR-0023 — Branch mode is one codebase and one migration set, switched by `BRANCH_MODE`

**Context.** H1 makes a branch able to run on a shop LAN with the internet down. The obvious
alternative is a separate branch codebase, or a branch-only migration set. Both would drift: the
branch would slowly diverge from the cloud, and the schema would have two truths.

The brief fixes the deployment shape: a branch runs a custom Next.js server (not Supabase's own
server), with a local Postgres and a local PIN sign-in, and the cloud keeps Supabase Auth, Realtime
and Redis.

**Decision.**

1. **One codebase, one build, two modes.** `src/branch/config.ts` reads `BRANCH_MODE` (`cloud` by
   default; `branch` when explicitly set). Every branch-only behaviour is behind `isBranchMode()`.
   The cloud behaviour is the default, so an unset variable is never branch mode.
2. **One migration set.** A branch runs the same `supabase/migrations/` as the cloud. H1 adds only
   *additive* tables and functions; it edits no applied migration and no core accounting path. The
   brief is explicit: a vertical (and a branch) may depend on core functions but must never edit core
   tables without an ADR. The branch-only tables (`device_registrations`, `cashier_pins`,
   `sync_state`) live in the same public schema, tenant-scoped and RLS-forced like every other.
3. **The branch serves the build itself.** `scripts/branch-server.mjs` serves the same Next.js build
   over HTTPS on the LAN when `TLS_CERT_FILE`/`TLS_KEY_FILE` are set, and over HTTP otherwise. The
   cloud keeps `next start`. `scripts/branch-https.sh` issues the self-signed LAN certificate.

**Consequence.** A cloud change is automatically a branch change, and a schema change is applied
identically on both sides. The cost is that branch-only code paths must be guarded, which the
`isBranchMode()` checks make explicit and testable.

## ADR-0024 — A device is registered with a one-time code, and only hashes are stored

**Context.** A till must be able to talk to the branch, and the branch must be able to tell one till
from another. The brief requires the same care as an invite token: single use, expiring, and stored
hashed, with no plaintext in the table.

**Decision.**

1. `app.create_device_registration(...)` mints a random code, stores **only its sha256 hash**
   (`code_hash`) and an expiry (24 hours by default), and returns the raw code once. The raw code is
   never written to a column.
2. `app.register_device(...)` redeems the code **once**: it locks the row `FOR UPDATE`, rejects a
   consumed, expired or unknown code, and on success stores **only the sha256 hash of the issued
   device token** (`device_token_hash`). The raw token is returned once.
3. `app.authenticate_device(...)` verifies a token by comparing its hash, and rejects a revoked
   device. `unique (code_hash)` and `unique (device_token_hash)` make a collision impossible to
   mistake for a valid redemption.
4. The pattern mirrors `app.create_invite`/`app.accept_invite` (M1), which the brief points at.

**Consequence.** `tests/branch-h1.test.ts` test 49 asserts that neither the code nor the token
appears in the table, that both stored values are 64-hex digests, and that a second redemption of the
same code fails. A database dump cannot be used to impersonate a till.

## ADR-0025 — The branch and the cloud carry a sync protocol version, and a mismatch blocks push

**Context.** The branch and the cloud evolve independently. A branch that pushes an event shape the
cloud does not understand must not corrupt the cloud, and a cloud that has moved on must not silently
misread an old branch. The brief makes this decision 17: the branch must refuse to push to a cloud
whose version it does not understand, and show a warning.

**Decision.**

1. The branch carries a protocol version: `app.branch_protocol_version()` in SQL (a constant) and
   `BRANCH_PROTOCOL_VERSION` in `src/branch/config.ts`. The two must be bumped together, in a
   migration, with an ADR.
2. `probeCloud` (in `src/branch/connectivity.ts`) compares the cloud's reported version to the
   branch's. A reachable cloud on a different version yields `incompatible`; a reachable cloud on the
   same version yields `online`; anything unreachable yields `offline`.
3. The branch stores its observation in `public.sync_state` (`cloud_status`,
   `cloud_protocol_version`, `last_cloud_contact_at`), so a health read does not have to reach the
   cloud. An `incompatible` status sets `push_blocked`, and the till shows a version-mismatch warning
   while still selling locally.
4. The cloud is master: the branch is the one that must be upgraded.

**Consequence.** A version skew is visible on the till and stops the push, rather than corrupting the
cloud. `tests/branch-h1.test.ts` test 51 covers `online`, `offline` and `incompatible`.

## ADR-0026 — H1 test numbering continues from 48, and the H1 spec's 16–18 map to 49–51

**Context.** The H1 brief numbers its tests 16, 17 and 18. Those numbers are already taken: R4 owns
tests 14–18 and R5 owns 19–24. ADR-0010 already fixed the rule: a new run continues from the highest
number actually present, not from a range reserved elsewhere.

**Decision.** H1 owns **49, 50 and 51** in `tests/branch-h1.test.ts`, plus supporting tests in the
same file and `tests/branch-https.test.ts`. The mapping is:

| H1 spec | Canonical | Test |
| --- | --- | --- |
| 16 | 49 | A device is registered with a one-time code; only hashes are stored, single use |
| 17 | 50 | A cashier signs in with a local PIN; five wrong PINs lock it; manager override |
| 18 | 51 | Branch health reports the cloud offline when unreachable; the branch keeps selling |
| — | 52 | e2e: the branch till shows cloud-offline and still sells on the LAN (`e2e/branch-offline.e2e.ts`) |

**Consequence.** No number is reused and no test is dropped. The H1 spec's numbers are recorded here
so a reader following the brief can find the right test.

## ADR-0027 — Redis is cloud-only; a branch uses in-process caches and the local database

**Context.** The brief makes decision 13: a branch has no Redis. Redis in this codebase is never a
source of truth; it holds a promotion *candidate* cache (R2) and a live-sale *rate-limit counter*
(R4). Both must keep working on a branch with no Redis.

**Decision.**

1. `src/branch/cache.ts` provides an in-process, TTL-aware map with the same fixed-window semantics
   as the Redis counter (`INCR` + `EXPIRE`, TTL set only when the window opens) and a `PromoCache`
   stand-in.
2. `redisCounterStore()` (R4) returns the in-process store when `isBranchMode()`, and the Redis store
   otherwise. The cloud path is byte-for-byte unchanged.
3. `defaultPromoCache()` (R2) returns the in-process cache when `isBranchMode()`, and the Redis cache
   otherwise. The promotion validity window is still re-checked in SQL at evaluation time on both
   sides, so an in-process entry cannot apply an expired promotion.
4. Nothing else in the branch reads Redis. The branch's durable state is its local Postgres, which
   carries the same immutable ledger.

**Consequence.** A branch needs only its own Postgres. The caches rebuild from the database on a
miss, so a restart loses nothing that matters. `tests/branch-h1.test.ts` covers the counter's window
semantics.

## ADR-0028 — The branch outbox is an append-only event log written by triggers in the fact's transaction

**Context.** H2 syncs a branch's financial and stock facts to the cloud. The events must be exactly
the facts that committed, in a fixed order, and must survive a crash and a re-push without
double-posting.

**Decision.**

1. `public.sync_outbox` is an append-only log. Its `bigserial seq` is the ORDER; the event's UUID
   (`event_id`) is the idempotency key. Order never follows the wall clock, so a branch clock that
   is set back changes nothing.
2. The events are written by `AFTER INSERT` triggers on the source tables (`pos_sales`, `stock_ledger`,
   `payments`, `credit_notes`), each gated on `app.branch_mode_enabled()`. Because the trigger runs in
   the same transaction as the fact, the event and the fact commit together or not at all: a
   rolled-back sale leaves no event.
3. A POS sale writes exactly ONE `sale` event. Its tenders are part of the sale (the payment trigger
   skips a payment whose invoice belongs to a POS sale) and its outbound stock movements are part of
   the sale (the stock trigger skips movements whose source is an invoice).
4. The only mutable column is `acked_at`, and it moves null -> not null once, enforced by
   `app.sync_outbox_guard()`. There is no delete. `authenticated` gets no UPDATE/DELETE grant.

**Consequence.** The outbox cannot drift from the ledger. A crash mid-push re-pushes the same batch,
and the cloud dedupes it (ADR-0029). Tests 53 and 62 cover the write and the restart.

## ADR-0029 — The cloud dedupes by event UUID; a push batch commits in one transaction with a savepoint per event

**Context.** A push may be retried (a network drop after the cloud committed but before the branch
saw the reply). The cloud must apply each event exactly once, and one bad event must not discard the
rest of the batch.

**Decision.**

1. The cloud's `public.sync_inbox` has `unique (org_id, event_id)`. `app.sync_inbox_apply` inserts
   `ON CONFLICT (org_id, event_id) DO NOTHING`. A re-pushed event is a no-op. This is the whole dedupe
   story.
2. `app.sync_push_result` applies a whole batch in ONE transaction, each event inside its own
   `BEGIN ... EXCEPTION` block (a savepoint). A rejected event rolls back only its own work and is
   reported in `rejects`; the rest of the batch commits.
3. The cloud returns `highest_seq` (the highest sequence applied). The branch acks up to it. A
   rejected event stops the ack before it, so the branch records a conflict and re-pushes from there.

**Consequence.** At-least-once delivery plus idempotent apply equals exactly-once effect. Tests 54
and 56 cover the dedupe and the rejection.

## ADR-0030 — Master data is pulled through a per-org monotonic change log; the branch mirror is a rebuildable cache

**Context.** The branch must price and show products from its LOCAL database with no cloud round
trip, yet the cloud owns master data (products, prices, tax rates). The branch needs an ordered,
gap-free way to catch up.

**Decision.**

1. The cloud appends every master-data change to `public.master_data_changes` and assigns a per-org
   monotonic `change_seq` (the org row is locked so two writers cannot collide).
2. The branch pulls "changes after my cursor" with `app.sync_pull_batch`, applies them to
   `public.branch_master_data` with `app.sync_apply_pull`, and stores the cursor forward-only in
   `public.sync_state`.
3. `public.branch_master_data` is a MUTABLE cache. It is allowed because it is rebuildable from the
   immutable change log: dropping it and re-pulling every `change_seq` reproduces it exactly
   (Phase 1 decision: a mutable cache is allowed only when it can be rebuilt from an immutable
   ledger).
4. A price row carries `price_version` (the `change_seq` at which its price last changed), so a sale
   records the version it charged and a later price change cannot rewrite history.

**Consequence.** The branch serves prices locally and stays consistent when it reconnects. Tests 58
and 59 cover the ordering, the forward-only cursor and the version bump.

## ADR-0031 — Only a cloud rejection is a conflict; a network failure retries forever with jittered backoff

**Context.** The brief distinguishes a transient failure (retry) from a real refusal (a conflict).
Conflating them either loses data (treating a timeout as a conflict) or loops forever (treating a
refusal as transient).

**Decision.**

1. `SyncNetworkError` and `SyncServerError` (a 5xx) are retryable. The branch retries with
   exponential backoff and full jitter, capped at 5 minutes (`src/sync/retry.ts`).
2. `SyncRejectionError` (a 4xx that names events) is not retryable. The branch records each rejected
   event in `public.sync_conflicts` and acks past it so it can make progress.
3. A conflict row therefore always means the cloud refused the event; a network failure never writes
   one.

**Consequence.** A flaky link never loses a sale and never produces a spurious conflict. Test 57
covers the policy; test 56 covers the conflict write.

## ADR-0032 — The branch backup is encrypted in memory before upload, and the checksum is of the ciphertext

**Context.** A branch's disk can die. The branch must be able to back its own database up to cloud
storage without the cloud ever seeing plaintext financial data, and a restore must detect a truncated
or tampered upload.

**Decision.**

1. `src/sync/backup.ts` dumps the branch Postgres, encrypts the dump with AES-256-GCM
   (`iv || tag || ciphertext`) using a 32-byte key from `BRANCH_BACKUP_KEY`, and uploads only the
   ciphertext.
2. The recorded `checksum` is the sha256 of the WHOLE encrypted file, so a partial or altered upload
   fails verification. `checksumMatches` compares in constant time.
3. The upload is behind an `Uploader` interface: a presigned cloud URL when `BRANCH_BACKUP_UPLOAD_URL`
   is set, else a local directory. The run is recorded in `public.sync_backups` as `running`, then
   `uploaded` or `failed` with the error.

**Consequence.** The cloud stores only ciphertext, and a failed run is visible rather than silent.
Test 63 covers the encryption round trip, the tamper detection and the failure record.

## ADR-0033 — H2 test numbering continues from 52; the H2 brief's example names map to 53–63

**Context.** H1 owns 49–52. The H2 brief describes behaviours rather than fixed numbers, so the new
tests continue from the highest number actually present (ADR-0010, ADR-0026).

**Decision.** H2 owns **53–63** in `tests/sync-h2.test.ts`, plus supporting tests in the same file.
The mapping is:

| H2 behaviour | Canonical | Test |
| --- | --- | --- |
| Outbox write, one event per sale, atomic with the fact | 53 | A completed sale writes one outbox event; a rollback writes none |
| Exactly-once apply / dedupe | 54 | A batch applies once; a re-push is all duplicates |
| Outbox immutability | 55 | DELETE rejected; acked_at is write-once; other columns immutable |
| Ack prefix and conflict on rejection | 56 | Only the applied prefix is acked; a rejection is a conflict |
| Retryable vs conflict | 57 | Network is retryable; a rejection is a conflict |
| Pull ordering and forward-only cursor | 58 | Changes come in change_seq order; the cursor never rewinds |
| Price mirror and versioning | 59 | Local price serves; a later change bumps the version |
| Cloud inertness | 60 | With branch mode off, no outbox rows are written |
| RLS on the sync tables | 61 | Org A cannot read Org B sync rows |
| Kill-and-restart | 62 | An interrupted push re-pushes; the cloud dedupes |
| Encrypted backup | 63 | Encrypt, checksum, tamper-detect, record failure |

**Consequence.** No number is reused and no test is dropped.

## ADR-0034 — The cloud replays each branch event once into its own ledger, deduped by event UUID

**Context.** The branch is the system of record for the sales it rings (ADR-0023): it holds an
immutable ledger locally and keeps selling with the cloud down. When a branch pushes an event, the
cloud must end up with the same facts — but a push is at-least-once, so the cloud must not apply an
event twice.

**Decision.** The cloud replays each event into its OWN tables through the SAME posting functions a
live sale uses (`app.sync_replay_sale` → `app.sync_pos_sale` → `app.create_invoice`, and the receipt,
adjustment and payment replays likewise). Two independent mechanisms make the replay idempotent:

1. The inbox claim. `app.sync_apply_event` first inserts into `public.sync_inbox` with
   `ON CONFLICT (org_id, event_id) DO NOTHING`. When the insert claims nothing, the event is a
   duplicate and the replay is skipped.
2. The posting functions are themselves idempotent on the natural key the payload carries
   (`app.sync_pos_sale` on `client_sale_id`), so even two events that carried the same sale cannot
   double-post.

The branch and the cloud are separate Postgres instances in production, so a replayed sale takes the
CLOUD's own gapless invoice number and consumes the CLOUD's own FIFO layers; each side keeps a
consistent ledger and the event UUID ties them together. (When a test harness points both sides at
one physical database, the branch's own row already claimed the `client_sale_id`, so the replay is a
no-op there — still no double-post.)

Two deliberate limits in this phase:

* Branch-local ids the cloud does not have (a shift) are not replayed; the branch's own `pos_sales`
  row keeps them.
* The credit-note event carries no line detail, so `app.sync_replay_credit_note` only records the
  inbox row (so the event is not lost or re-applied) and leaves the reversal to reconciliation. A
  full credit-note replay needs the note's lines in the payload — an H3 item.

**Consequence.** Pushing is safe to retry and never double-posts. Tests 54, 56 and 62 pin the
idempotency.

## ADR-0035 — Fiscal submission is branch-only; the cloud's write path stays free of fiscal rows

**Context.** H3 adds a fiscal invoice queue (`fiscal_invoices`) that must submit reliably after
outages. The branch is the system of record for the sales it rings (ADR-0023) and the FDMS device
lives at the branch. The cloud replays a branch's events into its own ledger (ADR-0034), so a naive
"enqueue on every invoice" would also queue fiscal rows on the cloud — for invoices the cloud never
sells at a till and has no device to submit.

**Decision.** The fiscal enqueue is gated by `app.branch_mode_enabled()`, exactly like the H2 outbox
triggers. `app.create_invoice` and `app.pos_sale_receipt` call `app.fiscal_invoice_enqueue` in the
invoice's own transaction, but the enqueue is a no-op unless `app.branch_mode` is on. The cloud's
replayed invoices therefore never queue fiscal rows, and the cloud never talks to FDMS.

**Consequence.** The cloud and branch share one `fiscal_invoices` table and one set of functions; the
GUC decides who queues. A cloud test that does not set `app.branch_mode=branch` sees no fiscal rows
(that is what test 60 in the H2 suite already asserts for the outbox, and it stays true for fiscal).
Tests that exercise the branch set the GUC on their connection.

## ADR-0036 — Invoice numbering uses cloud-issued, branch-local number blocks; exhaustion is a catchable error

**Context.** The core already draws gapless invoice numbers from `number_series` with a
`SELECT ... FOR UPDATE` (ADR-0004). That is correct on the cloud, where every request can reach the
series row. A branch that keeps selling while offline cannot lock the cloud's row, so it needs a
range of numbers it owns locally — but those ranges must never overlap another branch's, and a
number must never be reused.

**Decision.** The cloud issues **blocks**: `app.issue_number_block` carves a contiguous range from
the org's `number_series` row under a `FOR UPDATE` lock (`block_no = last_block_no + 1`,
`first_value = next_value`, `last_value = next_value + size - 1`) and advances the series past the
block. The branch stores the block in `public.number_blocks` (`app.store_number_block`, idempotent on
`(org_id, branch_id, series_code, block_no)`). `app.claim_invoice_number` takes the next number from
the branch's **oldest** block that still has numbers, so topping up early never leaves a gap; it
raises `'invoice number block exhausted...'` when no block has a number left. `app.next_number` for
the `INVOICE` series is redirected to `app.claim_invoice_number`, so `app.create_invoice` is
unchanged in shape. A branch that has never been issued a block falls back to the org series
(no behaviour change for the cloud or the existing core tests).

The branch asks for the next block **before** the current one runs out: `ensureNextBlock` fetches a
block when the remaining count reaches the low-water mark, and a failed fetch is a no-op, so an
offline branch keeps selling from what it has.

**Consequence.** Two branches can never be issued the same number (the cloud lock serialises block
issuance), a number is never reused (numbers only advance), and an offline branch fails a sale with
a clear, catchable error only when it has truly run out. Test 67 pins the top-up and the exhaustion
error; test 39 (100 concurrent invoices, gapless) still passes because the fallback path is
unchanged when no block exists.

## ADR-0037 — The FDMS client is an interface; a mock with real state exercises the outage paths

**Context.** H3 must show that fiscal invoices submit reliably after outages and that a real
rejection is handled differently from a network outage. Real ZIMRA integration (the exact wire
format, the device certificate flow) is an open item (ADR-0003), and the gate must run with no
network.

**Decision.** `src/fiscal/fdms.ts` defines `FdmsClient` with three outcomes: `sent` (accepted, with
a signature and QR), `failed` (a real FDMS rejection — counts against the 5-attempt budget), and
`unreachable` (a network outage — the row stays pending and the attempt count is untouched). Two
implementations: `MockFdmsClient` (a real object with real state — an outage switch, a rejection
counter, and a record of every invoice it accepted) and `httpFdmsClient` (POSTs to the configured
endpoint; a transport error is `unreachable`, a non-2xx is `failed`). The gate uses the mock; the
HTTP client needs credentials from the environment and is not exercised by the gate.

**Consequence.** The outage behaviour (queue, stay pending, no attempt counted, submit exactly once
on recovery) is tested against real Postgres with no network. The device is not mocked in the
"fake the database" sense: the mock is the device, and it is the same interface the real device
implements.

## ADR-0038 — H3 test numbering continues from 63; H3 owns 64–68

**Context.** H1 owns 49–52, H2 owns 53–63 (ADR-0033). The H3 brief describes behaviours rather than
fixed numbers, so the new tests continue from the highest number present (ADR-0010, ADR-0026).

**Decision.** H3 owns **64–68** in `tests/fiscal-h3.test.ts`:

| H3 behaviour | Canonical | Test |
| --- | --- | --- |
| Pending fiscal row enqueued in the sale's own transaction | 64 | A sale inserts its pending fiscal row; a rollback inserts none |
| Real rejection retries with backoff; 5 rejections fail | 65 | Backoff, the attempt cap, and the append-only attempts |
| Outage keeps the row pending and does not count an attempt | 65b | A network outage is not a rejection |
| Reliable submission after an outage, exactly once | 66 | 10 sales queue while down; all 10 submit once on recovery |
| Number blocks: top up before exhaustion; clear error; no reuse | 67 | The block is refilled early; offline exhaustion fails clearly |
| Two workers never submit the same invoice twice | 68 | Concurrent passes with SKIP LOCKED submit each invoice once |

**Consequence.** No number is reused and no test is dropped. The prior 63 tests are untouched.

## ADR-0039 — Printer settings live in the database; the relay is branch-side and outbound-only

**Context.** H4 must print a 58mm ESC/POS receipt. A branch may have a network thermal printer on the
shop LAN (`host:port`, usually 9100), or may print through the browser dialog. The destination must be
the same for every till in the branch, survive a re-imaged till, and never require the cloud to reach
into a shop LAN. Decision 16 is that the branch opens the socket, outbound only.

**Decision.** The configuration lives in `public.printer_settings` (org + branch, one active row per
`label`), read and written through `app.get_printer_settings` / `app.set_printer_settings`. `mode` is
`browser` or `network`; a `network` row must carry a host (a table check enforces it, and the setter
clears the host in browser mode). The **relay itself is not in SQL**: the till generates the ESC/POS
bytes, sends them to the branch (`POST /api/branch/print`) as base64 inside JSON — a transport
encoding, nothing more — and the branch decodes them and writes the raw bytes to the socket. Only the
branch relays; the route refuses on the cloud with 409. The byte generator (`generateEscPos`) is pure,
so the same receipt always yields the same bytes and the screen slip and the printed slip come from
one `ReceiptData`.

**Consequence.** A branch can print with no configuration at all (browser mode is the default). The
cloud never needs to reach a shop LAN, and a network printer is reachable from any till in the branch
because the destination is branch state, not till state. The relay opens a real TCP socket, so the
H4 tests drive it against a real listening server rather than a mock.

## ADR-0040 — The till reads scans at the document level; the shortcut map is one pure table

**Context.** A keyboard-wedge barcode scanner is a keyboard. If the till only listens on a focused
input, a cashier who clicks elsewhere, or a scanner that does not focus the field, silently loses a
scan. The R3 keyboard test also relies on function keys.

**Decision.** `ScannerBuffer` (`src/verticals/pos/scanner.ts`) is a pure, testable state machine that
turns a fast keystroke burst ending in Enter into a scan, and a slow burst into a hand-typed code
with the same downstream path. The till attaches one document-level key listener, so a scan works no
matter what has focus. Function keys are resolved through one pure table
(`src/verticals/pos/shortcuts.ts`): F2 focus scan, F3 hold, F4 recall, F9 pay (exact, preselected),
F10 pay in ZWG. The scan field's own handler does not handle the function keys, so a keypress is
never counted twice. The camera scanner is offered only over HTTPS, because a plain-HTTP LAN cannot
grant camera access; the affordance is hidden rather than shown and failing.

**Consequence.** The scanner works with no setup and with no focus requirement, the shortcut mapping
cannot drift from the keys, and the buffer is asserted in unit tests without a browser. F9 changed
from "tender exact cash immediately" to "open payment with the exact amount preselected", so a
cashier can still adjust before Enter; the R3 keyboard test (three actions) is unaffected.

## ADR-0041 — H4 owns tests 69–74; the print timing is measured from commit to print issued

**Context.** H1 owns 49–52, H2 owns 53–63 (ADR-0033), H3 owns 64–68 (ADR-0038). The H4 brief
describes behaviours rather than fixed numbers, so the new tests continue from the highest number
present (ADR-0010, ADR-0026). H4 must also show the printed receipt is issued promptly after the
sale.

**Decision.** H4 owns **69–74** in `tests/hardware-h4.test.ts` (the printer settings: default, round
trip, validation, tenant isolation, table invariants, functions). The relay, the pure receipt/ESC-POS
logic, the scanner, the shortcuts and the print timing are covered by `tests/hardware-h4-printer.test.ts`,
`tests/hardware-h4-units.test.ts` and `tests/hardware-h4-api.test.ts` without claiming numbers, so no
number is reused. The print timing is measured **from the commit of the sale to the moment the print
is issued** (before the transport runs), so it measures the till's own delay, not the printer's
speed, and must be under 1 second.

**Consequence.** No number is reused and no prior test is touched. The timing is observable on the
till and asserted in a unit test with an injected clock, so it is not flaky.

## ADR-0042 — H5 owns tests 75–84; the wizard is a staged import, not a live write

**Context.** H5 brings a shop's products, customers and opening stock from Pastel onto a branch so
the branch works offline. The H4 brief owns 69–74 (ADR-0041), so the new tests continue from the
highest number present (ADR-0010, ADR-0026). A Pastel export is large (a real shop has thousands of
products) and the shop must see what will happen before it happens.

**Decision.** H5 owns **75–84** in `tests/import-h5.test.ts`:

| H5 behaviour | Canonical | Test |
| --- | --- | --- |
| 5,000 products import under 2 s using COPY | 75 | The whole wizard on `samples/products-5000.csv` |
| Invalid rows are reported by row number and block commit until fixed | 76 | `samples/products-with-errors.csv`, then PATCH + revalidate + commit |
| A failed import leaves no partial data and a re-run duplicates nothing | 77 | Duplicate external code rolls the whole job back; the good file re-runs as updates |
| Opening stock writes opening ledger rows and one balanced journal | 78 | `samples/opening-stock.csv` posts Dr Inventory / Cr 3900 |
| Opening stock is idempotent | 79 | A re-run skips every already-committed row |
| Customers import by external code and are idempotent | 80 | `samples/customers.csv` |
| The column mapping is validated and saved per shop | 81 | `app.import_save_mapping` / `app.import_get_mapping` |
| The import tables are tenant-scoped and well-formed | 82 | RLS forced, the branch index, FK indexes |
| `applyMapping` / `naturalKey` unit behaviour | 83 | Pure mapping functions |
| Chunked load numbers rows contiguously | 84 | Two COPY chunks, one row-number sequence |

The wizard stages first and commits second. Parsing happens in the browser (PapaParse); the parsed
rows travel to the branch in chunks and land in `import_rows` with COPY. Validation is one SQL pass
over the staged rows. Commit is a single SQL function (`app.import_commit_job`) in one transaction:
either the whole file applies or none of it does.

**Consequence.** The shop sees a preview and a per-row problem list before anything is written, and
a bad file cannot leave half a catalogue behind. No number is reused and no prior test is touched.

## ADR-0043 — The import writes through the core posting functions; opening stock is a ledger fact

**Context.** Opening stock is real inventory with a real cost, so it must appear in the stock ledger
(and therefore in `stock_balances` and the FIFO layers) and it must balance in the accounting engine.
The core already owns both: `app.post_stock_adjustment` posts a stock movement and its journal, and
`app.post_balanced_journal` posts a balanced journal through the one hook.

**Decision.** The import never writes a core ledger table directly and never invents its own journal.
Products go in through the ordinary `products` / `product_variants` / `price_list_items` tables
(additive; no core table is altered). Opening stock inserts append-only `stock_ledger` rows with
`source_type = 'opening'`, their `stock_layer_balances` layers and the `stock_balances` cache in the
same transaction, then posts **one** balanced journal for the whole file through
`app.post_balanced_journal` (Dr Inventory 1300, Cr Opening Balance Equity 3900). The credit account
is created by an additive `create or replace` of `app.create_default_accounts` (3900 added for new
orgs) plus an `insert ... on conflict do nothing` for orgs that already exist. Invoice numbering
still goes through `app.next_number` -> `app.claim_invoice_number`; the import only ever calls the
SKU series.

**Consequence.** Opening stock is a first-class ledger fact: a subsequent sale consumes it FIFO at
the imported cost, and the balance sheet shows it. Re-running the same file skips the rows that were
already committed (matched on product + warehouse), so it never double-counts. Core tables and the
invoice-number path are untouched.

## ADR-0044 — Bulk SKU allocation locks the series once; imports are skipped, not re-posted

**Context.** Test 75 requires 5,000 products in under 2 seconds. A first cut called
`app.next_number(org, 'SKU')` once per row: each call takes `SELECT ... FOR UPDATE` on the
`number_series` row, which measured ~0.14 ms, so 5,000 rows cost ~700 ms on their own. A second cut
joined the staged rows to `products` on `nullif(btrim(coalesce(data ->> 'external_code','')),'')` —
an **expression**, so the index on `(org_id, external_code)` was not used and the planner fell back
to a nested loop: 12.5 M row comparisons and a 4-second insert.

**Decision.** Two changes. (1) `app.next_numbers(org, code, count)` locks the series **once** and
returns a contiguous, gapless block; the import allocates all its SKUs in one call and distributes
them with `row_number()`. It reads `number_series` directly, so it is only used for series that are
not carved into branch blocks (SKU, PO, ...); invoice numbers keep going through
`app.next_number` -> `app.claim_invoice_number`. (2) The commit resolves the mapped rows into a
materialised temporary table (`import_src` / `import_open`) and joins on the **stored** column, so
the index is used. Idempotency for opening stock is a `skipped` row status set during validation when
a matching `stock_ledger` `source_type = 'opening'` row already exists for that product and
warehouse; a skipped row is neither re-validated into an error nor re-posted.

**Consequence.** A 5,000-product commit fell from ~11 s to ~1.2 s (COPY staging is ~0.2 s). Gapless
allocation is preserved because the whole block is reserved in one locked update. A re-run of an
opening-stock file is a no-op rather than a second journal.

## ADR-0045 — H6 owns tests 86–95; report reads stream on a keyset

**Context.** H6 adds the reports and the owner console. H5 owns 75–85 (ADR-0042), so the new tests
continue from the highest number present (ADR-0010, ADR-0026): H6 owns **86–95**. A report over a
year of a busy shop is millions of rows, and the Phase 1 rule is that a list uses keyset pagination
on `(created_at, id)` and never `OFFSET`.

**Decision.** H6 owns **86–95** in `tests/reports-h6.test.ts`:

| H6 behaviour | Test |
| --- | --- |
| Profit by product equals the GL for the period | 86 |
| Best sellers and slow movers are ranked by quantity | 87 |
| The VAT report splits sales by the rate each line used, matching the Z-report | 88 |
| Z-reports page with their fiscal totals | 89 |
| A closed day is read from the facts; today is read live | 90 |
| Keyset pagination returns every product exactly once | 91 |
| The daily facts are append-only, and a closed day's figure never changes | 92 |
| `daily_product_sales` is a well-formed tenant table (RLS, indexes, FKs) | 93 |
| A report reads only its own branch | 94 |
| The report routes reject a limit above 100 and a branch out of scope | 95 |

The per-product reports aggregate on `product_id` and paginate on it: each source branch of the
union is itself a keyset page of at most `limit` products, ordered by `product_id`, and the merge of
the (at most three) pages re-limited is exact, because the smallest `limit` product ids of a union
lie in the union of the smallest `limit` of each branch. This keeps the closed-day side a streaming
index scan over `daily_product_sales`; a per-product page over 1M facts measured ~6 ms. The ranked
lists (best sellers, slow movers) aggregate every product by nature, so they read the period in
full; that is acceptable because they are bounded by the product count, not the fact count.

**Consequence.** A report is fast without a summary table or a materialised view, and the keyset
cursor is the product id, so no page is ever skipped or repeated.

## ADR-0046 — Daily facts are written at shift close; today is read live

**Context.** The reports must show a day's figures, and they must match the ledger. The Phase 1 rule
is that a mutable cache is allowed only when it can be rebuilt from an immutable ledger. The H6
brief forbids materialised views and says today's figures come from the live sales tables bounded by
today's date.

**Decision.** `daily_product_sales` is an append-only fact table, one row per closed shift, per
business date, per product and variant, holding the day's quantity, revenue (exclusive of tax), tax
and cost of goods sold. It is written by `app.close_shift`, in the same transaction as the immutable
Z-report, from that shift's completed sale lines. It is immutable (`app.enforce_immutable`) and the
`authenticated` role has no write grant, so a figure cannot change after a day closes.

A report reads **two** sources with one rule: a day that has closed is read from the facts, bounded
by `business_date between from and least(to, current_date - 1)`; today is read live from `invoices`
and `invoice_lines`, bounded by `invoice_date = current_date`. The two never overlap, so nothing is
double-counted. `invoices` gains an index on `(org_id, branch_id, invoice_date, id)` so the today
query does not scan every invoice of the org (ADR-0047).

The facts are a rebuildable projection of the ledger, not a second source of truth: the shift's sale
lines and their FIFO cost are themselves immutable ledger facts, so the rows can be recomputed. The
per-rate VAT split is *not* part of the fact grain; the VAT report and the Z-report both read
`invoice_lines` directly, so they always agree.

**Consequence.** A closed day is a cheap, immutable read; today is live and always current; and no
materialised view is needed. A shift that closes twice cannot double-write: the unique key
`(org_id, branch_id, shift_id, business_date, product_id, variant_id)` makes the write idempotent.

## ADR-0047 — The Z-report's fiscal totals are computed at read time

**Context.** The Z-report row is immutable and written at close. The fiscal status of a shift's
invoices (sent, pending, failed) changes *after* the close: a pending invoice is sent by the branch
worker minutes later, or retried after an outage. Test 89 must show the truth now.

**Decision.** `z_reports` stores the shift's financial totals (they are fixed at close) but **not**
the fiscal totals. `app.report_z_reports` computes sent / pending / failed and their amounts at read
time by joining `fiscal_invoices` to the shift's sales. The Z-report row therefore stays immutable
and the report shows the current fiscal state.

**Consequence.** The Z-report shows what the branch has actually submitted, even if that happened
after the close. No column of an immutable table is ever updated to reflect a later event.

## ADR-0048 — Returns net out of a report as negative rows
**Context.** A credit note returns stock at the original FIFO cost and reverses revenue and VAT
(CORE). The H6 reports are profit, VAT and Z-reports. A profit report that ignored returns would
overstate revenue and profit against the GL, which the credit note already reduced.

**Decision.** The profit, best-seller and slow-mover reports net a completed return out of the
period as a negative row (negative quantity, revenue, tax and cost of goods sold), taken from
`return_lines` joined to the original invoice line so the cost is the original FIFO cost. The
reversal journal already reduced the GL, so the report and the GL stay equal (test 86). The VAT
report reads `invoice_lines` directly, the same source the Z-report's `vat_by_rate` reads, so the
two agree (test 88); a credit note is a separate document with its own journal, and the ZIMRA
return is reconciled against that journal, not folded into the sales report.

**Consequence.** A return in the period lowers revenue, tax, cost and profit in the per-product
reports, exactly as it lowers the GL, so the two agree.

## ADR-0049 — The owner console reads the same report functions as the branch

**Context.** H6 asks for reports for the owner on the branch **and** in the cloud. The cloud holds
what the branch has synced, so the cloud's figures are only as fresh as the last sync. The console
must not hide that, and the two sides must not compute a figure two different ways, or they will
drift.

**Decision.** The owner console is `/reports`, a page in the same app, served on both deployments.
It reads `/api/reports/*`, and those routes call the same `app.report_*` functions the branch
console calls. There is no cloud-only aggregation. The page always shows a sync label from
`app.report_last_sync` (the last event the cloud received, or the branch's own observation), so a
stale figure is explained rather than surprising. A report never reads the service role: the routes
run as the caller, so RLS scopes every row, and a branch a token does not scope is refused.

**Consequence.** The branch and the cloud show the same figure from the same code; the console states
when the branch last synced; and no second reporting path exists to drift from the first.

## ADR-0050 — A1 owns tests 96–104, and the admin writes live in SQL

**Context.** The core owns tests 1–40 and forbids renumbering. H6 owns 86–95. ADR-0010 fixes the
rule: a new run continues from the highest number actually present. A1 is the admin products UI — a
new run.

**Decision.** A1 owns **96–104** in `tests/admin-a1.test.ts`. The mapping is:

| A1 requirement | Canonical | Test |
| --- | --- | --- |
| Category tree nests through `parent_id`; delete guards | 96 | 96 |
| New product takes a gapless SKU; master-data change recorded | 97 | 97 |
| Weighable unit rule | 98 | 98 |
| EAN-13 check digit and per-org barcode uniqueness | 99 | 99 |
| Batch belongs to a variant; days to expiry | 100 | 100 |
| Keyset pagination of the product list | 101 | 101 |
| Route refuses `limit > 100` and a cross-org body | 102 | 102 |
| Offline edit outbox and backoff | 103 | 103 |
| USB-wedge scanner detection | 104 | 104 |

The business logic lives in SQL functions under `app` (`app.create_product`, `app.create_variant`,
`app.admin_list_products`, …), called from thin route handlers. Every function is **SECURITY
INVOKER**, so RLS scopes the rows the caller may touch and no admin path runs as the service role.
A product or variant write also appends a master-data change (`app.record_master_data_change`), so a
branch pulls the new catalogue on its next sync (H2).

**Consequence.** The admin UI is a thin client over SQL, consistent with CORE_INTERFACE, and its
writes are RLS-scoped and synced to branches for free.

## ADR-0051 — EAN-13 is validated in the application, not by a table CHECK

**Context.** A barcode may be a real EAN-13 (13 digits with a check digit) or an internal code. R1
and the H5 import wizard already store barcodes that are not EAN-13: the R1 tests use `111222333`
(9 digits) and `5901234123457`, and the sample files use 13-digit codes. A table `CHECK` that
demanded a valid EAN-13 on every barcode would reject the R1 and H5 data, and a `CHECK` cannot run
the weighted-sum arithmetic cleanly for a nullable, sometimes-non-numeric column.

**Decision.** Validation is application-level, in two mirrored places: `app.is_valid_ean13(text)`
(and `app.assert_barcode`) in SQL, and `isValidEan13` in `src/verticals/admin/barcode.ts`. A
barcode that is **exactly 13 digits** must carry a valid EAN-13 check digit; anything else (a short
internal code, a 12-digit UPC, an alphanumeric code) is accepted as-is. Per-org uniqueness stays a
database constraint — the existing partial unique index `(org_id, barcode) WHERE barcode IS NOT
NULL`.

**Consequence.** A real EAN-13 is honest and a scan typo is caught at entry, while the R1 and H5
data stays valid and per-org uniqueness remains a database guarantee.

## ADR-0052 — An admin edit made offline is queued in IndexedDB, like a sale

**Context.** A branch admin may work when the cloud is unreachable. Losing a product edit is
unacceptable, and the POS already solved the same problem with an IndexedDB outbox (ADR-0015).

**Decision.** The admin reuses the pattern: a write that fails with a network error (not an HTTP
error) is written to an IndexedDB store (`erp-admin-outbox`) with its method, path, JSON body and
backoff bookkeeping, and replayed when the connection returns. An HTTP error (a 403, a 422 from a
constraint) is surfaced to the user, never queued, because replaying it would fail the same way.

**Consequence.** An offline branch admin does not lose a catalogue edit, and the admin outbox is
separate from the till's, so a backlog of catalogue edits never competes with a backlog of sales.

## ADR-0053 — The admin variant cost is a nullable planning figure, not the ledger cost

**Context.** The admin variant screen shows a cost per variant. The ledger's cost of goods is the
FIFO cost on the immutable stock layers, and it is not a single number per variant — it varies by
layer and by warehouse. Storing a "cost" on the variant risks a reader mistaking it for the ledger
cost.

**Decision.** `product_variants.cost` is a nullable `NUMERIC(19,4)` planning figure (a purchase or
list cost for the admin). It is documented as **not** the ledger FIFO cost, and no posting function
reads it: `app.create_invoice` and the FIFO consumers continue to read the immutable layers. The
column is nullable, so every existing row and every H5 import stays valid.

**Consequence.** The admin has a cost to show and to plan with, the ledger cost stays the single
source of truth for accounting, and the two can never be confused in a posting path.

## ADR-0054 — A2 pricing reuses the R2 pricing engine; it is not re-implemented

**Context.** A2 (the admin pricing console) must let an owner set price lists, customer groups and
promotions and see a live preview. R2 already implemented the pricing engine: `app.get_price`
resolves the list price (customer-group list, else retail), `app.apply_promotions` applies
promotions by priority, and `app.assert_manual_discount` enforces the role's discount limit. If A2
re-implemented any of that, the console and the till could disagree about a price.

**Decision.** A2 adds only the reads and the catalogue-management writes the console needs
(`app.admin_list_price_lists`, `app.admin_list_price_list_items`, `app.create_price_list`, …, and
`app.admin_price_preview`). The preview calls `app.get_price` and `app.assert_manual_discount`
rather than recomputing precedence, and the promotion writes go through `src/verticals/retail/pricing`
so the `promos:{org_id}` cache is invalidated on every write exactly as a till write does. Every new
function is SECURITY INVOKER.

The A2 brief numbered its three tests 29–31, but the core already owns 29–31 (inventory, in
`tests/inventory.test.ts`). A new run continues from the highest number actually present (ADR-0010),
so A2 owns 105–107:

| A2 brief | Canonical | Test |
| --- | --- | --- |
| 29 | 105 | Create list, import item, promotion discounts through the cache |
| 30 | 106 | Preview precedence and the manual-discount role limit |
| 31 | 107 | 1000-item COPY import under 3 s, and `get_price` uses an index |

**Consequence.** The console and the till cannot drift: the preview shows the price the till would
charge because it is the same SQL. The A2 migration adds no precedence rule of its own.

## ADR-0055 — Price list items are imported with COPY into a staging table, then merged once

**Context.** An owner imports thousands of (variant_id, price) pairs at a time. The stocktake import
(H5) already streams CSV into a staging table with COPY. A one-INSERT-per-row import would be slow
and would hit the `(price_list_id, variant_id)` unique key on re-import.

**Decision.** `importPriceListItems` streams the lines into a per-session temp table
(`copy _price_import … from stdin`), then merges with a single `INSERT … ON CONFLICT
(price_list_id, variant_id) DO UPDATE`. One COPY plus one merge for a whole file, never one round
trip per row. Re-importing a variant updates its price. The temp table is `on commit drop` and is
created per call, so a second import in the same transaction reuses it cleanly.

**Consequence.** A 1000-item import is two statements (test 107 asserts it completes in under 3 s),
and a re-import is idempotent rather than a unique-key failure.

## ADR-0056 — A price list is keyed by kind; the console shows the org's lists, not a free collection

**Context.** The brief describes `/admin/price-lists` as a list of "retail/wholesale lists per
currency". R2's `price_lists` table already carries `unique (org_id, kind)`, so an org has at most
one `retail` and one `wholesale` list, each with its own currency.

**Decision.** The console presents and manages exactly that: creating a kind that already exists is
a 422 (the unique key), and each row shows its kind, currency and item count. A "list per currency"
beyond one retail and one wholesale per org is not built, because R2's key does not allow it and
changing that key is an R2 change, not an A2 change.

**Consequence.** The console matches the schema the till already uses. If a future vertical needs
several lists of the same kind, that is an R2 migration with its own ADR.

## ADR-0057 — A keyset cursor keeps microsecond precision, not a JS Date

**Context.** A keyset cursor is `(created_at, id)`. A JS `Date` truncates a Postgres `timestamptz` to
milliseconds. A bulk COPY import writes thousands of rows in one statement, so they share one
`created_at` down to the microsecond. A cursor truncated to the millisecond then loses the
sub-millisecond tie-break and the next page stalls (discovered by test 107).

**Decision.** Every admin list function selects `created_at::text as created_at_exact` and the
cursor is built from that text, so the exact value round-trips. The API still returns
`created_at` as an ISO string for display, and the cursor uses the exact text.

**Consequence.** A page boundary inside a bulk-inserted batch advances correctly, and the admin
lists page every row exactly once (tests 107 and the platform's test 35).

## ADR-0058 — Manual-discount limits are enforced by `app.assert_manual_discount`, not by the console

**Context.** The brief requires the preview to reject a manual discount above the role's limit and
to require a reason. R2 already has `app.assert_manual_discount(org_id, role, subtotal, amount,
reason)`, which raises when the amount exceeds `discount_limits.max_percent` or when the reason is
blank.

**Decision.** `app.admin_price_preview` calls `app.assert_manual_discount` for the submitted
discount and returns the role's ceiling (`manual_max_amount`) either way, so the console can show
the limit before the operator commits and the route maps the raise to a 422. The limit is never
recomputed in TypeScript.

**Consequence.** A discount above the limit, or one with no reason, is refused identically in the
console and the till (test 106).

## ADR-0059 — A3 owns tests 108–111, and the ops console reuses the R5 functions

**Context.** The A3 brief calls its tests 32–35, but Phase 1 already owns 32–35 (the sales tests in
`tests/sales.test.ts`). ADR-0010 forbids renumbering: a new run continues from the highest number
actually present. A2 owns 105–107.

**Decision.** The A3 run owns tests 108–111 in `tests/admin-a3.test.ts`. The operational business
logic already exists in R5 (`app.create_layby`, `app.complete_layby`, `app.cancel_layby`,
`app.create_return`, `app.close_shift`, `app.create_stock_count`, `app.close_stock_count`,
`app.check_credit`). A3 adds the admin reads and the pages on top of them; it re-implements no rule.

**Consequence.** The console and the till cannot drift, because a layby completion, a return refund
and a shift close all call the same SQL the till calls. Test numbers are allocated in the order items
are built, so no number is skipped and no two runs collide.

## ADR-0060 — The admin ops reads are SECURITY INVOKER `app.admin_*` functions

**Context.** Every admin request runs as the caller (`authenticated`) with RLS enabled and forced, so
no admin path may use the service role (ADR-0052). The console needs paged, filtered reads of
laybys, returns, shifts, Z-reports and stock counts that R5 does not provide.

**Decision.** The A3 migration adds `app.admin_list_laybys`, `app.admin_layby_detail`,
`app.admin_list_returns`, `app.admin_invoice_returnable_lines`, `app.admin_list_shifts`,
`app.admin_z_report`, `app.admin_list_stock_counts`, `app.admin_stock_count_detail`,
`app.admin_stock_count_snapshot`, `app.admin_list_warehouses` and `app.admin_import_stock_count_lines`.
Every one is `security invoker`, so the caller's RLS scopes the rows; the grant to `authenticated` is
enough. The route handlers stay thin: they resolve the org, call one function, and map the result.

**Consequence.** An admin can only read a tenant the token scopes, enforced by the database rather
than by application checks (tests 108–111 drive the routes with a real token). No admin read needs
the service role.

## ADR-0061 — The layby status filter and the overdue flag are computed in SQL

**Context.** `/admin/laybys` filters by status (active/completed/cancelled) and shows an overdue
`due_date` in red. The brief's status words are `active`, but the R5 `laybys.status` values are
`open`, `completed`, `cancelled`.

**Decision.** The page's filter offers All / Active / Completed / Cancelled and sends the schema
value (`open`) for "Active". The list function computes `is_overdue` as
`status = 'open' and due_date < current_date` in SQL, so the console never recomputes "today" against
a due date in TypeScript. An unknown status is refused with 22023 (a 422).

**Consequence.** The overdue flag is consistent for every caller and time zone (the database's
`current_date`), and the filter maps cleanly between the brief's wording and the schema's values.

## ADR-0062 — The returnable-lines read shares the arithmetic with `app.create_return`

**Context.** The returns page shows, per invoice line, the quantity sold, the quantity already
returned and the remainder, so the operator cannot type a quantity the database will reject.
`app.create_return` already checks `qty_sold - qty_already_returned` while holding the invoice lines
`FOR UPDATE`.

**Decision.** `app.admin_invoice_returnable_lines` returns the same three figures from the same
source (`invoice_lines` minus completed `return_lines`). The read is a preview only: the authoritative
check remains inside `app.create_return`, which locks the lines `FOR UPDATE` so two concurrent returns
cannot each see the same remainder (test 110 asserts both the preview and the refusal).

**Consequence.** The console's preview and the writer's check agree, and the write path keeps its
lock; a return over the sold quantity is still a 422 from the database.

## ADR-0063 — The admin stocktake import is a set-based insert, not COPY

**Context.** The R5 route imported a stock count's lines with `COPY … FROM STDIN`
(`importStockCountLines`). `COPY FROM` is not supported under row-level security: the server raises
SQLSTATE `0A000` ("COPY FROM not supported with row-level security"). Every admin path runs as
`authenticated` with RLS forced, so the R5 COPY path cannot be reused by the console.

**Decision.** A3 adds `app.admin_import_stock_count_lines(org, branch, count_id, count_created_at,
lines jsonb)`, a set-based `INSERT … SELECT` from the JSON array, run as the caller
(`security invoker`). It asserts the header is visible to the caller first, then inserts every line
in one statement. The console calls this instead of COPY. (The R5 route keeps its COPY path for the
till's non-RLS contexts; the admin path does not use it.)

**Consequence.** The admin import works under RLS with no service role, and one round trip inserts a
whole count's lines (test 111 imports and closes a count). A future non-RLS bulk path may still use
COPY.

## ADR-0064 — The Z-report is read by primary key and shown read-only

**Context.** A Z-report is immutable (`app.enforce_immutable`). The console shows a shift's Z-report
and lets the operator close an open shift.

**Decision.** `app.admin_z_report(org_id, id)` reads one immutable row by its primary key (no
scan, no filter beyond the org). The console shows it read-only; the only write is `app.close_shift`
(via `POST /api/admin/shifts`), which writes the Z-report and closes the shift in one transaction.
`by_method`, `by_currency` and `vat_by_rate` are JSON objects of amounts; the route serialises each
to a fixed-scale string.

**Consequence.** Nothing on the console updates or deletes a Z-report, and the read is a single
indexed lookup (test 111 closes a shift and reads the report back).

## ADR-0065 — F1 adds `app.user_credentials`, a non-tenant table, without touching the core

**Context.** F1 replaces "paste a token into localStorage" with email/password sign-in. Supabase
Auth owns `auth.users`, but the local stack runs without the GoTrue email provider wired to a mailer,
and the brief wants a self-contained `/login` that returns a tenant-scoped access token. Storing a
password needs a table, and every tenant table in this schema carries `org_id` and RLS.

**Decision.** The F1 migration adds `app.user_credentials (user_id, password_hash, …)` in the `app`
schema: a bcrypt hash keyed by `auth.users.id`. It is deliberately not a public tenant table. A user
may belong to several orgs, so it has no `org_id`; it is never reachable through the Data API (it
lives in `app`, not `public`, and is granted to no role); and only the `SECURITY DEFINER` login
functions read it. It is therefore not registered in `scripts/check-tenant-tables.sql` or
`tests/support/tenant-tables.ts`. The migration is additive: no core table or function changes
(so no ADR-gated edit of a shared table). Two definer functions are added — `app.authenticate(email,
password)` and `app.upsert_user_credentials(user_id, password)` — plus `app.login_context(user_id)`,
which returns the same claims the custom access token hook would mint, plus the org name for the
shell header.

**Consequence.** Sign-in works with no hosted Supabase project and no mailer, and no plaintext
password ever reaches a table (test 114 asserts the stored value is a bcrypt hash and that no
`password` column exists). Because the table is not a tenant table, the tenant invariant checks stay
honest rather than being widened to a table that legitimately has no `org_id`.

## ADR-0066 — F1 owns tests 112–118

**Context.** The F1 brief specifies behaviour (a login page, `/api/auth/me`, an app shell) but
allocates no test numbers. ADR-0010 fixes the rule: a new run continues from the highest number
actually present, and the highest present after A3 is 111.

**Decision.** F1 owns tests 112–118 in `tests/frontend-f1.test.ts`. They cover: a correct sign-in
returns a token scoped to the right org (112); a wrong password and an unknown email fail
identically (113); passwords are stored only as a hash (114); a malformed body is rejected (115);
`/api/auth/me` rejects a missing, forged or malformed token (116); the session helpers use the keys
the brief names (117); a user with no membership gets a valid token with a null org (118).

**Consequence.** The numbering continues without gaps or collisions, and the F1 tests exercise the
real route handlers, the real SQL and the real token signature — nothing is mocked.

## ADR-0067 — the login path runs as `anon`, never the service role

**Context.** A signed-out caller has no token and no user context. `withUserContext` drops into the
`authenticated` role, which needs a subject; the login path has none yet. The tempting shortcut is
the service role key, but the brief forbids it on any application request path.

**Decision.** `login()` opens a transaction, runs `SET LOCAL ROLE anon`, and calls two `SECURITY
DEFINER` functions. `app.authenticate` compares the bcrypt hash with the definer's privileges and
returns the `auth.users.id` (or null); `app.login_context` reads the membership and the org name as
the definer and returns the claims. `anon` itself can read neither `app.user_credentials` nor a
tenant row, so the login path holds no broad privilege. On success the route signs an HS256 token in
TypeScript with `SUPABASE_JWT_SECRET` (the same secret the local stack and the custom access token
hook use), so the token the client stores is a real access token every other route verifies.

**Consequence.** Sign-in needs no service role and no RLS bypass, and a wrong email and a wrong
password are indistinguishable (both return null, then a 401 with the same body — test 113), so the
response never reveals which accounts exist.

## ADR-0068 — the app shell gates navigation on the client, not in edge middleware

**Context.** A page must send a signed-out visitor to `/login`. The token lives in `localStorage`,
which edge middleware cannot read. An initial F1 attempt added `src/middleware.ts` that read a
mirrored cookie and redirected pages; but the existing Playwright specs seed only
`localStorage['pos_access_token']` and then navigate, so a cookie-based redirect would break them,
and the cookie carried no authority the localStorage token did not already carry.

**Decision.** There is no `src/middleware.ts`. The `Shell` component (which wraps every `/pos` and
`/admin` page) checks `hasSession()` on mount and `router.replace('/login?next=…')` when there is no
token; `/pos` keeps its own equivalent guard. The `token` key is read first and the legacy
`pos_access_token` key is read as a fallback, so an existing browser session and the existing e2e
specs keep working. Authorisation is never a client decision: every API call re-verifies the token
on the server (`withAuth` / `withUserContext`).

**Consequence.** Signed-out navigation is redirected, the existing token-seeded specs are unaffected,
and the token is checked where it actually matters — on the server. The cost is a brief client-side
flash before the redirect, which is acceptable for a shell that already renders from token claims.

## ADR-0069 — F2 is a UI-completion slice; its tests are 119–121

**Context.** The F2 brief asks for an admin console covering categories, products, variants and
barcodes, price lists (with a COPY import), promotions, and a live pricing preview. The repository
already contains that backend and most of that UI: A1 built `/admin/categories`, `/admin/products`,
`/admin/products/[id]/variants` and the barcode scanner over `app.create_*` SQL; A2 built
`/admin/price-lists`, the inline item editor, the COPY import, `/admin/promotions` and
`/admin/pricing-preview` over `app.get_price`; R2 built the precedence engine and the
`promos:{org_id}` Redis cache (TTL 300s) that A2's writes invalidate. So F2 is not a green field: it
is the completion of a surface that already exists, and re-implementing it would duplicate A1/A2 and
risk drift between the console and the till.

The brief also numbers its tests 43–45, but 43–45 are Phase 1 retail tests (R1 owns 41–44, R2 owns
45–48). ADR-0010 forbids renumbering: a new run continues from the highest number actually present,
which after F1 is 118.

**Decision.** F2 is delivered as an additive UI-completion slice, with no change to any core table or
function and no re-implementation of an existing admin path:

* The **promotions form** gains the pieces the brief names that A2 left out: a `stackable` checkbox,
  a **conditions builder** (value, variant_ids, min_qty, min_subtotal — the keys
  `app.apply_promotions` actually reads), a **stackable badge** on the row, **drag-to-reorder** of
  priority (HTML5 drag, with the existing up/down buttons kept as the keyboard-accessible fallback),
  and a **precedence legend** (1. group price list, falling back to retail; 2. promotion by priority;
  3. manual discount).
* A dedicated **`POST /api/admin/price-lists/import`** route is added so the brief's endpoint exists;
  it delegates to the same `importPriceListItems` COPY path the existing `action:'import'` branch
  uses, so there is one implementation, not two.
* Everything else the brief lists already exists and is covered by A1/A2 tests 96–107; F2 does not
  rewrite it.

F2 owns tests **119–121** in `tests/frontend-f2.test.ts`, one per brief test: 119 the
category → product → variant → search flow with an org boundary; 120 a USD retail list priced and
discounted through the Redis cache, invalidated on write; 121 an expired promotion not applied even
when the cache entry is fresh, with `EXPLAIN` showing `get_price` reaches `price_list_items` by index.

**Consequence.** The admin console is complete and consistent with the till (both call the same
`app.get_price`), the brief's endpoint exists without duplicating the COPY import, and the test
numbering continues without collisions. The cost is a deliberately small diff: F2 adds UI and one
route, and records that the rest was already built rather than pretending to rebuild it.
