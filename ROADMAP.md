# SlipScan Roadmap

The destination: a fully self-hosted, decentralized personal-finance system — Rust core, Tauri desktop app, open-source bank scrapers, email ingestion, and community-shared classification packs. No central server, ever.

Legacy phase contracts for the old stack live in [docs/legacy/roadmap](docs/legacy/roadmap).

## Phase 0 — Consolidation ✅

- [x] Merge legacy repos (frontend, supabase) and branches into one history on `main`
- [x] MIT license, README, roadmap, contribution guidelines
- [x] Single repo: `vul-os/slipscan`

## Phase 1 — Rust core

The foundation everything else plugs into.

- [ ] Cargo workspace: `slipscan-core` (domain + storage), `slipscan-cli`
- [ ] Local SQLite storage (accounts, transactions, documents, categories, budgets)
- [ ] Port the extraction data model (slip-v2 schema: line items, categories, discounts, VAT)
- [ ] Import/export: CSV, OFX, and migration from the legacy Cloudflare stack
- [ ] Pluggable LLM/OCR extraction: bring-your-own key or local model — never a SlipScan-hosted endpoint

## Phase 2 — Tauri desktop app

- [ ] Tauri shell wrapping the Rust core (no separate backend process)
- [ ] Port dashboard, receipts, budgets, categories UI from the legacy React app
- [ ] Slip/receipt capture: drag-drop, file watch, camera (mobile later)
- [ ] Fully offline operation

## Phase 3 — Ingestion: your bank, your inbox

- [ ] **Bank scraper framework**: one open-source adapter per bank type, sandboxed, credentials stored in the OS keychain, sessions run locally
- [ ] First adapters (South African banks first — FNB, Capitec, Standard Bank, Nedbank, Absa)
- [ ] **Email inbound**: connect your own mailbox over IMAP; parse receipts, statements, and bank alert emails locally
- [ ] Optional self-hosted SMTP receiving mode (you run the mail endpoint, not us)
- [ ] Dedupe + reconciliation between scraped, emailed, and captured sources

## Phase 4 — Decentralized sharing

Share the smarts, not the data.

- [ ] **Classification packs**: category taxonomies, merchant→category mappings, and classification rules as signed, versioned packs
- [ ] Distribution with no central registry: git remotes and/or p2p, verified by signature
- [ ] Opt-in, privacy-preserving contribution flow (rules only — never transactions)
- [ ] Device-to-device sync (your own devices, end-to-end encrypted)

## Phase 5 — Self-host server mode

- [ ] Headless mode: run the core on your own home server / NAS, desktop and mobile as clients
- [ ] Multi-user households
- [ ] Mobile companion app (Tauri mobile)
- [ ] Insights & budgeting parity with 22seven/Vault22-class products

## Non-goals

- Hosted SaaS of any kind
- Central credential storage or screen-scraping-as-a-service
- Telemetry or any default data collection
- Coupling to VulOS — SlipScan stands alone
