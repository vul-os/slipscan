// Package classification provides a labelled fixture corpus and scoring
// harness for the Phase 1 transaction-classification pipeline.
//
// # Purpose
//
// This package tests the accuracy and consistency of the cascade classifier
// defined in PHASE1-CONTRACT.md §2 (P1-02 → P1-03 → P1-04).  It:
//
//  1. Embeds 30 South-African slip/invoice/bank-statement extraction fixtures
//     (the §2 JSON shape) each annotated with an expected category label.
//  2. Exposes a [Classifier] interface so the actual cascade (once P1-02
//     lands) can be plugged in without modifying this package.
//  3. Scores predicted vs expected labels and prints a per-merchant + overall
//     accuracy report via [Score] and [PrintReport].
//  4. Drives property tests on [merchant.Normalize] to prove that every
//     fixture variant pair that belongs to the same merchant collapses to
//     a shared normalised key prefix (the invariant that makes rules portable).
//
// # Running today (base branch)
//
// All tests PASS on the base branch.  Tests that require the P1-02 cascade
// implementation call t.Skip("pending P1-02 integration").
//
//	cd backend && go test ./internal/testsuite/classification/... -v
//
// # After P1-02 / P1-03 / P1-04 integrate
//
// Replace the stub [StubClassifier] with the real one and remove the Skip
// calls in harness_test.go.  The accuracy report will then measure the live
// pipeline against the labelled corpus.
package classification

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"strings"
)

//go:embed fixtures/*.json
var fixtureFS embed.FS

// LineItem matches the extraction contract line-item shape (§2).
type LineItem struct {
	Description string  `json:"description"`
	Qty         float64 `json:"qty"`
	Unit        float64 `json:"unit"`
	Amount      float64 `json:"amount"`
}

// StatementLine matches the extraction contract bank-statement line shape (§2).
type StatementLine struct {
	Date        string  `json:"date"`
	Description string  `json:"description"`
	Amount      float64 `json:"amount"`
	Balance     float64 `json:"balance"`
}

// Extraction is the §2 document_extractions.extracted JSONB shape.
// Fields prefixed with "_" are corpus-only annotations (not part of the
// production schema) and are stripped before passing to [Classifier].
type Extraction struct {
	// Core §2 fields (production schema)
	Kind       string          `json:"kind"`
	Merchant   string          `json:"merchant"`
	Date       string          `json:"date"`
	Currency   string          `json:"currency"`
	Subtotal   float64         `json:"subtotal"`
	Tax        float64         `json:"tax"`
	Total      float64         `json:"total"`
	Confidence float64         `json:"confidence"`
	LineItems  []LineItem      `json:"line_items"`
	StatLines  []StatementLine `json:"statement_lines"`

	// Corpus-only annotations
	ID                       string `json:"id"`
	ExpectedCategory         string `json:"_expected_category"`
	MerchantNormalizedExpect string `json:"_merchant_normalized_expected"`
	NormalizeGroup           string `json:"_normalize_group,omitempty"`
	NormalizeGroupNote       string `json:"_normalize_group_note,omitempty"`
}

// FixtureCase bundles an [Extraction] with its file origin for error messages.
type FixtureCase struct {
	File      string
	Extraction Extraction
}

// LoadCorpus reads all *.json files from the embedded fixtures/ directory and
// returns them as [FixtureCase] values.  It returns an error if any file
// cannot be parsed.  Callers should use this in tests rather than embedding
// their own copy so the corpus stays in sync with this package.
func LoadCorpus() ([]FixtureCase, error) {
	entries, err := fs.ReadDir(fixtureFS, "fixtures")
	if err != nil {
		return nil, fmt.Errorf("read fixtures dir: %w", err)
	}

	cases := make([]FixtureCase, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		path := "fixtures/" + e.Name()
		data, err := fixtureFS.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		var ex Extraction
		if err := json.Unmarshal(data, &ex); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
		if ex.ExpectedCategory == "" {
			return nil, fmt.Errorf("%s: missing _expected_category annotation", path)
		}
		if ex.MerchantNormalizedExpect == "" {
			return nil, fmt.Errorf("%s: missing _merchant_normalized_expected annotation", path)
		}
		cases = append(cases, FixtureCase{File: e.Name(), Extraction: ex})
	}
	return cases, nil
}

// NormalizeGroups returns a map from group name → list of FixtureCases that
// carry that group label.  Groups are used by the property tests to assert
// that variant-spellings of the same merchant collapse to a common prefix
// (or equal key) after normalization.
func NormalizeGroups(corpus []FixtureCase) map[string][]FixtureCase {
	groups := make(map[string][]FixtureCase)
	for _, fc := range corpus {
		g := fc.Extraction.NormalizeGroup
		if g == "" {
			continue
		}
		groups[g] = append(groups[g], fc)
	}
	return groups
}
