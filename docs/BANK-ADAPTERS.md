# Bank Adapters

Aggregators like Plaid, Yodlee, or the engine behind 22seven work by taking your internet-banking credentials onto **their** servers and scraping on your behalf. SlipScan inverts that: the scraper is open-source code that runs on **your** machine, in **your** session, with credentials that never leave your OS keychain. You can read every line of the adapter that touches your bank.

The framework is bank-agnostic and country-agnostic by design ([regions are data, not code](ARCHITECTURE.md#global-by-default--regions-are-data-not-code)): an adapter for any bank in any country plugs into the same trait, the same vault handoff, and the same dedupe pipeline. What differs per country is **data** — statement CSV column presets and, eventually, live adapters.

## The framework

> **Status:** the framework below is implemented in `crates/slipscan-ingest`, and the only adapter that exists today is a **file-based CSV statement adapter** with three tiers of coverage (see [Statement presets](#statement-csv-presets--region-data-not-code)): ready-made presets for the big South African banks (FNB, Standard Bank, Capitec, Nedbank, Absa — SA is the first region with presets), a `generic` preset family for common worldwide CSV layouts, and a fully custom column mapping for any other bank on day one. No live scraper adapter ships yet — Phase 3 in [ROADMAP.md](../ROADMAP.md).

`crates/slipscan-ingest` defines one small trait per concern. A bank adapter implements `BankAdapter` (`crates/slipscan-ingest/src/bank/mod.rs`):

```rust
#[async_trait(?Send)]
pub trait BankAdapter {
    /// Stable bank id, e.g. `"za-fnb"`.
    fn bank_id(&self) -> &str;

    /// Fetch lines posted within `range` (inclusive `YYYY-MM-DD` bounds).
    async fn fetch_lines(&mut self, range: &DateRange) -> IngestResult<Vec<StatementLine>>;
}
```

Adapters produce `StatementLine` values — posted date, description, amount in **minor units** (never floats; money out negative), optional running balance, the bank's own transaction id when it exposes one, and an optional currency (defaulting to the account's). The pipeline deduplicates by `(account, provider_txn_id | content hash)`, so overlapping fetches are always safe.

What an adapter is **not** allowed to do:

- Load credentials itself. Credentials come from the [vault](THREAT-MODEL.md) via `vault.use_with(name, |secret| ...)` — the adapter receives the secret inside a closure, uses it to authenticate, and it is zeroized on drop. No adapter code path can persist, log, or return it.
- Talk to anything except the bank. An adapter's only permitted egress is the bank's own endpoints (mantra #2).
- Depend on heavyweight or opaque libraries. Adapters must stay small and readable — that is the audit story.

## The credential vault handoff

```
you (once)          vault.set("za-fnb-main", credentials)   → OS keychain, write-only
sync (every time)   vault.use_with("za-fnb-main", |cred| adapter.login(cred))
audit log           "vault use: za-fnb-main by za-fnb @ 2026-07-17T06:00Z"
```

You type bank credentials exactly once. After that they are unviewable — by you, by the UI, by an attacker with a copy of your disk. Replacing them (`vault.replace`) destroys the old ciphertext. A per-use **user-presence** prompt (Touch ID / Windows Hello) for bank credentials is a design goal that is **not implemented yet** — today, use is gated by the OS session being unlocked, nothing more. Full design and honest status: [THREAT-MODEL.md](THREAT-MODEL.md).

## Writing an adapter

1. **Pick the mechanism, in order of preference:**
   - Official API / open banking endpoint, if your bank has one.
   - The JSON endpoints behind the bank's own web app (log in with browser devtools open; most modern internet banking is a SPA over clean JSON).
   - HTML scraping as a last resort — brittle, but sometimes all there is.
   - OFX/CSV "export automation" is also valid: an adapter that drives the bank's statement-download endpoint beats no adapter.
2. **Implement `BankAdapter`** in a new module. One file per bank where possible. Reqwest + serde should cover most banks; if you think you need a headless browser, raise it in the PR first.
3. **Normalise**: amounts to `i64` minor units (never floats — house rule), dates to `YYYY-MM-DD`, and keep the bank's own transaction id as `provider_txn_id` whenever it exposes one — it is the dedupe anchor.
4. **Handle MFA honestly.** If the bank sends an OTP or app approval, surface it as an interactive step. Never ask users to weaken their bank security to suit the adapter.
5. **Test against fixtures.** Record sanitised response fixtures (fake ids, fake amounts) and test parsing against them. CI never talks to a real bank.

## Auditing an adapter

Before you trust an adapter with your bank login, read it. The review bar, for authors and reviewers alike:

- [ ] Egress: every URL constructed in the adapter is the bank's own domain. Grep for `http` — the list should be short and obvious.
- [ ] Credentials: appear only inside the `use_with` closure; never stored on any struct field that outlives the session, never formatted into logs or errors.
- [ ] Dependencies: nothing beyond the workspace's blessed set (HTTP client, serde, parsing) without discussion.
- [ ] No obfuscation: no encoded blobs, no downloaded code, no "helper" binaries.
- [ ] Output: only `StatementLine` data — an adapter has no business reading other books, documents, or settings.

Small diffs, one bank per PR, fixtures included. An adapter nobody can review in twenty minutes is too big.

## Statement CSV presets — region data, not code

Until your bank has a live adapter, downloaded statement CSVs are the way in — and the mappings that parse them are **region-profile data**: a catalog of named, region-tagged column mappings (`crates/slipscan-ingest/src/bank/presets.rs`), listed grouped by region. Adding a country's banks means adding rows to the catalog, never touching core. Three tiers cover every bank in the world:

1. **Region presets** — ready-made mappings for specific banks' exports. South Africa, the first region profile, ships five: `za-fnb`, `za-standard`, `za-capitec`, `za-nedbank`, `za-absa`.
2. **The `generic` family** — common single-format layouts (date/description/signed-amount and date/description/debit/credit) in the widespread conventions: ISO and DMY dates, US MM/DD/YYYY, EU dotted dates with decimal comma and `;` delimiters.
3. **Custom mapping** — a declarative spec (`CustomMappingSpec`: column indices, date format, decimal style, delimiter, debit/credit or signed amounts) that handles any other bank, in any country, on day one. Amount parsing is float-free and knows both `1,234.56` and `1.234,56`.

The statement→transactions wiring into CLI/desktop is still in progress — see [GETTING-STARTED.md](GETTING-STARTED.md#2-import-a-bank-statement-csv) for what works today.

## Adapter roadmap

Live scraper adapters are tracked in [ROADMAP.md](../ROADMAP.md) Phase 3. South Africa — a market with no Plaid — is the first planned set:

| Bank | id | Notes |
|---|---|---|
| FNB | `za-fnb` | CSV statement column preset ships today |
| Capitec | `za-capitec` | CSV statement column preset ships today |
| Standard Bank | `za-standard` | CSV statement column preset ships today |
| Nedbank | `za-nedbank` | CSV statement column preset ships today |
| Absa | `za-absa` | CSV statement column preset ships today |

Bank-alert email parsing is planned but not implemented ([EMAIL.md](EMAIL.md#what-gets-ingested)). Everything reconciles into the same accounts when the adapter lands.

Contributions for any bank, any country, are welcome — this is the single highest-leverage way to contribute to SlipScan; the trait, the vault handoff, and the review bar are identical whether the bank is in Johannesburg, London, or Tokyo. See [CONTRIBUTING.md](../CONTRIBUTING.md).

---

**Next:** [PACKS.md](PACKS.md) — signed classification packs: share the smarts, not the data.
