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
  slipscan-cli/            # clap CLI: init, import, extract, mail-sync, recon, report, pack, vault, serve, list
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
| Storage | `rusqlite` (bundled) | SQLite at a user-visible path, WAL. Design target: one file per book; current implementation: one database file that can hold several books |
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

- `book` — a ledgerable context (personal / business); `kind` drives which features surface (one-file-per-book is the design target; today books share one database file)
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
- This parity is the contract; the current implementation does not fully meet it yet (the desktop IPC exposes a subset, with two divergent names). The honest gap list lives in [API.md](API.md) and closing it is on the roadmap.

## Design system

From the legacy brand, kept and refined:

- Neutral scale `ink` 0–950 (zinc-like: `#FFFFFF` → `#09090B`)
- Accent electric lime `#C8FF00` (fg `#0A0A0A`, muted `#E8FFA3`, ring `#9FCC00`) — used sparingly: primary actions, active states, the brand slash
- Success `#16A34A`, warning `#D97706`, danger `#DC2626`
- Inter for UI, Geist Mono for numbers/amounts/tables
- Dark and light themes; dark is first-class

## Email connectivity

Inbound email is a first-class ingestion source. One `MailboxConnector` trait, multiple providers — always the **user's own** accounts and (for OAuth) the **user's own app registration**; SlipScan never operates a central OAuth client, relay, or webhook receiver.

| Provider | Sync | Push |
|---|---|---|
| Generic IMAP (any host) | UID-cursor polling | **IMAP IDLE** |
| Gmail | Gmail API `history.list` delta (BYO Google OAuth client, loopback flow) | **Gmail watch → Cloud Pub/Sub *pull* subscription** — pull needs no public endpoint, fits local-first |
| Outlook / Microsoft 365 | Microsoft Graph delta queries (BYO app registration, device-code flow) | Graph change notifications **only in self-host server mode** (user exposes the endpoint); otherwise delta polling |
| Proton Mail | via local **Proton Bridge** (IMAP to 127.0.0.1) | IMAP IDLE against the bridge |

- OAuth refresh tokens, client secrets, and app passwords live in the credential vault (below) — write-only, never displayed.
- Connectors normalise everything into the same document-import pipeline (attachments, receipt-like bodies), with per-mailbox filters (folder/label, sender allowlist).
- No SlipScan-hosted middleman of any kind; adding a provider must never require our infrastructure.

## Credential vault (bank / IMAP / API secrets)

Secrets get their own subsystem with **write-only semantics**. Design goals: a copied disk/file yields nothing; software can use secrets; humans can set, replace, and revoke — **never view**.

- **Envelope encryption.** Each secret is encrypted with XChaCha20-Poly1305 under a per-machine data-encryption key (DEK). The DEK is wrapped by a key-encryption key (KEK) that lives **only in the OS keychain** (macOS Keychain / Windows Credential Manager / Secret Service), never on disk. Copying the vault + SQLite files off the machine is useless without that user's unlocked OS session.
- **User presence** *(design goal, not yet implemented)*. Where the platform supports it (Touch ID / Windows Hello), unwrapping the KEK for bank-scraper credentials should require user presence; the implemented guarantee today is that use requires the OS session to be unlocked.
- **Write-only API.** `vault.set(name, secret)`, `vault.replace(name, secret)`, `vault.revoke(name)`, and internal `vault.use_with(name, |secret| ...)` which hands the secret to the consuming adapter (scraper, IMAP, LLM client) inside a closure. There is **no** `get`-for-display, no export, no IPC command that returns secret material. The UI shows only metadata: label, created/rotated timestamps, last-used, and a short non-reversible fingerprint.
- **Memory hygiene.** Secrets are `zeroize`d on drop, held for the shortest possible scope, excluded from `Debug`/`Display`/logs/error messages by construction (newtype wrappers with redacted impls).
- **Auditability.** Every vault access (use, set, replace, revoke — never the material) is recorded in the append-only audit log.
- **Rotation, not editing.** Replacing a credential writes a new version and destroys the old ciphertext; there is no in-place edit path.
- Threat model and residual risks are documented in [THREAT-MODEL.md](THREAT-MODEL.md); vulnerability reporting in [SECURITY.md](../SECURITY.md).

## Insights, nudges & anonymous peer benchmarks

Target: the full Vault22/22seven experience — nudges, spending insights, peer comparison — without anyone learning who you are.

- **Nudges are 100% local.** A rules + stats engine over your own data: budget drift, category spikes vs your own history, recurring-subscription detection, duplicate charges, bank-fee creep, VAT deadlines, unreviewed slips. Nudges surface in-app (and optional OS notifications); nothing leaves the machine.
- **Peer comparison via benchmark packs.** Community-published, signed packs containing aggregate statistics only (e.g. "median groceries spend, ZA, household 2, income band C"). Comparing yourself = downloading a pack and computing locally — **reading is perfectly private**.
- **Contributing is opt-in, anonymous, and lossy by design:**
  - Only category-level aggregates for a period — never transactions, merchants, or free text.
  - **Local differential privacy**: calibrated noise is added on-device before anything leaves it.
  - Coarse cohort buckets only (region, rough income band, household size) — chosen so every cohort clears a k-anonymity floor; submissions carrying no identifiers, no account, no stable pseudonym.
  - Anonymous transport (relay/onion-style submission, randomized timing); aggregators are community-run and can be anyone — the DP noise means even a malicious aggregator learns nothing about an individual.
  - Default is **off**. Turning it on shows exactly what would be sent, in plain language.
- Parity North Star: feature-parity matrices vs Xero and Vault22/22seven will be maintained in [ROADMAP.md](../ROADMAP.md) (Phase 4.5 — not yet written); gaps are issues, not surprises.

## Non-negotiables (the mantra)

1. **No telemetry. No analytics. No default network calls.** The app must be fully functional offline.
2. Network egress only to endpoints the **user explicitly configured**: their LLM provider (BYO key or local model), their IMAP server, their bank (scraper session).
3. No hosted SlipScan service of any kind. `slipscan-server` binds localhost unless the user opts in.
4. Credentials live in the OS keychain, never on disk in plaintext.
5. Community sharing moves **rules, never data**: packs contain taxonomies and classification rules only.
6. Everything auditable: adapters small, dependency-light, readable.
