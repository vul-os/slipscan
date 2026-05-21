package classification

import (
	"fmt"
	"io"
	"sort"
	"strings"
)

// Prediction is a single classifier output paired with its expected label.
type Prediction struct {
	// FixtureID is the corpus fixture "id" field (for traceability).
	FixtureID string
	// Merchant is the raw merchant string from the extraction.
	Merchant string
	// Expected is the ground-truth category label from the corpus annotation.
	Expected string
	// Predicted is the category label returned by the classifier.
	Predicted string
	// Source is the classification cascade stage that produced the prediction
	// (one of: "user", "rule", "merchant_signal", "llm", "unknown").
	// Leave empty / "unknown" for stub predictions.
	Source string
	// Confidence ∈ [0,1] reported by the classifier; 0 means not provided.
	Confidence float64
}

// correct reports whether the prediction matches the expectation
// (case-insensitive, trimmed).
func (p Prediction) correct() bool {
	return strings.EqualFold(
		strings.TrimSpace(p.Expected),
		strings.TrimSpace(p.Predicted),
	)
}

// ScoreResult holds aggregate and per-merchant metrics computed by [Score].
type ScoreResult struct {
	// Total is the number of predictions evaluated.
	Total int
	// Correct is the number of predictions that matched the expected label.
	Correct int
	// Accuracy is Correct/Total ∈ [0,1] (0 when Total==0).
	Accuracy float64
	// ByMerchant maps normalised merchant key → MerchantResult.
	ByMerchant map[string]MerchantResult
	// BySource maps cascade stage name → SourceResult.
	BySource map[string]SourceResult
}

// MerchantResult aggregates predictions for a single normalised merchant key.
type MerchantResult struct {
	// MerchantRaw is an example raw merchant string for display.
	MerchantRaw string
	// Total is the number of predictions for this merchant.
	Total int
	// Correct is the number of correct predictions.
	Correct int
	// Accuracy is Correct/Total.
	Accuracy float64
	// Errors lists (expected, predicted) pairs that were wrong.
	Errors []ErrorDetail
}

// ErrorDetail captures a single wrong prediction for reporting.
type ErrorDetail struct {
	FixtureID string
	Expected  string
	Predicted string
	Source    string
}

// SourceResult aggregates precision by cascade source stage.
type SourceResult struct {
	Total   int
	Correct int
}

// Score computes precision/accuracy metrics from a slice of [Prediction]
// values.  It normalises merchant strings via the provided normFn (pass
// [merchant.Normalize]) so the per-merchant breakdown keys on the same
// token as the classification pipeline.
func Score(predictions []Prediction, normFn func(string) string) ScoreResult {
	if normFn == nil {
		normFn = func(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
	}

	res := ScoreResult{
		ByMerchant: make(map[string]MerchantResult),
		BySource:   make(map[string]SourceResult),
	}

	for _, p := range predictions {
		res.Total++
		ok := p.correct()
		if ok {
			res.Correct++
		}

		// Per-merchant breakdown.
		key := normFn(p.Merchant)
		if key == "" {
			key = "(unknown)"
		}
		mr := res.ByMerchant[key]
		if mr.MerchantRaw == "" {
			mr.MerchantRaw = p.Merchant
		}
		mr.Total++
		if ok {
			mr.Correct++
		} else {
			mr.Errors = append(mr.Errors, ErrorDetail{
				FixtureID: p.FixtureID,
				Expected:  p.Expected,
				Predicted: p.Predicted,
				Source:    p.Source,
			})
		}
		mr.Accuracy = float64(mr.Correct) / float64(mr.Total)
		res.ByMerchant[key] = mr

		// Per-source breakdown.
		src := p.Source
		if src == "" {
			src = "unknown"
		}
		sr := res.BySource[src]
		sr.Total++
		if ok {
			sr.Correct++
		}
		res.BySource[src] = sr
	}

	if res.Total > 0 {
		res.Accuracy = float64(res.Correct) / float64(res.Total)
	}
	return res
}

// PrintReport writes a human-readable accuracy report to w.
// Merchants are sorted alphabetically; errors are listed inline.
func PrintReport(w io.Writer, res ScoreResult) {
	fmt.Fprintf(w, "=== Classification Accuracy Report ===\n")
	fmt.Fprintf(w, "Overall: %d/%d correct  (%.1f%%)\n\n",
		res.Correct, res.Total, res.Accuracy*100)

	// Per-source breakdown.
	if len(res.BySource) > 0 {
		fmt.Fprintf(w, "By cascade source:\n")
		srcs := make([]string, 0, len(res.BySource))
		for s := range res.BySource {
			srcs = append(srcs, s)
		}
		sort.Strings(srcs)
		for _, s := range srcs {
			sr := res.BySource[s]
			pct := 0.0
			if sr.Total > 0 {
				pct = float64(sr.Correct) / float64(sr.Total) * 100
			}
			fmt.Fprintf(w, "  %-20s %d/%d  (%.1f%%)\n", s, sr.Correct, sr.Total, pct)
		}
		fmt.Fprintln(w)
	}

	// Per-merchant breakdown.
	keys := make([]string, 0, len(res.ByMerchant))
	for k := range res.ByMerchant {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	fmt.Fprintf(w, "Per-merchant breakdown:\n")
	fmt.Fprintf(w, "  %-45s  %6s  %s\n", "merchant_normalized", "acc", "errors")
	fmt.Fprintf(w, "  %s\n", strings.Repeat("-", 80))
	for _, k := range keys {
		mr := res.ByMerchant[k]
		status := "OK"
		if mr.Correct < mr.Total {
			status = fmt.Sprintf("FAIL (%d wrong)", mr.Total-mr.Correct)
		}
		fmt.Fprintf(w, "  %-45s  %5.1f%%  %s\n", truncate(k, 45), mr.Accuracy*100, status)
		for _, e := range mr.Errors {
			fmt.Fprintf(w, "    [%s] expected=%q got=%q source=%s\n",
				e.FixtureID, e.Expected, e.Predicted, e.Source)
		}
	}
	fmt.Fprintln(w)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
