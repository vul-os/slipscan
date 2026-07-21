# SlipScan Roadmap

The destination: a fully self-hosted, decentralized personal-finance system — Rust core, Tauri desktop app, open-source bank scrapers, email ingestion, and community-shared classification packs. No central server, ever.

Phase contracts for the old (removed) cloud stack live only in git history, alongside the legacy code itself ([CHANGELOG.md](CHANGELOG.md)).

## Phase 0 — Consolidation ✅

- [x] Fold every prior repo into one history on `main` — frontend, supabase, the ShapePay repos (frontend, supabase, scraper-go), and slipsnap-mono — each secret-scrubbed and re-authored before grafting (heritage only; their files live in history, not the current tree)
- [x] MIT license, README, roadmap, contribution guidelines
- [x] Single repo `vul-os/slipscan`; `main` and `dev` kept in lockstep, no other branches

## Phase 1 — Rust core

The foundation everything else plugs into.

- [x] Cargo workspace: `slipscan-core` (domain + storage), `slipscan-cli`
- [x] Local SQLite storage (accounts, transactions, documents, categories, budgets, ledger, audit)
- [x] Port the extraction data model (slip-v2 schema: line items, categories, discounts, VAT)
- [ ] Import/export: CSV, OFX, and migration from the legacy Cloudflare stack *(partial: files import as documents; CSV statement parsing with SA-bank presets exists in `slipscan-ingest` but is not wired to a surface; no OFX parser; trial-balance CSV export and desktop report exports exist)*
- [x] Pluggable LLM/OCR extraction: bring-your-own key or local model — never a SlipScan-hosted endpoint *(driven from the CLI)*

## Phase 2 — Tauri desktop app

- [x] Tauri shell wrapping the Rust core (no separate backend process)
- [x] Dashboard, transactions, receipts, budgets, ledger, reconcile, reports, settings screens on real core data
- [ ] Slip/receipt capture: drag-drop, file watch, camera (mobile later) *(partial: file-picker import works; drag-drop and file watch not wired)*
- [x] Fully offline operation

## Phase 3 — Ingestion: your bank, your inbox

- [ ] **Bank scraper framework**: one open-source adapter per bank type, sandboxed, credentials stored in the OS keychain, sessions run locally *(partial: `BankAdapter` trait + statement pipeline + SA CSV presets implemented as a library; no surface wiring, no live adapter)*
- [ ] First adapters (South African banks first — FNB, Capitec, Standard Bank, Nedbank, Absa)
- [ ] **Email inbound**: connect your own mailbox over IMAP; parse receipts, statements, and bank alert emails locally *(partial: one-shot generic-IMAP poll via `slipscan mail-sync` works; Gmail/Graph connectors implemented but unwired; no push loop; bank-alert parsing not implemented)*
- [ ] Optional self-hosted SMTP receiving mode (you run the mail endpoint, not us)
- [x] Dedupe + reconciliation between imported, emailed, and captured sources *(occurrence-indexed dedupe + scored recon in core)*

## Phase 4 — Decentralized sharing

Share the smarts, not the data.

- [ ] **Classification packs**: category taxonomies, merchant→category mappings, and classification rules as signed, versioned packs *(partial: format, ed25519 sign/verify, and install ship; installed rules are not yet consulted during categorisation)*
- [ ] Distribution with no central registry: git remotes and/or p2p, verified by signature
- [ ] Opt-in, privacy-preserving contribution flow (rules only — never transactions)
- [ ] Device-to-device sync (your own devices, end-to-end encrypted)
  - [x] Merge algebra: `slipscan-sync` maps SlipScan's replicated state onto the
        shared DMTAP Sync engine (`substrate/SYNC.md` ③) rather than a private
        CRDT — editable rows as §4.4 LWW registers, the posted ledger as a §4.3
        add-only set. Same compiled core Ofisi and FlowStock use; as a native
        Rust product SlipScan takes it as a plain crate dependency.
  - [ ] Oplog: record each repo write as a signed op (nothing mints ops yet)
  - [ ] Per-device identity from the existing vault, and a transport

## Phase 4.5 — Insights, nudges & anonymous benchmarks

Vault22/22seven-class intelligence, decentralized (design in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

- [ ] Local nudge engine: budget drift, category spikes, subscription & duplicate detection, fee creep, VAT deadlines *(partial: budget drift, duplicate charges, and subscription detection ship in the desktop app; the rest is unbuilt)*
- [ ] Optional OS notifications (local only)
- [ ] Benchmark packs: signed aggregate-statistics packs; local peer comparison ("you vs households like yours") *(partial: pack format + comparison math in `slipscan-packs`; no surface computes or shows it)*
- [ ] Opt-in anonymous contribution: local differential privacy, coarse k-anonymous cohorts, anonymous transport, off by default
- [ ] **Parity matrices**: tracked feature-by-feature vs Xero (invoicing, quotes, fixed assets, payroll-lite, multi-currency) and Vault22/22seven (net worth, goals, nudges, peer comparison) — each gap becomes an issue

## Phase 4.7 — Global by default + OpenRate FX

SlipScan is a worldwide product; countries are region profiles, not code (contract: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

- [x] Region profiles: CoA seeds, tax config (rates + report labels/box mappings), bank CSV presets, and merchant packs as selectable data — SA is the first profile (`za`), generic profile for everywhere else
- [x] Generic tax-period summary in core; "VAT201" only as the SA profile's label
- [x] Remove every hardcoded currency/jurisdiction default from core, CLI, server, desktop *(verified by a residual-jurisdiction audit)*
- [x] OpenRate client: user-configured endpoint, decimal-only rate math, local rate cache with `as_of` + quality grade, rate recorded per conversion
- [ ] Converted report views ("all activity in book currency, rated at booking time") with provenance shown

## Phase 4.75 — Movable data folder & bring-your-own backup

Contract: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) "Data location & backup".

- [x] One data folder (SQLite + documents), pointer file in the fixed app-data dir, resolved identically by desktop/CLI/server
- [x] Settings + CLI flow to move it: copy → verify (checksums, exclusive-lock WAL quiesce, open/migrate + integrity check) → fsync-durable atomic pointer switch → remove old
- [x] Safety rails: no nested targets, permission checks, existing-database detection (open-instead), read-only during move, cross-process move refusal
- [x] In-app + docs backup guidance: sync the folder with your own cloud (iCloud/Dropbox/Syncthing/Nextcloud/NAS) — **users back up their own data**; note the keychain KEK never travels with the folder

## Phase 4.8 — ShapePay: email-driven payment webhooks ([TODO-FOLD-SHAPEPAY.md](TODO-FOLD-SHAPEPAY.md))

Simple by design: connect your email, watch for reference codes, fire signed webhooks — a payment system on the transactions already in your inbox.

- [x] Original ShapePay history folded into this repo
- [x] Watch codes (reference + optional amount)
- [x] Webhook endpoints: vault-held secrets, HMAC-signed payloads (timestamp + nonce), SQLite retry queue with backoff, audited deliveries
- [x] Detection hook on inbound transactions (every source inherits: the hook runs inside `transaction_create`) *(partial upstream: parsing bank-alert emails into transactions is not wired yet — see [docs/EMAIL.md](docs/EMAIL.md); statement imports and manual entries trigger detection today)*
- [x] `slipscan pay` CLI, server routes, desktop Payments panel — guide with receiver verification example: [docs/PAYMENTS.md](docs/PAYMENTS.md)

## Phase 4.9 — Household members & per-person attribution

Contract: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) "Household members & per-person attribution". Members are local data (no logins); sharing is via the synced data folder or self-host server.

- [x] Members in core: table + repo + service (label, initial/colour, default account); books gain members
- [x] Transaction attribution: `attributed_member` on every transaction, default = account owner, overridable; orthogonal to the ledger (no debit/credit change)
- [x] Per-member reports: expense + contribution rollups, share-of-category, "who owes whom" settle-up over a period
- [x] Split attribution: `(member, share_minor)` rows summing to the amount
- [x] Surfaces: member CRUD + attribution on Transactions, a household view on the Dashboard, member filter on Reports — CLI + server + desktop
- [x] Design-system-grade UI for all of the above (both themes, responsive)

## Phase 4.95 — Bank feeds (safe paths only)

No fabricated credential scrapers. Real, testable, ToS-respecting integrations plus a contributor SDK.

- [ ] Bank-alert email parser: rules-driven extraction of transaction-notification emails into statement lines (patterns supplied per-bank by the user/community, not hardcoded)
- [ ] API adapters where banks publish real APIs (e.g. Investec Programmable Banking — OAuth + REST) as the reference `BankAdapter` implementation
- [ ] Adapter SDK: documented trait, mock-transport test harness, fixtures format, `BANK-ADAPTERS.md` walkthrough so people build/maintain their own bank's adapter
- [ ] File/statement import remains the universal fallback *(done: CSV presets)*

## Phase 5 — Feature-parity push (Vault22/22seven + Xero) & self-host

Contract: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) "Feature parity". Every screen held to the design-system bar.

- [ ] **Parity matrices** written and tracked: Vault22/22seven (net worth, accounts, goals, nudges, household, peer comparison) and Xero (invoicing, quotes, fixed assets, payroll-lite, multi-currency, reconciliation)
- [ ] Xero-side gaps: invoicing + quotes, fixed-asset register, multi-currency converted views (OpenRate FX already wired)
- [ ] Vault22-side gaps: net-worth over time, goals, the remaining nudge tiers
- [ ] UI/UX parity pass: deep design-system CSS across every screen, responsive, both themes — no screen ships below the bar
- [ ] Headless mode: run the core on your own home server / NAS, desktop and mobile as clients *(partial: `slipscan-server` serves the core surface over HTTP with optional bearer auth; no in-server connectors/scheduler yet, and the desktop cannot connect to a remote server yet)*
- [ ] IPC/HTTP parity: every operation under the same name and payload on both transports (current gaps listed in [docs/API.md](docs/API.md))
- [ ] Mobile companion app (Tauri mobile)

## Non-goals

- Hosted SaaS of any kind
- Central credential storage or screen-scraping-as-a-service
- Telemetry or any default data collection
- Coupling to VulOS — SlipScan stands alone
