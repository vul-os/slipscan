---
id: T1-classification-accuracy-harness
title: Classification accuracy + learning-loop evaluation harness
phase: 1
status: review
owner: sonnet-agent
depends_on: []
unblocks: [P1-02, P1-03, P1-04]
---

## Goal

Provide a test infrastructure and labelled fixture corpus that lets any agent
(and CI) measure classification accuracy against the Phase 1 contract — both
today (base branch) and once P1-02/03/04 integrate.

## What was built

### Package: `backend/internal/testsuite/classification`

| File | Purpose |
|---|---|
| `corpus.go` | Loads the embedded fixture corpus; defines `Extraction`, `FixtureCase`, `LoadCorpus()`, `NormalizeGroups()` |
| `classifier.go` | `Classifier` interface (what P1-02 must satisfy); `StubClassifier` no-op for base-branch compilation |
| `scorer.go` | `Score()` + `PrintReport()` — pure-Go, no network/DB; per-merchant + per-source accuracy breakdown |
| `corpus_test.go` | Property tests on `merchant.Normalize` driven by the corpus |
| `scorer_test.go` | Unit tests for the scoring/reporting logic |
| `harness_test.go` | Entrypoint `TestClassificationAccuracy`; pending-integration tests for P1-02/03/04 |
| `fixtures/*.json` | 31 labelled South-African extraction fixtures (see below) |

### Fixture corpus (`fixtures/`)

31 synthetic slip/invoice/bank-statement JSON files in the `§2 extraction shape`.
Each has corpus-only annotations (`_expected_category`, `_merchant_normalized_expected`,
optional `_normalize_group`).

Categories covered:

| Category | Merchants (examples) |
|---|---|
| Groceries | Woolworths (3 variants), Pick n Pay, Checkers |
| Fuel/Transport | Engen (2 variants), BP Express |
| Telecoms | Vodacom (2 variants), MTN, Telkom |
| Restaurants/Fast Food | McDonald's, Nando's, KFC |
| Food Delivery | Uber Eats |
| Transport/Rideshare | Uber Trip |
| Entertainment/Subscriptions | Netflix, Showmax |
| Health/Pharmacy | Dis-Chem, Clicks |
| Clothing/Apparel | Edgars, Mr Price, Woolworths Fashion (2 variants) |
| Utilities | Eskom, City of Johannesburg |
| Medical/Healthcare | Life Healthcare |
| Automotive | AutoZone |
| Travel | Intercape |
| Banking/Finance | Capitec (bank statement with 6 statement lines) |

Normalize groups (5 groups, 2–3 members each):

| Group | Members | Property proven |
|---|---|---|
| `engen_randburg` | engen_005, engen_variant_006 | common prefix "engen" |
| `vodacom` | vodacom_008, vodacom_variant_009 | common prefix "vodacom" |
| `woolworths_core` | woolworths_jhb_001, woolworths_cape_town_002, woolworths_no_location_030 | common prefix "woolworths" |
| `woolworths_fashion` | woolworths_fashion_023, woolworths_kids_031 | common prefix "woolworths" (DISTINCT category from core) |
| `uber` | uber_013, uber_eats_014 | common prefix "uber" (different categories — test proves rules need full key) |

## How to run

```sh
# All tests pass today (base branch):
cd backend && go test ./internal/testsuite/classification/... -v

# Full backend build + vet still clean:
cd backend && go build ./... && go vet ./...

# Run with custom accuracy threshold (after P1-02 integrates):
CLASSIFICATION_MIN_ACCURACY=0.85 go test ./internal/testsuite/classification/... -v -run TestClassificationAccuracy
```

## What "lights up" after each phase task integrates

### After P1-02 (cascade engine)

1. In `harness_test.go`, remove the `t.Skip` in `TestClassificationAccuracy`.
2. Replace `StubClassifier{}` with:
   ```go
   cl := classify.NewCascade(db, orgID)
   ```
3. `TestClassificationAccuracy` now runs the full 31-fixture corpus through the
   live cascade and fails if accuracy drops below the threshold (default 70%).
4. Remove the `t.Skip` in `TestCascadePrecedenceUnit` and implement the
   rule/signal/llm source-ordering assertions described in the skip comment.

### After P1-03 (corrections + rule promotion)

1. Remove the `t.Skip` in `TestCorrectionPromotion`.
2. Implement the 2-correction → rule-upsert assertions described in the skip comment.

### After P1-04 (cross-tenant signals)

1. Remove the `t.Skip` in `TestMerchantSignalPrivacyInvariant`.
2. Query the `merchant_signals` table and assert no PII columns exist.

## Tests active today (base branch)

All pass, none need a DB or network:

| Test | What it checks |
|---|---|
| `TestCorpusLoads` | All 31 JSON fixtures parse; IDs unique; required fields present |
| `TestNormalizeMatchesExpected` | `merchant.Normalize(raw)` matches the `_merchant_normalized_expected` annotation for every fixture |
| `TestNormalizeGroupVariants` | All variant-pairs in each normalize group share a common non-empty prefix (learning-loop portability) |
| `TestNormalizeGroupNoFalseMerge` | Logs any normalized key that maps to two different categories (alerts on potential rule ambiguity) |
| `TestNormalizeDeterministic` | Normalize is deterministic (no randomness) |
| `TestNormalizeNonEmpty` | No real-merchant fixture produces an empty normalized key |
| `TestScore*` (8 tests) | Unit tests for `Score()` and `PrintReport()` |

## Notes

- The `Classifier` interface lives in this package, not in `internal/classify`,
  to keep the harness independent of the unbuilt implementation.  P1-02 should
  implement it in its own package and the harness test imports it.
- `merchant.Normalize` is called by both the corpus annotation validator and
  the scorer's per-merchant breakdown — the normalizer is the single canonical
  key, consistent with the contract §1.
- The `woolworths_fashion` vs `woolworths_core` fixture pair is intentional:
  it demonstrates that the cascade must use the longer, more-specific
  normalized key (e.g. "woolworths fashion") when promoting rules, not just
  "woolworths", to avoid Groceries ↔ Clothing cross-contamination.
- The `uber` group intentionally has two members mapping to different categories
  ("uber trip" → Transport/Rideshare, "uber eats" → Food Delivery).
  `TestNormalizeGroupVariants` verifies the common prefix exists ("uber") while
  `TestNormalizeGroupNoFalseMerge` logs the ambiguity — highlighting that rules
  must be keyed on the full "uber trip" / "uber eats" key, not just "uber".
- No migrations needed: this package is pure test infrastructure.
- `go build ./... && go vet ./...` is clean on the base branch with all pending
  tests using `t.Skip`.
