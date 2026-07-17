# SlipScan Architecture

This document is the **binding contract** for the codebase. Changes to it are deliberate, discussed decisions — not drive-by edits.

## Layout

```
Cargo.toml                 # workspace (crates/* only; desktop src-tauri is its own crate)
crates/
  slipscan-core/           # domain model, SQLite storage, migrations, services — everything depends on this
  slipscan-extract/        # document extraction: slip-v2 schema, OCR/LLM providers (BYO key), provider trait
  slipscan-ingest/         # email inbound (IMAP), file import/watch, bank-scraper framework
  slipscan-packs/          # signed classification/category packs: format, ed25519 verify, import/export
  slipscan-server/         # axum headless server (self-host mode), thin wrapper over core services
  slipscan-cli/            # clap CLI: init, import, serve, list, export
apps/
  desktop/                 # Tauri 2 + Svelte 5 + TypeScript + Vite + Tailwind v4
    src/                   # Svelte frontend
    src-tauri/             # Tauri shell — thin IPC adapters over slipscan-core, no logic here
assets/brand/              # logo, favicon
docs/                      # this file, guides
```

## Technology decisions

| Concern | Choice | Notes |
|---|---|---|
| Storage | `rusqlite` (bundled) | one SQLite file per book, user-visible path, WAL |
| Migrations | embedded numbered SQL via `include_str!`, tiny runner in core | no external migration tool |
| IDs | UUID v7 strings (`uuid` crate) | sortable, no coordination |
| Time | `time` crate, ISO-8601 UTC in DB | render local in UI |
| Money | `i64` minor units + ISO-4217 currency code | **never floats** |
| Errors | `thiserror` in libraries, `anyhow` only in binaries | |
| Secrets | `keyring` crate (OS keychain) | IMAP passwords, LLM API keys — **never in SQLite or config files** |
| Pack signing | `ed25519-dalek` | packs are signed, verified on install |
| Server | `axum`, binds `127.0.0.1` by default | explicit opt-in for LAN bind |
| Desktop | Tauri 2 | IPC commands are thin: parse → call core service → serialize |
| Frontend | Svelte 5 (runes) + TypeScript + Vite + Tailwind v4 | minimal internal router, no router dependency |
| Fonts | `@fontsource` Inter + Geist Mono | bundled, offline |

## Core domain (slipscan-core modules)

- `book` — a ledgerable context (personal / business); one SQLite file each; `kind` drives which features surface
- `account` — bank / cash / card / asset / liability accounts (personal-finance view)
- `transaction` — bank-level transactions; source = scraper | email | import | manual; dedupe by (account, provider_txn_id | hash)
- `category` — hierarchical; merchant→category mappings; classification via rules from packs + local corrections (learning loop stays local)
- `budget` — per-category monthly budgets, rollover
- `document` — receipts/slips/statements; extraction status machine (pending → extracted → reviewed); slip-v2 result (line items, categories, discounts, VAT) lives in slipscan-extract types, stored by core
- `ledger` — double-entry: chart of accounts, journals, journal lines (balanced enforced), VAT rates & returns
- `recon` — matching documents/transactions/journal lines; suggestions + confirmed matches
- `report` — spending breakdowns, income/expense, VAT summary, trial balance, CSV export
- `audit` — append-only local audit log of mutations
- `settings` — provider configs (LLM, mailbox, scrapers); secret material referenced by keychain entry name

Legacy SQL schemas (reference only, cloud concepts like orgs/billing/auth must NOT return) are in the session scratchpad, not the repo.

## IPC / API surface

- Tauri commands and axum routes expose the **same core services**, same names: `book_list`, `transaction_list`, `transaction_categorize`, `document_import`, `document_get`, `budget_upsert`, `journal_post`, `recon_suggest`, `recon_confirm`, `report_spending`, `settings_get/set`, `pack_install`, …
- All payloads serde JSON. TypeScript mirrors are hand-maintained in `apps/desktop/src/lib/api/types.ts` — update both sides in the same change.

## Design system

From the legacy brand, kept and refined:

- Neutral scale `ink` 0–950 (zinc-like: `#FFFFFF` → `#09090B`)
- Accent electric lime `#C8FF00` (fg `#0A0A0A`, muted `#E8FFA3`, ring `#9FCC00`) — used sparingly: primary actions, active states, the brand slash
- Success `#16A34A`, warning `#D97706`, danger `#DC2626`
- Inter for UI, Geist Mono for numbers/amounts/tables
- Dark and light themes; dark is first-class

## Non-negotiables (the mantra)

1. **No telemetry. No analytics. No default network calls.** The app must be fully functional offline.
2. Network egress only to endpoints the **user explicitly configured**: their LLM provider (BYO key or local model), their IMAP server, their bank (scraper session).
3. No hosted SlipScan service of any kind. `slipscan-server` binds localhost unless the user opts in.
4. Credentials live in the OS keychain, never on disk in plaintext.
5. Community sharing moves **rules, never data**: packs contain taxonomies and classification rules only.
6. Everything auditable: adapters small, dependency-light, readable.
