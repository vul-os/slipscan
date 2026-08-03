# Feature parity — SlipScan vs Xero and Vault22 / 22seven

SlipScan's pitch is that it gives you "what Vault22 / 22seven does for personal finance and what
Xero does for small-business accounting", without a central server. This document measures that
claim against the code, capability by capability.

It exists because the claim is the first thing a reader meets and the hardest thing to check.
[ROADMAP.md](ROADMAP.md) had promised these matrices twice without ever carrying them; a phase list
says what is *planned*, which is a different question from what is *there*. Phases 4.5 and 5 now
link here instead of promising, and what they still owe is an issue per gap plus something that
re-scores this document without a human doing it.

**Scored 2026-07-29, re-scored 2026-08-03 against the working tree after ROADMAP Phase 6.1–6.5.** 24 capabilities:

| | Built | Partial | Not built |
|---|---:|---:|---:|
| **Xero axis** (14) | 2 | 7 | 5 |
| **Vault22 / 22seven axis** (10) | 3 | 5 | 2 |
| **Total** (24) | **5** | **12** | **7** |

## The honest headline

**SlipScan is not a Xero alternative today, but the distance is no longer the whole road.**
**Invoicing** is built — invoice entity, gapless numbering, line items, payments, derived
paid/unpaid state — where this document's first scoring said, accurately, "there is no invoicing at
all". Contacts, purchasing and aged receivables all have finished models behind them.

**Much of it is still not reachable, and that is the honest headline.** Phase 6 built its
foundations in core and then wired almost none of them to a surface: of sixteen catalogue operations
exactly one is reachable, and of nine stock operations **none at all**. Contacts were in the same
state until 2026-08-03 and are now on all four surfaces, which is what makes a standalone invoice
exercisable end to end at all. A *stock-tracked* line still is not: it needs a `variant_id`, and no
surface can create a product variant. So purchasing and sales — every one of whose ~38 operations is
on the CLI, the HTTP API and the desktop — sit on foundations a user can only half reach. The schema
work is real; the product surface over it is half finished, and `npm run reachable:check` keeps the
count honest (36 of 167 core operations reachable from nothing, down from 42).

The rest is still missing outright: quotes, credit notes, fixed assets, payroll and tracking
categories do not exist in any form, and the *payable* half of bills is unbuilt, so aged payables
cannot exist either. And the one that matters most — **nothing an invoice or a goods receipt does
reaches the ledger**. A confirmed sale moves stock but posts no revenue, VAT or cost-of-goods-sold,
and a receipt debits no inventory asset. Until ROADMAP 6.6 lands, SlipScan is an
inventory-and-invoicing app sharing a binary with an accounting app, which is precisely the outcome
that fold exists to avoid.

**On the Vault22 / 22seven axis it is much closer.** The core loop — accounts, transactions in,
automatic categorisation that learns from your corrections, budgets, household attribution — is
real and works end to end, and **net worth over time is now built** — `networth_snapshots` records
an immutable balance per account per date, backfills history from the transaction ledger, and is
charted on the Dashboard. The one structural thing still missing is **no live bank connection
anywhere**: every path in is a file you hand it or an email it reads.

**Surface coverage is uneven, and it matters.** Statement CSV import and bank-alert email parsing
run from the CLI only; budgets have no CLI command at all; the profit-and-loss and balance-sheet
reports have no desktop screen. A capability is scored on what the code does, not on how many
surfaces reach it — but the surface gap is named in every row where there is one, because a feature
a user cannot get to is not one they have.

## How to read this

- **Built** — a user can do this end to end on at least one surface, and the implementation is not
  a stub.
- **Partial** — something real ships, but a named part of the capability is absent. The "What's
  missing" column says what, in one sentence.
- **Not built** — no implementation. The rule here is that *a row that cannot be cited is Not
  built*, so these rows either cite nothing or cite the nearest thing that does exist — usually a
  chart-of-accounts seed line, which is a name in a list, not a feature.

Every path below is a live link to the file in this repo, and `npm run docs:check` fails if any of
them stops resolving. Paths are shortened for width: **`core/`** = `crates/slipscan-core/`,
**`ingest/`** = `crates/slipscan-ingest/`, **`packs/`** = `crates/slipscan-packs/`,
**`server/`** = `crates/slipscan-server/`, **`cli/`** = `crates/slipscan-cli/`,
**`desktop/`** = `apps/desktop/`.

---

## A. Xero axis — small-business accounting

| Capability | Status | Evidence | What's missing |
|---|---|---|---|
| **Invoicing** | **Built** | `invoices` / `invoice_items` / `invoice_payments` (migration `0014_sales`), issued through `CoreService::invoice_issue` with gapless per-book numbering, and reachable over HTTP, the CLI and desktop IPC | An issued invoice is immutable by trigger, so correcting one needs a credit note — **not built**, along with voiding, quotes, repeating invoices, partial fulfilment, per-line currency, and any posting to `journals` (that is ROADMAP 6.6). Multi-device numbering is unsolved: two offline devices would both mint the same number, caught loudly by `UNIQUE (book_id, series, number)` rather than silently. No desktop screen yet (6.9). A contact can now be created on every surface, so a standalone invoice **is** exercisable end to end; a stock-tracked line still is not, because **no surface can create a product variant** (the catalogue is 1-of-16 reachable — see `npm run reachable:check`). |
| **Quotes / estimates** | **Not built** | — | Everything, and it is blocked behind invoicing, which a quote converts into. |
| **Bills / accounts payable** | **Partial** | `purchase_orders` / `purchase_order_items` / `po_receipts` (migration `0013_purchasing`) give the ordering and receiving half, with receipts insert-only so partial deliveries merge by union | The **payable** half is missing: no bill entity distinct from the order, no supplier payment or paid/unpaid state (a PO is only `draft`/`ordered`/`cancelled`), no due dates, no supplier balances, no payment run, and nothing posts to the Accounts Payable CoA line. |
| **Contacts (customers & suppliers)** | **Built** | One `contacts` table (migration `0010_contacts`) with a `role`, deliberately not split into `customers`/`suppliers` because a real party is often both; referenced by `sales_orders`, `invoices` and `purchase_orders` with `ON DELETE RESTRICT` so trade history cannot be deleted out from under itself. Reachable on **all four surfaces** — CLI `slipscan contact`, HTTP, desktop IPC and a `client.ts` wrapper — which it was not until 2026-08-03: the model shipped with Phase 6.2 and only a read-only list was routed, so nothing could create the `contact_id` an invoice requires | No merge/dedupe of contacts, no statement, and no per-contact balance beyond aged receivables. Tax numbers, addresses and credit limits are stored and nothing consumes them yet. |
| **Aged receivables / payables** | **Partial** | `report_aged_receivables` (migration `0014_sales`) buckets every outstanding invoice by age per contact, backed by the `invoices (book_id, due_date)` index | **Receivables only.** Aged *payables* needs the bill/payment half of purchasing, which is not built — see that row. No statement rendering or emailing. |
| **Fixed-asset register** | **Not built** | `Accumulated Depreciation` and `Depreciation` are chart-of-accounts seed lines in [`core/src/region.rs`](crates/slipscan-core/src/region.rs) and nothing more | No asset records, cost/life/method, depreciation run, or disposal. You can hand-post a depreciation journal; nothing computes one. |
| **Bank rules** | **Partial** | Categorisation cascade on every inbound transaction (`transaction_create` → `classify_by_packs`) in [`core/src/service.rs`](crates/slipscan-core/src/service.rs); rule kinds `Contains` / `Regex` / `KeywordRule` in [`packs/src/model.rs`](crates/slipscan-packs/src/model.rs); classifier registration in [`packs/src/engine.rs`](crates/slipscan-packs/src/engine.rs) | Rules only ever set a **category**, match only on merchant/description text, and arrive as installed signed packs — there is no in-app rule editor, no amount/date/account conditions, and no rule that codes to a ledger account, tax rate or contact. |
| **Repeating invoices / recurring transactions** | **Not built** | — | No schedule, template or generator; the only "recurring" code is a read-only detector of recurring charges in [`desktop/src/lib/nudges.ts`](apps/desktop/src/lib/nudges.ts), which creates nothing. |
| **Multi-currency converted views** | **Partial** | Rate client, cache with `as_of` + quality grade, and decimal-only conversion in [`core/src/fx/`](crates/slipscan-core/src/fx); `fx_convert` / `fx_convert_at` in [`core/src/service.rs`](crates/slipscan-core/src/service.rs) | **No report converts anything** — [`core/src/repo/report.rs`](crates/slipscan-core/src/repo/report.rs) returns one row per currency, and [`desktop/src/routes/Reports.svelte`](apps/desktop/src/routes/Reports.svelte) tells the user outright: "Nothing here is converted." |
| **Bank reconciliation** | **Partial** | `recon_suggest` / `recon_confirm` / `recon_reject` in [`core/src/service.rs`](crates/slipscan-core/src/service.rs), storage in [`core/src/repo/recon.rs`](crates/slipscan-core/src/repo/recon.rs), screen at [`desktop/src/routes/Reconcile.svelte`](apps/desktop/src/routes/Reconcile.svelte), `slipscan recon suggest\|confirm` in [`cli/src/main.rs`](crates/slipscan-cli/src/main.rs), and two HTTP routes in [`server/src/routes.rs`](crates/slipscan-server/src/routes.rs) | It scores transaction↔document↔journal pairs by amount, date and merchant; it is not Xero's reconciliation *workflow* — no statement session, no reconciled-vs-actual balance check, no create-while-reconciling, no unreconciled-items report — and *rejecting* a suggestion is desktop-only (neither the CLI nor HTTP exposes `recon_reject`). |
| **Tax returns** | **Partial** | `report_tax_summary` / `report_vat201` and `book_set_lock_date` in [`core/src/service.rs`](crates/slipscan-core/src/service.rs); region-supplied box labels in [`core/src/region.rs`](crates/slipscan-core/src/region.rs); CSV in [`core/src/csv.rs`](crates/slipscan-core/src/csv.rs) | This is a **period summary with region-named boxes**, not a return: nothing is filed, there is no return record or revision history, no submission anywhere, and no reconciliation back to a filed figure. |
| **Payroll-lite** | **Not built** | `PAYE & UIF Payable` / `Payroll Taxes Payable` are chart-of-accounts seed lines in [`core/src/region.rs`](crates/slipscan-core/src/region.rs) | Everything: no employees, pay runs, payslips or statutory calculation. |
| **Tracking categories** | **Not built** | Nearest analogue is the household-member dimension — `transaction_attribute`, `transaction_split_set`, `report_member_category` in [`core/src/service.rs`](crates/slipscan-core/src/service.rs) | That dimension is *people*, fixed and singular: no user-defined dimensions, nothing on journal lines, and no report sliceable by one. |
| **CSV / OFX import & export** | **Partial** | Import: [`ingest/src/bank/csv_statement.rs`](crates/slipscan-ingest/src/bank/csv_statement.rs) and per-region presets in [`ingest/src/bank/presets.rs`](crates/slipscan-ingest/src/bank/presets.rs), wired to `slipscan import --preset` in [`cli/src/main.rs`](crates/slipscan-cli/src/main.rs). Export: report CSVs in [`core/src/csv.rs`](crates/slipscan-core/src/csv.rs) | **No OFX parser exists** — `.ofx` is only a recognised extension that files as a document ([`ingest/src/import.rs`](crates/slipscan-ingest/src/import.rs)); statement CSV import is CLI-only (desktop `document_import` merely stores the file — [`desktop/src-tauri/src/commands.rs`](apps/desktop/src-tauri/src/commands.rs)); export is report-shaped only — [`desktop/src/lib/csv.ts`](apps/desktop/src/lib/csv.ts) is used by the Reports and Receipts screens and nowhere else, so there is no transaction-list, ledger or whole-book export. |

### What the accounting side *does* have

None of this is on the Xero axis above, because Xero users take it for granted rather than buy it —
but it is real, and leaving it out would misrepresent the codebase in the other direction:

- Double-entry ledger with balanced-by-construction journal lines, immutable posted journals, and
  corrections as reversals — `journal_post` / `journal_reverse` in
  [`core/src/service.rs`](crates/slipscan-core/src/service.rs).
- Chart of accounts with region-profile seeds, archiving, and a transaction→account map —
  `coa_seed` / `coa_create` / `coa_archive` / `coa_map_set` in
  [`core/src/service.rs`](crates/slipscan-core/src/service.rs), seed data in
  [`core/src/region.rs`](crates/slipscan-core/src/region.rs).
- Automatic journal generation from a transaction or an extracted document —
  `journal_generate_for_transaction` and `journal_generate_for_document` in
  [`core/src/service.rs`](crates/slipscan-core/src/service.rs).
- Trial balance, income statement, balance sheet and tax-period summary —
  [`core/src/repo/report.rs`](crates/slipscan-core/src/repo/report.rs). Note the surface gap: the
  income statement and balance sheet reach the CLI and HTTP but have no Tauri command at all
  ([`desktop/src-tauri/src/lib.rs`](apps/desktop/src-tauri/src/lib.rs) registers neither; see also
  `missing_from_ipc` in [`docs/parity.json`](docs/parity.json)), so the desktop Reports screen
  carries spending, income vs expense, tax and trial balance only.
- Period locking — `book_set_lock_date` in
  [`core/src/service.rs`](crates/slipscan-core/src/service.rs) — and an append-only audit log in
  [`core/src/repo/audit.rs`](crates/slipscan-core/src/repo/audit.rs).

---

## B. Vault22 / 22seven axis — personal finance

| Capability | Status | Evidence | What's missing |
|---|---|---|---|
| **Account aggregation** | **Partial** | Accounts in [`core/src/repo/account.rs`](crates/slipscan-core/src/repo/account.rs); statement CSV import with bank presets in [`ingest/src/bank/`](crates/slipscan-ingest/src/bank); mailbox sync over IMAP, Gmail and Graph in [`ingest/src/email/`](crates/slipscan-ingest/src/email); bank-alert emails → transactions via signed `mailrules` packs ([`ingest/src/email/alerts.rs`](crates/slipscan-ingest/src/email/alerts.rs), [`packs/src/mailrules.rs`](crates/slipscan-packs/src/mailrules.rs)); the only non-test `BankAdapter` implementation reads files ([`ingest/src/bank/csv_statement.rs`](crates/slipscan-ingest/src/bank/csv_statement.rs)) | **Nothing connects to a bank**: no adapter talks to a bank API or feed, nothing runs on a schedule, and both the statement import and the alert parser run from the CLI only (`slipscan import --preset`, `slipscan mail-sync --alerts`). |
| **Net worth over time** | **Built** | `networth_snapshots` (migration `0015_networth`) records one immutable balance snapshot per account per date; `networth_capture` stamps today, `networth_backfill` reconstructs history from the transaction ledger, and `networth_series` reads the series back. Charted on [`desktop/src/lib/components/NetWorthChart.svelte`](apps/desktop/src/lib/components/NetWorthChart.svelte), reached from the Dashboard. | A snapshot is a fact about a date, not an editable value, so the table is an insert-only ledger with `RAISE(ABORT)` triggers and is registered in `LEDGER_TABLES` — two devices that captured the same account and date offline keep both facts and the read side picks the freshest, rather than one silently overwriting the other. Still not built: no asset/liability valuation beyond account balances, and no goals or peer comparison. |
| **Goals** | **Not built** | — | No goal table, type, endpoint or screen exists anywhere in the tree. |
| **Budgets** | **Partial** | `budget_upsert` / `budget_status` / `budget_list` in [`core/src/service.rs`](crates/slipscan-core/src/service.rs), [`core/src/repo/budget.rs`](crates/slipscan-core/src/repo/budget.rs), screen at [`desktop/src/routes/Budgets.svelte`](apps/desktop/src/routes/Budgets.svelte), HTTP routes in [`server/src/routes.rs`](crates/slipscan-server/src/routes.rs) | Monthly per-category only; the stored `rollover` flag ([`core/src/domain.rs`](crates/slipscan-core/src/domain.rs)) is **never applied to any number** — `budget_status` does not even carry it — so there is no envelope budgeting, no non-monthly period and no income budgeting; and there is no `slipscan budget` command at all, so budgets are unreachable from the CLI. |
| **Nudges** | **Partial** | Three kinds — budget over/drift, duplicate charges, recurring subscriptions — computed in [`desktop/src/lib/nudges.ts`](apps/desktop/src/lib/nudges.ts) and rendered with actions on [`desktop/src/routes/Dashboard.svelte`](apps/desktop/src/routes/Dashboard.svelte) | It is desktop-UI code, not core: no CLI, no HTTP, no persistence, no dismissal, no OS notifications — and the category-spike, fee-creep and tax-deadline tiers the roadmap promises do not exist. |
| **Categorisation quality** | **Built** | Cascade on every inbound transaction (stored mapping → pack classifier) and the learning loop (`transaction_categorize` → `insert_correction` + `upsert_mapping`) in [`core/src/service.rs`](crates/slipscan-core/src/service.rs); merchant keys derived from bank narratives in [`core/src/util.rs`](crates/slipscan-core/src/util.rs); pack rules in [`packs/src/engine.rs`](crates/slipscan-packs/src/engine.rs); LLM/OCR slip extraction in [`crates/slipscan-extract/`](crates/slipscan-extract) | Two limits worth naming: a correction changes *future* rows only (nothing re-classifies transactions already imported), and correcting one is a desktop/HTTP action — the CLI has no `categorize` command, so a CLI-only user gets the automatic cascade and no way to teach it. |
| **Household / shared spending** | **Built** | [`core/src/migrations/0006_members.sql`](crates/slipscan-core/src/migrations/0006_members.sql), [`core/src/repo/member.rs`](crates/slipscan-core/src/repo/member.rs), attribution + splits + four member reports (`transaction_attribute`, `transaction_split_set`, `report_member_expense`, `report_member_contribution`, `report_member_category`, `report_settle_up`) in [`core/src/service.rs`](crates/slipscan-core/src/service.rs), screen at [`desktop/src/routes/Household.svelte`](apps/desktop/src/routes/Household.svelte), `slipscan member` / `attribute` / `split` / `report members` / `report settle-up` in [`cli/src/main.rs`](crates/slipscan-cli/src/main.rs), and the member routes in [`server/src/routes.rs`](crates/slipscan-server/src/routes.rs) — all three surfaces | Limit worth naming: members are local data with no logins and no access control — "sharing" means sharing the data folder or pointing clients at your own server. |
| **Peer comparison / benchmarks** | **Partial** | Benchmark pack format with a k-anonymity floor in [`packs/src/model.rs`](crates/slipscan-packs/src/model.rs), comparison math in [`packs/src/benchmark.rs`](crates/slipscan-packs/src/benchmark.rs), read path on all three surfaces via `pack_benchmark` in [`server/src/ops.rs`](crates/slipscan-server/src/ops.rs) | **There is nothing to compare against** — no benchmark pack is published — and the contribution half (local differential privacy, cohorting, anonymous transport) has no code at all, which `ops.rs` states in its own doc comment. |
| **Subscription detection** | **Partial** | `subscriptionNudges` in [`desktop/src/lib/nudges.ts`](apps/desktop/src/lib/nudges.ts): same-merchant charges at a roughly monthly cadence surface as a dashboard nudge | A dashboard heuristic and nothing more: no subscription record, no expected next charge, no price-increase or cancellation tracking, and nothing outside the desktop UI. |
| **Fee tracking** | **Not built** | — | No fee detection, classification or report anywhere; bank fees land as ordinary transactions and are visible only if some category happens to catch them. |

---

## Gaps, ranked

Ordered by how far the gap sits from the claim on the front page, not by effort.

1. **Invoicing and quotes** — the single largest hole on the Xero axis, and the one a small-business
   reader will look for first. Nothing exists to build on: this needs an entity, numbering,
   delivery, and payment state.
2. **Contacts, then bills, then aged AR/AP** — a chain. Aging is meaningless without bills and
   invoices, which are meaningless without contacts.
3. **Live bank connection** — the `BankAdapter` trait is designed and its file-based implementation
   works, but no adapter reaches a bank, and nothing schedules a sync. Every path in is manual.
4. ~~**Net worth over time**~~ — **closed**: `networth_snapshots` is the series, captured forward and backfilled from the ledger.
   Needs periodic balance snapshots; nothing else on this list is closer to shipping.
5. **Converted multi-currency reports** — the FX plumbing is done and unused by every report; this
   is wiring, not new machinery.
6. **Nudges out of the UI and into core** — three kinds exist as desktop TypeScript. Moving them
   into core makes them testable, reachable from CLI and HTTP, and extensible to the missing tiers.
7. **Benchmark contribution** — the read side ships and has nothing to read. Publishing a pack
   needs the aggregation and privacy code, which does not exist.
8. **Fixed assets, payroll-lite, tracking categories, repeating transactions, goals, fee tracking** —
   each a self-contained feature with no groundwork laid.
9. **Surface parity** — statement CSV import, bank-alert parsing, and the P&L and balance-sheet
   reports exist on one surface only. See [docs/API.md](docs/API.md) and
   [`docs/parity.json`](docs/parity.json) for the operation-level transport gaps.

## How this was measured

Every row was checked against the code, not against the README or the roadmap — several claims in
this repo's own documentation were found stale in both directions while writing it. Concretely:

- The set of entities was taken from the schema, not from prose: the tables created in
  [`core/src/migrations/`](crates/slipscan-core/src/migrations/) are the ground truth for what
  SlipScan can store, and there is no `invoices`, `bills`, `fixed_assets`, `bank_rules`,
  `tracking_categories`, or `goals` among them. **`contacts` is no longer on that list** - it
  shipped in `0010_contacts.sql`, alongside `locations` (`0009`) and the product catalogue
  (`0011`). The Contacts row moved to Partial rather than Built: a table no surface can reach
  is not yet a capability.
- Every capability keyword was grepped across `crates/`, `apps/desktop/src/` and
  `apps/desktop/src-tauri/src/` before a row was scored, and every surviving hit was opened. Most
  hits for the absent capabilities turned out to be chart-of-accounts seed *names* in
  [`core/src/region.rs`](crates/slipscan-core/src/region.rs) — which is exactly why those rows are
  Not built rather than Partial.
- Where something exists as a library but reaches no user, the row says so and names the surface.
- Every file path in this document is a link, so `npm run docs:check` re-verifies that all of them
  resolve on every run; a citation that rots fails the gate.

This document is a snapshot with a date on it. Re-score it in the same change that closes a gap —
a parity matrix that lags the code is worse than none, because it is trusted.
