package classification_test

import (
	"fmt"
	"os"
	"testing"

	"github.com/exolutionza/slipscan/backend/internal/merchant"
	"github.com/exolutionza/slipscan/backend/internal/testsuite/classification"
)

// TestClassificationAccuracy is the main harness entrypoint.
//
// On the base branch (before P1-02 lands) this test is skipped — the corpus
// loads and Normalize property tests run, but the cascade is not wired up.
//
// After P1-02 integrates:
//  1. Remove the t.Skip call.
//  2. Replace StubClassifier{} with the real cascade classifier, e.g.:
//
//	cl := classify.NewCascade(db, orgID)
//	classification.RunHarness(t, cl)
//
// After P1-03 / P1-04 integrate, set CLASSIFICATION_HARNESS_FULL=1 to enable
// the learning-loop sub-tests that exercise correction→rule promotion and
// cross-tenant signal lookup.
func TestClassificationAccuracy(t *testing.T) {
	t.Skip("pending P1-02 integration: replace StubClassifier with classify.NewCascade")

	corpus, err := classification.LoadCorpus()
	if err != nil {
		t.Fatalf("LoadCorpus: %v", err)
	}

	cl := classification.StubClassifier{}
	RunHarnessWithClassifier(t, corpus, cl)
}

// TestCascadePrecedenceUnit verifies that when the cascade is available,
// it honours rule > merchant_signal > llm ordering.
//
// This test is also skipped until P1-02 is integrated.
func TestCascadePrecedenceUnit(t *testing.T) {
	t.Skip("pending P1-02 integration: implement CascadeClassifier and remove this skip")

	// After P1-02 lands, this test should:
	//
	// 1. Create an in-memory or test-DB org with:
	//    - A classification_rules row matching "woolworths" → Groceries
	//    - A merchant_signals row for "checkers" → Groceries (vote_count=5)
	//    - No rules matching "nandos"
	//
	// 2. Run Classify on:
	//    - A woolworths extraction → expect source="rule"
	//    - A checkers extraction  → expect source="merchant_signal"
	//    - A nandos extraction    → expect source="llm"
	//
	// 3. Assert that source values are strictly ordered.
	t.Log("cascade precedence test placeholder — implement after P1-02")
}

// TestMerchantSignalPrivacyInvariant verifies that the merchant_signals table
// (aggregated by P1-04) never leaks org IDs, user IDs, or transaction amounts.
//
// This test is skipped until P1-04 is integrated.
func TestMerchantSignalPrivacyInvariant(t *testing.T) {
	t.Skip("pending P1-04 integration: verify merchant_signals privacy constraints")

	// After P1-04 lands, this test should query the merchant_signals table
	// and assert that every row contains ONLY:
	//   merchant_normalized TEXT
	//   category_label      TEXT
	//   vote_count          INTEGER
	//   last_seen_at        TIMESTAMPTZ
	//   updated_at          TIMESTAMPTZ
	// — and that no org_id, user_id, amount, or description columns exist.
	t.Log("privacy invariant test placeholder — implement after P1-04")
}

// TestCorrectionPromotion verifies that after ≥ 2 identical corrections for
// the same merchant_normalized → category, a classification_rules row is
// upserted (P1-03 acceptance criterion).
//
// This test is skipped until P1-03 is integrated.
func TestCorrectionPromotion(t *testing.T) {
	t.Skip("pending P1-03 integration: verify rule promotion from corrections")

	// After P1-03 lands, this test should:
	//
	// 1. Create a transaction classified as "Groceries" for merchant "checkers".
	// 2. Record 1 correction: checkers → "Food & Drink". Assert NO rule yet.
	// 3. Record 2nd correction: checkers → "Food & Drink".
	//    Assert a classification_rules row now exists for merchant_normalized
	//    "checkers" with match_type="merchant_contains", source="user".
	t.Log("correction promotion test placeholder — implement after P1-03")
}

// RunHarnessWithClassifier runs the full accuracy scoring loop and prints a
// report.  It fails the test if overall accuracy falls below the threshold
// set by the CLASSIFICATION_MIN_ACCURACY env var (default 0.70 / 70%).
//
// This function is exported so integration test suites in other packages
// (e.g. internal/classify) can import and drive it with a real classifier.
func RunHarnessWithClassifier(t *testing.T, corpus []classification.FixtureCase, cl classification.Classifier) {
	t.Helper()

	predictions := make([]classification.Prediction, 0, len(corpus))
	for _, fc := range corpus {
		label, source, confidence := cl.Classify(fc.Extraction)
		predictions = append(predictions, classification.Prediction{
			FixtureID:  fc.Extraction.ID,
			Merchant:   fc.Extraction.Merchant,
			Expected:   fc.Extraction.ExpectedCategory,
			Predicted:  label,
			Source:     source,
			Confidence: confidence,
		})
	}

	res := classification.Score(predictions, merchant.Normalize)
	classification.PrintReport(os.Stdout, res)

	// Configurable accuracy threshold.
	threshold := 0.70
	if env := os.Getenv("CLASSIFICATION_MIN_ACCURACY"); env != "" {
		var thr float64
		if _, err := parseFloat(env, &thr); err == nil && thr >= 0 && thr <= 1 {
			threshold = thr
		}
	}

	if res.Total == 0 {
		t.Fatal("no predictions produced — classifier returned nothing")
	}
	if res.Accuracy < threshold {
		t.Errorf("accuracy %.1f%% is below minimum threshold %.1f%% (%d/%d correct)",
			res.Accuracy*100, threshold*100, res.Correct, res.Total)
	} else {
		t.Logf("accuracy %.1f%% meets threshold %.1f%%", res.Accuracy*100, threshold*100)
	}
}

// parseFloat is a minimal strconv.ParseFloat wrapper that avoids an extra import.
func parseFloat(s string, f *float64) (int, error) {
	n, err := fmt.Sscanf(s, "%f", f)
	return n, err
}
