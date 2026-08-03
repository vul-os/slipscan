# API

SlipScan has **one service surface, two transports**. Every operation is a function on the core service layer (`crates/slipscan-core`); the Tauri desktop app calls it over IPC and `slipscan-server` exposes the same operations over HTTP. Full same-name/same-payload parity is the contract in [ARCHITECTURE.md](ARCHITECTURE.md#ipc--api-surface) — **and it is not met yet**:

- The **HTTP server is the canonical, near-complete surface** — the operation tables below describe it. 183 routes under `/api/v1` (182 distinct handlers: `report_vat` is a deprecated alias of `report_tax`), plus the public `GET /health`.
- The **desktop IPC exposes a UI-shaped subset** — **172 commands** with display-oriented DTOs (`health` in `src-tauri/src/lib.rs`, the other 171 in `src-tauri/src/commands.rs`). `apps/desktop/src/lib/api/client.ts` calls **all 172**: every registered command has a typed wrapper, and [`npm run parity:check`](../scripts/check-parity.mjs) fails CI if one ever does not. (Several were wired ahead of the screen that will call them, which is [ROADMAP.md](../ROADMAP.md) 6.9 rather than the phase that added them: `pack_install_seeds` was registered-but-uncalled until the Packs screen surfaced it, `pack_benchmark` had no IPC command until the same change added one, `book_create` had none until first-run setup needed to create the first book, the fourteen `device_*` commands had none until Settings › Devices surfaced identity and pairing, `book_profile`/`book_set_kind`/`book_set_multi_location_override`/`location_create`/`location_list`/`location_update`/`location_delete` had none until first-run setup and Settings needed to resolve and change a book's profile — see [Book profiles](#book-profiles-phase-60) below — and the eighteen `po_*` [purchasing](#purchasing-phase-64) and twenty-one [sales & invoicing](#sales-orders--invoicing-phase-65) operations are wired the same way.) **20 HTTP operations have no IPC command**: `book_get`, `account_create`/`account_get`/`account_update`/`account_delete` (`account_list` **is** wired — Dashboard, Transactions, Reports and Settings all call it), `transaction_create`/`transaction_get`, `category_create`, `member_get`, `location_get` (create/list/update/delete **are** wired — first-run setup and Settings both call them), `budget_status`, the document status-machine ops (`document_transition`, `document_record_extraction`, `document_current_extraction`), `journal_get`, `coa_seed`, `report_profit_loss`, `report_balance_sheet`, `audit_list`, and `pack_source_publish` (publishing a pack into a shared folder is a CLI/self-host action; the desktop reads sources and installs from them, and has no publish screen).
- Three names currently diverge where both surfaces exist: desktop `report_vat_summary` vs server `report_tax` (the server keeps `report_vat` as a deprecated route alias), desktop `ledger_account_list` vs server `coa_list`, and desktop `category_list` vs server `category_tree`. `settings_get`/`settings_set` share names across both, but the payloads diverge: the desktop carries a whole-settings UI blob, the server generic key/value pairs. `book_set_kind`/`book_set_multi_location_override` share names too, but **their payloads diverge on purpose**: the HTTP route returns the updated `Book`, the desktop IPC command returns the resolved `BookProfile` directly, since that is what the Settings screen redraws from in one round trip. Discounting the three renames, **9 commands are desktop-only**: `journal_list`, `budget_list`, `report_income_expense`, `data_move`, `vault_set`/`vault_replace`, `pay_deliver_due`, `pack_verify`, and `device_invite_cancel`. Each omission is deliberate, not a gap — vault writes and the data-folder move are local-only by design (see [Data folder](#data-folder) and [What is deliberately absent](#what-is-deliberately-absent)), the server flushes webhook deliveries with its own loop instead of a route (see [Payments](#payments)), pack verification is a preflight the CLI does inline (`slipscan pack verify`), and withdrawing a pairing invite belongs with the rest of the local-only invite lifecycle (`slipscan device cancel-invite`). The rest are UI conveniences the server has no reason to grow.

The three sets are machine-readable in [`parity.json`](parity.json), derived from `crates/slipscan-server/src/routes.rs`, `apps/desktop/src-tauri/src/lib.rs`, and `apps/desktop/src/lib/api/client.ts`. Regenerate it in the same change as any route or command you add, so a CI check can diff the doc against the code.

Closing the 20-operation gap (one name, one payload, both transports) is tracked in [ROADMAP.md](../ROADMAP.md).

## Transports

| Transport | Where | Shape |
|---|---|---|
| Tauri IPC | desktop app | `invoke("transaction_list", { ... })` |
| HTTP | `slipscan-server`, default `127.0.0.1:7151` | `POST /api/v1/transaction_list` with a JSON body |

TypeScript mirrors of every payload are hand-maintained in `apps/desktop/src/lib/api/types.ts`; Rust and TS sides are updated in the same change, always.

The server binds loopback by default; an optional hashed bearer token (managed by the `serve` command, never readable via the settings API) gates everything under `/api/v1` when configured. TLS is your reverse proxy's job when you opt into LAN exposure ([SELFHOST.md](SELFHOST.md)).

## Conventions

- **Operation-per-route:** `POST /api/v1/<operation_name>`, body = the operation's request object, response = the result object. Reads and writes alike — the operation name carries the semantics.
- **IDs** are UUIDv7 strings. **Money** is `{ amount_minor: i64, currency: "EUR" }` — integer minor units plus an ISO-4217 code, never floats, no hardcoded currency anywhere. **Timestamps** are ISO-8601 UTC.
- Errors return a JSON `{ "error": { "kind", "message" } }` with a matching HTTP status; over IPC the same object is the rejected promise value.

## Operations

The surface, grouped by domain module. It mirrors the `pub fn`s on the core service, with a handful of route names that differ from the core fn they call: `report_profit_loss` → core `report_income_statement`, and `report_tax` → core `report_tax_summary` (`report_vat` is kept as a deprecated alias for the same route).

### Books & accounts

| Operation | Purpose |
|---|---|
| `book_create` / `book_list` / `book_get` | Manage books (kind = personal \| business); a database file can hold several books. Each book carries a `region` profile id ([CONFIGURATION.md](CONFIGURATION.md#region-profiles)) — set explicitly via the optional `region` field on `book_create` (unknown ids are rejected), otherwise inferred from the book's optional `country`, else `generic`. **One payload divergence:** the desktop's `book_create` also seeds the new book — the region profile's chart of accounts plus a starter category set — because the desktop exposes no separate `coa_seed`, and first-run setup would otherwise hand back a book with an empty ledger. It is the only way a desktop book is created: opening a database never makes one |
| `region_list` | List the built-in region profiles (id, name, default currency, tax-report name) — purely local data |
| `account_create` / `account_get` / `account_list` / `account_update` / `account_delete` | Bank / cash / card / asset / liability accounts |

### Book profiles (Phase 6.0)

One data model, three presentations — personal / business / business-multi-location are progressive disclosure over one schema, decided by `crate::profile::resolve` from a book's `kind`, its `locations` row count, and an optional override, never a schema fork or a migration between tiers (ROADMAP.md "Phase 6" decisions #1 and #3). Every field `book_profile` returns is a *display* fact: a personal book with no Contacts screen still accepts a `NewContact` at the service layer.

| Operation | Purpose |
|---|---|
| `book_profile` | Resolve which capability groups a book should show right now: `kind`, the `locations` row count, the stored override, the resolved `multi_location` flag, and the nine `show_*` booleans (accounts/transactions/budgets/members always true; contacts/catalogue/purchasing/sales gated on `kind == business`; locations additionally gated on `multi_location`) |
| `book_set_kind` | Change a book's kind later, in either direction. Downgrading only ever changes what `book_profile` recommends showing — it never touches a row in `locations`, `contacts`, `product_categories`, `products` or `product_variants`. **One payload divergence:** the desktop IPC command returns the resolved `BookProfile` rather than the updated `Book`, so the Settings screen that calls it redraws in one round trip |
| `book_set_multi_location_override` | Pin (`true`/`false`) or clear (`null`/omitted, back to derived) the multi-location flag — the one piece of Settings-editable state Phase 6.0 adds, stored directly on `books` (the existing `settings` table is a single global key/value store, not per-book, so it cannot hold this). Same payload divergence as `book_set_kind` |

### Locations (Phase 6.1)

Branches, sites and warehouses within a book — additive and optional, the same way `members` is: a book with zero locations behaves exactly as it always has. Adding a second is what derives the multi-location flag on by itself.

| Operation | Purpose |
|---|---|
| `location_create` / `location_get` / `location_list` / `location_update` / `location_delete` | CRUD on a book's locations (`kind` = branch \| warehouse \| site, an optional unique-per-book `code`, an address, an archived flag). No reassignment guard on delete — nothing in core references a location yet |

### Stock (Phase 6.3b)

The **append-only movement ledger**. On-hand is always `SUM(qty_delta)` over immutable rows, computed on every read — never a stored counter. There is deliberately **no "set stock level" operation and there never will be**: a correction is a new `adjustment` movement, which is exactly what lets two locations that traded while disconnected converge by union instead of one overwriting the other. `RAISE(ABORT)` triggers on update and delete mean SQLite itself refuses to mutate a movement.

A **transfer** is two movements summing to zero, written in one transaction, so stock never leaks in transit because it is never in transit — moving stock cannot change how much of it exists.

Routed last of the three Phase 6 foundations: 6.3b shipped with none of its nine operations on any surface, so on-hand could not be read anywhere and a movement could only be written as a side effect of confirming a sales order or receiving a PO.

| Operation | Purpose |
|---|---|
| `stock_movement_record` | Write one signed movement (`receipt` / `sale` / `adjustment` / `transfer` / `count`). Zero is refused |
| `stock_on_hand` | One variant at one location |
| `stock_on_hand_by_location` | One variant, broken down per location |
| `stock_on_hand_total` | One variant across every location |
| `stock_movements_for_variant` / `_for_location` | Movement history along either axis |
| `stock_movements_for_ref` | Every movement written by one source document — the audit trail behind a goods receipt or a confirmed sale |
| `stock_transfer` | Two movements summing to zero, in one transaction |
| `stock_low_variants` | Variants whose total on-hand is **at or below** their reorder point |

### Catalogue (Phase 6.3a)

Product categories, products, and their variants. **The variant is the unit that matters**: `stock_movements` and every purchase-order and sales-order line reference a `variant_id`, never a `product_id`. A product is the grouping ("T-shirt"); a variant is the thing you sell and count ("Blue / L", with its own SKU, price, cost price and reorder point). A SKU is unique within the book.

`product_categories` is deliberately a different table from the transaction `categories` used for classification — a `products.category_id = categories.id` join would type-check while being silently wrong.

Every operation is on all four surfaces (CLI `slipscan catalogue …`, HTTP, desktop IPC, `client.ts`). Like contacts, they were routed late: only `product_variant_list_for_book` was reachable, so an order line could name a variant nothing could create. That was the last blocker on exercising Phase 6 end to end — category, product, variant, order line, confirm, stock movement.

| Operation | Purpose |
|---|---|
| `product_category_create` / `_get` / `_list` / `_rename` / `_delete` | CRUD on the grouping. Deleting a category leaves its products in place, uncategorised |
| `product_create` / `product_get` / `product_list` / `product_update` / `product_delete` | CRUD on the product. `product_delete` is refused while the product still has variants |
| `product_variant_add` / `_get` / `_update` / `_delete` | CRUD on the sellable/stockable unit. SKU uniqueness is enforced within the book |
| `product_variant_list` | Variants of one product |
| `product_variant_list_for_book` | Every variant in the book — what a line-item picker needs |

### Contacts (Phase 6.2)

Customers and suppliers in **one** table with a `role` (`customer` / `supplier` / `both`), deliberately not split in two: a real trading party is often both, and two tables make that party two rows that drift apart. `contact_list_customers` and `contact_list_suppliers` filter on the role, and a `both` contact appears on **both** lists — that is the point of the shape, not a quirk.

Every operation is on all four surfaces (CLI `slipscan contact …`, HTTP, desktop IPC, and a `client.ts` wrapper). They were routed late: the model shipped with Phase 6.2 and only a read-only list was reachable, so an invoice or a purchase order could name a `contact_id` that nothing could create — see [ROADMAP.md](../ROADMAP.md) 6.2 and `npm run reachable:check`, which now fails CI if a core capability is left unreachable again.

Nullable fields follow this API's one convention: omit a key to leave it untouched, send `null` to clear it, send a value to set it.

| Operation | Purpose |
|---|---|
| `contact_add` / `contact_get` / `contact_update` | CRUD on a contact (role, name, company, email, phone, addresses, tax number, payment terms, credit limit, notes) |
| `contact_list` | Every contact in the book |
| `contact_list_customers` / `contact_list_suppliers` | Filtered by role; a `both` contact is on each |
| `contact_remove` | Hard delete, **refused by the database** when the contact has any sales order, invoice or purchase order against it — those FKs are `ON DELETE RESTRICT` so trade history cannot be deleted out from under itself |

### Purchasing (Phase 6.4)

Purchase orders and goods receipts, re-derived from the retired FlowStock product ([ROADMAP.md](../ROADMAP.md) "Phase 6"). `po_receive` is the keystone: it writes a stock movement (`kind = receipt`, `ref_kind = "po_receipt"`) in the same transaction as the receipt row, so on-hand (`stock_on_hand` — Phase 6.3b, itself not yet routed over HTTP either) and a PO's receiving progress can never disagree about how much arrived. `po_receipts` is insert-only — a correction is a second, signed row (`qty` can be negative), never an edit to one already recorded — so two sites receiving against the same line while disconnected converge by union.

Receiving progress (none / partial / complete) is always derived from `po_receipts`, never stored; `purchase_orders.status` (`draft` / `ordered` / `cancelled`) is the one hand-maintained field, moved only through the guarded `po_set_status` transitions.

**All eighteen operations below have a desktop IPC command too**, wired ahead of any screen — there is no Purchasing screen yet (that is [ROADMAP.md](../ROADMAP.md) 6.9, "Desktop screens"), the same order `book_profile` and the location CRUD landed in before first-run setup and Settings needed them. Nothing here invents UI-only behaviour: each command is a thin adapter over the identical core service function CLI and HTTP call, and the mock fallback in `apps/desktop/src/lib/api/mock.ts` (used only outside Tauri, or before a command is wired) mirrors the same derivation rules — `subtotal_minor` recomputed from lines, receiving status derived from receipts, never a stored counter.

Suppliers, locations and product variants referenced below are all creatable on every surface now — [contacts](#contacts-phase-62) and the [catalogue](#catalogue-phase-63a) were routed after this section was first written, which is when it stopped being true that a PO line could only name rows something else had created. `npm run reachable:check` keeps score.

| Operation | Purpose |
|---|---|
| `po_create` / `po_get` / `po_list` / `po_update` / `po_delete` | CRUD on a purchase order header (supplier, expected location, PO number, dates, notes). `subtotal_minor`/`total_minor` are recomputed server-side whenever a line changes — they are not independently settable |
| `po_set_status` | The guarded workflow transition: `draft -> ordered`, `draft -> cancelled`, `ordered -> cancelled`. Never reversible, and never through `po_update` |
| `po_item_add` / `po_item_get` / `po_item_list` / `po_item_update` / `po_item_delete` | CRUD on a PO's line items (variant, quantity, unit price). `po_item_update` refuses to shrink `qty_ordered` below what has already been received |
| `po_receive` | Record one goods receipt against a line **and** write the stock movement it represents, in the same transaction — the keystone invariant this phase exists to prove |
| `po_receipts_for_item` / `po_receipts_for_po` | A line's, or a whole PO's, full receiving history, oldest first |
| `po_item_received_qty` | A line's received quantity: `SUM(qty)` over its receipts, never a stored counter |
| `po_item_receiving_status` / `po_receiving_status` | A line's, or a whole PO's, derived receiving progress (none / partial / complete) |
| `po_items_with_receiving` | A PO's lines paired with each one's derived received quantity and status — what a purchasing screen would actually render |

### Sales orders & invoicing (Phase 6.5)

PARITY.md's single largest Xero-axis gap: "there is no invoicing at all — no invoice entity, no numbering, no delivery, no paid/unpaid state." Closed by two tables with two different sync mappings — see migration `0014_sales`'s header. `sales_orders`/`sales_order_items` are an editable draft (draft → confirmed → paid, or → cancelled); `invoices`/`invoice_items`/`invoice_payments` are only ever created, never edited — an issued invoice is a fact, not a form. All 21 operations exist under the same name on HTTP and desktop IPC; on the CLI they are `slipscan sales-order <action>` and `slipscan invoice <action>` (`slipscan report aged-receivables` for the last row). **These are the first Phase 6 tables with a real surface** — contacts (6.2), the catalogue (6.3a) and the stock ledger (6.3b) all shipped core-only, and still have none.

| Operation | Purpose |
|---|---|
| `sales_order_create` / `sales_order_get` / `sales_order_list` / `sales_order_update` / `sales_order_delete` | A customer order: contact, optional location, currency, notes. `update` only reaches a `draft` order (location/date/notes — never `status`, which has its own transition operations below); `delete` only reaches a `draft` order too — cancel a confirmed one instead |
| `sales_order_item_add` / `sales_order_items_list` / `sales_order_item_update` / `sales_order_item_remove` | Line items: a catalogue line (`variant_id`, description/price default from the variant) or a free-text/service line (`variant_id: null`, description and price required). All three writes are refused once the order leaves `draft` |
| `sales_order_confirm` | draft → confirmed: deducts stock for every stock-tracked line (`stock_movements`, `kind = sale`) — this is ROADMAP.md's "delivery". Requires a `location_id` the moment any line is stock-tracked |
| `sales_order_cancel` | draft\|confirmed → cancelled. From `confirmed`, writes one compensating stock movement per stock-tracked line rather than touching the original rows — the ledger `stock_movements` posts to is immutable |
| `sales_order_mark_paid` | confirmed → paid — a cash-sale convenience for an order settled with no invoice at all |
| `sales_order_totals` | `subtotal`/`tax`/`total`, derived from the order's own lines at call time — never a stored column |
| `invoice_issue` | The only way an invoice comes into existence — already numbered, no draft phase. Either from a confirmed/paid sales order (`sales_order_id`; its own contact/currency/lines win) or standalone (`contact_id` + `items`). Numbering is atomic per `(book_id, series)` and gapless under concurrent callers on one machine — see migration `0014_sales`'s header for the one thing it does not yet cover (multi-device numbering, blocked on the sync transport in Phase 6.7) |
| `invoice_get` / `invoice_list` / `invoice_items_list` | Read an issued invoice and its lines. There is no update or delete operation anywhere on this path — the schema itself refuses both |
| `invoice_totals` | `subtotal`/`tax`/`total`/`paid`/`due` and the derived `unpaid`/`partly_paid`/`paid` status — computed from `invoice_payments` every time, never stored |
| `invoice_payment_record` / `invoice_payments_list` | Record a payment against an invoice (amount, date, free-text method/note) and list them. Not blocked from exceeding the balance due |
| `report_aged_receivables` | Every outstanding invoice, by customer, bucketed by age as of a date (defaults to today): current / 1-30 / 31-60 / 61-90 / 90+ days overdue. PARITY.md's #2-ranked gap, the receivables half |

### Transactions & classification

| Operation | Purpose |
|---|---|
| `transaction_create` / `transaction_get` / `transaction_list` | Bank-level transactions; `source` = scraper \| email \| import \| manual |
| `transaction_categorize` | Assign a category; records a local correction that feeds the learning loop ([PACKS.md](PACKS.md#corrections-stay-local)) |
| `category_create` / `category_tree` | Hierarchical categories |

### Household members & attribution

Members are rows in the book, never logins — the model is in [ARCHITECTURE.md](ARCHITECTURE.md#household-members--per-person-attribution). Attribution is metadata on the transaction: it adds a member dimension to reporting and never alters debits or credits.

| Operation | Purpose |
|---|---|
| `member_add` / `member_get` / `member_list` / `member_update` / `member_remove` | People in the household: label, display initial, cosmetic colour, and an optional default account they own (new transactions on it attribute to them unless overridden) |
| `transaction_attribute` | Set — or clear, with a null member — who a transaction is attributed to; the member must belong to the transaction's book |
| `transaction_splits_list` / `transaction_split_set` | Split one transaction across members as `(member_id, share_minor)` rows that must sum to the transaction's absolute amount; each member appears at most once, and an empty list clears the split |

### Budgets

| Operation | Purpose |
|---|---|
| `budget_upsert` | Per-category monthly budget, rollover flag |
| `budget_status` | Spent-vs-budget for a month — the data behind budget nudges |

### Documents (receipts / slips / statements)

| Operation | Purpose |
|---|---|
| `document_import` | Ingest a file; enters the `pending → extracted → reviewed` state machine |
| `document_get` / `document_list` | Fetch with extraction status |
| `document_transition` | Move through the status machine (e.g. mark reviewed) |
| `document_record_extraction` / `document_current_extraction` | Store / read the slip-v2 result (line items, categories, discounts, VAT) — core service fns only today, not HTTP routes (`slipscan extract` writes results locally) |

### Ledger (double-entry)

| Operation | Purpose |
|---|---|
| `coa_list` / `coa_seed` | Chart of accounts; seed a standard chart into a new business book |
| `journal_post` / `journal_get` | Post balanced journals — unbalanced lines are rejected at the service layer |
| `vat_rate_list` / `vat_rate_set_bps` | Tax rates for the book: list them, and set a rate's basis points (how the generic profile's configurable standard rate — seeded at 0 — gets its actual percentage; `slipscan tax set-rate` on the CLI) |

### Reconciliation

| Operation | Purpose |
|---|---|
| `recon_suggest` | Suggested matches across documents / transactions / journal lines |
| `recon_confirm` | Confirm a match |

### Reports

| Operation | Purpose |
|---|---|
| `report_spending` | Spending breakdowns by category/period |
| `report_trial_balance` | Trial balance for business books |
| `report_profit_loss` / `report_balance_sheet` / `report_tax` | Income statement, balance sheet, and the tax-period summary (base-currency) — labeled from the book's region profile ("VAT201" is the `za` profile's name for it). `report_vat` remains as a deprecated alias of `report_tax` |
| `report_member_expense` / `report_member_contribution` | Per-member expense and contribution rollups over a period ([Household members](ARCHITECTURE.md#household-members--per-person-attribution)) |
| `report_member_category` | Share-of-category per member. Server + desktop only — no CLI equivalent yet (`slipscan report` supports `tb`/`pl`/`bs`/`tax`/`members`/`settle-up`, not this one) |
| `report_settle_up` | Net "who owes whom" position per member over a period; desktop and CLI (`slipscan report settle-up`) both call it |

### Settings, packs, audit

| Operation | Purpose |
|---|---|
| `settings_get` / `settings_set` | Key/value settings; secret-flagged values are **rejected over HTTP** — secret material is set locally (CLI / desktop) only ([CONFIGURATION.md](CONFIGURATION.md#the-settings-model)) |
| `pack_install` / `pack_list` | Verify (ed25519) and install a classification pack ([PACKS.md](PACKS.md)) |
| `pack_install_seeds` | Install the built-in seed packs into a book — an explicit action, never automatic, and idempotent (categories you already have are adopted by (parent, name), not duplicated). On the desktop it is a user action on the Packs screen, presented with the book's region profile in view |
| `pack_source_list` / `pack_source_add` / `pack_source_remove` | Where packs may be fetched from — a list only the user writes. **Empty on a fresh install, and nothing seeds it**: with no source configured SlipScan makes no outbound request about packs at all. A source is `file:<path>`, `folder:<path>` (a synced folder or USB stick), `git:<url>[#ref]`, or `https://<url>`; plain `http://` is refused ([PACKS.md](PACKS.md#getting-a-pack)) |
| `pack_source_fetch` | Read a source's catalogue and preflight every pack it offers against a book. **Installs nothing.** Each offer carries the catalogue's (untrusted) claim and, when the bytes verify, the signer fingerprint and what installing would do |
| `pack_source_install` | Fetch one pack from a source and install it. Verification happens on the bytes before the database is touched; a signer this machine has never seen refuses unless `accept_signer` carries the fingerprint the caller was shown; a changed publisher key on a pinned pack id refuses regardless |
| `pack_source_publish` | Write a signed pack into a `folder:` source, in the layout every reader expects — a directory named for the publisher's key fingerprint, so two publishers sharing one folder never write the same path. The three inputs are verified before a byte is written |
| `pack_uninstall` | Remove a pack's rules and its registration. Categories it created stay (history never breaks) and the signer pin stays; returns `false` if that pack was not installed |
| `pack_benchmark` | Peer comparison for one month (`period`: `YYYY-MM`) against installed benchmark packs — computed locally from your own spend, transmits nothing ([BENCHMARKS.md](BENCHMARKS.md)). On all three surfaces (HTTP, `slipscan pack benchmark`, and the desktop Packs screen); the desktop DTO adds the pack's display name, and no surface converts currencies — a pack the book's currency does not match comes back `skipped`, and a taxonomy key nothing maps to comes back in `unmapped_keys` |
| `audit_list` | Read the append-only audit log |
| `vault_list` / `vault_revoke` | Vault **metadata** and revocation; `vault_set`/`vault_replace` are deliberately not HTTP routes |

### Data folder

Where the durable data lives, and the operation that relocates it ([ARCHITECTURE.md](ARCHITECTURE.md#data-location--backup--your-folder-your-cloud-your-responsibility)).

| Operation | Purpose |
|---|---|
| `data_status` | Current data folder, pointer path, and sizes. The **one `GET`** in the API — `GET /api/v1/data_status`, everything else is `POST`. A server started with an explicit `--db` (no managed folder) answers `503` rather than inventing an answer about a folder it is not serving. The desktop DTO adds a cloud-sync hint for the Settings screen |
| `data_move` | Move the data folder (copy → verify → switch pointer → delete old). **Desktop IPC and CLI (`slipscan data move`) only — no HTTP route.** The target is a path on the server's own filesystem, so a remote caller cannot meaningfully name one and a leaked bearer token could otherwise redirect and then delete the data; the process must also quiesce read-only mid-move, which an HTTP client cannot be trusted to coordinate; and the move deletes the old copy, which is an owner-present decision |

### Exchange rates (opt-in)

The opt-in OpenRate FX operations ([CONFIGURATION.md](CONFIGURATION.md#exchange-rates--openrate-opt-in)) are exposed under the same names on both transports — HTTP routes and desktop IPC commands — plus the `slipscan fx` CLI subcommand:

| Operation | Purpose |
|---|---|
| `fx_configure` | Set (or clear, with an empty string) the OpenRate base URL — purely local |
| `fx_status` | Configured flag, base URL, and cached rates with staleness/grade — purely local, never fetches |
| `fx_fetch_rate` | **The only operation that touches the network**, always on explicit user action, only against the configured URL. Persists the fetched rate to the local cache. Without a configured URL it fails `fx_not_configured` before any transport is touched; a server started without an FX transport answers `503 fx_unavailable` |
| `fx_convert` | Convert `amount_minor` between currencies **from the cache only** (a missing pair is an error, never a silent fetch); records the exact decimal rate used in the response and the audit log. With the optional `rate` field (a decimal string) the conversion instead **replays at that pinned rate** (core `fx_convert_at`, `slipscan fx convert --rate`) — how a booked conversion reproduces offline without ever being re-rated by cache refreshes |

Rates are decimal strings end-to-end — never floats. The single FX setting (`fx.openrate_base_url`) can also be written through the generic `settings_set` route.

### Payments

Reference watches and signed webhooks: watch reference codes on inbound transactions and fire signed webhooks to endpoints you registered — the full model, delivery semantics, and a receiver verification example are in [PAYMENTS.md](PAYMENTS.md). All `pay_*` operations exist under the same names on both transports, with the exceptions called out below:

| Operation | Purpose |
|---|---|
| `pay_watch_add` / `pay_watch_list` / `pay_watch_remove` / `pay_watch_set_enabled` | Watch codes: a flat list of references to detect (whole-token, case-insensitive, inbound only), each optionally narrowed to one exact `expected_amount_minor` + `expected_currency`. Enabled/disabled is the only state |
| `pay_endpoint_add` / `pay_endpoint_rotate_secret` | **Refused over HTTP** — the response carries the endpoint's signing secret exactly once, and secret material never transits HTTP. Add and rotate locally (CLI `slipscan pay endpoint …` / desktop Payments panel) |
| `pay_endpoint_list` / `pay_endpoint_remove` / `pay_endpoint_set_enabled` | Endpoint metadata (URL, label, enabled — never secrets); removal drops the endpoint's queued deliveries and revokes its vault-held secret; disabling parks its queue without touching the rows |
| `pay_match_list` / `pay_delivery_list` | Detected matches, and the SQLite delivery queue with state (`pending` / `delivered` / `failed`), attempts, `next_attempt_at`, and last status/error |
| `pay_deliver_due` | POST every due pending delivery now — **desktop IPC only**. The server has no route for it: `slipscan serve` runs its own delivery loop (every 30 s, honoring each delivery's backoff), and `slipscan mail-sync` / `slipscan pay deliver` flush from the CLI |

### Devices (identity & pairing)

Per-device ed25519 identity and the pairing ceremony ([NODES.md](NODES.md)). **Nothing here syncs anything** — there is no transport, no coordinator, no directory and no default endpoint, and no operation below moves a byte of book data. The signed operation log ([NODES.md](NODES.md#the-operation-log--phase-2)) is deliberately **not** exposed here either, on either surface: a route handing out operations would be the front half of a transport, with no authenticated peer, no replay defence and no admission check behind it. `slipscan sync` is CLI-only. Pairing establishes that this key and that key belong together, and stops.

There are also no accounts: no email, no password, no username, no login. A device's **public key *is* its id**, and its human-comparable rendering (`keyname`, nine checksummed words) is what a person compares out of band.

The split across transports is one rule — *an operation that would put key material or a claim token on the wire is local-only*:

| Operation | Purpose |
|---|---|
| `device_status` | This device's own identity (`public_key`, `keyname`, `label`, timestamps), or `null` if it has none. Public information; served |
| `device_list` / `device_get` | Pinned peers, **revoked tombstones included** — a tombstone is why a re-pair is being refused, so hiding it would hide the reason. `last_seen_at` is always `null`: nothing connects to anything |
| `device_invite_list` | Invite metadata. **Never carries a claim token** — only a SHA-256 of it is stored, so a copy of the database can redeem nothing |
| `device_rotations` | This device's rotation chain: each entry is signed by the key it replaced, so the chain proves itself |
| `device_revoke` | Revoke a peer. The pin becomes a **tombstone**, not a deleted row, so that key cannot silently re-pair. Served deliberately: cutting a lost device off a self-hosted box is the point of having one |
| `device_init` / `device_rotate` / `device_reset` | **Refused over HTTP** (the routes exist to say so and name the local command). They create or destroy the private key, which is generated on the device and lives in the write-only vault. `init` refuses when an identity exists; `rotate` must be signed by the outgoing key; `reset` is the deliberate local wipe and keeps peer pins. Desktop IPC additionally requires `confirm` on `device_reset`, mirroring the CLI's `--yes` |
| `device_forget` | **Refused over HTTP.** Drops a pin outright, tombstone included — the only way back from a revocation, and deliberately local so no message can reach it |
| `device_pair_invite` / `device_pair_accept` / `device_pair_confirm` | **Refused over HTTP.** The ceremony: mint a single-use invite, redeem it (pins the inviter, returns an acceptance), redeem that (burns the claim token, pins the accepter). Blobs are base64url text a human carries — QR, paste, USB. Two reasons this cannot be a route: the invite blob **is a credential** until redeemed, and the key-name comparison needs a person in front of the device |
| `device_invite_cancel` | Withdraw an unredeemed invite. **Desktop IPC and CLI (`slipscan device cancel-invite`) only** — the whole invite lifecycle is local, and a live credential needs an answer other than waiting out its TTL |

Both redeem operations take the key-name check explicitly, and **it is not optional**: pass either the key-name the user typed after reading it off the other device (compared against the key inside the blob; a mismatch refuses, and a name failing its own checksum reports itself as *mistyped* instead) or an assertion that the caller displayed the key-name and a human affirmed it. Supplying neither is refused rather than silently downgraded. That comparison is the entire authentication step — the blobs are self-signed, so one substituted wholesale in transit verifies perfectly. (The CLI's `--unverified` escape hatch exists for scripted use; the desktop has no equivalent, and its pairing screen requires the key-name to be typed.)

### Health

`GET /health` → `{ "status": "ok", "version": "..." }`. The one non-`/api/v1` route — unauthenticated, outside the bearer check — for probes and reverse-proxy checks. The desktop has the same-named `health` IPC command; it adds the `tauri` runtime version and backs the sidebar's live/mock status badge.

## What is deliberately absent

- **No vault-read operation.** Vault writes (`vault_set` / `vault_replace`) exist over desktop IPC only; over HTTP only `vault_list` (metadata) and `vault_revoke` exist. Nothing returns secret material over IPC or HTTP, to anyone, ever. This is structural, not policy — see [THREAT-MODEL.md](THREAT-MODEL.md).
- **No remote data-folder move.** `data_move` exists over desktop IPC and the CLI only; over HTTP the data folder is read-only status (`data_status`). The rationale is in [Data folder](#data-folder) above and in the `data_status` handler's doc comment.
- **No remote device pairing, and no accounts to pair.** `device_init`, `device_rotate`, `device_reset`, `device_forget` and the three `device_pair_*` operations are desktop IPC and CLI only; the routes exist solely to refuse and name the local command ([Devices](#devices-identity--pairing)). And **no operation anywhere syncs book data between devices** — [NODES.md](NODES.md) phases 1 and 2 (identity, and a signed operation log) exist; the transport does not.
- **No cloud concepts.** No orgs, no billing, no auth-as-a-service. Those died with the legacy stack ([CHANGELOG.md](../CHANGELOG.md)).
- **No push from the server.** Clients poll or subscribe locally; the server only answers.

---

**Next:** [THREAT-MODEL.md](THREAT-MODEL.md) — what an attacker with your files actually gets.
