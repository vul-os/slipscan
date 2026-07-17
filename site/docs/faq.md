# FAQ

Straight answers to the questions everyone asks.

## Why decentralized? Isn't a cloud service easier?

Easier for the vendor. A finance aggregator is a honeypot: one service holding bank credentials and transaction history for millions of people. Every one of them says "bank-grade security"; every one of them is one breach, acquisition, or shutdown away from being your problem — 22seven's shutdown-and-migration into Vault22 is exactly the kind of event you don't want your financial history subject to. SlipScan removes the honeypot: your data on your machine, your credentials in your OS keychain, community knowledge shared as [signed rule packs](PACKS.md) instead of pooled data.

## How does this compare to 22seven / Vault22? To Xero?

Same feature targets, inverted architecture. Vault22/22seven-class personal finance (accounts, categorisation, budgets, nudges, peer comparison) and Xero-class small-business accounting (double-entry ledger, VAT, reconciliation) — with no server-side aggregation, no credential custody, and no subscription. Peer comparison, their most "requires-a-cloud" feature, is *designed* to work here through [anonymous, differentially-private benchmark packs](BENCHMARKS.md) — the comparison math exists in the packs crate, but no UI surfaces it yet and contribution is not implemented. Feature-by-feature parity matrices are planned for [ROADMAP.md](../ROADMAP.md) (Phase 4.5 — they do not exist yet); gaps are issues, not surprises.

## Where exactly is my data?

One SQLite database file (holding your books) plus a documents folder, at a visible path on your disk ([CONFIGURATION.md](CONFIGURATION.md#data-locations)). Open it with any SQLite tool. Back it up by copying it. Leave SlipScan by taking it. There is no other copy anywhere, because there is nowhere else.

## What phones home?

Nothing. No telemetry, no analytics, no update pings, no crash reports, no default network calls of any kind — the app is fully functional offline. Network egress happens only to endpoints **you** configured: your mail server, your bank, your LLM provider. That's non-negotiable #1 and #2 in [ARCHITECTURE.md](ARCHITECTURE.md#non-negotiables-the-mantra), and it's verifiable — the code is open, grep it.

## Can I use my Proton Mail account?

Yes, via the official [Proton Bridge](https://proton.me/mail/bridge): it decrypts locally and exposes IMAP on `127.0.0.1`, and SlipScan connects to it like any IMAP server (today via `slipscan mail-sync` polling; IDLE push once a push loop ships). Requires a paid Proton plan (Bridge is a Proton requirement). Setup: [EMAIL.md](EMAIL.md#proton-mail).

## Can I trust the bank adapters with my banking login?

Don't trust — read. (Note: no live scraper adapter ships yet — today the only adapter is CSV statement parsing; this answer describes the framework's rules for when they do.) Every adapter is open-source, deliberately small, and dependency-light; the review checklist ([BANK-ADAPTERS.md](BANK-ADAPTERS.md#auditing-an-adapter)) demands that its every URL is your bank's own domain and that credentials only ever appear inside a vault closure. Credentials live in your OS keychain, are write-only (no code path can display them), and every use is audit-logged. Compare that with any aggregator, where the scraper runs on servers you cannot inspect, with credentials they custody.

## Do I need an LLM? Does that mean my receipts go to an AI company?

Extraction needs a model; where it runs is your call. Fully local via Ollama or your own [llmux](https://github.com/vul-os) gateway means receipts never leave your machine. BYO API key means receipt images go to that one provider, under your key and their terms — your explicit configuration, never a SlipScan-hosted endpoint. [GETTING-STARTED.md](GETTING-STARTED.md#5-set-an-llm-provider).

## What's the relationship with VulOS?

SlipScan is a **standalone product in the VulOS family** — same principles (open source, self-hosted, no central server), zero coupling. It never imports other Vulos products and none of them are required. It *connects* to siblings across clean seams when **you** choose to: a [lilmail](https://github.com/vul-os) mailbox is just an IMAP mailbox, [Vulos Relay](https://vulos.org) is one optional way to make a self-host box reachable, llmux is one LLM provider option. "No coupling to VulOS" is a stated non-goal in [ROADMAP.md](../ROADMAP.md#non-goals).

## Is there a mobile app? Sync between devices?

Coming, in that order roadmap-wise: self-host server mode makes your devices clients of one always-on box ([SELFHOST.md](SELFHOST.md)), device-to-device E2E sync and a Tauri mobile companion follow (Phases 4–5). Today: desktop app, plus CLI and headless server.

## What happened to the old SlipScan?

The previous implementation (React + Cloudflare Workers) was a cloud stack — the wrong architecture for this product. It has been removed and lives in git history; the rewrite is Rust core + Tauri desktop ([CHANGELOG.md](../CHANGELOG.md)). Cloud concepts — orgs, billing, hosted auth — are not coming back.

## How do I report a security issue?

Privately, please — see [SECURITY.md](../SECURITY.md). The threat model worth attacking first is documented in [THREAT-MODEL.md](THREAT-MODEL.md).

---

**Next:** back to [GETTING-STARTED.md](GETTING-STARTED.md) — or the [ROADMAP](../ROADMAP.md) to see what lands next.
