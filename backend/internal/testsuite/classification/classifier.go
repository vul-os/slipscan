package classification

// Classifier is the interface that the Phase 1 cascade (P1-02) must satisfy
// to plug into the corpus harness.  It takes an [Extraction] and returns the
// winning category label, the cascade source stage that produced it, and a
// confidence score.
//
// Contract (mirrors PHASE1-CONTRACT.md §2):
//   - Cascade precedence (highest first): user > rule > merchant_signal > llm.
//   - source must be one of: "user", "rule", "merchant_signal", "llm".
//   - label must be a category name that exists in the org's categories table
//     (no invented labels).
//   - confidence ∈ [0,1]; 1.0 for user/rule; as-reported for llm.
//   - When no stage matches, return ("", "llm", 0) and the LLM fallback
//     should still return a constrained category.
//
// P1-02 implementation lives in internal/classify (file-ownership §4).
// This interface lives here so the harness can compile and skip gracefully
// before that package exists.
type Classifier interface {
	// Classify returns (categoryLabel, source, confidence).
	Classify(ex Extraction) (label, source string, confidence float64)
}

// StubClassifier is a no-op implementation that always returns the same
// stub label.  It is used by harness tests that are pending P1-02
// integration so the package compiles and the test skips cleanly.
type StubClassifier struct {
	// Label is the fixed label returned for every extraction.
	// Defaults to "Uncategorised" if empty.
	Label string
}

// Classify implements [Classifier] returning a fixed stub label.
func (s StubClassifier) Classify(_ Extraction) (label, source string, confidence float64) {
	l := s.Label
	if l == "" {
		l = "Uncategorised"
	}
	return l, "unknown", 0
}
