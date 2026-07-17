# SlipScan Roadmap

The destination: a fully self-hosted, decentralized personal-finance system — Rust core, Tauri desktop app, open-source bank scrapers, email ingestion, and community-shared classification packs. No central server, ever.

Phase contracts for the old (removed) cloud stack live only in git history, alongside the legacy code itself ([CHANGELOG.md](CHANGELOG.md)).

## Phase 0 — Consolidation ✅

- [x] Merge legacy repos (frontend, supabase) and branches into one history on `main`
- [x] MIT license, README, roadmap, contribution guidelines
- [x] Single repo: `vul-os/slipscan`

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

## Phase 4.5 — Insights, nudges & anonymous benchmarks

Vault22/22seven-class intelligence, decentralized (design in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

- [ ] Local nudge engine: budget drift, category spikes, subscription & duplicate detection, fee creep, VAT deadlines *(partial: budget drift, duplicate charges, and subscription detection ship in the desktop app; the rest is unbuilt)*
- [ ] Optional OS notifications (local only)
- [ ] Benchmark packs: signed aggregate-statistics packs; local peer comparison ("you vs households like yours") *(partial: pack format + comparison math in `slipscan-packs`; no surface computes or shows it)*
- [ ] Opt-in anonymous contribution: local differential privacy, coarse k-anonymous cohorts, anonymous transport, off by default
- [ ] **Parity matrices**: tracked feature-by-feature vs Xero (invoicing, quotes, fixed assets, payroll-lite, multi-currency) and Vault22/22seven (net worth, goals, nudges, peer comparison) — each gap becomes an issue

## Phase 5 — Self-host server mode

- [ ] Headless mode: run the core on your own home server / NAS, desktop and mobile as clients *(partial: `slipscan-server` serves the core surface over HTTP with optional bearer auth; no in-server connectors/scheduler yet, and the desktop cannot connect to a remote server yet)*
- [ ] IPC/HTTP parity: every operation under the same name and payload on both transports (current gaps listed in [docs/API.md](docs/API.md))
- [ ] Multi-user households
- [ ] Mobile companion app (Tauri mobile)
- [ ] Insights & budgeting parity with 22seven/Vault22-class products

## Non-goals

- Hosted SaaS of any kind
- Central credential storage or screen-scraping-as-a-service
- Telemetry or any default data collection
- Coupling to VulOS — SlipScan stands alone
