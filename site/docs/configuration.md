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
settings:  llm.provider = "ollama"                 ← plain
settings:  mailbox.home.secret = "imap-home"       ← a *name*
keychain:  slipscan / imap-home = <app password>   ← the secret, OS keychain only
```

## Data locations

One SQLite database file holds your books (several books can share one file — the CLI's `--book` flag selects one), at a user-visible path. WAL mode, so you'll see `-wal`/`-shm` sidecars while the app runs. (A one-file-*per-book* layout under a `books/` directory is the eventual design in [ARCHITECTURE.md](ARCHITECTURE.md); today there is a single database file.)

| Platform | Default location |
|---|---|
| macOS (desktop app) | `~/Library/Application Support/<app-id>/slipscan.db` |
| Linux (desktop app) | `~/.local/share/<app-id>/slipscan.db` |
| Windows (desktop app) | `%APPDATA%\<app-id>\slipscan.db` |
| CLI | `slipscan.sqlite` in the working directory, or wherever `--db` points |

Alongside the database, SlipScan keeps a `documents/` directory with the original receipt/statement files, content-addressed. The database stores metadata and extraction results; the originals stay as ordinary files.

**Backup = copy the database file (plus sidecars when the app is closed) and the `documents/` directory.** That's the whole story. Secrets are *not* in the backup — they never leave the OS keychain — so on a new machine you re-enter credentials once. This is by design; see [THREAT-MODEL.md](THREAT-MODEL.md).

With the CLI you can put the database anywhere (an encrypted volume, a synced folder you trust) — the path is yours.

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

Design: per adapter, a bank id, account mapping, and sync schedule, with credentials in the vault, handed to the adapter only inside a closure at run time. No live adapter ships yet — see [BANK-ADAPTERS.md](BANK-ADAPTERS.md) for what exists (CSV statement presets) versus what's planned.

### File watch

Planned: point SlipScan at one or more folders (e.g. a scanner's output directory) and have new files imported through the same document pipeline as manual import. The watcher is implemented as a library in `slipscan-ingest` but no surface wires it yet — there is currently no watch-folder setting that does anything.

## Server settings (self-host)

`slipscan-server` binds `127.0.0.1:7151` by default. Binding anything else is an explicit opt-in flag. Details: [SELFHOST.md](SELFHOST.md).

## What is *not* configurable

There is no telemetry toggle, because there is no telemetry. No update-check switch, no crash reporting, no "anonymous usage statistics". The only network settings that exist are ones **you** create by configuring a provider.

---

**Next:** [EMAIL.md](EMAIL.md) — connect Gmail, Outlook, Proton, or any IMAP mailbox.
