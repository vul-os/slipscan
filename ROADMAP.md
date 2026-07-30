# SlipScan Roadmap

The destination: a fully self-hosted, decentralized personal-finance system — Rust core, Tauri desktop app, open-source bank scrapers, email ingestion, and community-shared classification packs. No central server, ever.

Phase contracts for the old (removed) cloud stack live only in git history, alongside the legacy code itself ([CHANGELOG.md](CHANGELOG.md)).

## Phase 0 — Consolidation ✅

- [x] Fold every prior repo into one history on `main` — frontend, supabase, the legacy payments repos (frontend, supabase, scraper-go), and slipsnap-mono — each secret-scrubbed and re-authored before grafting (heritage only; their files live in history, not the current tree)
- [x] MIT license, README, roadmap, contribution guidelines
- [x] Single repo `vul-os/slipscan`; `main` and `dev` kept in lockstep, no other branches

## Phase 1 — Rust core

The foundation everything else plugs into.

- [x] Cargo workspace: `slipscan-core` (domain + storage), `slipscan-cli`
- [x] Local SQLite storage (accounts, transactions, documents, categories, budgets, ledger, audit)
- [x] Port the extraction data model (slip-v2 schema: line items, categories, discounts, VAT)
- [ ] Import/export: CSV, OFX, and migration from the legacy Cloudflare stack *(partial: statement CSV import is wired — `slipscan import <file> --preset <id> --account <acct>` parses rows into transactions through the region-grouped preset catalog (`--list-presets`), and `slipscan watch <dir>` imports a drop folder as documents. Both are CLI-only: the desktop stores a file without parsing it. No OFX parser exists — `.ofx` is only a recognised extension. Trial-balance CSV export and desktop report exports exist)*
- [x] Pluggable LLM/OCR extraction: bring-your-own key or local model — never a SlipScan-hosted endpoint *(driven from the CLI)*

## Phase 2 — Tauri desktop app

- [x] Tauri shell wrapping the Rust core (no separate backend process)
- [x] Dashboard, transactions, receipts, budgets, ledger, reconcile, reports, settings screens on real core data
- [ ] Slip/receipt capture: drag-drop, file watch, camera (mobile later) *(partial: the desktop file picker works, and file watch ships — on the CLI: `slipscan watch <dir>` imports what is already in a drop folder and keeps importing as files land, `--once` for cron/launchd. Not built: drag-drop anywhere, a watch-folder setting in the desktop app, camera capture)*
- [x] Fully offline operation

## Phase 3 — Ingestion: your bank, your inbox

- [ ] **Bank scraper framework**: one open-source adapter per bank type, sandboxed, credentials stored in the OS keychain, sessions run locally *(partial: `BankAdapter` trait + statement pipeline + region CSV presets ship, and the statement path is wired on the CLI — `slipscan import --preset`. The only non-test `BankAdapter` implementation reads files: nothing talks to a bank, nothing runs on a schedule, no credential ever reaches an adapter, and the desktop cannot run a preset import)*
- [ ] First adapters (South African banks first — FNB, Capitec, Standard Bank, Nedbank, Absa)
- [ ] **Email inbound**: connect your own mailbox over IMAP; parse receipts, statements, and bank alert emails locally *(partial: one-shot generic-IMAP, Gmail, and Graph syncs all run from `slipscan mail-sync`, with `--login` for the OAuth providers' grants. **Bank-alert parsing ships**: `slipscan mail-sync --alerts --account <acct>` turns a matched alert into a statement line and imports it through the same function CSV uses, so dedupe, the categorisation cascade and the Payments hook all apply — see Phase 4.95 below and [docs/EMAIL.md](docs/EMAIL.md#bank-alert-emails--transactions). Still missing: no push loop runs on any surface (IMAP IDLE is implemented in the connector and nothing calls it), the sender allowlist has no config key, alerts are CLI-only with one target account per run, and no self-hosted SMTP mode)*
- [ ] Optional self-hosted SMTP receiving mode (you run the mail endpoint, not us)
- [x] Dedupe + reconciliation between imported, emailed, and captured sources *(occurrence-indexed dedupe + scored recon in core)*

## Phase 4 — Decentralized sharing

Share the smarts, not the data.

- [ ] **Classification packs**: category taxonomies, merchant→category mappings, and classification rules as signed, versioned packs *(partial: three pack kinds ship — `taxonomy`, `benchmark`, and `mailrules` for [bank-alert formats](docs/EMAIL.md#formats-are-packs-not-code). Install, seed, uninstall and list are on CLI + HTTP + desktop IPC; ed25519 verification is on CLI + desktop IPC (there is no `/pack_verify` route — installing over HTTP verifies, inspecting-without-installing does not); every binary registers the pack classifier at startup, so `contains`/`regex`/`keyword` rules apply on every surface. Missing: a `pack sign` helper — signing is a library function, and both `pack publish` and `pack install` take a signature you produced elsewhere — and export of your own merchant mappings as a pack)*
- [x] Distribution with no central registry: four transports in `slipscan-packs/src/transport/` — `file:`, `folder:` (a synced folder, a NAS mount, a USB stick), `git:` (any remote git accepts, `#ref` pinning) and `https://` — every one of them ending at the same `verify_detached` check, so no channel grants any authority and an `index.json` is a hint rather than a fact. There is no built-in source and no default endpoint: the source list starts empty, so a fresh install makes zero pack network calls until you name a source yourself. Source management, fetch and install ship on all three surfaces (`pack source add|remove|list`, `pack fetch`, `pack pull` on the CLI; `pack_source_*` over HTTP and desktop IPC, with the desktop Packs screen showing a publisher's fingerprint before you accept it); `publish` into a folder source is CLI + HTTP. *(p2p is not implemented — `BlobStore` is the one seam it would land on.)*
- [ ] Opt-in, privacy-preserving contribution flow (rules only — never transactions)
- [ ] Device-to-device sync (your own devices, end-to-end encrypted) — **nothing syncs between devices today.** Two of the four pieces below exist and neither of them moves a byte between machines; the parent stays open until the other two do.
  - [x] Merge algebra: `slipscan-sync` maps SlipScan's replicated state onto the
        shared DMTAP Sync engine (`substrate/SYNC.md` ③) rather than a private
        CRDT — editable rows as §4.4 LWW registers, the posted ledger as a §4.3
        add-only set. Same compiled core Diwan and FlowStock use; as a native
        Rust product SlipScan takes it as a plain crate dependency.
  - [x] Per-device identity and pairing (phase 1 of the node model — spec:
        [docs/NODES.md](docs/NODES.md)). An ed25519 keypair per device whose
        **public half is the device id**, private half held in the existing
        vault; migration `0600_devices`; peer keys pinned trust-on-first-use,
        where a key change is a refusal and never a silent re-pin, and a
        revoked peer is a tombstone that cannot let itself back in; 9-word
        key-names so two people can compare a fingerprint out loud.
        `crates/slipscan-core/src/device/`. The whole ceremony runs on
        `slipscan device`; over HTTP only the public half is served — identity,
        peers, invite *metadata*, and revocation — while anything that creates
        key material or carries a claim token is local-only and answers 403
        with the command to run instead ([docs/NODES.md](docs/NODES.md#what-crosses-http-and-what-stays-local)).
        There is no Devices *screen* in the desktop app, so pairing is a CLI
        job today. There are no accounts anywhere in this — no email,
        password, username or login.
  - [ ] Oplog: record each repo write as a signed op (nothing mints ops yet)
  - [ ] Transport: nothing carries an op from one paired device to another —
        no endpoint, no discovery, no coordinator, no default anything

## Phase 4.5 — Insights, nudges & anonymous benchmarks

Vault22/22seven-class intelligence, decentralized (design in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

- [ ] Local nudge engine: budget drift, category spikes, subscription & duplicate detection, fee creep, VAT deadlines *(partial: budget drift, duplicate charges, and subscription detection ship in the desktop app; the rest is unbuilt)*
- [ ] Optional OS notifications (local only)
- [ ] Benchmark packs: signed aggregate-statistics packs; local peer comparison ("you vs households like yours") *(partial: pack format, comparison math and the read path all ship — `ops::pack_benchmark`, `slipscan pack benchmark`, `POST /api/v1/pack_benchmark`. Missing: any published benchmark pack to compare against — publishing one needs contributors, which is the line below)*
- [ ] Opt-in anonymous contribution: local differential privacy, coarse k-anonymous cohorts, anonymous transport, off by default *(not started: no differential-privacy code exists anywhere in the tree)*
- [ ] **Parity matrices**: tracked feature-by-feature vs Xero (invoicing, quotes, fixed assets, payroll-lite, multi-currency) and Vault22/22seven (net worth, goals, nudges, peer comparison) — each gap becomes an issue *(written: [PARITY.md](PARITY.md) scores 24 capabilities Built / Partial / Not built with a file-level citation for every row — 2 built, 10 partial, 12 not built. Still missing: the gaps are not filed as issues, and nothing re-scores the matrix automatically)*

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

## Phase 4.8 — Payments: reference watches and signed webhooks

Simple by design: watch reference codes, fire signed webhooks — a payment detector on the transactions already flowing into your books.

- [x] The prior payments product's history folded into this repo
- [x] Watch codes (reference + optional amount)
- [x] Webhook endpoints: vault-held secrets, HMAC-signed payloads (timestamp + nonce), SQLite retry queue with backoff, audited deliveries
- [x] Detection hook on inbound transactions (every source inherits: the hook runs inside `transaction_create`) *(and bank-alert emails now reach it: `slipscan mail-sync --alerts` books a matched alert through `transaction_create`, and the same command flushes the delivery queue, so **email in → webhook out is one invocation** — see [docs/EMAIL.md](docs/EMAIL.md#bank-alert-emails--transactions). Statement imports and manual entries trigger detection as they always did)*
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

- [x] Bank-alert email parser: rules-driven extraction of transaction-notification emails into statement lines (patterns supplied per-bank by the user/community, not hardcoded) *(engine in `crates/slipscan-ingest/src/email/alerts.rs`; formats are a pack kind — `mailrules`, in `crates/slipscan-packs/src/mailrules.rs` — so they inherit ed25519 signing, TOFU signer pinning and per-book install. Not one bank, country, currency or date order appears in the code, and **SlipScan ships no patterns at all**: until you install a pack, `--alerts` has nothing to match and says exactly that. A rule that matches and then cannot read a field cleanly declines with a reason rather than guessing, because a wrongly-parsed transaction also teaches the categoriser to keep being wrong. Missing: CLI-only, one target account per run (the account hint is used to reject a mismatch, not yet to route), and no desktop screen — see [docs/EMAIL.md](docs/EMAIL.md#what-is-still-missing))*
- [ ] API adapters where banks publish real APIs (e.g. Investec Programmable Banking — OAuth + REST) as the reference `BankAdapter` implementation
- [ ] Adapter SDK: documented trait, mock-transport test harness, fixtures format, `BANK-ADAPTERS.md` walkthrough so people build/maintain their own bank's adapter
- [x] File/statement import remains the universal fallback *(region-grouped CSV presets, wired on `slipscan import --preset`; the fully custom column mapping exists in the library and has no CLI flags yet)*

## Phase 5 — Feature-parity push (Vault22/22seven + Xero) & self-host

Contract: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) "Feature parity". Every screen held to the design-system bar.

- [ ] **Parity matrices** written and tracked: Vault22/22seven (net worth, accounts, goals, nudges, household, peer comparison) and Xero (invoicing, quotes, fixed assets, payroll-lite, multi-currency, reconciliation) *(written — [PARITY.md](PARITY.md), and it is blunt: **zero of Xero's 14 core capabilities are built**, including no invoicing of any kind. Not tracked: no issue per gap yet. The ranked gap list at the end of that document is what the rest of this phase has to close)*
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
