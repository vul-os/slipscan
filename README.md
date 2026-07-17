<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-wordmark-dark.svg">
    <img src="assets/brand/logo-wordmark.svg" alt="slip/scan" width="220">
  </picture>
</p>

<p align="center"><strong>Self-hosted, decentralized personal finance & accounting. You are the server.</strong></p>

SlipScan gives you what Vault22 / 22seven does for personal finance and what Xero does for small-business accounting — bank transactions, receipts, budgets, categorised spending, double-entry ledger, reconciliation, VAT — with one fundamental difference: **there is no central server**. Your data lives on your machine, your scrapers run with your credentials, and the only thing the community shares is knowledge, never data.

SlipScan is a standalone product in the VulOS family (like Ofisi). It does not depend on VulOS or any hosted service.

## Principles

- **You are the server.** No SaaS backend, no aggregator in the middle. Everything runs locally or on infrastructure you control.
- **Your credentials never leave your machine.** Bank scraping happens on your device with open-source, auditable, per-bank adapters.
- **Share the smarts, not the data.** Category taxonomies and transaction-classification rules are shared as signed, community-maintained packs. Your transactions stay yours.
- **Open source, MIT licensed.** Every scraper, every parser, every line is inspectable.
- **Local-first.** Works offline; sync is between *your own* devices, opt-in.

## How it works

```
┌─────────────────────────── your machine ───────────────────────────┐
│                                                                    │
│  Bank scrapers (per-bank, open source)  ─┐                         │
│  Email inbound (your IMAP/SMTP inbox)   ─┼─▶  Rust core            │
│  Receipt / slip capture (OCR + LLM)     ─┘    (local SQLite)       │
│                                                    │               │
│                                               Tauri desktop app    │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
              ▲
              │  signed classification & category packs
              ▼
     community pack registry (git / p2p — no central server)
```

- **Bank ingestion:** one open-source scraper module per bank type. You run it, you audit it, you own the session.
- **Email ingestion:** connect your own mailbox (IMAP) — receipts, statements and bank alerts flow in without any central mail relay.
- **Classification:** transactions and slips are categorised locally. Community packs improve everyone's classification without anyone uploading their transactions.

## Features

**Personal finance (Vault22 / 22seven class)** — accounts across banks, automatic transaction categorisation, budgets, spending breakdowns, receipts matched to transactions.

**Accounting (Xero class)** — chart of accounts, double-entry ledger, manual journals, VAT, bank reconciliation, and standard exports — for freelancers and small businesses that want their books local.

All of it offline-capable, on your machine, in a plain SQLite file you can back up yourself.

## Status

Active development on the new stack: **Rust core + [Tauri](https://tauri.app) desktop app (Svelte 5 + TypeScript), local SQLite.** The previous cloud implementation (React + Cloudflare Workers) has been removed — it lives in git history. See [ROADMAP.md](ROADMAP.md).

```sh
# desktop app (once scaffolded)
cd apps/desktop && npm install && npm run tauri dev

# core library & CLI
cargo build --workspace && cargo test --workspace
```

## Contributing

Contributions are welcome — bank scraper adapters especially. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
