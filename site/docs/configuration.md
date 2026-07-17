# Configuration

SlipScan's configuration model is deliberately small: **settings live in SQLite, secrets live in the OS keychain, and nothing lives in dotfiles you have to manage.** There is no required config file.

---

## The settings model

Settings are key/value rows in each book's `settings` table, read and written through `settings_get` / `settings_set` (same operation names in the desktop app, the CLI, and the [server API](API.md)).

Two kinds of values:

- **Plain settings** — provider choices, mailbox filters, watch-folder paths, UI preferences. Stored as-is.
- **Secret-referencing settings** — anything sensitive stores only a **keychain entry name**, never the material. The secret itself goes to the [credential vault](THREAT-MODEL.md). Copying your SQLite file copies configuration, not credentials.

```
settings:  llm.provider = "ollama"                 ← plain
settings:  mailbox.home.secret = "imap-home"       ← a *name*
keychain:  slipscan / imap-home = <app password>   ← the secret, OS keychain only
```

## Data locations

One SQLite file per book, at a user-visible path. WAL mode, so you'll see `-wal`/`-shm` sidecars while the app runs.

| Platform | Default books directory |
|---|---|
| macOS | `~/Library/Application Support/slipscan/books/` |
| Linux | `~/.local/share/slipscan/books/` |
| Windows | `%APPDATA%\slipscan\books\` |

Alongside each book's database, SlipScan keeps a `documents/` directory with the original receipt/statement files, content-addressed. The database stores metadata and extraction results; the originals stay as ordinary files.

**Backup = copy the directory.** That's the whole story. Secrets are *not* in the backup — they never leave the OS keychain — so on a new machine you re-enter credentials once. This is by design; see [THREAT-MODEL.md](THREAT-MODEL.md).

You can create a book anywhere (an encrypted volume, a synced folder you trust) — the path is yours.

## Vault-backed secrets

Everything sensitive goes through the credential vault:

- IMAP / app passwords
- OAuth client secrets and refresh tokens (Gmail, Microsoft)
- LLM API keys
- Bank-adapter credentials

Vault semantics are **write-only**: you can set, replace, and revoke a secret, never view one. The UI shows metadata only — label, created/rotated timestamps, last-used, and a short non-reversible fingerprint. Every use is recorded in the append-only audit log.

Deep-dive (envelope encryption, KEK in the OS keychain, user presence): [THREAT-MODEL.md](THREAT-MODEL.md).

## Provider configs

### LLM / OCR extraction

`Settings → Extraction`. One active provider per book:

| Provider | Config | Secret |
|---|---|---|
| BYO API key | provider id, model name | API key → vault |
| Ollama (local) | base URL, default `http://127.0.0.1:11434`, model name | none |
| llmux | your gateway URL, model route | gateway key → vault (if set) |

Extraction requests go only to the endpoint you configured. Offline with a local model means zero egress, full function.

### Mailboxes

Per mailbox: provider type, connection details, a folder/label to watch, and a sender allowlist. Credentials go to the vault. Full matrix and per-provider setup: [EMAIL.md](EMAIL.md).

### Bank adapters

Per adapter: bank id, account mapping, sync schedule. Credentials go to the vault and are only ever handed to the adapter inside a closure at run time. See [BANK-ADAPTERS.md](BANK-ADAPTERS.md).

### File watch

Point SlipScan at one or more folders (e.g. a scanner's output directory, a synced camera-roll folder). New files are imported through the same document pipeline as drag-and-drop.

## Server settings (self-host)

`slipscan-server` binds `127.0.0.1:7151` by default. Binding anything else is an explicit opt-in flag. Details: [SELFHOST.md](SELFHOST.md).

## What is *not* configurable

There is no telemetry toggle, because there is no telemetry. No update-check switch, no crash reporting, no "anonymous usage statistics". The only network settings that exist are ones **you** create by configuring a provider.

---

**Next:** [EMAIL.md](EMAIL.md) — connect Gmail, Outlook, Proton, or any IMAP mailbox.
