/**
 * Currency normalisation — port of backend/internal/extract/currency.go.
 * Converts whatever Gemini returns (symbol, alias, mixed case) to a
 * 3-letter ISO 4217 code. Falls back to orgDefault when the value is empty
 * or unrecognised.
 */

/** Maps common currency symbols and lowercase aliases to ISO codes. */
const symbolMap: Record<string, string> = {
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
};

/** True if `s` is exactly 3 ASCII letters (potential ISO code). */
function isISOCode(s: string): boolean {
  return /^[A-Za-z]{3}$/.test(s);
}

/**
 * NormalizeCurrency converts whatever Gemini returns to a 3-letter ISO code.
 * Falls back to orgDefault when the value is empty or unrecognised.
 * Port of Go NormalizeCurrency.
 */
export function normalizeCurrency(raw: string, orgDefault: string): string {
  if (!raw) {
    return orgDefault ? orgDefault.toUpperCase() : "ZAR";
  }

  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();

  // Already a valid ISO code.
  if (isISOCode(upper)) return upper;

  // Try the symbol / alias map.
  const lower = trimmed.toLowerCase();
  if (symbolMap[lower]) return symbolMap[lower];

  // Extract leading letter prefix (e.g. "R 1,200" → "R").
  const match = trimmed.match(/^([A-Za-z€£¥₦]+)/);
  if (match) {
    const prefix = match[1];
    const prefixUpper = prefix.toUpperCase();
    if (isISOCode(prefixUpper)) return prefixUpper;
    const prefixLower = prefix.toLowerCase();
    if (symbolMap[prefixLower]) return symbolMap[prefixLower];
  }

  // Unrecognised — fall back to org default.
  return orgDefault ? orgDefault.toUpperCase() : "ZAR";
}
