# Getting Started with SlipScan

SlipScan is a self-hosted, decentralized personal-finance and accounting app. Everything runs on your machine: a Rust core over a local SQLite file, wrapped in a Tauri desktop app. No account, no cloud, no telemetry.

This guide takes you from a clone to a working book with imported transactions, a scanned receipt, a connected mailbox, and an LLM provider for extraction.

---

## Prerequisites

There are no binary releases yet — you build from source.

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

The CLI covers headless use: `init` (create a book), `import` (files), `serve` (self-host server), `list`, `export`.

---

## 1. Create your first book

A **book** is one ledgerable context — "Personal" or "My Business". Each book is one SQLite file at a path you can see, back up, and move.

In the desktop app: **New book → name it → pick a kind** (personal or business). The kind decides which features surface — a personal book leads with budgets and spending; a business book adds the chart of accounts, journals, VAT, and reconciliation.

From the CLI:

```sh
slipscan init --name "Personal" --kind personal
```

Data locations are documented in [CONFIGURATION.md](CONFIGURATION.md#data-locations).

## 2. Import a bank statement (CSV)

The fastest way to get real data in:

1. Download a statement CSV from your bank's internet banking.
2. Drag it onto the SlipScan window (or **Import → Choose file**).
3. Map the columns (date, amount, description) once — SlipScan remembers the mapping per bank.
4. Transactions land in the account you pick, deduplicated by provider transaction id or content hash. Re-importing an overlapping export is safe.

OFX imports work the same way. For automatic pulls straight from your bank, see [BANK-ADAPTERS.md](BANK-ADAPTERS.md).

## 3. Drop a receipt

Drag a photo or PDF of a till slip onto the app. It becomes a **document** and moves through an extraction pipeline:

```
pending → extracted → reviewed
```

Extraction (line items, categories, discounts, VAT) runs through the LLM/OCR provider you configure in the next step. Review the result, fix anything, and confirm — corrections train the local classifier, and matched receipts attach to their bank transactions in [reconciliation](../README.md#features).

You can also point SlipScan at a watch folder — anything saved there is imported automatically. See [CONFIGURATION.md](CONFIGURATION.md).

## 4. Connect a mailbox

Receipts and bank alerts mostly arrive by email. Connect your own mailbox and SlipScan ingests them as they arrive — no mail relay, no middleman.

**Settings → Mailboxes → Add**, then pick your provider:

- **Any IMAP host** — server, username, app password. Works everywhere, including a [lilmail](https://github.com/vul-os)-managed mailbox.
- **Gmail** — your own Google OAuth client, real-time push via a Pub/Sub *pull* subscription.
- **Outlook / Microsoft 365** — your own app registration, device-code sign-in.
- **Proton Mail** — via the local Proton Bridge.

Set a folder/label and a sender allowlist per mailbox so only receipt-like mail is processed. The password or refresh token goes into the [credential vault](THREAT-MODEL.md) — write-only, never displayed again.

Full provider walkthroughs: [EMAIL.md](EMAIL.md).

## 5. Set an LLM provider

Receipt extraction and the "Ask" view need a model. You bring your own — SlipScan never routes through a hosted SlipScan endpoint.

**Settings → Extraction → Provider:**

| Option | What you need |
|---|---|
| BYO API key | An API key for your provider of choice. Stored in the vault, sent only to that provider's endpoint. |
| Local via Ollama | Ollama running on `127.0.0.1:11434` with a vision-capable model. Zero egress. |
| [llmux](https://github.com/vul-os) | Point SlipScan at your own llmux gateway URL — one config for all your models, still your infrastructure. |

Pick a provider, paste the key (or URL), done. The key is vaulted; the UI shows only a fingerprint and last-used time.

---

## Where to go from here

- Automate bank pulls — [BANK-ADAPTERS.md](BANK-ADAPTERS.md)
- Install a regional classification pack — [PACKS.md](PACKS.md)
- Run headless on your NAS — [SELFHOST.md](SELFHOST.md)
- Understand what protects your credentials — [THREAT-MODEL.md](THREAT-MODEL.md)

**Next:** [CONFIGURATION.md](CONFIGURATION.md) — settings model, data locations, and provider configs.
