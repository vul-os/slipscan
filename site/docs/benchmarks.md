# Nudges & Anonymous Peer Benchmarks

The target is the full Vault22/22seven experience — nudges, insights, "how do I compare to households like mine" — without anyone, anywhere, learning who you are. This page explains how, and is precise both about the privacy model **and about what is actually built today**. Status per feature is marked; the unbuilt parts are design, tracked in [ROADMAP.md](../ROADMAP.md) (Phase 4.5).

## Nudges: 100% local

The nudge engine is rules + statistics over **your own data**, evaluated on your machine. No cohort data, no model service, no network at all.

Shipped today (computed on-device by the desktop app, shown on the Dashboard):

- **Budget drift** — over budget, or trending well ahead of the month's pace.
- **Duplicate charges** — same merchant, same amount, days apart.
- **Recurring subscriptions** — steady same-amount monthly charges, surfaced for review.

Designed, not yet built: category spikes vs trailing average, subscription price-raise detection, bank-fee creep, VAT-deadline reminders for business books, unreviewed-slip reminders, and optional OS notifications (which would be generated locally — an OS notification is not a network call). Nudges currently surface in-app only.

Nothing about a nudge leaves the machine. There is nothing to opt out of because nothing is collected.

## Peer comparison: reading is perfectly private

Peer comparison uses **benchmark packs** — signed packs (same machinery as [classification packs](PACKS.md)) containing aggregate statistics only:

```
"median monthly groceries spend, ZA, household of 2, income band C: R 4,850"
```

The comparison math (percentile placement against a pack's aggregates) is implemented in the `slipscan-packs` crate, but **no app surface calls it yet** — there is currently no CLI command or screen that shows "you vs households like yours". When it lands, the model is: you download a public pack, and the comparison is computed locally. Downloading a public file reveals nothing about your finances — **reading is perfectly private**, full stop. If you never contribute, you still get the comparison feature, at zero privacy cost.

## Contributing: opt-in, anonymous, lossy by design — **not implemented**

Nothing in SlipScan today can transmit benchmark contributions — there is no contribution code, no noise generation, no transport, and no settings surface for it. The pipeline below is the **design** the eventual implementation must satisfy; it is written down now so the privacy bar cannot quietly slip later.

Benchmark packs need contributors. The contribution pipeline is designed so that even a **malicious aggregator** learns nothing about an individual:

1. **Aggregates only.** A contribution is category-level totals for a period. Never transactions, never merchants, never free text. The fine-grained data physically is not in the payload.
2. **Local differential privacy.** Calibrated random noise would be added to each value **on your device, before anything leaves it**. What is transmitted is already noised — no server-side promise involved. Any single value from any single person is deniable: the DP guarantee bounds (by the privacy parameter ε) how much *anyone* downstream can learn about your true numbers, no matter what they do with the data.
3. **Coarse k-anonymous cohorts.** Your cohort label is deliberately blunt: region, rough income band, household size. Buckets are chosen so every cohort clears a k-anonymity floor — you are always one of many. Submissions carry **no identifiers**: no account, no key, and no stable pseudonym that would let two submissions be linked to the same person over time.
4. **Anonymous transport.** Submissions would go over relay/onion-style routing with randomized timing, so the aggregator does not see your IP next to your data, and traffic analysis can't correlate submission times to you.
5. **Community-run aggregation.** Aggregators can be anyone — the design assumes they might be hostile. They compute medians/percentiles over noisy submissions and publish signed benchmark packs. The trust is in the math on your device, not in the operator.
6. **Off by default.** Contribution will be opt-in. Turning it on must show you the exact payload — every number, post-noise — in plain language before the first submission and on request thereafter.

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

Privacy engineering without stated residual risks is marketing. The residuals (of the *design* — remember, contribution does not exist yet):

- **DP is a budget, not a cloak.** Each contribution spends privacy budget (ε). The implementation must bound contribution frequency accordingly, but contributing forever leaks more than contributing once. The tracked budget must be visible in settings.
- **Cohort labels are coarse but real.** "ZA, household 2, band C" is information. The k-anonymity floor means it never narrows to few people; it is still more than the zero disclosure of not contributing.
- **Malicious *packs* are handled by signing;** a malicious *aggregator* can publish wrong statistics (bad medians), just not deanonymize contributors. Cross-checking multiple community aggregators is the mitigation.
- **The strongest guarantee remains the default:** contribution off, comparison via public packs, zero disclosure. Today that guarantee is trivially met, because no contribution path exists at all.

Threat-model context: [THREAT-MODEL.md](THREAT-MODEL.md). Roadmap status for everything on this page: [ROADMAP.md](../ROADMAP.md).

---

**Next:** [SELFHOST.md](SELFHOST.md) — run SlipScan headless on your own home server or NAS.
