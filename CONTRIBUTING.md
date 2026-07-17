# Contributing to SlipScan

Thanks for helping build self-hosted, decentralized personal finance. All contributions are under the [MIT license](LICENSE).

## What we need most

1. **Bank scraper adapters** — one open-source module per bank type. If your bank isn't supported, that's the highest-value contribution you can make. Adapters must run entirely locally, keep credentials in the OS keychain, and never phone home.
2. **Email parsers** — receipt/statement/alert formats for merchants and banks.
3. **Classification packs** — category taxonomies and merchant→category rules for your region. Packs contain rules only, never transaction data.
4. **Rust core & Tauri app** — see [ROADMAP.md](ROADMAP.md) for the current phase.

## Ground rules

- **Privacy is non-negotiable.** No telemetry, no central endpoints, no default data collection. PRs that add any of these will be declined.
- Keep adapters auditable: small, dependency-light, readable.
- Discuss significant changes in an issue before opening a large PR.
- Conventional commits appreciated (`feat:`, `fix:`, `chore:`...).

## Workflow

1. Fork, branch from `main`.
2. Make your change with tests where practical (`npm test` for the legacy stack; `cargo test` once the Rust core lands).
3. Open a PR describing what and why.

## Legacy stack

The React/Vite + Cloudflare Workers code in this repo is the working legacy implementation being ported to Rust + Tauri. Bug fixes there are welcome; new features should target the new architecture unless discussed first.
