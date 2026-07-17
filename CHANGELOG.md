# Changelog

All notable changes to SlipScan are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

The 0.1.0 rewrite, in progress: SlipScan rebuilt from the ground up as a fully local, self-hosted product — Rust core, Tauri 2 desktop app, one SQLite file per book, zero default network calls. Architecture contract in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Added
- **Rust workspace foundation** — `slipscan-core` (domain model, SQLite storage with embedded migrations, service layer: books, accounts, transactions, categories, budgets, documents, double-entry ledger, VAT, reconciliation, reports, append-only audit log), `slipscan-cli` (`init`, `import`, `serve`, `list`, `export`).
- **Tauri 2 desktop app** scaffold (`apps/desktop`) — Svelte 5 + TypeScript + Vite + Tailwind v4; IPC commands as thin adapters over core services, with hand-maintained TypeScript payload mirrors.
- **Credential vault** — OS-keychain-rooted secret storage (`keyring`-backed `SecretStore`), envelope-encryption design with write-only semantics: secrets can be set, replaced, revoked, and used — never viewed. Design: [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).
- **Ingestion framework** (`slipscan-ingest`) — `MailboxConnector` trait for user-owned mailboxes (IMAP + IDLE; Gmail history deltas with Pub/Sub pull push; Microsoft Graph delta with device-code flow; Proton via local Bridge), `BankScraper` trait for local, auditable per-bank adapters, and file import/watch. Guides: [docs/EMAIL.md](docs/EMAIL.md), [docs/BANK-ADAPTERS.md](docs/BANK-ADAPTERS.md).
- **Extraction pipeline** (`slipscan-extract`) — slip-v2 schema (line items, categories, discounts, VAT) with pluggable BYO-key or local LLM/OCR providers; document status machine `pending → extracted → reviewed`.
- **Signed classification packs** (`slipscan-packs`) — category taxonomies + merchant rules as ed25519-signed manifests, verified on install; corrections stay local. Guide: [docs/PACKS.md](docs/PACKS.md).
- **Headless self-host server** (`slipscan-server`) — axum wrapper over the same core services, `/api/v1` operation-per-route, binds `127.0.0.1:7151` by default with LAN bind as explicit opt-in. Guides: [docs/SELFHOST.md](docs/SELFHOST.md), [docs/API.md](docs/API.md).
- **Documentation set** — getting started, configuration, email, bank adapters, packs, benchmarks, self-host, API, threat model, screenshots, FAQ under `docs/`; root `SECURITY.md` reporting policy.

### Changed
- **README** rewritten to the VulOS product-repo standard: centered wordmark, Part-of-VulOS banner, badges, hero screenshot, screenshot gallery, standalone quick start, architecture + decentralized-network diagrams, and a full documentation table.

### Removed
- **The legacy cloud stack.** The previous implementation — React frontend on Cloudflare Workers with a Supabase backend, including its orgs/billing/hosted-auth concepts — has been removed from the tree; it remains in git history. Cloud concepts do not return: no hosted service, no telemetry, no central server of any kind.

---

## [0.0.x] — legacy (historical)

Pre-rewrite cloud-era iterations (React + Cloudflare Workers + Supabase). Preserved in git history.
