# API

SlipScan has **one service surface, two transports**. Every operation is a function on the core service layer (`crates/slipscan-core`); the Tauri desktop app calls it over IPC and `slipscan-server` exposes the same operations over HTTP. Full same-name/same-payload parity is the contract in [ARCHITECTURE.md](ARCHITECTURE.md#ipc--api-surface) — **and it is not met yet**:

- The **HTTP server is the canonical, near-complete surface** — the operation tables below describe it.
- The **desktop IPC currently exposes a UI-shaped subset** (32 commands) with display-oriented DTOs. Missing from IPC today: `book_create`/`book_get`, all account CRUD, `transaction_create`/`transaction_get`, `category_create`, `budget_status`, the document status-machine ops (`document_transition`, `document_record_extraction`, `document_current_extraction`), `journal_get`, `coa_seed`, `report_profit_loss`, `report_balance_sheet`, `audit_list`, and `pack_install`/`pack_list`.
- Three names currently diverge where both surfaces exist: desktop `report_vat_summary` vs server `report_tax` (the server keeps `report_vat` as a deprecated route alias), desktop `ledger_account_list` vs server `coa_list`, and desktop `category_list` vs server `category_tree`. `settings_get`/`settings_set` share names across both, but the payloads diverge: the desktop carries a whole-settings UI blob, the server generic key/value pairs. The desktop additionally has `journal_list`, `budget_list`, `report_income_expense`, and `vault_set`/`vault_replace`, none of which are HTTP routes (vault writes are deliberately local-only — see below).

Closing this gap (one name, one payload, both transports) is tracked in [ROADMAP.md](../ROADMAP.md).

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
| `book_create` / `book_list` / `book_get` | Manage books (kind = personal \| business); a database file can hold several books. Each book carries a `region` profile id ([CONFIGURATION.md](CONFIGURATION.md#region-profiles)) — set explicitly via the optional `region` field on `book_create` (unknown ids are rejected), otherwise inferred from the book's optional `country`, else `generic` |
| `region_list` | List the built-in region profiles (id, name, default currency, tax-report name) — purely local data |
| `account_create` / `account_get` / `account_list` / `account_update` / `account_delete` | Bank / cash / card / asset / liability accounts |

### Transactions & classification

| Operation | Purpose |
|---|---|
| `transaction_create` / `transaction_get` / `transaction_list` | Bank-level transactions; `source` = scraper \| email \| import \| manual |
| `transaction_categorize` | Assign a category; records a local correction that feeds the learning loop ([PACKS.md](PACKS.md#corrections-stay-local)) |
| `category_create` / `category_tree` | Hierarchical categories |

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

### Settings, packs, audit

| Operation | Purpose |
|---|---|
| `settings_get` / `settings_set` | Key/value settings; secret-flagged values are **rejected over HTTP** — secret material is set locally (CLI / desktop) only ([CONFIGURATION.md](CONFIGURATION.md#the-settings-model)) |
| `pack_install` / `pack_list` | Verify (ed25519) and install a classification pack ([PACKS.md](PACKS.md)) |
| `audit_list` | Read the append-only audit log |
| `vault_list` / `vault_revoke` | Vault **metadata** and revocation; `vault_set`/`vault_replace` are deliberately not HTTP routes |

### Exchange rates (opt-in)

The opt-in OpenRate FX operations ([CONFIGURATION.md](CONFIGURATION.md#exchange-rates--openrate-opt-in)) are exposed under the same names on both transports — HTTP routes and desktop IPC commands — plus the `slipscan fx` CLI subcommand:

| Operation | Purpose |
|---|---|
| `fx_configure` | Set (or clear, with an empty string) the OpenRate base URL — purely local |
| `fx_status` | Configured flag, base URL, and cached rates with staleness/grade — purely local, never fetches |
| `fx_fetch_rate` | **The only operation that touches the network**, always on explicit user action, only against the configured URL. Persists the fetched rate to the local cache. Without a configured URL it fails `fx_not_configured` before any transport is touched; a server started without an FX transport answers `503 fx_unavailable` |
| `fx_convert` | Convert `amount_minor` between currencies **from the cache only** (a missing pair is an error, never a silent fetch); records the exact decimal rate used in the response and the audit log. With the optional `rate` field (a decimal string) the conversion instead **replays at that pinned rate** (core `fx_convert_at`, `slipscan fx convert --rate`) — how a booked conversion reproduces offline without ever being re-rated by cache refreshes |

Rates are decimal strings end-to-end — never floats. The single FX setting (`fx.openrate_base_url`) can also be written through the generic `settings_set` route.

### Health (HTTP only)

`GET /health` → `{ "status": "ok", "version": "..." }`. The one non-`/api/v1` route; exists for probes and reverse-proxy checks.

## What is deliberately absent

- **No vault-read operation.** Vault writes (`vault_set` / `vault_replace`) exist over desktop IPC only; over HTTP only `vault_list` (metadata) and `vault_revoke` exist. Nothing returns secret material over IPC or HTTP, to anyone, ever. This is structural, not policy — see [THREAT-MODEL.md](THREAT-MODEL.md).
- **No cloud concepts.** No orgs, no billing, no auth-as-a-service. Those died with the legacy stack ([CHANGELOG.md](../CHANGELOG.md)).
- **No push from the server.** Clients poll or subscribe locally; the server only answers.

---

**Next:** [THREAT-MODEL.md](THREAT-MODEL.md) — what an attacker with your files actually gets.
