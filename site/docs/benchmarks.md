# Nudges & Anonymous Peer Benchmarks

The target is the full Vault22/22seven experience — nudges, insights, "how do I compare to households like mine" — without anyone, anywhere, learning who you are. This page explains how, and is precise about what the privacy model does and does not guarantee.

## Nudges: 100% local

The nudge engine is rules + statistics over **your own data**, evaluated on your machine. No cohort data, no model service, no network at all:

- **Budget drift** — trending 40% over your groceries budget with 10 days left.
- **Category spikes** — this month's transport is 2.3× your trailing average.
- **Recurring subscriptions** — detected recurring charges, including ones that just raised their price.
- **Duplicate charges** — same merchant, same amount, same day.
- **Bank-fee creep** — fees rising over time.
- **VAT deadlines** — for business books, upcoming return dates.
- **Unreviewed slips** — extraction done, review pending.

Nudges surface in-app, optionally as OS notifications (generated locally — an OS notification is not a network call). Nothing about a nudge leaves the machine. There is nothing to opt out of because nothing is collected.

## Peer comparison: reading is perfectly private

Peer comparison uses **benchmark packs** — signed packs (same machinery as [classification packs](PACKS.md)) containing aggregate statistics only:

```
"median monthly groceries spend, ZA, household of 2, income band C: R 4,850"
```

You download a pack; SlipScan computes "you vs households like yours" locally. Downloading a public file reveals nothing about your finances — **reading is perfectly private**, full stop. If you never contribute, you still get the comparison feature, at zero privacy cost.

## Contributing: opt-in, anonymous, lossy by design

Benchmark packs need contributors. The contribution pipeline is designed so that even a **malicious aggregator** learns nothing about an individual:

1. **Aggregates only.** A contribution is category-level totals for a period. Never transactions, never merchants, never free text. The fine-grained data physically is not in the payload.
2. **Local differential privacy.** Calibrated random noise is added to each value **on your device, before anything leaves it**. What is transmitted is already noised — no server-side promise involved. Any single value from any single person is deniable: the DP guarantee bounds (by the privacy parameter ε) how much *anyone* downstream can learn about your true numbers, no matter what they do with the data.
3. **Coarse k-anonymous cohorts.** Your cohort label is deliberately blunt: region, rough income band, household size. Buckets are chosen so every cohort clears a k-anonymity floor — you are always one of many. Submissions carry **no identifiers**: no account, no key, and no stable pseudonym that would let two submissions be linked to the same person over time.
4. **Anonymous transport.** Submissions go over relay/onion-style routing with randomized timing, so the aggregator does not see your IP next to your data, and traffic analysis can't correlate submission times to you.
5. **Community-run aggregation.** Aggregators can be anyone — the design assumes they might be hostile. They compute medians/percentiles over noisy submissions and publish signed benchmark packs. The trust is in the math on your device, not in the operator.
6. **Off by default.** Contribution is opt-in. Turning it on shows you the exact payload — every number, post-noise — in plain language before the first submission and on request thereafter.

```
your book ──▶ category aggregates ──▶ + DP noise (on-device) ──▶ coarse cohort label
                                                                      │
                                              anonymous transport (relay, jittered)
                                                                      ▼
                                                  community aggregator (untrusted)
                                                                      ▼
                                                signed benchmark pack ──▶ everyone
```

## Honest limits

Privacy engineering without stated residual risks is marketing. The residuals:

- **DP is a budget, not a cloak.** Each contribution spends privacy budget (ε). SlipScan bounds contribution frequency accordingly, but contributing forever leaks more than contributing once. The tracked budget is visible in settings.
- **Cohort labels are coarse but real.** "ZA, household 2, band C" is information. The k-anonymity floor means it never narrows to few people; it is still more than the zero disclosure of not contributing.
- **Malicious *packs* are handled by signing;** a malicious *aggregator* can publish wrong statistics (bad medians), just not deanonymize contributors. Cross-checking multiple community aggregators is the mitigation.
- **The strongest guarantee remains the default:** contribution off, comparison via public packs, zero disclosure.

Threat-model context: [THREAT-MODEL.md](THREAT-MODEL.md). Feature-parity tracking vs Vault22/22seven and Xero: [ROADMAP.md](../ROADMAP.md).

---

**Next:** [SELFHOST.md](SELFHOST.md) — run SlipScan headless on your own home server or NAS.
