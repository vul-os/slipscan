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
- [ ] Device-to-device sync (your own devices, end-to-end encrypted) — **nothing syncs between devices today.** Three of the four pieces below exist and not one of them moves a byte between machines; the parent stays open until the transport does.
  - [x] Merge algebra: `slipscan-sync` maps SlipScan's replicated state onto the
        shared DMTAP Sync engine (`substrate/SYNC.md` ③) rather than a private
        CRDT — editable rows as §4.4 LWW registers, the posted ledger as a §4.3
        add-only set. The same compiled core Diwan runs; as a native Rust
        product SlipScan takes it as a plain crate dependency. FlowStock ran it
        too, behind a build tag, until it was retired into this repo — see
        Phase 6.
  - [x] Per-device identity and pairing (phase 1 of the node model — spec:
        [docs/NODES.md](docs/NODES.md)). An ed25519 keypair per device whose
        **public half is the device id**, private half held in the existing
        vault; migration `0007_devices`; peer keys pinned trust-on-first-use,
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
  - [x] Oplog: every write to a replicated table is recorded as one
        individually signed operation (phase 2 of the node model — migration
        `0008_oplog`, `crates/slipscan-core/src/sync/`). Capture is a **SQLite
        trigger** per replicated table rather than a call from the repo layer,
        so a cascading delete, a migration or a future importer is recorded
        too — and the trigger set is asserted equal to the mapping registry in
        both directions, so a new table cannot replicate by accident or fail
        to replicate silently. Operations are signed one at a time as RFC 9052
        `COSE_Sign1` under the device key pairing already established, so a
        replicated change is verified **on its own** rather than trusted for
        the connection it arrived over; they are ordered by a persisted HLC
        with a drift bound kept above the engine; and they are stored keyed by
        the §4.1 content address, which is the operation's only identity.
        Money stays `i64` minor units end to end. `slipscan sync
        status|seal|log|verify`. **This records; it sends nothing.**
  - [ ] Transport: nothing carries an op from one paired device to another —
        no endpoint, no discovery, no coordinator, no default anything. Nor is
        there an **apply path**: a peer's verified operations do not become
        rows, no admission check against a pinned key exists, and the remote
        half of the clock-drift bound is unwritten
        ([docs/NODES.md](docs/NODES.md#what-is-still-missing))

## Phase 4.5 — Insights, nudges & anonymous benchmarks

Vault22/22seven-class intelligence, decentralized (design in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

- [ ] Local nudge engine: budget drift, category spikes, subscription & duplicate detection, fee creep, VAT deadlines *(partial: budget drift, duplicate charges, and subscription detection ship in the desktop app; the rest is unbuilt)*
- [ ] Optional OS notifications (local only)
- [ ] Benchmark packs: signed aggregate-statistics packs; local peer comparison ("you vs households like yours") *(partial: pack format, comparison math and the read path all ship — `ops::pack_benchmark`, `slipscan pack benchmark`, `POST /api/v1/pack_benchmark`. Missing: any published benchmark pack to compare against — publishing one needs contributors, which is the line below)*
- [ ] Opt-in anonymous contribution: local differential privacy, coarse k-anonymous cohorts, anonymous transport, off by default *(not started: no differential-privacy code exists anywhere in the tree)*
- [ ] **Parity matrices**: tracked feature-by-feature vs Xero (invoicing, quotes, fixed assets, payroll-lite, multi-currency) and Vault22/22seven (net worth, goals, nudges, peer comparison) — each gap becomes an issue *(written: [PARITY.md](PARITY.md) scores 24 capabilities Built / Partial / Not built with a file-level citation for every row — re-scored 2026-08-03 after Phase 6.1–6.5 to 5 built, 12 partial, 7 not built. Still missing: the gaps are not filed as issues, and nothing re-scores the matrix automatically — it is re-scored by hand, which is why it went stale for a whole wave before this)*

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

- [ ] **Parity matrices** written and tracked: Vault22/22seven (net worth, accounts, goals, nudges, household, peer comparison) and Xero (invoicing, quotes, fixed assets, payroll-lite, multi-currency, reconciliation) *(written — [PARITY.md](PARITY.md). It opened blunt — *zero* of Xero's 14 core capabilities built, no invoicing of any kind — and as of 2026-08-03 reads **2 of 14 built** (invoicing, contacts) with purchasing and aged receivables partial. Not tracked: no issue per gap yet. The ranked gap list at the end of that document is what the rest of this phase has to close)*
- [ ] Xero-side gaps: ~~invoicing~~ (built, Phase 6.5) + quotes, fixed-asset register, multi-currency converted views (OpenRate FX already wired)
- [ ] Vault22-side gaps: net-worth over time, goals, the remaining nudge tiers
- [ ] UI/UX parity pass: deep design-system CSS across every screen, responsive, both themes — no screen ships below the bar
- [ ] Headless mode: run the core on your own home server / NAS, desktop and mobile as clients *(partial: `slipscan-server` serves the core surface over HTTP with optional bearer auth; no in-server connectors/scheduler yet, and the desktop cannot connect to a remote server yet)*
- [ ] IPC/HTTP parity: every operation under the same name and payload on both transports (current gaps listed in [docs/API.md](docs/API.md))
- [ ] Mobile companion app (Tauri mobile)

## Phase 6 — Inventory & trade (the flowstock fold)

FlowStock was a separate Vulos product: offline-first, multi-branch inventory for shops and
wholesalers, a Go binary serving a React UI. It has been retired and its 89 commits folded into this
history (archival — no files landed; `git log 0fea5e8` reads them). This phase re-derives its domain
in Rust here, because the argument for two products never survived contact with the code:

- **The overlap was structural, not cosmetic.** Xero and QuickBooks treat stock as a *module* of the
  book, not a neighbouring app, and for a reason — a goods receipt is an inventory event *and* a
  journal entry. Two databases cannot both own that fact.
- **It closes real [PARITY.md](PARITY.md) gaps rather than adding a 15th axis.** FlowStock already
  had customers, suppliers, purchase orders, payments and sales documents — four of the fourteen
  Xero capabilities currently scored *Not built*, arriving with the inventory instead of beside it.
- **Most of it was never going to be ported anyway.** FlowStock's domain model was a 16-row table
  registry; ~4.7k of its ~5.3k Go source lines were HLC, oplog, peer auth and folder replication —
  all of which this repo already has, signed and immutable by trigger (migration 0700), which
  FlowStock's was not.

**What is deliberately not taken:** the Go backend, its unsigned oplog and HLC (superseded by
migration 0700), its React UI, and its cloud-node deployment path. This is a re-derivation against
the existing `books`/`members` model, not a port.

**PARITY.md is re-scored per stage from the code, and no row moves on the strength of a plan.**

### Decisions taken (not open questions)

These were settled rather than escalated, and are recorded here so the reasoning survives:

1. **One data model, three presentations — the tier is display, not schema.** Every Phase 6 table is
   per-book and nullable, so personal / business / multi-location is progressive disclosure over one
   schema. There is no "business edition", no separate database, and no migration to move between
   tiers. Downgrading hides screens; it never destroys rows.
2. **Personal and business are separate books, not one book wearing two hats.** `books` already
   carries a `kind`, a currency, a country and a lock date — all of which a person and their side
   business genuinely disagree about. Merging them would mean every one of those becoming a
   per-section override, and a single `financial_lock_date` that is wrong for one of the two.
   Someone with a side business already thinks in two sets of books; the app should agree.
3. **Multi-location is derived from the `locations` count, with an explicit Settings override.**
   Adding a second location *is* the upgrade, so the common case needs no toggle and no toggle can
   drift out of step with reality. The override exists for the one case derivation gets wrong — a
   business setting up its first branch wants the location UI before the second row exists.
4. **On-hand stock is always derived, never stored.** `SUM(qty_delta)` over immutable movements. A
   cached counter is the one thing that cannot survive two locations trading while disconnected.

### Stages

- [x] **6.0 Book profiles.** The `kind`-driven disclosure rules, the derived multi-location flag and
      its override, a setup flow at book creation, and Settings that can change the answer later in
      both directions *(shipped: `profile.rs` resolves visible capability groups from kind +
      location count + override, where multi-location is `override.unwrap_or(count > 1)` so the
      common case has no toggle to drift. `book profile` / `set-kind` / `set-multi-location` and
      the location CRUD ship on CLI, HTTP and desktop IPC together, with a first-run locations step
      and a Settings panel. The load-bearing test is that downgrading business to personal hides
      every group while leaving every location, contact and product row readable and unchanged.
      The flags gate real screens as of 6.9, not only the Settings panel and first-run step)*
- [x] **6.1 Locations.** A `locations` table per book, shaped like `members` — additive, nullable,
      a book with zero locations behaves exactly as today *(shipped: branch/warehouse/site kinds,
      CRUD through the service layer, and the first table created after the oplog existed so it
      carries its own sync-capture triggers rather than having them retrofitted. `BookKind::Business`
      already existed and was already wired through CLI, server and desktop — verified, not
      re-added. As of 6.9, locations are exposed on the desktop — Stock and Purchasing list and
      quick-create them inline, and Stock's per-location columns gate on `show_locations` — and
      `location_delete` refuses a location with movement history rather than deleting it out from
      under a stock ledger)*
- [x] **6.2 Contacts.** Customers and suppliers as one contact model per book *(shipped: one
      `contacts` table with a role of customer, supplier or both — a business buys from and sells to
      the same party, and duplicating it is how ledgers drift. Carries company name, email, phone,
      billing/shipping address, tax number, payment terms, credit limit and active flag. Reachable on
      all four surfaces as of 2026-08-03 — `slipscan contact add|list|show|update|remove`, HTTP,
      desktop IPC and a `client.ts` wrapper. It was not for three phases: only a read-only list was
      routed, so 6.4 and 6.5 could name a `contact_id` nothing could create, and this entry said so
      while PARITY briefly scored the row Built. `npm run reachable:check` now fails CI on that
      class of gap. Still missing: no merge/dedupe, no statement, and the tax number, addresses and
      credit limit are stored but unconsumed)*
- [x] **6.3a Catalogue.** Product categories, products, and variants carrying SKU, price, cost
      price, reorder point and attributes *(shipped, and reachable on all four surfaces as of
      2026-08-03 — `slipscan catalogue …`, HTTP, desktop IPC and a `client.ts` wrapper. For three
      phases only 1 of its 16 operations was routed anywhere, so nothing could create the
      `variant_id` a 6.4 or 6.5 order line requires; closing that is what made Phase 6 exercisable
      end to end (category -> product -> variant -> order line -> confirm -> stock movement).
      `npm run reachable:check` now fails CI on that class of gap. Named `product_categories` with a
      `product_category_id` FK, deliberately distinct from the existing transaction `categories`
      table — a `products.category_id = categories.id` join would type-check while being silently
      wrong. Money follows the existing INTEGER-minor-units + ISO-4217 convention rather than a
      second representation)*
- [x] **6.3b Stock ledger.** The **append-only stock-movement ledger** — on-hand is always
      `SUM(qty_delta)` over immutable movements, never a stored counter *(shipped, and reachable on
      all four surfaces as of 2026-08-03 — `slipscan stock …`, HTTP, desktop IPC and a `client.ts`
      wrapper. It shipped with **zero** of its nine operations routed anywhere, so on-hand could not
      be read and a movement could only be written as a side effect of confirming an order or
      receiving a PO; `npm run reachable:check` now fails CI on that. Otherwise: immutability is
      enforced by `RAISE(ABORT)` triggers rather than convention, and `repo/stock.rs` has no update
      or delete function at all. Registered in `LEDGER_TABLES`, so two locations that both traded
      offline converge by union instead of one overwriting the other. Transfers write two movements
      summing to zero; on-hand is proven order-independent. The Stock screen reaches it as of 6.9.
      Still open: `ref_kind` has no constrained vocabulary until purchasing and sales define one, and
      `created_by` is free text until roles land)*
- [x] **6.4 Purchasing.** Purchase orders and goods receipts, receipts insert-only so partial
      deliveries recorded at two locations merge by union *(shipped, migration `0013_purchasing`.
      `po_receipts` is in `LEDGER_TABLES` with `RAISE(ABORT)` immutability triggers, so a line's
      received quantity is `SUM(qty)` over receipts rather than a stored counter — two sites
      receiving against the same line while disconnected converge by union. The Purchasing screen
      calls all of it as of 6.9; the 18 `po_*` IPC commands and their `client.ts` wrappers were
      wired ahead of it)*
- [x] **6.5 Sales orders → invoicing.** Draft → confirm (deducts stock) → paid, cancel reverses
      stock. Carried to a real invoice entity with numbering, delivery and paid/unpaid state, this
      is the single largest hole in PARITY — *"there is no invoicing at all"* *(shipped, migration
      `0014_sales`. Two mappings on purpose: `sales_orders`/`_items` are editable LWW registers,
      `invoices`/`_items`/`_payments` are insert-only ledger facts with immutability triggers, and
      paid/unpaid is derived from `SUM(invoice_payments)` rather than stored. Numbering is a single
      `UPSERT ... RETURNING`, proven gapless and duplicate-free under 8 concurrent issuers on one
      machine. Known gaps, all named rather than implied: **multi-device numbering is unsolved**
      (two offline devices would both mint #47 — the `UNIQUE (book_id, series, number)` index turns
      that into a loud failure, not a silent collision; 6.7's problem once a transport exists), no
      credit notes or voiding, no quotes, no partial fulfilment, no posting to `journals` (that was
      6.6). The Sales screen calls all of it as of 6.9 — the 21 IPC commands and their `client.ts`
      wrappers were wired ahead of it, and `npm run parity:check` now fails CI if a registered
      command ever loses its wrapper again)*
- [x] **6.6 Stock posts to the ledger.** The keystone, and the one piece neither codebase had: a
      goods receipt debits inventory-asset and credits accounts-payable; a confirmed sale posts
      revenue, VAT and cost-of-goods-sold against the existing chart of accounts and `journals` /
      `journal_lines` *(shipped, migration `0016_ledger_trade` (the one schema change needed — it
      only widens `journals.source_type`'s CHECK to add `po_receipt`/`sales_cogs`/`sales_revenue`/
      `invoice_payment`, a table rebuild since SQLite has no `ALTER TABLE ADD CONSTRAINT`).
      `CoreService::po_receive`/`sales_order_confirm`/`sales_order_cancel`/`invoice_payment_record`
      each post their journal(s) in the *same* SQLite transaction as the trade fact itself — the
      "one code path, one transaction, or none of it lands" discipline migration `0013_purchasing`
      already documents for a receipt and its stock movement, extended to the journal. A confirmed
      sale posts **two** journals sharing one `source_id` (`SalesCogs`, `SalesRevenue`), not one
      four-line entry, so either leg can be reversed and re-derived independently; `sales_order_cancel`
      reverses whichever are still net-live via the existing `journal_reverse` machinery (dated at
      cancellation, not at the original confirm, so a book locked after the sale was confirmed can
      still cancel it). Idempotence and the lock-date refusal are both the pre-existing
      `post_journal_in_tx` guarantees (one net-live journal per `(source_type, source_id)`; no
      posting on or before `financial_lock_date`), reused rather than reimplemented, and a refusal
      rolls back the *whole* trade action, not just the journal. A personal book, or a business book
      that never ran `coa_seed`, resolves every required account to `None` and posts nothing — the
      trade still succeeds — proven directly rather than assumed. VAT on the revenue leg is
      `crate::vat::vat_on_net` (round-half-away-from-zero), the identical rule
      `repo::sales::order_totals` already uses, so the journal's tax total never drifts from the
      total a person already sees on the order; tested at a rounding boundary (333 minor units at
      15% → 50, not 49 or 51). Ten new tests in `service.rs`, all against a real in-memory SQLite
      `CoreService` — receipt, confirm, VAT boundary, part/full payment, cancel-to-net-zero,
      idempotence, both lock-date paths, no-CoA gracefulness (personal and unseeded-business), and
      the full receive-then-sell round trip proving the trial balance and the inventory account
      balance both land exactly right.
      **Not built, named rather than implied:** no per-line COGS/revenue detail — each leg is one
      journal aggregating every line, not one line-item pair per order line; no `coa_map` override
      for a supplier/customer/variant (`CoaMapEntity` still only covers `account`/`category`, so
      every trade account resolves by seed code alone, same as before this stage — see
      `coa_by_code_opt`'s own doc comment); no manual "regenerate this trade's journal" entry point
      on any surface — posting is automatic and embedded, there is no
      `journal_generate_for_po_receipt`-style public function to call again by hand; and a leg whose
      required accounts are only *partly* seeded (e.g. Inventory/COGS present, Revenue/AR absent)
      posts nothing for that leg specifically rather than erroring, which is untested beyond what
      the code review here states. **Revenue is recognised exactly once per sale, on the path that matches how it
      happened:** at `sales_order_confirm` for an order-backed sale, and at `invoice_issue` for a
      standalone invoice (`sales_order_id: None` — a retainer, a one-off bill with no order behind
      it). Both call one shared `post_revenue_ar_journal`, so the two can never drift apart by a
      cent. The first cut of 6.6 posted only at confirm — following a brief that named three call
      sites and did not think about the fourth — which left `invoice_payment_record` crediting an
      accounts-receivable balance nothing had ever debited, driving that account negative by exactly
      what was collected. Every journal still balanced, so no trial balance could show it; it is
      covered now by tests from both sides (a standalone invoice clears AR to zero when paid, and an
      order-backed invoice does not debit AR twice))*
- [ ] **6.7 Sync transport.** FlowStock shipped the one thing [docs/NODES.md](docs/NODES.md) still
      lists as missing: a working authenticated transport — three HTTP endpoints
      (`/sync/vector`, `/sync/pull`, `/sync/ops`) plus folder/USB replication for sites with no
      link at all. Re-derived over the *signed* oplog, so it carries a guarantee FlowStock's could
      not: every op individually verifiable, not merely fetched from a trusted peer
- [ ] **6.8 Roles.** Genuinely new work — neither codebase had it. The device model here is
      trust-on-first-use pairing built for *your own devices*; branches have staff, and staff turn
      over. Revocation cannot stay "delete the peer row" once a till operator is a real person
- [x] **6.9 Desktop screens.** Catalogue, stock, orders, purchasing, and per-location views, held
      to the same design-system bar as every other screen *(shipped: Contacts, Catalogue, Stock and
      Purchasing landed together, then Sales. All five gate on `BookProfile` — a personal book
      resolves `show_contacts`/`show_catalogue`/`show_purchasing`/`show_sales` to `false`, the
      "Trade" nav group renders with zero visible items and disappears rather than showing an empty
      heading, and every route also refuses direct hash/palette access, not only the sidebar link.
      Contacts is one list with role tabs over the shared customer/supplier model. Catalogue makes
      the category → product → variant hierarchy legible, labelling a variant-less product "not
      sellable yet" rather than leaving it looking empty. Stock has no "set level" control anywhere
      on purpose — Adjust and Count write movements (Count does the signed-delta arithmetic), and
      Transfer shows both resulting movements so on-hand stays visibly `SUM(qty_delta)`; per-location
      columns are further gated on `show_locations` so a single-location business sees one honest
      total rather than a location axis with one entry. Purchasing is built on the derived receiving
      status (none/partial/complete) rather than three calls per line. Sales is one screen with three
      tabs — Orders, Invoices, Aged receivables — because issuing an invoice from an order literally
      copies its lines, and splitting the two would turn one action into a navigation; invoices carry
      no edit or delete affordance anywhere, because the database refuses one. Merging the parallel
      streams surfaced a real defect neither could see alone: Catalogue and Purchasing both claimed
      jump key "U", making one destination keyboard-unreachable while looking correct in the rail —
      Purchasing moved to "O" and a test now names any key clash, mutation-verified by reintroducing
      the collision.)*

**Positioning, settled:** SlipScan is now aiming at both axes in full — personal finance *and*
small-business accounting, with inventory as a module of the book rather than a neighbouring app.
The honest near-term effect is that the Xero axis gets *longer* before it gets greener: absorbing
inventory adds capabilities to measure before it adds ones that are built. PARITY.md is expected to
look worse for a while, and that is the document working correctly rather than a reason to soften
it.

## Phase 6.95 — Period close

The last structural gap before release: `financial_lock_date` could be set directly
(`book_set_lock_date`), but nothing checked whether the period behind it was actually *ready* to
lock, there was no way to preview a close before committing to it, and reopening one — a legitimate,
routine act ("an accountant finds something") — was indistinguishable from any other call that
happens to clear the same field.

- [x] **6.95 Period close.** `close_period_check` / `close_period` / `reopen_period` in
      `core/src/service.rs` *(shipped. `close_period_check` and `close_period` run the identical
      checks — read-only preview vs. the real thing, never two implementations that can drift apart
      — built by a shared private `build_close_report`. One hard refusal: the trial balance must
      balance as of the close date, which every posted journal already guarantees on its own
      (`post_journal_in_tx`), so this exists as a data-integrity guard against anything that ever
      reaches `journal_lines` outside the service layer, proven by a test that writes an unbalanced
      line directly and confirms the refusal names the exact imbalance. Closing an already-closed
      range is refused too, not a silent no-op — the fix is `reopen_period`, not a second close.
      Four advisory warnings, computed over the period between the previous lock date and the new
      one and **never** blocking: uncategorised transactions, unreconciled statement lines (no
      `auto`- or human-confirmed `recon_matches` row), draft sales orders dated in the period, and
      invoices due in the period with zero payments recorded. None of the four make the books
      *wrong* — a "Miscellaneous" category, an immaterial unreconciled line, a sales order correctly
      still being edited, an invoice a customer has 30 days to pay are all legitimate states — so
      refusing to close over them would be a close that lies about how often a real one succeeds.
      They are reported on `close_period`'s own successful return, not only on the dry run: closing
      does not make the messiness disappear, only seals the period it was found in. `reopen_period`
      requires a non-empty `reason` and is audited under its own `"reopen"` action, distinct from
      `book_set_lock_date`'s `"lock_date"` audit action — reopening is a deliberate act with its own
      trail, never a side effect indistinguishable from setting the date the first time. No new
      migration: every check reads tables that already exist, and the report itself is the audit
      record (serialized into `audit_log.after_json`), so a `period_closes` table was considered and
      rejected as a second, redundant history. Reachable on all three surfaces the same change it
      landed in — `slipscan close check|run|reopen`, three HTTP routes, three desktop IPC commands
      and their `client.ts` wrappers — rather than in a later wiring pass, the gap the rest of Phase
      6 kept finding. Seven tests against a real in-memory `CoreService`: a clean close locks and
      then refuses posting into it; the dry run matches the real close byte-for-byte except `closed`
      and mutates nothing; the broken-balance refusal; all four warnings each appear only when their
      condition holds, cleared one at a time in the same test; closing an already-closed range is
      refused, not silent; reopening restores postability and is audited; and reopening is itself
      refused with no reason or with nothing closed to reopen. Every key assertion was mutation-
      tested — the balance check, the lock-date write, and the dry run's read-only-ness — each
      confirmed to turn its test red before being reverted.)*

## Non-goals

- Hosted SaaS of any kind
- Central credential storage or screen-scraping-as-a-service
- Telemetry or any default data collection
- Coupling to VulOS — SlipScan stands alone
