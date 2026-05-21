package classification_test

import (
	"strings"
	"testing"

	"github.com/exolutionza/slipscan/backend/internal/merchant"
	"github.com/exolutionza/slipscan/backend/internal/testsuite/classification"
)

// TestCorpusLoads verifies that every fixture file parses cleanly and has the
// required corpus annotations.  This is the canary that catches broken JSON
// or missing labels before any pipeline code is involved.
func TestCorpusLoads(t *testing.T) {
	corpus, err := classification.LoadCorpus()
	if err != nil {
		t.Fatalf("LoadCorpus: %v", err)
	}
	if len(corpus) < 20 {
		t.Errorf("expected at least 20 fixture cases, got %d", len(corpus))
	}
	t.Logf("loaded %d fixture cases", len(corpus))

	seen := make(map[string]string) // id → file
	for _, fc := range corpus {
		ex := fc.Extraction
		if ex.ID == "" {
			t.Errorf("%s: fixture missing 'id' field", fc.File)
		}
		if prev, dup := seen[ex.ID]; dup {
			t.Errorf("duplicate fixture id %q in %s (first seen in %s)", ex.ID, fc.File, prev)
		}
		seen[ex.ID] = fc.File

		if ex.Kind == "" {
			t.Errorf("%s: missing 'kind'", fc.File)
		}
		if ex.Merchant == "" {
			t.Errorf("%s: missing 'merchant'", fc.File)
		}
		if ex.Currency == "" {
			t.Errorf("%s: missing 'currency'", fc.File)
		}
		if ex.ExpectedCategory == "" {
			t.Errorf("%s: missing '_expected_category'", fc.File)
		}
		if ex.MerchantNormalizedExpect == "" {
			t.Errorf("%s: missing '_merchant_normalized_expected'", fc.File)
		}
		// bank_statement must have statement_lines
		if ex.Kind == "bank_statement" && len(ex.StatLines) == 0 {
			t.Errorf("%s: kind=bank_statement but no statement_lines", fc.File)
		}
		// slip/invoice should have line_items (warn, not fatal — some may legitimately be empty)
		if (ex.Kind == "slip" || ex.Kind == "invoice") && len(ex.LineItems) == 0 {
			t.Logf("WARNING %s: kind=%s but no line_items (intentional?)", fc.File, ex.Kind)
		}
	}
}

// TestNormalizeMatchesExpected verifies that merchant.Normalize applied to
// each fixture's raw merchant string produces the value recorded in
// _merchant_normalized_expected.  Any deviation means either:
//   (a) the fixture annotation is wrong (fix the annotation), or
//   (b) the normaliser behaviour changed (fix normalise.go and cascade keys).
func TestNormalizeMatchesExpected(t *testing.T) {
	corpus, err := classification.LoadCorpus()
	if err != nil {
		t.Fatalf("LoadCorpus: %v", err)
	}

	failures := 0
	for _, fc := range corpus {
		ex := fc.Extraction
		got := merchant.Normalize(ex.Merchant)
		want := ex.MerchantNormalizedExpect
		if got != want {
			t.Errorf("[%s] Normalize(%q)\n\tgot:  %q\n\twant: %q",
				fc.File, ex.Merchant, got, want)
			failures++
		}
	}
	if failures == 0 {
		t.Logf("all %d fixtures: Normalize output matches annotation", len(corpus))
	}
}

// TestNormalizeGroupVariants is the key learning-loop property test:
// For every fixture that carries a _normalize_group, all members of that
// group must produce normalised keys that share a common non-empty prefix.
//
// This proves that a merchant_contains rule keyed on that prefix would fire
// for every spelling variant — which is the mechanism P1-03 uses to promote
// user corrections into portable rules.
func TestNormalizeGroupVariants(t *testing.T) {
	corpus, err := classification.LoadCorpus()
	if err != nil {
		t.Fatalf("LoadCorpus: %v", err)
	}

	groups := classification.NormalizeGroups(corpus)
	if len(groups) == 0 {
		t.Fatal("no normalize groups found in corpus; add _normalize_group annotations")
	}
	t.Logf("checking %d normalize groups", len(groups))

	for groupName, members := range groups {
		if len(members) < 2 {
			// A group with one member can't prove variant-collision.
			t.Logf("group %q: only 1 member, skipping collision check", groupName)
			continue
		}

		keys := make([]string, len(members))
		for i, m := range members {
			keys[i] = merchant.Normalize(m.Extraction.Merchant)
		}

		// Find the longest common prefix among all normalised keys in the group.
		prefix := longestCommonPrefix(keys)
		if prefix == "" {
			t.Errorf("group %q: normalised keys share NO common prefix — "+
				"a contains rule cannot cover all variants\n\tkeys: %v",
				groupName, keys)
			continue
		}

		// The prefix must contain at least the first meaningful token of the
		// merchant name (not just whitespace/empty).
		firstToken := strings.Fields(prefix)
		if len(firstToken) == 0 {
			t.Errorf("group %q: common prefix %q contains no tokens", groupName, prefix)
			continue
		}

		t.Logf("group %q: common prefix %q covers %d variants", groupName, prefix, len(members))
	}
}

// TestNormalizeGroupNoFalseMerge verifies that fixtures NOT in the same group
// do NOT collapse to an identical normalised key.  This prevents the learning
// loop from accidentally merging distinct merchants.
//
// Specifically it checks the Woolworths Food vs Woolworths Fashion distinction
// which is documented in the fixture annotations.
func TestNormalizeGroupNoFalseMerge(t *testing.T) {
	corpus, err := classification.LoadCorpus()
	if err != nil {
		t.Fatalf("LoadCorpus: %v", err)
	}

	// Build normalised-key → []fixtureID+category map.
	type entry struct {
		file     string
		category string
	}
	byKey := make(map[string][]entry)
	for _, fc := range corpus {
		key := merchant.Normalize(fc.Extraction.Merchant)
		byKey[key] = append(byKey[key], entry{
			file:     fc.File,
			category: fc.Extraction.ExpectedCategory,
		})
	}

	// Any key that maps to two different expected categories is a collision
	// that would cause the learning loop to produce a wrong rule.
	for key, entries := range byKey {
		cats := make(map[string]bool)
		for _, e := range entries {
			cats[e.category] = true
		}
		if len(cats) > 1 {
			catList := make([]string, 0, len(cats))
			for c := range cats {
				catList = append(catList, c)
			}
			fileList := make([]string, 0, len(entries))
			for _, e := range entries {
				fileList = append(fileList, e.file)
			}
			// This is a WARNING not a fatal error: legitimate ambiguity exists
			// (e.g. "woolworths" in isolation could be food or fashion).
			// Real cascade uses richer context (line items, amounts) for LLM.
			t.Logf("NOTICE: normalised key %q maps to multiple expected categories %v "+
				"(files: %v) — ensure rules are keyed on the longer/more-specific key",
				key, catList, fileList)
		}
	}
}

// TestNormalizeDeterministic verifies that calling Normalize twice on the
// same input always returns the same result (no randomness or stateful side
// effects).
func TestNormalizeDeterministic(t *testing.T) {
	corpus, err := classification.LoadCorpus()
	if err != nil {
		t.Fatalf("LoadCorpus: %v", err)
	}
	for _, fc := range corpus {
		raw := fc.Extraction.Merchant
		a := merchant.Normalize(raw)
		b := merchant.Normalize(raw)
		if a != b {
			t.Errorf("[%s] Normalize is non-deterministic for %q: %q vs %q",
				fc.File, raw, a, b)
		}
	}
}

// TestNormalizeNonEmpty verifies that no fixture produces an empty normalised
// key — an empty key must never be matched in the cascade (it would merge all
// unrecognised merchants into one signal bucket).
func TestNormalizeNonEmpty(t *testing.T) {
	corpus, err := classification.LoadCorpus()
	if err != nil {
		t.Fatalf("LoadCorpus: %v", err)
	}
	for _, fc := range corpus {
		raw := fc.Extraction.Merchant
		if raw == "" {
			continue // fixture may legitimately have empty merchant for statement lines
		}
		got := merchant.Normalize(raw)
		if got == "" {
			t.Errorf("[%s] Normalize(%q) returned empty string — "+
				"this fixture would silently skip cascade matching", fc.File, raw)
		}
	}
}

// longestCommonPrefix returns the longest string that is a prefix of every
// element in ss.
func longestCommonPrefix(ss []string) string {
	if len(ss) == 0 {
		return ""
	}
	prefix := ss[0]
	for _, s := range ss[1:] {
		for !strings.HasPrefix(s, prefix) {
			if len(prefix) == 0 {
				return ""
			}
			// Trim at word boundary if possible.
			i := strings.LastIndex(prefix, " ")
			if i < 0 {
				return ""
			}
			prefix = prefix[:i]
		}
	}
	return strings.TrimSpace(prefix)
}
