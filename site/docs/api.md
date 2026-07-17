# API

SlipScan has **one service surface, two transports**. Every operation is a function on the core service layer (`crates/slipscan-core`); the Tauri desktop app calls it over IPC and `slipscan-server` exposes the same operations over HTTP. Same names, same serde-JSON payloads, same behaviour — [ARCHITECTURE.md](ARCHITECTURE.md#ipc--api-surface) makes this parity a contract.

## Transports

| Transport | Where | Shape |
|---|---|---|
| Tauri IPC | desktop app | `invoke("transaction_list", { ... })` |
| HTTP | `slipscan-server`, default `127.0.0.1:7151` | `POST /api/v1/transaction_list` with a JSON body |

TypeScript mirrors of every payload are hand-maintained in `apps/desktop/src/lib/api/types.ts`; Rust and TS sides are updated in the same change, always.

Because the server binds loopback by default, there is no auth layer in the server itself — access control is the machine boundary, or your reverse proxy when you opt into more ([SELFHOST.md](SELFHOST.md)).

## Conventions

- **Operation-per-route:** `POST /api/v1/<operation_name>`, body = the operation's request object, response = the result object. Reads and writes alike — the operation name carries the semantics.
- **IDs** are UUIDv7 strings. **Money** is `{ amount_minor: i64, currency: "ZAR" }` — integer minor units, never floats. **Timestamps** are ISO-8601 UTC.
- Errors return a JSON `{ "error": { "kind", "message" } }` with a matching HTTP status; over IPC the same object is the rejected promise value.

## Operations

The surface, grouped by domain module. This is the same list you'll find as `pub fn`s on the core service.

### Books & accounts

| Operation | Purpose |
|---|---|
| `book_create` / `book_list` / `book_get` | Manage books (one SQLite file each; kind = personal \| business) |
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
| `document_record_extraction` / `document_current_extraction` | Store / read the slip-v2 result (line items, categories, discounts, VAT) |

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

### Settings, packs, audit

| Operation | Purpose |
|---|---|
| `settings_get` / `settings_set` | Key/value settings; secret values store a keychain entry **name**, the material goes to the vault ([CONFIGURATION.md](CONFIGURATION.md#the-settings-model)) |
| `pack_install` | Verify (ed25519) and install a classification pack ([PACKS.md](PACKS.md)) |
| `audit_list` | Read the append-only audit log |

### Health (HTTP only)

`GET /health` → `{ "status": "ok", "version": "..." }`. The one non-`/api/v1` route; exists for probes and reverse-proxy checks.

## What is deliberately absent

- **No vault-read operation.** `vault.set` / `replace` / `revoke` exist; nothing returns secret material over IPC or HTTP, to anyone, ever. The UI gets metadata only. This is structural, not policy — see [THREAT-MODEL.md](THREAT-MODEL.md).
- **No cloud concepts.** No orgs, no billing, no auth-as-a-service. Those died with the legacy stack ([CHANGELOG.md](../CHANGELOG.md)).
- **No push from the server.** Clients poll or subscribe locally; the server only answers.

---

**Next:** [THREAT-MODEL.md](THREAT-MODEL.md) — what an attacker with your files actually gets.
