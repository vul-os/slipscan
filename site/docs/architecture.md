# SlipScan Architecture

This document is the **binding contract** for the codebase. Changes to it are deliberate, discussed decisions — not drive-by edits.

## Layout

```
Cargo.toml                 # workspace: members = crates/*, minus the excluded slipscan-sync
                           # (desktop src-tauri is its own crate too)
crates/
  slipscan-core/           # domain model, SQLite storage, migrations, services — everything depends on this
  slipscan-extract/        # document extraction: slip-v2 schema, OCR/LLM providers (BYO key), provider trait
  slipscan-ingest/         # email inbound (IMAP), file import/watch, bank-scraper framework
  slipscan-packs/          # signed classification/category packs: format, ed25519 verify, import/export
  slipscan-server/         # axum headless server (self-host mode), thin wrapper over core services
  slipscan-cli/            # clap CLI: init, import, extract, mail-sync, recon, report, pack, vault, serve, list
  slipscan-sync/           # DMTAP Sync merge-algebra mapping ONLY — nothing else depends on it,
                           # and nothing syncs between devices yet (see below)
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
- `budget` — per-category monthly budgets; a rollover flag is stored per budget (rollover *behaviour* — carrying unspent amounts into the next month — is not yet implemented)
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
- This parity is the contract; the current implementation does not fully meet it yet (the desktop IPC exposes a subset, with three divergent names). The honest gap list lives in [API.md](API.md) and closing it is on the roadmap. The three sets — HTTP routes, registered IPC commands, and the names the frontend client calls — are kept machine-readable in [parity.json](parity.json), derived from `routes.rs`, `src-tauri/src/lib.rs` and `client.ts`; regenerate it in the same change as any route or command you add.

## Sync — an algebra mapping only; nothing syncs between devices

`crates/slipscan-sync` expresses SlipScan's replicated state in the shared **DMTAP Sync** merge algebra (the VulOS substrate's `SYNC.md` capability ③). It is a **mapping and nothing else**, and the boundary is the point:

- **What it is.** A translation between a SlipScan row change and a substrate op, and back. Editable rows (accounts, categories, budgets, members, merchant mappings, transactions) map to §4.4 last-writer-wins registers, one register per row because the repo layer writes whole rows. Posted journals and journal lines map to a §4.3 OR-Set that never mints a remove — SlipScan's ledger is immutable by construction and a correction is a reversal journal, so the mapping is an identity on existing behaviour rather than a new one to re-validate against the books. Money crosses as canonical decimal text; the substrate bans floats and that costs SlipScan nothing.
- **What it is not.** No oplog, no identity, no transport, no storage. It opens no socket and touches no file. The convergence rules live in `dmtap-sync` and are deliberately not re-derived here.
- **Therefore: nothing syncs between devices today.** There is no device pairing, no replication loop, and no code path that ships an op anywhere. Sharing a book still means what [Data location](#data-location--backup--your-folder-your-cloud-your-responsibility) and [Household members](#household-members--per-person-attribution) say it means: a synced data folder, or the self-host server with other surfaces as clients.
- **An ordinary workspace member, on a published engine.** The mapping lives behind the `sync-dmtap` feature (now on by default) and depends on `kotva-sync` from crates.io — the same compiled algebra Ofisi and FlowStock run, consumed under its old name via cargo's dependency-rename so this crate's source never moved. It was previously `exclude`d from the workspace, and that was load-bearing rather than tidiness: the dependency was a *git* dep, and Cargo resolves every optional dependency's source during workspace resolution regardless of active features, so a plain `cargo build` still reached out to a git remote. A registry dependency resolves from the committed `Cargo.lock` with no network at all, so the exclusion is gone and `cargo build --workspace --offline --locked` is green. The property that mattered is unchanged and still enforced: a bare `git clone && cargo build` of SlipScan fetches nothing from anywhere.
- Nothing else in the workspace depends on this crate. Enabling the feature changes no other behaviour.

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

## Global by default — regions are data, not code

SlipScan is a **worldwide product**. No jurisdiction may be hardcoded into core logic; everything country-specific ships as a **region profile** — data the user picks, never an assumption baked into code.

- **A region profile carries:** chart-of-accounts seeds, tax configuration (rate table, tax-report labels and box mappings — e.g. South Africa's profile names its return "VAT201"; other regions name and map their own), bank statement CSV presets, and region merchant/classification packs.
- **Core is region-neutral.** The tax engine works on configured rates and roles; reports are labeled from the profile, not from constants. The generic tax-period summary is the core concept; "VAT201" is the SA profile's label for it.
- **No hardcoded currency anywhere.** The book's currency drives formatting, budgets, and reports end-to-end; UI fallbacks to a fixed currency (e.g. ZAR) are contract violations.
- **South Africa is the first region profile** — fully supported, never special-cased. Adding a country must never require touching core.
- A **generic profile** (neutral CoA, single configurable tax rate, custom CSV column mapping) makes SlipScan usable in any country on day one, before its dedicated profile exists.

## Classification packs — one install pipeline

Packs are the only channel by which community knowledge reaches a book, and they carry **rules, never data** (mantra #5). `crates/slipscan-packs` owns the format, signing, trust, installation and the classification engine, and performs no network access of any kind — packs are files, fetched however the user likes.

**Two install pipelines existed, and that was the defect.** The crate grew a second, richer path without the first being retired, so "the packs installed in this book" meant different things depending on which surface you asked:

| | Legacy flat manifest | Installer |
|---|---|---|
| Format | one flat JSON manifest + a detached signature (`compat::verify_pack`, `PackManifest`) | `pack.toml` manifest + JSON payload, the payload bytes being exactly what gets ed25519-signed (`format::Pack` → `verify::VerifiedPack`) |
| Installed state | a JSON array in **one settings key**, `packs.installed` | SQL tables: `pack_installs`, `pack_category_map`, `pack_rules` |
| Trust | valid signature only — any key is accepted | TOFU signer store with per-pack-id pinning: a pack id stays bound to its first signer forever |
| Versioning | none; re-installing appends another entry | strict semver — same version is a no-op error, downgrades are rejected, upgrades re-map without touching user data |
| Category mapping | re-derived on every install | `pack_category_map` remembers pack key → local category id, so user renames and upgrades are both safe |
| Merchant rules | written straight through | seeded into `merchant_mappings` with `source = 'pack'`, never clobbering a user's own mapping — corrections always win |
| Audit | none | every install/upgrade/uninstall in the append-only audit log |
| Reached by | `slipscan-server`'s ops layer, and through it the HTTP `pack_*` routes and the CLI `slipscan pack` subcommand | the same ops layer (`pack_install`, `pack_install_seeds`, `pack_uninstall`, `pack_benchmark`), the desktop's own `pack_*` IPC commands, and the classification engine — which every binary now switches on at startup |

The visible consequence: a book seeded at `init` recorded its packs in SQL, and a pack the user installed afterwards recorded itself in a settings key — two answers to one question, with only one of them versioned, pinned or audited.

**The contract is one pipeline: the Installer.** Every path that installs or lists a pack goes through `VerifiedPack` + `Installer`, so trust pinning, semver ordering, safe category re-mapping and the audit trail apply to every pack regardless of which surface asked. `compat` and `INSTALLED_PACKS_SETTING` are retired with it; no new code may reference either. The legacy settings key is *left in place* in books that already have one — it is an inert settings row, and tidying it is not worth a migration against databases users already hold ([Non-negotiables](#non-negotiables-the-mantra)); it simply stops being read.

*Status:* the server ops layer still consumes the legacy surface (`slipscan-server/src/ops.rs`, `INSTALLED_PACKS_SETTING`) at the time of writing. The paragraph above is the architecture of record for where this lands, not a claim that it has landed.

## Exchange rates — OpenRate

Multi-currency conversion comes from **[OpenRate](https://github.com/vul-os/openrate)** (MIT, Go, self-hostable — the VulOS family's open FX engine), consumed over its HTTP JSON API from a **user-configured endpoint** (their own self-hosted instance, or any instance they choose to trust).

- **Opt-in, mantra-compliant.** No OpenRate URL configured → SlipScan makes zero FX network calls and reports stay strictly per-currency / base-currency-scoped, exactly as today.
- **Client shape:** thin Rust client over `GET /api/v1/convert?from=&to=&amount=1` (plus `/api/v1/meta` for currency discovery and `/healthz`). The `rate` field is parsed as a **decimal from the JSON token — never through `f64`**; money conversion is `i64` minor units × decimal rate with explicit banker's rounding, in integer paths only.
- **Rates are cached locally** (rate, `as_of`, quality grade, fetch time) in SQLite. OpenRate serves **latest rates only** (no history), so every conversion used in a report or posting **records the rate it used** at booking time — reports reproduce offline and never silently re-rate.
- **Provenance surfaces to the user.** OpenRate's quality grade and staleness (`age_sec`) are shown wherever a converted amount is; a stale weekend rate says so.
- Refresh is user-triggered or an explicit schedule the user turns on — never a default background call.

### A 200 is not proof of a complete body

OpenRate (like more than one Go engine in this suite) writes its response header **before** it finishes encoding JSON — the encode result is discarded after `WriteHeader` has already gone out. An encode or write failure part-way therefore publishes a **success status with a short body**. The truncated response is still a complete, well-formed HTTP message, so nothing at the transport layer — content length, chunk terminator, TLS close — can flag it. **The parse is the only place it can be caught.** A hand-written client that treats "2xx" as "good poll" would book a partial response as a rate.

SlipScan's side is built so a partial body can only ever become an error, never a number:

- **One door for every body.** `fx::client::decode_body` is the single decode path for `/api/v1/convert` and `/api/v1/meta`. It rejects an empty body outright and names truncation explicitly when the body ends mid-JSON, so the failure is actionable rather than a bare `EOF while parsing at line 1 column 0`. `serde_json` also rejects trailing content after the value, so the whole body must be exactly one JSON document.
- **Nothing load-bearing defaults.** A field with `#[serde(default)]` is a field a truncated body can silently supply, so `rate`, `as_of` and `quality.grade` are all required on the wire, as is `/meta`'s `currencies` (a missing list is a malformed response, not an instance that quotes nothing). The two deliberate exceptions — `age_sec` and `sources` — default to *unknown*, never to a value that could pass for good data: omitted staleness stays `None` rather than becoming a fresh-looking `0`.
- **Non-positive rates are refused at the client boundary**, not only where they would be cached. A zero rate would silently convert every amount to zero and a negative one would poison every later conversion, so `OpenRateClient::convert_one` rejects both before any caller sees them; the cache layer re-checks as defence in depth.
- **`/healthz` is status-only** by design — no value is read out of its body, so a truncated health body cannot mislead anything. It must not grow a body-derived return value without going through `decode_body`.
- Tests drive every prefix of a good convert and `/meta` body through the mock transport and assert each one errors, so a future edit that adds a `default` or relaxes a required field fails the suite rather than shipping.

The same hazard applies wherever SlipScan parses a body it did not produce: `slipscan-ingest`'s `HttpResponse::json` (OAuth/Gmail/Graph/Pub-Sub) and `slipscan-extract`'s `providers::decode_response_body` (LLM envelopes) carry the same empty/truncated checks. A truncated body is deliberately **not** retryable in the extraction path — quietly re-asking would hide a server publishing a wrong result. Webhook *delivery* is unaffected: `WebhookTransport` records the receiver's status and never reads its body.

The decimal contract holds across all of this: the `rate` token is captured verbatim as a `serde_json` `RawValue` and parsed with `Decimal::from_str` — never through `f64` — and stays decimal through the SQLite cache (TEXT) and out to IPC/HTTP as a JSON **string**. Tests pin the exact digits of a 28-significant-digit rate at each hop, and assert the serialized form is a string, so a regression to `f64` (including `rust_decimal`'s `serde-float` feature being switched on anywhere in the dependency graph, which Cargo feature unification would apply workspace-wide) fails loudly.

## Data location & backup — your folder, your cloud, your responsibility

The user owns their data's location and its backup. SlipScan never operates backup infrastructure.

- **Movable data folder.** All durable data (the SQLite database and the documents store) lives in ONE folder. It defaults to the OS app-data directory, and the user can move it anywhere — an external drive, `~/Documents`, a NAS mount — from desktop Settings and the CLI. The move flow copies, verifies integrity (checksums + a post-move open/migrate check), atomically switches a small pointer file kept in the fixed OS app-data dir, and only then removes the old copy. CLI, server, and desktop all resolve the same pointer, so every surface agrees on where the data is.
- **Backup = the user's own cloud on that folder.** The documented and in-app guidance: point the data folder at (or sync it with) a folder your own cloud syncs — iCloud Drive, Dropbox, Syncthing, Nextcloud, a NAS. **We rely on the user to back up; SlipScan ships no backup service.** The Settings screen says this plainly next to the data-folder control, and shows the current folder so users can verify it is inside their synced tree.
- **What moves and what doesn't.** The vault ciphertext moves with the folder, but the KEK stays in the OS keychain — a synced/backed-up folder alone still yields no secrets (by design; restoring onto a new machine means re-entering credentials). State that explicitly wherever backup is discussed.
- **Safety rails.** Refuse to move into a subfolder of the current data folder, into a path without write permission, or onto a target that already contains a different SlipScan database (offer open-instead). While a move is in progress the app is read-only.

## Household members & per-person attribution

A book can belong to a household of several people, sharing one set of books, with spend and contributions tracked per person — without accounts, logins, or any hosted identity.

- **Members are data, not logins.** A member is a person in the household: a label, an initial/colour, optional default account(s) they own. Members live in the book like categories do. SlipScan has no authentication — "who is using the app" is still just whoever is at the machine (or holds the self-host bearer token). Members describe *whose money it is*, never *who may access it*.
- **One dashboard, shared the sovereign way.** Sharing the household dashboard means sharing the book: a synced data folder, or the self-host server with the desktop/mobile as clients (see Data location, Self-host). No SlipScan cloud, no per-member cloud accounts.
- **Attribution is orthogonal to the ledger.** Every transaction carries an *attributed member* — who actually incurred it — independent of which account it came from. So an expense that hits one person's account (or a joint account) can be attributed to another person. Default attribution follows the account's owning member; it is overridable per transaction. Attribution is metadata on the transaction: it never alters debits/credits, so double-entry integrity is untouched — it only adds a member dimension to reporting.
- **Splits.** A single transaction may be split across members as a set of `(member, share_minor)` rows that sum to the transaction amount (e.g. a grocery shop split three ways). Single-member attribution is the MVP; splits are the natural extension of the same table.
- **Contributions.** Money into the shared pool (income, transfers in) is attributed per member too, so the household can see who contributed what.
- **Reports.** Per-member expense and contribution rollups, share-of-category per person, and a "who owes whom" settle-up view (net position per member over a period) — computed locally, like every other report.
- **Privacy holds.** Members, attributions, and settle-up are ordinary local rows in the shared book; nothing about this introduces a network call, an account, or a hosted service.

## Feature parity — Vault22/22seven and Xero

SlipScan's north star is genuine parity with the two products it stands in for, tracked as living matrices in [ROADMAP.md](../ROADMAP.md), with the desktop UI held to the same "precision ledger" design system depth (deep, documented CSS tokens; responsive; both themes first-class) across every screen. Personal-finance parity (Vault22/22seven): accounts and net worth, automatic categorisation, budgets and goals, nudges, per-person household view, peer benchmarks. Accounting parity (Xero): chart of accounts, double-entry journals, VAT/tax returns, bank reconciliation, invoicing and quotes, fixed assets, multi-currency. Each gap is a tracked issue, not a surprise; a screen ships only when it meets the design-system bar, not merely when it functions.

## Insights, nudges & anonymous peer benchmarks

Target: the full Vault22/22seven experience — nudges, spending insights, peer comparison — without anyone learning who you are.

- **Nudges are 100% local.** A rules + stats engine over your own data: budget drift, category spikes vs your own history, recurring-subscription detection, duplicate charges, bank-fee creep, VAT deadlines, unreviewed slips. Nudges surface in-app (and optional OS notifications); nothing leaves the machine.
- **Peer comparison via benchmark packs.** Community-published, signed packs containing aggregate statistics only (e.g. "median groceries spend, ZA, household 2, income band C"). Comparing yourself = downloading a pack and computing locally — **reading is perfectly private**. The read side exists today (`ops::pack_benchmark`, `slipscan pack benchmark`, `POST /api/v1/pack_benchmark`, and the desktop Packs screen).
- **Contributing is opt-in, anonymous, and lossy by design** — and **none of it is implemented**: there is no contribution code, no noise generation and no transport anywhere in the tree. What follows is the design the eventual implementation must satisfy, written down so the bar cannot quietly slip ([BENCHMARKS.md](BENCHMARKS.md)):
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
