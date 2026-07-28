# API

SlipScan has **one service surface, two transports**. Every operation is a function on the core service layer (`crates/slipscan-core`); the Tauri desktop app calls it over IPC and `slipscan-server` exposes the same operations over HTTP. Full same-name/same-payload parity is the contract in [ARCHITECTURE.md](ARCHITECTURE.md#ipc--api-surface) — **and it is not met yet**:

- The **HTTP server is the canonical, near-complete surface** — the operation tables below describe it. 75 routes under `/api/v1` (74 distinct handlers: `report_vat` is a deprecated alias of `report_tax`), plus the public `GET /health`.
- The **desktop IPC exposes a UI-shaped subset** — **65 commands** with display-oriented DTOs (`health` in `src-tauri/src/lib.rs`, the other 64 in `src-tauri/src/commands.rs`). `apps/desktop/src/lib/api/client.ts` calls **all 65**: every registered command is reachable from a screen. (`pack_install_seeds` was registered-but-uncalled until the Packs screen surfaced it as an explicit action, `pack_benchmark` had no IPC command at all until the same change added one, and `book_create` had none until first-run setup needed to create the first book.) **18 HTTP operations have no IPC command**: `book_get`, `account_create`/`account_get`/`account_update`/`account_delete` (`account_list` **is** wired — Dashboard, Transactions, Reports and Settings all call it), `transaction_create`/`transaction_get`, `category_create`, `member_get`, `budget_status`, the document status-machine ops (`document_transition`, `document_record_extraction`, `document_current_extraction`), `journal_get`, `coa_seed`, `report_profit_loss`, `report_balance_sheet`, and `audit_list`.
- Three names currently diverge where both surfaces exist: desktop `report_vat_summary` vs server `report_tax` (the server keeps `report_vat` as a deprecated route alias), desktop `ledger_account_list` vs server `coa_list`, and desktop `category_list` vs server `category_tree`. `settings_get`/`settings_set` share names across both, but the payloads diverge: the desktop carries a whole-settings UI blob, the server generic key/value pairs. Discounting those three renames, **8 commands are desktop-only**: `journal_list`, `budget_list`, `report_income_expense`, `data_move`, `vault_set`/`vault_replace`, `pay_deliver_due`, and `pack_verify`. Each omission is deliberate, not a gap — vault writes and the data-folder move are local-only by design (see [Data folder](#data-folder) and [What is deliberately absent](#what-is-deliberately-absent)), the server flushes webhook deliveries with its own loop instead of a route (see [Payments](#payments)), and pack verification is a preflight the CLI does inline (`slipscan pack verify`). The rest are UI conveniences the server has no reason to grow.

The three sets are machine-readable in [`parity.json`](parity.json), derived from `crates/slipscan-server/src/routes.rs`, `apps/desktop/src-tauri/src/lib.rs`, and `apps/desktop/src/lib/api/client.ts`. Regenerate it in the same change as any route or command you add, so a CI check can diff the doc against the code.

Closing the 18-operation gap (one name, one payload, both transports) is tracked in [ROADMAP.md](../ROADMAP.md).

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
| `book_create` / `book_list` / `book_get` | Manage books (kind = personal \| business); a database file can hold several books. Each book carries a `region` profile id ([CONFIGURATION.md](CONFIGURATION.md#region-profiles)) — set explicitly via the optional `region` field on `book_create` (unknown ids are rejected), otherwise inferred from the book's optional `country`, else `generic`. **One payload divergence:** the desktop's `book_create` also runs the seed a fresh install's book gets — the region profile's chart of accounts plus a starter category set — because the desktop exposes no separate `coa_seed`, and first-run setup would otherwise hand back a book with an empty ledger |
| `region_list` | List the built-in region profiles (id, name, default currency, tax-report name) — purely local data |
| `account_create` / `account_get` / `account_list` / `account_update` / `account_delete` | Bank / cash / card / asset / liability accounts |

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

### Health

`GET /health` → `{ "status": "ok", "version": "..." }`. The one non-`/api/v1` route — unauthenticated, outside the bearer check — for probes and reverse-proxy checks. The desktop has the same-named `health` IPC command; it adds the `tauri` runtime version and backs the sidebar's live/mock status badge.

## What is deliberately absent

- **No vault-read operation.** Vault writes (`vault_set` / `vault_replace`) exist over desktop IPC only; over HTTP only `vault_list` (metadata) and `vault_revoke` exist. Nothing returns secret material over IPC or HTTP, to anyone, ever. This is structural, not policy — see [THREAT-MODEL.md](THREAT-MODEL.md).
- **No remote data-folder move.** `data_move` exists over desktop IPC and the CLI only; over HTTP the data folder is read-only status (`data_status`). The rationale is in [Data folder](#data-folder) above and in the `data_status` handler's doc comment.
- **No cloud concepts.** No orgs, no billing, no auth-as-a-service. Those died with the legacy stack ([CHANGELOG.md](../CHANGELOG.md)).
- **No push from the server.** Clients poll or subscribe locally; the server only answers.

---

**Next:** [THREAT-MODEL.md](THREAT-MODEL.md) — what an attacker with your files actually gets.
