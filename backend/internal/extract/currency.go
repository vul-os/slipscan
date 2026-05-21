package extract

import (
	"strings"
	"unicode"
)

// symbolMap maps common currency symbols/prefixes to ISO codes.
// Used as a fallback when the model returns a symbol instead of a code.
var symbolMap = map[string]string{
	"r":   "ZAR", // South African Rand
	"zar": "ZAR",
	"$":   "USD",
	"usd": "USD",
	"us$": "USD",
	"€":   "EUR",
	"eur": "EUR",
	"£":   "GBP",
	"gbp": "GBP",
	"¥":   "JPY",
	"jpy": "JPY",
	"cny": "CNY",
	"a$":  "AUD",
	"aud": "AUD",
	"c$":  "CAD",
	"cad": "CAD",
	"chf": "CHF",
	"nzd": "NZD",
	"nz$": "NZD",
	"ngn": "NGN",
	"₦":   "NGN",
	"kes": "KES",
	"ksh": "KES",
	"ghs": "GHS",
	"mzn": "MZN",
	"bwp": "BWP",
	"szl": "SZL",
	"lsl": "LSL",
	"nad": "NAD",
	"mur": "MUR",
	"scr": "SCR",
	"tzs": "TZS",
	"ugx": "UGX",
	"rwf": "RWF",
	"etb": "ETB",
	"egp": "EGP",
}

// isoPattern detects strings that look like a 3-letter ISO code (e.g. "ZAR").
func isISOCode(s string) bool {
	if len(s) != 3 {
		return false
	}
	for _, r := range s {
		if !unicode.IsLetter(r) {
			return false
		}
	}
	return true
}

// NormalizeCurrency converts whatever Gemini returns to a 3-letter ISO code.
// Falls back to orgDefault when the value is empty or unrecognised.
func NormalizeCurrency(raw, orgDefault string) string {
	if raw == "" {
		if orgDefault != "" {
			return strings.ToUpper(orgDefault)
		}
		return "ZAR"
	}
	trimmed := strings.TrimSpace(raw)
	upper := strings.ToUpper(trimmed)

	// Already a valid ISO code.
	if isISOCode(upper) {
		return upper
	}

	// Try the symbol/alias map.
	lower := strings.ToLower(trimmed)
	if iso, ok := symbolMap[lower]; ok {
		return iso
	}

	// Try stripping digits/spaces and re-checking (e.g. "R 1,200").
	// Extract leading letters.
	var prefix strings.Builder
	for _, r := range trimmed {
		if unicode.IsLetter(r) {
			prefix.WriteRune(r)
		} else {
			break
		}
	}
	p := strings.ToUpper(prefix.String())
	if isISOCode(p) {
		return p
	}
	if iso, ok := symbolMap[strings.ToLower(prefix.String())]; ok {
		return iso
	}

	// Unrecognised — fall back to org default.
	if orgDefault != "" {
		return strings.ToUpper(orgDefault)
	}
	return "ZAR"
}
