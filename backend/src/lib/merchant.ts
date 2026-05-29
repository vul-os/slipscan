/**
 * Canonical merchant-name normalization — EXACT port of Go
 * internal/merchant/normalize.go. Used for transactions.merchant_normalized,
 * classification merchant_exact/contains matching, classification_corrections,
 * and cross-tenant merchant_signals. MUST stay byte-for-byte identical to the
 * Go version or cross-tenant signals fragment. Deterministic, dependency-free.
 */

const NOISE_TOKENS = new Set([
  "pty", "ltd", "limited", "cc", "inc",
  "the", "pos", "card", "purchase", "payment",
  "paid", "to", "ref", "tx", "trx",
]);

const NON_ALNUM = /[^a-z0-9]+/g;
const PURE_NUMBER = /^[0-9]+$/;
const MULTI_SPACE = /\s+/g;

export function normalizeMerchant(raw: string): string {
  if (!raw) return "";
  let s = raw.toLowerCase();
  s = s.replace(NON_ALNUM, " ");
  s = s.trim();
  if (s === "") return "";

  const out: string[] = [];
  for (const tok of s.split(/\s+/)) {
    if (tok === "") continue;
    if (PURE_NUMBER.test(tok)) continue; // store / branch / card numbers
    if (NOISE_TOKENS.has(tok)) continue;
    out.push(tok);
  }
  // If stripping removed everything, fall back to punctuation-stripped form.
  if (out.length === 0) return s.replace(MULTI_SPACE, " ");
  return out.join(" ");
}
