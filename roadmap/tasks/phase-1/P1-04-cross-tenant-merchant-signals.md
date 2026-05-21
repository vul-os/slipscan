---
id: P1-04
title: Cross-tenant learning — global merchant signals
phase: 1
status: todo
depends_on: [P1-03]
owner: unassigned
---

## Goal
Aggregate classification corrections **across all orgs** into platform-wide
merchant signals so a merchant any user has ever categorized improves the
out-of-the-box classification for everyone — without leaking any org's data. This
is the compounding moat: the product gets smarter the more total usage it sees.

## Context
`merchant_signals` is designed as the cross-tenant table; per-org corrections
come from P1-03. This task builds the privacy-safe rollup job and feeds the
global signal back into the P1-02 cascade's `merchant_signal` stage.

## Existing assets
- `merchant_signals` table; `classification_corrections` (per-org, from P1-03);
  `categories` taxonomy; `ai_models` (`normalization` kind) if embeddings used.
- `internal/classify` cascade.

## Scope
**In:** a periodic aggregation job that rolls up corrections → global
`merchant_signals` (normalized merchant → most-likely category + confidence,
weighted by distinct-org count, recency, agreement); wire the global signal into
the cascade as a low-precedence prior; privacy guardrails (only category labels +
normalized merchant strings aggregate, never amounts/PII/org identity); a
minimum-distinct-orgs threshold before a signal is trusted.
**Out:** training a bespoke ML model (heuristic rollup is enough for now; note it
as a future option); per-org rules (P1-03 owns those).

## Implementation
1. **Normalization:** reuse the shared merchant-normalizer from P1-02/P1-03.
2. **Aggregation job** (cron/leader-guarded like P0-04): group
   `classification_corrections` by normalized merchant; compute the dominant
   category with a confidence from agreement ratio × distinct-org count × recency
   decay; require ≥K distinct orgs before writing a global signal.
3. **Feedback:** the P1-02 cascade's `merchant_signal` stage consults global
   signals (below per-org rules, above the LLM). A strong global signal can also
   pre-fill the LLM prompt as a hint.
4. **Privacy:** assert in code + tests that only `{normalized_merchant,
   category, confidence, support_count}` leave an org boundary — no amounts, no
   contact data, no org id in the global row.

## Acceptance criteria
- [ ] After K+ distinct orgs correct the same merchant to the same category, a
      global `merchant_signals` row appears with a confidence reflecting support.
- [ ] A brand-new org ingesting that merchant gets the correct category at the
      `merchant_signal` stage with no prior correction of its own.
- [ ] Signals below the distinct-org threshold are not applied.
- [ ] A test proves no amount/PII/org-identity field is written to the global table.
- [ ] The job is idempotent and runs on a single fleet member.

## Tests
- Unit: confidence/weighting math; threshold gating; privacy field-set assertion.
- Integration: simulate K orgs' corrections → global signal → new-org auto-classify.

## Notes
This is what makes scale a moat: incumbents using static categorizers can't match
a system that learns from every correction across the base. Keep the rollup
explainable (store support_count) so we can debug and show "why this category".
