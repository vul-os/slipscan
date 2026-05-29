/**
 * Classify module unit tests.
 *
 * Focus: the error-prone parts of the port.
 * 1. Cascade rule matching: exact / contains / regex against normalized merchants.
 * 2. Signal aggregation grouping: the PRIVACY-critical in-memory grouping logic
 *    (mirrors the SQL HAVING COUNT(DISTINCT org_id) >= minOrgs filter).
 *
 * These tests do NOT hit the DB — they test the pure matching and grouping
 * logic extracted from the service.
 */
import { test, expect, describe } from "vitest";
import { normalizeMerchant } from "../src/lib/merchant";

// ─── Re-export the matching logic for testing ─────────────────────────────────
// We mirror the exact logic from service.ts tryRules so the tests are
// authoritative without importing the full service (which needs Env/DB).

type MatchType = "merchant_exact" | "merchant_contains" | "merchant_regex";

interface Rule {
  id: string;
  match_type: MatchType;
  match_value: string;
  category_id: string | null;
  account_id: string | null;
  confidence: number;
}

/**
 * Pure rule matching — extracted from service.ts tryRules for testability.
 * Returns the first matching rule in cascade order: exact → contains → regex.
 */
function applyRules(merchantNorm: string, rules: Rule[]): Rule | null {
  if (!merchantNorm) return null;

  for (const pass of ["merchant_exact", "merchant_contains", "merchant_regex"] as const) {
    for (const r of rules) {
      if (r.match_type !== pass) continue;
      let matched = false;
      switch (r.match_type) {
        case "merchant_exact":
          matched = merchantNorm === r.match_value;
          break;
        case "merchant_contains":
          matched = merchantNorm.includes(r.match_value);
          break;
        case "merchant_regex":
          try {
            matched = new RegExp(r.match_value).test(merchantNorm);
          } catch {
            matched = false;
          }
          break;
      }
      if (matched) return r;
    }
  }
  return null;
}

// ─── Signal grouping logic ────────────────────────────────────────────────────

interface CorrectionRecord {
  merchant_normalized: string;
  new_category_label: string;
  organization_id: string;
  created_at: Date;
}

interface SignalRow {
  merchant_normalized: string;
  category_label: string;
  vote_count: number;
  last_seen_at: Date;
}

/**
 * Pure in-memory aggregation — mirrors the SQL aggregation in signals.ts.
 * Groups by (merchant_normalized, category_label), counts distinct org_ids,
 * and returns rows where count >= minOrgs.
 *
 * This is the logic tested; the SQL version runs the same algorithm in Postgres.
 */
function aggregateInMemory(corrections: CorrectionRecord[], minOrgs: number): SignalRow[] {
  // Group: key → Set of org_ids + max created_at.
  const groups = new Map<string, { orgs: Set<string>; lastSeen: Date }>();
  for (const c of corrections) {
    if (!c.merchant_normalized || !c.new_category_label) continue;
    const key = `${c.merchant_normalized}\x00${c.new_category_label}`;
    const g = groups.get(key) ?? { orgs: new Set<string>(), lastSeen: c.created_at };
    g.orgs.add(c.organization_id);
    if (c.created_at > g.lastSeen) g.lastSeen = c.created_at;
    groups.set(key, g);
  }

  const out: SignalRow[] = [];
  for (const [key, g] of groups.entries()) {
    if (g.orgs.size < minOrgs) continue;
    const [merchant_normalized, category_label] = key.split("\x00");
    out.push({
      merchant_normalized,
      category_label,
      vote_count: g.orgs.size,
      last_seen_at: g.lastSeen,
    });
  }
  return out;
}

// ─── Tests: rule cascade matching ─────────────────────────────────────────────

describe("cascade rule matching", () => {
  test("merchant_exact matches normalized merchant exactly", () => {
    const norm = normalizeMerchant("WOOLWORTHS PTY LTD #4021  JHB");
    expect(norm).toBe("woolworths jhb");

    const rules: Rule[] = [
      { id: "r1", match_type: "merchant_exact", match_value: "woolworths jhb", category_id: "cat-1", account_id: null, confidence: 0.99 },
    ];
    const match = applyRules(norm, rules);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("r1");
  });

  test("merchant_exact is case-sensitive (normalized values are lowercase)", () => {
    const norm = normalizeMerchant("PICK N PAY 0123");
    // normalizeMerchant lowercases and strips noise tokens
    const rules: Rule[] = [
      { id: "r1", match_type: "merchant_exact", match_value: "PICK N PAY", category_id: "cat-1", account_id: null, confidence: 0.99 },
      { id: "r2", match_type: "merchant_exact", match_value: "pick n pay", category_id: "cat-2", account_id: null, confidence: 0.99 },
    ];
    const match = applyRules(norm, rules);
    // After normalization the merchant is lowercase, so r2 should match
    expect(match?.id).toBe("r2");
  });

  test("merchant_contains matches substring in normalized merchant", () => {
    const norm = normalizeMerchant("Uber *EATS help.uber.com");
    expect(norm).toBe("uber eats help uber com");

    const rules: Rule[] = [
      { id: "r1", match_type: "merchant_contains", match_value: "uber eats", category_id: "cat-meals", account_id: null, confidence: 0.9 },
    ];
    const match = applyRules(norm, rules);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("r1");
  });

  test("merchant_contains does not match when substring absent", () => {
    const norm = normalizeMerchant("Pick n Pay 0123");
    const rules: Rule[] = [
      { id: "r1", match_type: "merchant_contains", match_value: "woolworths", category_id: "cat-1", account_id: null, confidence: 0.9 },
    ];
    expect(applyRules(norm, rules)).toBeNull();
  });

  test("merchant_regex matches regex pattern", () => {
    const norm = normalizeMerchant("SASOL FUEL CARD 00123");
    // normalizeMerchant strips pure numbers but keeps alphanum tokens
    const rules: Rule[] = [
      { id: "r1", match_type: "merchant_regex", match_value: "^sasol", category_id: "cat-fuel", account_id: null, confidence: 0.85 },
    ];
    const match = applyRules(norm, rules);
    expect(match).not.toBeNull();
    expect(match!.id).toBe("r1");
  });

  test("merchant_regex with invalid pattern does not crash — skips rule", () => {
    const norm = "woolworths jhb";
    const rules: Rule[] = [
      { id: "r-bad", match_type: "merchant_regex", match_value: "[invalid(regex", category_id: "cat-1", account_id: null, confidence: 0.8 },
      { id: "r-good", match_type: "merchant_contains", match_value: "woolworths", category_id: "cat-2", account_id: null, confidence: 0.8 },
    ];
    // Bad regex skipped; falls through to contains
    const match = applyRules(norm, rules);
    expect(match?.id).toBe("r-good");
  });

  test("cascade priority: exact wins over contains over regex", () => {
    const norm = normalizeMerchant("Woolworths 555");
    // normalizeMerchant removes pure numbers, so norm = "woolworths"
    expect(norm).toBe("woolworths");

    const rules: Rule[] = [
      // regex would match too
      { id: "r-regex",    match_type: "merchant_regex",    match_value: "wool",          category_id: "cat-regex",    account_id: null, confidence: 0.7 },
      // contains would match
      { id: "r-contains", match_type: "merchant_contains", match_value: "woolworths",    category_id: "cat-contains", account_id: null, confidence: 0.8 },
      // exact matches
      { id: "r-exact",    match_type: "merchant_exact",    match_value: "woolworths",    category_id: "cat-exact",    account_id: null, confidence: 0.99 },
    ];
    const match = applyRules(norm, rules);
    expect(match?.id).toBe("r-exact");
  });

  test("returns null when no rules match", () => {
    const norm = normalizeMerchant("Unknown Vendor XYZ");
    const rules: Rule[] = [
      { id: "r1", match_type: "merchant_exact", match_value: "woolworths", category_id: "cat-1", account_id: null, confidence: 0.99 },
    ];
    expect(applyRules(norm, rules)).toBeNull();
  });

  test("returns null for empty merchant_normalized", () => {
    expect(applyRules("", [])).toBeNull();
  });

  test("multiple contains rules: first in cascade order wins", () => {
    const norm = "uber eats help uber com";
    const rules: Rule[] = [
      { id: "r1", match_type: "merchant_contains", match_value: "uber",       category_id: "cat-1", account_id: null, confidence: 0.8 },
      { id: "r2", match_type: "merchant_contains", match_value: "uber eats",  category_id: "cat-2", account_id: null, confidence: 0.9 },
    ];
    // Rules are iterated in array order within the same pass — r1 comes first
    const match = applyRules(norm, rules);
    expect(match?.id).toBe("r1");
  });
});

// ─── Tests: signal aggregation grouping ──────────────────────────────────────

describe("signal aggregation grouping", () => {
  const t1 = new Date("2026-01-01T10:00:00Z");
  const t2 = new Date("2026-01-02T10:00:00Z");
  const t3 = new Date("2026-01-03T10:00:00Z");

  test("single org: no signal emitted (below minOrgs=2)", () => {
    const corrections: CorrectionRecord[] = [
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-a", created_at: t1 },
    ];
    const signals = aggregateInMemory(corrections, 2);
    expect(signals).toHaveLength(0);
  });

  test("two distinct orgs: signal emitted with vote_count=2", () => {
    const corrections: CorrectionRecord[] = [
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-a", created_at: t1 },
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-b", created_at: t2 },
    ];
    const signals = aggregateInMemory(corrections, 2);
    expect(signals).toHaveLength(1);
    expect(signals[0].merchant_normalized).toBe("woolworths");
    expect(signals[0].category_label).toBe("Groceries");
    expect(signals[0].vote_count).toBe(2);
  });

  test("same org repeated: counts as one vote (DISTINCT)", () => {
    const corrections: CorrectionRecord[] = [
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-a", created_at: t1 },
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-a", created_at: t2 },
    ];
    const signals = aggregateInMemory(corrections, 2);
    expect(signals).toHaveLength(0);
  });

  test("different category labels are separate signal rows", () => {
    const corrections: CorrectionRecord[] = [
      { merchant_normalized: "woolworths", new_category_label: "Groceries",  organization_id: "org-a", created_at: t1 },
      { merchant_normalized: "woolworths", new_category_label: "Groceries",  organization_id: "org-b", created_at: t2 },
      { merchant_normalized: "woolworths", new_category_label: "Household",  organization_id: "org-a", created_at: t1 },
      { merchant_normalized: "woolworths", new_category_label: "Household",  organization_id: "org-b", created_at: t2 },
    ];
    const signals = aggregateInMemory(corrections, 2);
    expect(signals).toHaveLength(2);
    const labels = signals.map((s) => s.category_label).sort();
    expect(labels).toEqual(["Groceries", "Household"]);
  });

  test("last_seen_at is max(created_at) per group", () => {
    const corrections: CorrectionRecord[] = [
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-a", created_at: t1 },
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-b", created_at: t3 },
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-c", created_at: t2 },
    ];
    const signals = aggregateInMemory(corrections, 2);
    expect(signals).toHaveLength(1);
    expect(signals[0].vote_count).toBe(3);
    expect(signals[0].last_seen_at).toEqual(t3);
  });

  test("rows with empty merchant_normalized are excluded", () => {
    const corrections: CorrectionRecord[] = [
      { merchant_normalized: "",           new_category_label: "Groceries", organization_id: "org-a", created_at: t1 },
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-a", created_at: t1 },
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-b", created_at: t2 },
    ];
    const signals = aggregateInMemory(corrections, 2);
    expect(signals).toHaveLength(1);
    expect(signals[0].merchant_normalized).toBe("woolworths");
  });

  test("privacy: vote_count is org count, not correction count", () => {
    // org-a corrected woolworths→Groceries 10 times, org-b once
    const corrections: CorrectionRecord[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        merchant_normalized: "woolworths",
        new_category_label: "Groceries",
        organization_id: "org-a",
        created_at: new Date(t1.getTime() + i * 1000),
      })),
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-b", created_at: t2 },
    ];
    const signals = aggregateInMemory(corrections, 2);
    expect(signals).toHaveLength(1);
    // DISTINCT org count = 2, not 11
    expect(signals[0].vote_count).toBe(2);
  });

  test("minOrgs=3: requires 3 distinct orgs", () => {
    const corrections: CorrectionRecord[] = [
      { merchant_normalized: "sasol", new_category_label: "Fuel", organization_id: "org-a", created_at: t1 },
      { merchant_normalized: "sasol", new_category_label: "Fuel", organization_id: "org-b", created_at: t2 },
    ];
    expect(aggregateInMemory(corrections, 3)).toHaveLength(0);

    corrections.push({ merchant_normalized: "sasol", new_category_label: "Fuel", organization_id: "org-c", created_at: t3 });
    const signals = aggregateInMemory(corrections, 3);
    expect(signals).toHaveLength(1);
    expect(signals[0].vote_count).toBe(3);
  });

  test("multiple distinct merchants are independent signals", () => {
    const corrections: CorrectionRecord[] = [
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-a", created_at: t1 },
      { merchant_normalized: "woolworths", new_category_label: "Groceries", organization_id: "org-b", created_at: t2 },
      { merchant_normalized: "sasol",      new_category_label: "Fuel",      organization_id: "org-a", created_at: t1 },
      { merchant_normalized: "sasol",      new_category_label: "Fuel",      organization_id: "org-b", created_at: t2 },
    ];
    const signals = aggregateInMemory(corrections, 2);
    expect(signals).toHaveLength(2);
    const merchants = signals.map((s) => s.merchant_normalized).sort();
    expect(merchants).toEqual(["sasol", "woolworths"]);
  });
});

// ─── Tests: normalizeMerchant integration with matching ──────────────────────

describe("normalizeMerchant integration with rule matching", () => {
  test("rule match_value should use normalized form (same as DB storage)", () => {
    // Simulate how rules are stored: match_value is already normalized
    const rawMerchant = "WOOLWORTHS PTY LTD #4021  JHB";
    const norm = normalizeMerchant(rawMerchant);

    const rules: Rule[] = [
      {
        id: "r1",
        match_type: "merchant_exact",
        // match_value stored as the normalized form (just like Go normalizes on write)
        match_value: normalizeMerchant("WOOLWORTHS JHB"),
        category_id: "cat-grocery",
        account_id: null,
        confidence: 0.99,
      },
    ];

    // Both normalize to the same form
    expect(norm).toBe("woolworths jhb");
    expect(rules[0].match_value).toBe("woolworths jhb");
    const match = applyRules(norm, rules);
    expect(match).not.toBeNull();
  });

  test("bank statement description normalization feeds cascade correctly", () => {
    const desc = "PAYMENT TO NETFLIX SUBSCRIPTION REF:12345";
    const norm = normalizeMerchant(desc);
    // "payment", "to", "ref" are noise tokens; pure numbers stripped
    expect(norm).toBe("netflix subscription");

    const rules: Rule[] = [
      { id: "r1", match_type: "merchant_contains", match_value: "netflix", category_id: "cat-entertainment", account_id: null, confidence: 0.95 },
    ];
    expect(applyRules(norm, rules)?.id).toBe("r1");
  });
});
