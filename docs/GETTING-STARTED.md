# Getting Started with SlipScan

SlipScan is a self-hosted, decentralized personal-finance and accounting app. Everything runs on your machine: a Rust core over a local SQLite file, wrapped in a Tauri desktop app. No account, no cloud, no telemetry.

This guide takes you from a clone to a working book with imported transactions, a scanned receipt, a connected mailbox, and an LLM provider for extraction.

---

## Prerequisites

Packaged installers (macOS, Windows, Linux) are on the [releases page](https://github.com/vul-os/slipscan/releases/latest) — download, open, done. The steps below are for building from source (contributors, or platforms without a package).

- **Rust** (stable) — https://rustup.rs
- **Node.js** 20+ and npm
- **Tauri 2 system deps** — on Linux: `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libayatana-appindicator3-dev`; macOS and Windows need nothing extra beyond Xcode CLT / MSVC. See the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
git clone https://github.com/vul-os/slipscan
cd slipscan
```

## Build and run

### Desktop app

```sh
cd apps/desktop
npm install
npm run tauri dev      # dev build with hot reload
npm run tauri build    # release bundle (.app / .msi / .deb / .AppImage)
```

### Core library and CLI

```sh
cargo build --workspace
cargo test --workspace

# the CLI binary
cargo run -p slipscan-cli -- --help
```

The CLI covers headless use: `init` (create a book), `import` (files → documents), `watch` (a drop folder → documents), `extract` (run slip extraction), `mail-sync` (poll a mailbox: IMAP, Gmail or Graph), `recon`, `report` (with `--csv` on the trial balance), `pack`, `vault`, `serve` (self-host server), and `list`. (There is no separate `export` subcommand; CSV export lives on `report … --csv` and in the desktop Reports screen.)

---

## 1. Create your first book

A **book** is one ledgerable context — "Personal" or "My Business". Books live in a plain SQLite database file at a path you can see, back up, and move ([CONFIGURATION.md](CONFIGURATION.md#data-locations)).

The desktop app opens on an empty database with **no book**, and asks. First-run setup walks you through a region profile and a currency and then creates the book with them — chart of accounts, tax rate table and tax-report labels all come from the profile you picked. Nothing is created before you answer, because the region a book is created with cannot be changed afterwards.

It is reachable again at any time: press <kbd>⌘K</kbd> / <kbd>Ctrl-K</kbd> and choose **Set up a new book**, or use **Create a book** in Settings › General. The kind decides which features matter — a personal book leads with budgets and spending; a business book adds the chart of accounts, journals, VAT, and reconciliation.

One limitation worth knowing: the desktop screens work with the **first** book in a database and there is no book switcher yet, so a second book is reachable from the CLI (`slipscan --book <id-or-name>`) and the HTTP API rather than from the app. Settings › General lists every book and marks which one the screens are showing.

From the CLI:

```sh
slipscan init --name "Personal" --kind personal
```

Every book carries a **region profile** — the data bundle (chart-of-accounts seeds, tax rates, tax-report labels, default currency) that makes it country-specific ([CONFIGURATION.md](CONFIGURATION.md#region-profiles)). Pick one at creation with `slipscan init --region <id>` (`slipscan init --list-regions` shows what ships built-in — South Africa's `za` profile with VAT rates, VAT201 labels and ZAR, and the worldwide `generic` profile: neutral chart, one configurable tax rate, USD default). With no region given you get the **generic** profile; no jurisdiction is ever assumed. Existing databases migrate automatically: books that were implicitly South African come out on the `za` profile.

Data locations are documented in [CONFIGURATION.md](CONFIGURATION.md#data-locations).

## 2. Import a bank statement (CSV)

1. Download a statement CSV (or OFX) from your bank's internet banking.
2. Create the account the lines belong to (once): `slipscan account add "Cheque"` — it inherits the book currency unless you pass `--currency`.
3. Import it **with a statement preset**: `slipscan import statement.csv --preset za-fnb --account Cheque`. The preset's column mapping (a region-grouped catalog: SA-bank presets, a `generic` worldwide family — `slipscan import --list-presets` shows all of it; see [BANK-ADAPTERS.md](BANK-ADAPTERS.md#statement-csv-presets--region-data-not-code)) parses the rows into transactions, deduplicated by provider id / content hash, and the file itself is also stored as a bank-statement document. Without `--preset`, the file is stored as a document only.
4. Honest gaps: the desktop app cannot run preset imports yet, the fully custom column mapping has no CLI flags yet, and there is no OFX parser at all — all tracked in [ROADMAP.md](../ROADMAP.md).

For the design of automatic pulls straight from your bank, see [BANK-ADAPTERS.md](BANK-ADAPTERS.md).

## 3. Import a receipt

Import a photo or PDF of a till slip with the app's **Import receipt** button (or `slipscan import`). Drag-and-drop into the desktop app is not wired yet — it is tracked in [ROADMAP.md](../ROADMAP.md). The file becomes a **document** and moves through an extraction pipeline:

```
pending → extracted → reviewed
```

Extraction (line items, categories, discounts, VAT) runs through the LLM/OCR provider you configure in the next step — today it is triggered from the CLI (`slipscan extract`); the desktop shows the results. Review the result, fix anything, and confirm — corrections train the local classifier, and matched receipts attach to their bank transactions in [reconciliation](../README.md#features).

**Drop folder:** `slipscan watch ~/Slips` imports every PDF, image and CSV already in the folder (recursively), then keeps importing whatever lands there until you stop it with Ctrl-C. Everything goes through the same import path as `slipscan import`, so content-hash dedup applies — rescanning, or re-saving the same file, never creates a second document. Use `--once` for a one-shot scan from cron/launchd. The desktop app has no watch-folder setting yet.

## 4. Connect a mailbox

Receipts and bank alerts mostly arrive by email. Connect your own mailbox and SlipScan ingests them — no mail relay, no middleman.

The simplest path is **generic IMAP polling via the CLI**: configure host/port/username/folder, put the app password in the [credential vault](THREAT-MODEL.md) (write-only, never displayed again), and run `slipscan mail-sync` — attachments in unseen mail become documents. Any IMAP host works, including a [lilmail](https://github.com/vul-os)-managed mailbox or a local Proton Bridge.

The dedicated **Gmail** (history deltas) and **Outlook/Microsoft 365** (Graph deltas) connectors run from the same command: `slipscan mail-sync --provider gmail|graph`, after a one-time `--login` that completes the OAuth grant against **your own** app registration (browser loopback for Gmail, device code for Graph) and puts the tokens in the vault. `--provider imap` remains the default, so existing invocations are unchanged. What is still missing: no push loop runs anywhere (each `mail-sync` is one poll, so IMAP IDLE, Gmail's Pub/Sub pull and `users.watch` renewal stay library-only), and the desktop app's mailbox settings are IMAP-only — see the status note in [EMAIL.md](EMAIL.md) for exactly where each provider stands.

**Bank alerts can become transactions**, not just documents — add `--alerts --account <acct>` to any of the above. This needs one thing first: a signed `mailrules` pack that knows your bank's alert format, because **SlipScan deliberately ships no bank patterns of its own** (formats are per-bank and per-country, so they are data, not code). Without a pack installed, `--alerts` tells you so and does nothing. With one, a matched alert is parsed into a statement line and imported through the exact path `--preset` uses above, so dedupe, your categorisation corrections, and the [Payments](PAYMENTS.md) hook all apply — and a rule that matches but cannot read a field cleanly declines with a reason instead of guessing. CLI-only, one target account per run: [EMAIL.md](EMAIL.md#bank-alert-emails--transactions).

## 5. Set an LLM provider

Receipt extraction needs a model. You bring your own — SlipScan never routes through a hosted SlipScan endpoint.

| Option | What you need |
|---|---|
| BYO API key | An API key for your provider of choice. Stored in the vault, sent only to that provider's endpoint. |
| Local via Ollama | Ollama running on `127.0.0.1:11434` with a vision-capable model. Zero egress. |
| [llmux](https://github.com/vul-os) | Point SlipScan at your own llmux gateway URL — one config for all your models, still your infrastructure. |

Configuration is headless today, and honestly clunky: the CLI has no settings command yet, so the `extract.provider` setting is written through the server API (`slipscan serve`, then `POST /api/v1/settings_set` — [CONFIGURATION.md](CONFIGURATION.md#the-settings-model)); the key goes in with `slipscan vault set`, and `slipscan extract` runs the extraction. The desktop Settings screen shows extraction preferences and lets you vault keys, but does not yet drive extraction itself. The key is vaulted; the UI shows only a fingerprint and last-used time.

---

## Where to go from here

- Automate bank pulls — [BANK-ADAPTERS.md](BANK-ADAPTERS.md)
- Install a regional classification pack, or a `mailrules` pack for your bank's alerts — [PACKS.md](PACKS.md)
- Run headless on your NAS — [SELFHOST.md](SELFHOST.md)
- Give this device an identity and pair another one — [NODES.md](NODES.md) (identity and pairing only; nothing syncs yet)
- See how much of Xero and Vault22 actually exists — [PARITY.md](../PARITY.md)
- Understand what protects your credentials — [THREAT-MODEL.md](THREAT-MODEL.md)

**Next:** [CONFIGURATION.md](CONFIGURATION.md) — settings model, data locations, and provider configs.
