<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-wordmark-dark.svg">
    <img src="assets/brand/logo-wordmark.svg" alt="slip/scan" width="220">
  </picture>
</p>

<p align="center"><strong>Self-hosted, decentralized personal finance &amp; accounting. You are the server.</strong></p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#download">Download</a> ·
  <a href="#features">Features</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

<!-- Plain-text badges on purpose: rendering this README triggers no external
     image fetches — the same no-default-network-calls ethos as the app. -->
<p align="center"><sub><a href="LICENSE">MIT license</a> · Rust 1.85+ · Tauri 2 · SQLite · offline-first</sub></p>

<p align="center">
  <img src="assets/screens/dashboard.png" alt="SlipScan dashboard — the shipped desktop app showing balances, budget burn, nudges, and recent activity" width="820">
  <br>
  <sub><em>The shipped desktop app — Dashboard with net balance, monthly spend, budget remaining, locally-computed nudges, and recent activity. All screenshots show demo data (<a href="docs/SCREENSHOTS.md">full tour</a>).</em></sub>
</p>

<table align="center">
  <tr>
    <td align="center" width="33%"><strong>You are the server</strong><br><sub>No SaaS backend, no aggregator in the middle. Everything runs on your machine or a box you control.</sub></td>
    <td align="center" width="33%"><strong>Write-only secrets</strong><br><sub>Bank &amp; mailbox credentials live in your OS keychain. Set, rotate, revoke, use — never view.</sub></td>
    <td align="center" width="33%"><strong>Share smarts, not data</strong><br><sub>Community knowledge travels as signed classification packs — with noise-protected benchmark statistics designed on the same principle (<a href="docs/BENCHMARKS.md">not yet built</a>). Never your transactions.</sub></td>
  </tr>
</table>

## What is SlipScan?

SlipScan gives you what Vault22 / 22seven does for personal finance and what Xero does for small-business accounting — bank transactions, receipts, budgets, categorised spending, double-entry ledger, reconciliation, tax — with one fundamental difference: **there is no central server**. A Rust core over a plain SQLite file, wrapped in a Tauri desktop app. It is a standalone product: no account, no cloud, no telemetry, and it never depends on any hosted service.

It is also **global by default**: nothing country-specific is hardcoded — chart-of-accounts seeds, tax rates and return labels, bank CSV presets, and merchant packs all ship as **region profiles** (data you pick, [contract](docs/ARCHITECTURE.md#global-by-default--regions-are-data-not-code)). South Africa is the first region profile; a generic profile covers any country from day one.

Your data lives on your machine, your bank and mailbox credentials stay in your OS keychain, and the only thing the community shares is knowledge — signed classification packs today, with differentially-private benchmark statistics designed but [not yet implemented](docs/BENCHMARKS.md) — never data.

## Features

<table>
  <tr>
    <th align="left" width="50%">💰 Personal finance <sub>(Vault22 / 22seven class)</sub></th>
    <th align="left" width="50%">📒 Accounting <sub>(Xero class)</sub></th>
  </tr>
  <tr>
    <td valign="top">
      <ul>
        <li>Accounts across banks — bank, cash, card, asset, liability</li>
        <li>Transaction categorisation with local corrections and merchant mappings — the learning loop never leaves your machine; community pack <em>rules</em> install today but are not yet consulted during categorisation (<a href="docs/PACKS.md">status</a>)</li>
        <li>Per-category monthly budgets, spending breakdowns and income/expense reports (a rollover flag is stored per budget, but rollover is not yet applied to the numbers)</li>
        <li>Receipt/slip capture with LLM/OCR extraction (line items, discounts, VAT) — bring your own key or run a local model</li>
        <li>Household members &amp; per-person attribution — split spend across the people sharing a book, with per-member expense/contribution reports and a "who owes whom" settle-up view; members are local data, not logins</li>
        <li>Local nudge engine and anonymous peer benchmarks — designed, in progress (<a href="docs/BENCHMARKS.md">how it stays private</a>)</li>
      </ul>
    </td>
    <td valign="top">
      <ul>
        <li>Double-entry ledger: chart of accounts, journals, balanced-by-construction journal lines</li>
        <li>Chart-of-accounts seeds, tax rates, tax-period summaries, and returns groundwork from your <em>region profile</em> — South Africa first, generic profile everywhere else</li>
        <li>Bank reconciliation: suggested matches between documents, transactions, and journal lines</li>
        <li>Trial balance, income statement, balance sheet, and CSV export</li>
        <li>Immutable posted journals — corrections are reversals, never edits</li>
      </ul>
    </td>
  </tr>
</table>

**Infrastructure you can trust**

- **Get paid by reference (ShapePay)** — watch an EFT reference code, and when the matching payment lands in your books (from any source) SlipScan fires an HMAC-signed webhook to endpoints you register. Signing secrets are vault-held and shown exactly once; payloads carry the reference and amount, never account numbers; deliveries retry until your box has network. Inbox in, webhook out, no central infrastructure ([guide](docs/PAYMENTS.md))
- **Movable data folder, your own backup** — your books and documents live in one folder you can see, relocate from Settings or `slipscan data move` (verified copy + atomic switch), and back up by syncing it with your own cloud (iCloud / Dropbox / Syncthing / NAS). SlipScan ships no backup service, and the keychain key never travels with the folder ([data &amp; backup](docs/CONFIGURATION.md))
- Ingestion from your own mailbox — always your accounts, [never our infrastructure](docs/EMAIL.md); generic IMAP polling works today, Gmail/Graph connectors and push are built but not yet wired to a surface
- Open-source, local bank-scraper framework — adapters run in your session, first adapters in progress ([framework](docs/BANK-ADAPTERS.md))
- Write-only credential vault rooted in the OS keychain — secrets can be set, rotated, revoked, and used, never viewed ([threat model](docs/THREAT-MODEL.md))
- Opt-in multi-currency FX via [OpenRate](https://github.com/vul-os/openrate) — self-hosted, provenance-graded rates. Decimal-only rate math (floats never touch money), a local rate cache, and every conversion recording the exact rate, quality grade, and as-of age it used — surfaced on the CLI (`slipscan fx`), the HTTP server, and the desktop Settings screen; converted report views are still landing (Phase 4.7). No endpoint configured means zero FX network calls ([contract](docs/ARCHITECTURE.md#exchange-rates--openrate))
- Headless self-host server mode for an always-on box ([guide](docs/SELFHOST.md))

> [!NOTE]
> **Status: 0.2.0, under active development.** The Rust core, CLI, extraction, ingestion, packs, and server crates are implemented; bank adapters, nudges/benchmarks, and device sync are tracked phase-by-phase in [ROADMAP.md](ROADMAP.md).

## Screenshots

These are the **shipped desktop app**, running with demo data. The full annotated set — every screen, plus light mode — is in [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md).

<table>
  <tr>
    <td width="50%"><img src="assets/screens/receipts.png" alt="Receipts"><br><sub><em>Receipts — every captured slip with extraction status (pending / extracted / reviewed / failed) and confidence</em></sub></td>
    <td width="50%"><img src="assets/screens/receipt-detail.png" alt="Receipt detail"><br><sub><em>Slip detail — extracted line items with quantities, VAT, and discounts, inline in the list</em></sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/screens/ledger.png" alt="Ledger"><br><sub><em>Double-entry ledger — chart of accounts with per-account VAT treatment; journal and trial balance tabs</em></sub></td>
    <td width="50%"><img src="assets/screens/reconcile.png" alt="Reconcile"><br><sub><em>Reconciliation — scored matches between bank transactions and slips; confirm or reject each</em></sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/screens/reports.png" alt="Reports"><br><sub><em>Reports — income vs expense, spending by category, tax summary (VAT201 here), CSV exports — all computed locally</em></sub></td>
    <td width="50%"><img src="assets/screens/budgets.png" alt="Budgets"><br><sub><em>Budgets — per-category monthly limits with burn bars, remaining amounts, and warn colours as they fill</em></sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/screens/payments.png" alt="Payments"><br><sub><em>Payments (ShapePay) — watch codes, webhook endpoints with rotate-once secrets, and the signed-delivery queue with retry status</em></sub></td>
    <td width="50%"><img src="assets/screens/transactions.png" alt="Transactions"><br><sub><em>Transactions — inline categorisation and per-person attribution (member avatars) for households sharing a book</em></sub></td>
  </tr>
</table>

## Quick start

### Download

Installers for every desktop platform are on the [latest release](https://github.com/vul-os/slipscan/releases/latest):

| Platform | Grab |
|---|---|
| macOS | `.dmg` |
| Windows | `.msi` or `-setup.exe` |
| Linux | `.AppImage` or `.deb` |

Standalone CLI binaries ship alongside the installers in the same release. Builds are unsigned for now — first launch: macOS right-click → Open; Windows SmartScreen → "More info" → "Run anyway".

### Build from source

Prerequisites (Rust stable, Node 20+, Tauri system deps) are listed in [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

```sh
git clone https://github.com/vul-os/slipscan
cd slipscan

# Desktop app
cd apps/desktop && npm install && npm run tauri dev

# Core library + CLI (headless)
cargo build --workspace
cargo run -p slipscan-cli -- init --name "Personal" --kind personal
cargo run -p slipscan-cli -- --help    # import, extract, mail-sync, recon, report, pack, vault, serve, list
```

`slipscan serve` binds `127.0.0.1` unless you explicitly pass `--lan` — see [docs/SELFHOST.md](docs/SELFHOST.md).

## How it works

Everything runs on your machine. Sources feed one Rust core, the core owns a plain SQLite database holding your books, and the desktop app is a thin shell over the same services. The only network endpoints in the picture are ones **you** configured — your bank, your mailbox, your LLM provider, and (opt-in, for multi-currency) your own [OpenRate](https://github.com/vul-os/openrate) instance for provenance-graded FX rates:

```mermaid
flowchart LR
    subgraph machine["your machine"]
        direction LR
        subgraph sources["sources"]
            bank["Bank scrapers<br/>(open-source, your session)"]
            mail["Email inbound<br/>(your IMAP / Gmail / Graph / Proton)"]
            files["Slips &amp; files<br/>(import today; drag-drop &amp; watch planned)"]
        end
        core["Rust core<br/>(slipscan-core services:<br/>categorise, budget, ledger, recon)"]
        db[("SQLite<br/>your books, one file")]
        app["Tauri desktop app<br/>(Svelte 5, thin IPC)"]
        bank --> core
        mail --> core
        files --> core
        core <--> db
        app <-->|"IPC"| core
    end
    openrate["OpenRate<br/>(your self-hosted FX instance —<br/>opt-in, no URL = no FX calls)"]
    openrate -.->|"rates + provenance,<br/>cached locally"| core
```

Between machines there is no hub — every node is a self-hosted peer. The only things that ever cross the network are **signed packs** (taxonomies and rules, verified with ed25519 on install) and, for users who opt in, **differentially-private aggregates** — category-level statistics noised on-device before they leave it. Aggregators are community-run and untrusted by design; transactions, merchants, and credentials never appear on any edge:

```mermaid
flowchart TB
    a["Alice's node<br/>(desktop or self-host server)"]
    b["Ben's node"]
    c["Chris's node"]
    m["Pack maintainer<br/>(any node, signs releases)"]
    agg["Community aggregator<br/>(anyone can run one — untrusted)"]
    a <-->|"signed packs<br/>(git / p2p)"| b
    b <-->|"signed packs"| c
    a <-->|"signed packs"| c
    m -->|"signed classification &amp;<br/>benchmark packs"| a
    m --> b
    a -.->|"opt-in: DP-noised aggregates,<br/>anonymous transport"| agg
    c -.->|"opt-in"| agg
    agg -->|"aggregate statistics"| m
```

Reading benchmark packs is perfectly private — comparison happens locally. Contributing is off by default, anonymous, and lossy by design: [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Configuration

Settings live in SQLite, secrets live in the OS keychain, and there is no required config file — the full model, data locations, and every setting key are in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Documentation

| Document | What it covers |
|---|---|
| [GETTING-STARTED.md](docs/GETTING-STARTED.md) | Clone to first book: build, import, capture a slip, connect a mailbox, pick an LLM provider |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | The binding contract: layout, tech decisions, domain model, vault spec, non-negotiables |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | Settings model, data locations, environment |
| [API.md](docs/API.md) | One service surface, two transports — Tauri IPC and the `/api/v1` HTTP server |
| [EMAIL.md](docs/EMAIL.md) | Email ingestion: IMAP IDLE, Gmail, Microsoft Graph, Proton Bridge — your accounts, no middleman |
| [PAYMENTS.md](docs/PAYMENTS.md) | ShapePay: watch a payment reference, get a signed webhook when the EFT lands — setup, receiver verification, delivery and retry semantics |
| [BANK-ADAPTERS.md](docs/BANK-ADAPTERS.md) | The local, open-source bank-scraper framework and how to write an adapter |
| [PACKS.md](docs/PACKS.md) | Signed classification packs: format, signing, verification, distribution |
| [BENCHMARKS.md](docs/BENCHMARKS.md) | Nudges and anonymous peer benchmarks: local DP, cohorts, honest limits |
| [SELFHOST.md](docs/SELFHOST.md) | Running the core headless on a NAS / home server |
| [THREAT-MODEL.md](docs/THREAT-MODEL.md) | What protects your credentials, what an attacker gets, residual risks |
| [SCREENSHOTS.md](docs/SCREENSHOTS.md) | Annotated tour of every screen in the shipped app |
| [FAQ.md](docs/FAQ.md) | Straight answers to the questions everyone asks |

Also: [ROADMAP.md](ROADMAP.md) (phases, with honest partial-status notes; parity matrices are planned there but not yet written), [SECURITY.md](SECURITY.md) (vulnerability reporting), [CHANGELOG.md](CHANGELOG.md).

## Development

```sh
# Rust workspace
cargo build --workspace
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets

# Desktop app
cd apps/desktop
npm install
npm run check          # svelte-check
npm run tauri dev      # run against the real core
```

The workspace denies `unsafe_code`; money is `i64` minor units, never floats; secrets never appear in logs, `Debug` impls, or IPC responses. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing anything structural — it is the contract.

## Contributing

Contributions are welcome — bank adapters, mailbox providers, and classification packs especially. See [CONTRIBUTING.md](CONTRIBUTING.md), and [docs/BANK-ADAPTERS.md](docs/BANK-ADAPTERS.md#writing-an-adapter) for the adapter checklist.

## License

[MIT](LICENSE)
