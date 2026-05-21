// Package merchant provides the canonical merchant-name normalization used
// across the classification pipeline. It is the single shared dependency for:
//
//   - writing transactions.merchant_normalized (extraction → transaction)
//   - the classification cascade's merchant_exact / merchant_contains matching
//   - classification_corrections.merchant_normalized
//   - cross-tenant merchant_signals (keyed on merchant_normalized)
//
// Every component MUST normalize through Normalize so that a rule learned in
// one place matches a transaction created in another, and so cross-tenant
// signals aggregate correctly. Do not reimplement this logic elsewhere.
package merchant

import (
	"regexp"
	"strings"
)

// noiseTokens are corporate/transactional words that carry no merchant
// identity and would otherwise fragment signals (e.g. "woolworths pty ltd"
// vs "woolworths"). Kept deliberately small and conservative — over-stripping
// merges distinct merchants, which is worse than under-stripping.
var noiseTokens = map[string]bool{
	"pty": true, "ltd": true, "limited": true, "cc": true, "inc": true,
	"the": true, "pos": true, "card": true, "purchase": true, "payment": true,
	"paid": true, "to": true, "ref": true, "tx": true, "trx": true,
}

var (
	nonAlnum   = regexp.MustCompile(`[^a-z0-9]+`)
	pureNumber = regexp.MustCompile(`^[0-9]+$`)
	multiSpace = regexp.MustCompile(`\s+`)
)

// Normalize reduces a raw merchant string to a stable comparison key:
//
//	"WOOLWORTHS PTY LTD #4021  JHB"  ->  "woolworths jhb"
//	"Uber *EATS help.uber.com"       ->  "uber eats help uber com"
//	"  Pick n Pay 0123 "             ->  "pick n pay"
//
// Rules: lowercase; non-alphanumeric → space; drop pure-number tokens
// (store/branch/card numbers); drop a small noise-word list; collapse spaces.
// Deterministic and dependency-free. Returns "" for input that normalizes to
// nothing (callers should treat "" as "unknown merchant", never match on it).
func Normalize(raw string) string {
	if raw == "" {
		return ""
	}
	s := strings.ToLower(raw)
	s = nonAlnum.ReplaceAllString(s, " ")
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}

	out := make([]string, 0, 8)
	for _, tok := range strings.Fields(s) {
		if pureNumber.MatchString(tok) {
			continue // store / branch / card numbers
		}
		if noiseTokens[tok] {
			continue
		}
		out = append(out, tok)
	}
	// If stripping removed everything (e.g. merchant was only noise/numbers),
	// fall back to the punctuation-stripped form so we never lose the row.
	if len(out) == 0 {
		return multiSpace.ReplaceAllString(s, " ")
	}
	return strings.Join(out, " ")
}
