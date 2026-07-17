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
2. Make your change with tests where practical. Before opening a PR:
   - Rust workspace: `cargo test --workspace`, `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets`
   - Desktop app: `cd apps/desktop && npm install && npm run check`
3. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing anything structural — it is the binding contract.
4. Open a PR describing what and why.

## What about the old cloud stack?

There is none in this tree. The legacy implementation (React on Cloudflare Workers with a Supabase backend) was removed and lives only in git history ([CHANGELOG.md](CHANGELOG.md)); all contributions target the Rust core + Tauri desktop app.
