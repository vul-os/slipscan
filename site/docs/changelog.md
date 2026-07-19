# Changelog

All notable changes to SlipScan are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.2.0] — 2026-07-19

- **ShapePay — email-driven payment webhooks (Phase 4.8).** Watch reference codes on inbound transactions (a flat list — whole-token matching, optional exact amount + currency) and fire HMAC-SHA256-signed webhooks (timestamp + nonce headers, receiver-verifiable, replay-safe) to endpoints you register. Signing secrets are generated locally, held write-only in the credential vault, and shown exactly once; deliveries queue in SQLite with exponential backoff (1m → daily, 20-attempt cap) and carry metadata only — never account numbers or raw bank descriptions. Surfaced as `slipscan pay` on the CLI, `pay_*` server routes (secret-bearing operations refused over HTTP), a serve-mode delivery loop, a `mail-sync` flush, and the desktop Payments panel. Guide with a receiver verification example: [docs/PAYMENTS.md](docs/PAYMENTS.md).
- **Movable data folder + bring-your-own-backup (Phase 4.75).** One data folder (SQLite + documents) relocatable from desktop Settings and `slipscan data move` via a verified copy (exclusive-lock WAL quiesce, per-file SHA-256, open/migrate + integrity check, fsync-durable atomic pointer swap, old copy removed only after the verified swap), resolved identically by CLI/server/desktop; backup is the user's own cloud sync on that folder (no SlipScan backup service; the keychain KEK never travels with it).
- **UI/UX pass.** Deep design-system layer (oklch elevation hairlines, grain overlay, motion tokens with a staggered route-enter reveal, branded focus-visible rings, display numeric scale, unified chips), per-screen polish across all routes with token-palette charts and semantic budget bars, responsive down to ~740px with a collapsing sidebar rail, and refreshed real-app screenshots.

---

## [0.1.0] — 2026-07-19

The rewrite: SlipScan rebuilt from the ground up as a fully local, self-hosted product — Rust core, Tauri 2 desktop app, embedded SQLite, zero default network calls. Architecture contract in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). First packaged release: installers for macOS (.dmg), Windows (.msi / setup.exe), Linux (.AppImage / .deb) plus standalone CLI binaries on the [releases page](https://github.com/vul-os/slipscan/releases).

### Added
- **Global by default — region profiles.** Nothing country-specific is code: chart-of-accounts seeds, tax rate tables, and tax-report labels ship as selectable region profiles (`za` for South Africa — where the tax summary is labeled "VAT201" — and a `generic` profile with a configurable standard rate that works in any country). Bank statement presets are region-namespaced (five SA banks + eight generic international CSV conventions + a custom column mapper), and builtin packs include a global `intl-starter` merchant taxonomy alongside the SA packs.
- **Multi-currency FX via [OpenRate](https://github.com/vul-os/openrate)** — strictly opt-in (no endpoint configured means zero FX network calls): decimal-only rate parsing (floats never touch money), exact 256-bit integer conversion with banker's rounding, a local rate cache with `as_of`/quality-grade/staleness provenance, every conversion recording the exact rate it used; surfaced on CLI (`slipscan fx`), server routes, and desktop Settings.
- **Release packaging** — Tauri bundles for all three platforms and a tag-triggered CI release workflow (version-match guard, draft releases, commented signing hooks); Playwright screenshotter (`npm run screenshot`) keeps README/site/docs screenshots real.
- **Rust workspace foundation** — `slipscan-core` (domain model, SQLite storage with embedded migrations, service layer: books, accounts, transactions, categories, budgets, documents, double-entry ledger, VAT, reconciliation, reports, append-only audit log), `slipscan-cli` (`init`, `import`, `extract`, `mail-sync`, `recon`, `report`, `pack`, `vault`, `serve`, `list` — CSV export lives on `report … --csv`, there is no separate `export` subcommand).
- **Tauri 2 desktop app** scaffold (`apps/desktop`) — Svelte 5 + TypeScript + Vite + Tailwind v4; IPC commands as thin adapters over core services, with hand-maintained TypeScript payload mirrors.
- **Credential vault** — OS-keychain-rooted secret storage (`keyring`-backed `SecretStore`), envelope-encryption design with write-only semantics: secrets can be set, replaced, revoked, and used — never viewed. Design: [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).
- **Ingestion framework** (`slipscan-ingest`) — `MailboxConnector` trait for user-owned mailboxes (IMAP + IDLE; Gmail history deltas with Pub/Sub pull push; Microsoft Graph delta with device-code flow; Proton via local Bridge), `BankAdapter` trait for local, auditable per-bank adapters, and file import/watch. Guides: [docs/EMAIL.md](docs/EMAIL.md), [docs/BANK-ADAPTERS.md](docs/BANK-ADAPTERS.md).
- **Extraction pipeline** (`slipscan-extract`) — slip-v2 schema (line items, categories, discounts, VAT) with pluggable BYO-key or local LLM/OCR providers; document status machine `pending → extracted → reviewed`.
- **Signed classification packs** (`slipscan-packs`) — category taxonomies + merchant rules as ed25519-signed manifests, verified on install; corrections stay local. Guide: [docs/PACKS.md](docs/PACKS.md).
- **Headless self-host server** (`slipscan-server`) — axum wrapper over the same core services, `/api/v1` operation-per-route, binds `127.0.0.1:7151` by default with LAN bind as explicit opt-in. Guides: [docs/SELFHOST.md](docs/SELFHOST.md), [docs/API.md](docs/API.md).
- **Documentation set** — getting started, configuration, email, bank adapters, packs, benchmarks, self-host, API, threat model, screenshots, FAQ under `docs/`; root `SECURITY.md` reporting policy.

### Changed
- **README** rewritten for the standalone product: centered wordmark, plain-text badges (no external image fetches), hero screenshot, screenshot gallery, quick start, architecture + decentralized-network diagrams, and a full documentation table.

### Fixed
- **Reversal-aware correction path** (migration 0201): a generated journal that has been reversed no longer blocks regenerating a corrected journal for the same transaction/document, and reconciliation now treats a journal reinstated by reversing its reversal as matchable again. Uniqueness is enforced as "one *net-live* generated journal per source" in the service layer.
- **VAT classification**: the counter-account fallback for generated journals follows the category's kind (income/expense) before cash direction, so customer refunds on unmapped income categories reduce output VAT instead of inflating input VAT; VAT rates are rejected on transfer-like (asset/liability/equity) counter accounts.
- **Validation**: transaction `posted_date` must be a real `YYYY-MM-DD` date; budget months must be real months (`MM` in 01–12); a rejected reconciliation match can no longer be confirmed; re-uncategorising an uncategorised transaction is a no-op instead of audit noise.
- **Merchant normalization** is Unicode-aware ("CAFÉ" ≡ "café") for mappings and recon scoring.

### Removed
- **The legacy cloud stack.** The previous implementation — React frontend on Cloudflare Workers with a Supabase backend, including its orgs/billing/hosted-auth concepts — has been removed from the tree; it remains in git history. Cloud concepts do not return: no hosted service, no telemetry, no central server of any kind.

---

## [0.0.x] — legacy (historical)

Pre-rewrite cloud-era iterations (React + Cloudflare Workers + Supabase). Preserved in git history.
