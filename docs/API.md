# API

SlipScan has **one service surface, two transports**. Every operation is a function on the core service layer (`crates/slipscan-core`); the Tauri desktop app calls it over IPC and `slipscan-server` exposes the same operations over HTTP. Full same-name/same-payload parity is the contract in [ARCHITECTURE.md](ARCHITECTURE.md#ipc--api-surface) — **and it is not met yet**:

- The **HTTP server is the canonical, near-complete surface** — the operation tables below describe it.
- The **desktop IPC currently exposes a UI-shaped subset** (25 commands) with display-oriented DTOs. Missing from IPC today: `book_create`/`book_get`, all account CRUD, `transaction_create`/`transaction_get`, `category_create`, `budget_status`, the document status-machine ops (`document_transition`, `document_record_extraction`, `document_current_extraction`), `journal_get`, `coa_seed`, `vat_rate_list`, `report_profit_loss`, `report_balance_sheet`, `audit_list`, and `pack_install`/`pack_list`.
- Three names currently diverge where both surfaces exist: desktop `report_vat_summary` vs server `report_vat`, desktop `ledger_account_list` vs server `coa_list`, and desktop `category_list` vs server `category_tree`. `settings_get`/`settings_set` share names across both, but the payloads diverge: the desktop carries a whole-settings UI blob, the server generic key/value pairs. The desktop additionally has `journal_list`, `budget_list`, `report_income_expense`, and `vault_set`/`vault_replace`, none of which are HTTP routes (vault writes are deliberately local-only — see below).

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
- **IDs** are UUIDv7 strings. **Money** is `{ amount_minor: i64, currency: "ZAR" }` — integer minor units, never floats. **Timestamps** are ISO-8601 UTC.
- Errors return a JSON `{ "error": { "kind", "message" } }` with a matching HTTP status; over IPC the same object is the rejected promise value.

## Operations

The surface, grouped by domain module. It mirrors the `pub fn`s on the core service, with a handful of route names that differ from the core fn they call: `report_profit_loss` → core `report_income_statement`, and `report_vat` → core `report_vat201`.

### Books & accounts

| Operation | Purpose |
|---|---|
| `book_create` / `book_list` / `book_get` | Manage books (kind = personal \| business); a database file can hold several books |
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
| `vat_rate_list` | VAT rates for the book |

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
| `report_profit_loss` / `report_balance_sheet` / `report_vat` | Income statement, balance sheet, VAT201 summary (base-currency) |

### Settings, packs, audit

| Operation | Purpose |
|---|---|
| `settings_get` / `settings_set` | Key/value settings; secret-flagged values are **rejected over HTTP** — secret material is set locally (CLI / desktop) only ([CONFIGURATION.md](CONFIGURATION.md#the-settings-model)) |
| `pack_install` / `pack_list` | Verify (ed25519) and install a classification pack ([PACKS.md](PACKS.md)) |
| `audit_list` | Read the append-only audit log |
| `vault_list` / `vault_revoke` | Vault **metadata** and revocation; `vault_set`/`vault_replace` are deliberately not HTTP routes |

### Health (HTTP only)

`GET /health` → `{ "status": "ok", "version": "..." }`. The one non-`/api/v1` route; exists for probes and reverse-proxy checks.

## What is deliberately absent

- **No vault-read operation.** Vault writes (`vault_set` / `vault_replace`) exist over desktop IPC only; over HTTP only `vault_list` (metadata) and `vault_revoke` exist. Nothing returns secret material over IPC or HTTP, to anyone, ever. This is structural, not policy — see [THREAT-MODEL.md](THREAT-MODEL.md).
- **No cloud concepts.** No orgs, no billing, no auth-as-a-service. Those died with the legacy stack ([CHANGELOG.md](../CHANGELOG.md)).
- **No push from the server.** Clients poll or subscribe locally; the server only answers.

---

**Next:** [THREAT-MODEL.md](THREAT-MODEL.md) — what an attacker with your files actually gets.
