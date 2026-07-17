# SlipScan

**Self-hosted, decentralized personal finance. You are the server.**

SlipScan tracks your money the way services like 22seven / Vault22 do — bank transactions, receipts, budgets, categorised spending — but with one fundamental difference: **there is no central server**. Your data lives on your machine, your scrapers run with your credentials, and the only thing the community shares is knowledge, never data.

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

## Status

SlipScan is in transition to its new architecture:

- **Target stack:** Rust backend + [Tauri](https://tauri.app) desktop app, local SQLite.
- **Legacy stack (this repo, working):** React/Vite frontend + Cloudflare Workers backend, being ported.

See [ROADMAP.md](ROADMAP.md) for the plan.

### Running the legacy stack

```sh
npm install
npm run dev          # frontend
npm run dev:worker   # backend (wrangler)
npm test
```

## Contributing

Contributions are welcome — bank scraper adapters especially. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
