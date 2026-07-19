# Configuration

SlipScan's configuration model is deliberately small: **settings live in SQLite, secrets live in the OS keychain, and nothing lives in dotfiles you have to manage.** There is no required config file.

---

## The settings model

Settings are key/value rows in the `settings` table, read and written through `settings_get` / `settings_set`. Honest status of the writers today:

- The **[server API](API.md)** exposes generic key/value `settings_get` / `settings_set` routes — currently the only surface that can write arbitrary keys like `extract.provider` or `mail.imap.config` (`slipscan serve`, then `POST /api/v1/settings_set` with `{"key": …, "value": …, "secret": false}`).
- The **desktop app** has IPC commands of the same names, but they carry only the Settings screen's own UI/provider blob — they cannot write arbitrary keys yet.
- The **CLI** reads settings internally (`slipscan extract`, `slipscan mail-sync`) but has **no settings command yet**; a `slipscan settings get/set` is on the roadmap.

Two kinds of values:

- **Plain settings** — provider choices, mailbox filters, watch-folder paths, UI preferences. Stored as-is.
- **Secret-referencing settings** — anything sensitive stores only a **keychain entry name**, never the material. The secret itself goes to the [credential vault](THREAT-MODEL.md). Copying your SQLite file copies configuration, not credentials.

```
settings:  llm.provider = "ollama"                     ← plain
settings:  fx.openrate_base_url = "https://rates.you"  ← plain (an endpoint you chose)
settings:  mailbox.home.secret = "imap-home"           ← a *name*
keychain:  slipscan / imap-home = <app password>       ← the secret, OS keychain only
```

## Region profiles

Everything country-specific is **data on the book, not a hidden global setting** ([the contract](ARCHITECTURE.md#global-by-default--regions-are-data-not-code)). Each book stores a `region` id naming the region profile that drives its chart-of-accounts seeds, tax-rate table, and tax-report labels ("VAT201" is the `za` profile's name for the tax-period summary; the generic profile just says "Tax summary"). Two profiles ship built-in, as embedded data in `slipscan-core` (`src/region.rs`):

| Region id | Profile | Seeds |
|---|---|---|
| `za` | South Africa (first region profile) | SA business chart with VAT controls, 15%/zero/exempt VAT rates, VAT201 labels, ZAR default currency |
| `generic` | Generic (international) | Neutral chart of accounts, one configurable standard tax rate, neutral report labels |

The region is fixed at book creation and can be chosen explicitly: `slipscan init --region za` on the CLI (`slipscan init --list-regions` prints the built-in profiles), or the optional `region` field on the server's `book_create` route. An explicit region wins; an unknown explicit id is rejected (a typo can't silently produce a generic book). Without one, creation infers the region from the book's country (`ZA` → `za`; anything else, or none, → `generic`). The book currency defaults from the profile and is overridable at creation (`slipscan init --currency EUR`, or the `currency` field on `book_create`) — any ISO-4217 currency, day one. The generic profile's standard tax rate seeds at 0 bps until you set it: `slipscan tax set-rate STD 1500` (or the `vat_rate_set_bps` operation). Adding a country means adding profile data, never touching core logic. **Existing databases keep working**: a migration backfills the column — books that were implicitly South African (explicit `ZA` country, `ZAR` currency, or seeded ZA VAT rates) come out as `za`; everything else as `generic`. A book stored with a region id a build doesn't know falls back to the generic profile instead of breaking.

## Data locations

All durable data — the SQLite database (`slipscan.db`) and the `documents/` store with the original receipt/statement files — lives in **one movable folder** ([the contract](ARCHITECTURE.md#data-location--backup--your-folder-your-cloud-your-responsibility)). One database file holds your books (several books can share one file — the CLI's `--book` flag selects one). WAL mode, so you'll see `-wal`/`-shm` sidecars while the app runs. (A one-file-*per-book* layout under a `books/` directory is the eventual design in [ARCHITECTURE.md](ARCHITECTURE.md); today there is a single database file.)

A small **pointer file** (`data_dir.json`) in the fixed per-OS app-config directory names the current data folder. CLI, server, and desktop all resolve the same pointer, so every surface agrees on where the data is. When no pointer is set, the platform default applies:

| Platform | Default data folder | Pointer file |
|---|---|---|
| macOS | `~/Library/Application Support/org.vulos.slipscan/` | `~/Library/Application Support/org.vulos.slipscan/data_dir.json` |
| Linux | `~/.local/share/org.vulos.slipscan/` | `~/.config/org.vulos.slipscan/data_dir.json` |
| Windows | `%APPDATA%\org.vulos.slipscan\` | `%APPDATA%\org.vulos.slipscan\data_dir.json` |

`slipscan data status` shows the current folder, sizes, and the pointer path. The CLI's global `--db <file>` still explicitly overrides everything for that invocation (an encrypted volume, a scratch database — the path is yours; documents then default to `<db dir>/slipscan-documents`).

**Moving the folder** — `slipscan data move <target>` on the CLI, or desktop **Settings → Data & backup → Move…** (both drive the same core operation):

1. validates the target: refused when it is inside the current folder, not writable, or already contains a SlipScan database (open that one instead — it is someone's books);
2. takes SQLite's own exclusive lock on the database and folds the WAL into the main file — **refused while any other SlipScan process (a desktop window, `slipscan serve`, another CLI command) still has the database open**, and held until the pointer has swapped, so nothing can commit writes the copy would miss;
3. copies the database and every file in the `documents/` store with **per-file SHA-256 verification**, then re-opens the copy and runs the migration + integrity check. Documents referenced *in place* (imported without copying into the store) are not moved: they stay where they are, and their stored paths keep naming them;
4. **atomically swaps the pointer** (temp file + rename + directory fsync, then read back);
5. only after the swap is verified does it remove the old copy.

Aborting, crashing, or losing power at any point is safe: until the pointer swap is on disk, the old folder stays active, and re-running the move resumes — over the partial copy, or, if the interruption landed in the narrow window after the copy already took its final database name, via a small commit journal kept next to the pointer file whose checksum proves the database at the target is your own half-moved copy (anything else there is still refused with open-instead). While a move is in progress the app is read-only — enforced by the exclusive lock itself, across every process.

**Backup = your own cloud on that folder.** Point the data folder at (or sync it with) a folder your own cloud syncs — iCloud Drive, Dropbox, Syncthing, Nextcloud, a NAS. **We rely on you to back up; SlipScan ships no backup service.** Secrets are *not* in the backup: the vault ciphertext moves with the folder, but the key that unwraps it never leaves the OS keychain — a synced or stolen copy of the folder yields no credentials, and restoring onto a new machine means re-entering them once. This is by design; see [THREAT-MODEL.md](THREAT-MODEL.md).

## Vault-backed secrets

Everything sensitive goes through the credential vault:

- IMAP / app passwords
- OAuth client secrets and refresh tokens (Gmail, Microsoft)
- LLM API keys
- Bank-adapter credentials

Vault semantics are **write-only**: you can set, replace, and revoke a secret, never view one. The UI shows metadata only — label, created/rotated timestamps, last-used, and a short non-reversible fingerprint. Every use is recorded in the append-only audit log.

Deep-dive (envelope encryption, KEK in the OS keychain): [THREAT-MODEL.md](THREAT-MODEL.md).

## Provider configs

### LLM / OCR extraction

Configured via the `extract.provider` setting (written through the server API's `settings_set` today — see [the settings model](#the-settings-model) above) and driven by `slipscan extract` (the desktop Settings screen's extraction section stores UI preferences but does not yet drive extraction — the CLI is the working extraction path). One active provider per book:

| Provider | Config | Secret |
|---|---|---|
| BYO API key | provider id, model name | API key → vault |
| Ollama (local) | base URL, default `http://127.0.0.1:11434`, model name | none |
| llmux | your gateway URL, model route | gateway key → vault (if set) |

Extraction requests go only to the endpoint you configured. Offline with a local model means zero egress, full function.

### Mailboxes

Per mailbox: connection details and a folder to watch (the `mail.imap.config` setting, read by `slipscan mail-sync` and written through the server API's `settings_set` today). Credentials go to the vault. Status per provider and setup: [EMAIL.md](EMAIL.md).

### Bank adapters

Design: per adapter, a bank id, account mapping, and sync schedule, with credentials in the vault, handed to the adapter only inside a closure at run time. No live adapter ships yet — see [BANK-ADAPTERS.md](BANK-ADAPTERS.md) for what exists (region-grouped CSV statement presets plus a custom column mapping for any bank) versus what's planned.

### Exchange rates — OpenRate (opt-in)

Multi-currency FX has exactly **one configuration knob**:

| Key | Value | Kind |
|---|---|---|
| `fx.openrate_base_url` | Base URL of the [OpenRate](https://github.com/vul-os/openrate) instance you host or trust, e.g. `https://rates.example.net` | Plain setting — a URL you chose is an endpoint, not a secret |

Absent or empty means **FX is off**: every fetch path fails with `fx_not_configured` *before* touching any transport — zero FX network calls, exactly the [mantra](ARCHITECTURE.md#non-negotiables-the-mantra). With it set, rate fetches are explicit (never a background default), and:

- fetched rates are **cached locally** in the `fx_rates` table — decimal rate (stored as text, never a float), `as_of`, OpenRate's quality grade, and fetch time;
- conversions **serve from the cache** and surface staleness (`age_secs`) instead of silently re-fetching — a stale weekend rate says so;
- every conversion **records the exact rate it used** (returned payload + audit log), so converted reports reproduce offline and never silently re-rate.

The core service surface is `fx_configure`, `fx_status`, `fx_fetch_rate`, `fx_convert` ([ARCHITECTURE.md](ARCHITECTURE.md#exchange-rates--openrate) is the binding contract; [API.md](API.md) tracks which transports expose the fx operations as they are wired).

### File watch

Planned: point SlipScan at one or more folders (e.g. a scanner's output directory) and have new files imported through the same document pipeline as manual import. The watcher is implemented as a library in `slipscan-ingest` but no surface wires it yet — there is currently no watch-folder setting that does anything.

## Server settings (self-host)

`slipscan-server` binds `127.0.0.1:7151` by default. Binding anything else is an explicit opt-in flag. Details: [SELFHOST.md](SELFHOST.md).

## What is *not* configurable

There is no telemetry toggle, because there is no telemetry. No update-check switch, no crash reporting, no "anonymous usage statistics". The only network settings that exist are ones **you** create by configuring a provider.

---

**Next:** [EMAIL.md](EMAIL.md) — connect Gmail, Outlook, Proton, or any IMAP mailbox.
