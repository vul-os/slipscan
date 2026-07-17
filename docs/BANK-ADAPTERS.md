# Bank Adapters

Aggregators like Plaid, Yodlee, or the engine behind 22seven work by taking your internet-banking credentials onto **their** servers and scraping on your behalf. SlipScan inverts that: the scraper is open-source code that runs on **your** machine, in **your** session, with credentials that never leave your OS keychain. You can read every line of the adapter that touches your bank.

## The framework

`crates/slipscan-ingest` defines one small trait per concern. A bank adapter implements `BankScraper`:

```rust
#[async_trait]
pub trait BankScraper: Send + Sync {
    /// Stable bank id, e.g. "za-fnb".
    fn bank_id(&self) -> &str;

    /// Fetch transactions posted on/after `since` (YYYY-MM-DD),
    /// or all available when None.
    async fn fetch_transactions(
        &mut self,
        since: Option<&str>,
    ) -> Result<Vec<ScrapedTransaction>, IngestError>;
}
```

Adapters produce `ScrapedTransaction` values — provider transaction id, posted date, amount in minor units, currency, description, merchant. The core deduplicates by `(account, provider_txn_id | hash)`, so overlapping fetches are always safe.

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

You type bank credentials exactly once. After that they are unviewable — by you, by the UI, by an attacker with a copy of your disk. Replacing them (`vault.replace`) destroys the old ciphertext. On platforms with Touch ID / Windows Hello, unwrapping bank credentials requires **user presence**, so a scheduled sync will prompt you unless you opt into unattended mode on a self-host box. Full design: [THREAT-MODEL.md](THREAT-MODEL.md).

## Writing an adapter

1. **Pick the mechanism, in order of preference:**
   - Official API / open banking endpoint, if your bank has one.
   - The JSON endpoints behind the bank's own web app (log in with browser devtools open; most modern internet banking is a SPA over clean JSON).
   - HTML scraping as a last resort — brittle, but sometimes all there is.
   - OFX/CSV "export automation" is also valid: an adapter that drives the bank's statement-download endpoint beats no adapter.
2. **Implement `BankScraper`** in a new module. One file per bank where possible. Reqwest + serde should cover most banks; if you think you need a headless browser, raise it in the PR first.
3. **Normalise**: amounts to `i64` minor units (never floats — house rule), dates to `YYYY-MM-DD`, and keep the bank's own transaction id as `provider_txn_id` whenever it exposes one — it is the dedupe anchor.
4. **Handle MFA honestly.** If the bank sends an OTP or app approval, surface it as an interactive step. Never ask users to weaken their bank security to suit the adapter.
5. **Test against fixtures.** Record sanitised response fixtures (fake ids, fake amounts) and test parsing against them. CI never talks to a real bank.

## Auditing an adapter

Before you trust an adapter with your bank login, read it. The review bar, for authors and reviewers alike:

- [ ] Egress: every URL constructed in the adapter is the bank's own domain. Grep for `http` — the list should be short and obvious.
- [ ] Credentials: appear only inside the `use_with` closure; never stored on any struct field that outlives the session, never formatted into logs or errors.
- [ ] Dependencies: nothing beyond the workspace's blessed set (HTTP client, serde, parsing) without discussion.
- [ ] No obfuscation: no encoded blobs, no downloaded code, no "helper" binaries.
- [ ] Output: only `ScrapedTransaction` data — an adapter has no business reading other books, documents, or settings.

Small diffs, one bank per PR, fixtures included. An adapter nobody can review in twenty minutes is too big.

## Adapter roadmap — South Africa first

SlipScan's first target market has no Plaid. Planned adapters, tracked in [ROADMAP.md](../ROADMAP.md) Phase 3:

| Bank | id | Notes |
|---|---|---|
| FNB | `za-fnb` | Bank-alert emails already parseable via [email ingestion](EMAIL.md) today |
| Capitec | `za-capitec` | |
| Standard Bank | `za-standard` | |
| Nedbank | `za-nedbank` | |
| Absa | `za-absa` | |

Until your bank has an adapter, you are not stuck: CSV/OFX import and bank-alert email parsing cover the gap, and everything reconciles into the same accounts when the adapter lands.

Contributions for any bank, any country, are welcome — this is the single highest-leverage way to contribute to SlipScan. See [CONTRIBUTING.md](../CONTRIBUTING.md).

---

**Next:** [PACKS.md](PACKS.md) — signed classification packs: share the smarts, not the data.
