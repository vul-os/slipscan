/**
 * Insights module unit tests.
 *
 * Tests cover:
 *   1. buildWhere — intent → safe parameterized SQL (asserts all user input
 *      becomes positional params; no string interpolation of filter values).
 *   2. summarizeList / summarizeSum / summarizeCount / summarizeGroups —
 *      deterministic summary strings matching Go output.
 *   3. isValidIntent — closed-enum validation.
 *
 * No database; no network. Pure functions only.
 */
import { test, expect, describe } from "vitest";
import { buildWhere } from "../src/modules/insights/queries";
import {
  summarizeList,
  summarizeSum,
  summarizeCount,
  summarizeGroups,
} from "../src/modules/insights/summary";
import { isValidIntent, VALID_INTENTS } from "../src/modules/insights/types";
import type { Filters, Group, Totals } from "../src/modules/insights/types";

const ORG_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ─── buildWhere — parameterization safety ─────────────────────────────────────

describe("buildWhere — parameterization safety", () => {
  test("orgId is always the first positional param ($1)", () => {
    const { where, args } = buildWhere(ORG_ID, {});
    expect(where).toContain("$1");
    expect(args[0]).toBe(ORG_ID);
  });

  test("no filters → WHERE organization_id = $1 only", () => {
    const { where, args } = buildWhere(ORG_ID, {});
    expect(where).toBe("organization_id = $1");
    expect(args).toHaveLength(1);
  });

  test("merchant_contains becomes a positional param (never interpolated)", () => {
    const { where, args } = buildWhere(ORG_ID, { merchant_contains: "Uber" });
    // The merchant value must NOT appear literally in the WHERE clause text.
    expect(where).not.toContain("Uber");
    // It must appear as a positional param.
    expect(args).toContain("Uber");
    // The WHERE clause uses a placeholder ($2).
    expect(where).toContain("$2");
  });

  test("SQL injection attempt via merchant_contains is neutralised (escaped as param)", () => {
    const evil = "'; DROP TABLE transactions; --";
    const { where, args } = buildWhere(ORG_ID, { merchant_contains: evil });
    // The SQL text must not contain the raw injection string.
    expect(where).not.toContain("DROP");
    expect(where).not.toContain("--");
    // The evil string is passed as a positional param (escaped via escapeLike).
    // The escaped version should contain literal backslash-percent etc.
    expect(args.some((a) => typeof a === "string" && (a as string).includes("DROP"))).toBe(true);
  });

  test("category filter becomes positional param (lowercased)", () => {
    const { where, args } = buildWhere(ORG_ID, { category: "Meals" });
    expect(where).not.toContain("Meals");
    expect(args).toContain("meals");
    expect(where).toContain("$2");
  });

  test("date_from and date_to become sequential positional params", () => {
    const { where, args } = buildWhere(ORG_ID, { date_from: "2026-01-01", date_to: "2026-06-30" });
    expect(args[1]).toBe("2026-01-01");
    expect(args[2]).toBe("2026-06-30");
    expect(where).toContain("$2");
    expect(where).toContain("$3");
  });

  test("amount_min and amount_max become positional params", () => {
    const { where, args } = buildWhere(ORG_ID, { amount_min: 100, amount_max: 500 });
    expect(args).toContain(100);
    expect(args).toContain(500);
    expect(where).toContain("$2");
    expect(where).toContain("$3");
  });

  test("currency is uppercased and passed as positional param", () => {
    const { where, args } = buildWhere(ORG_ID, { currency: "zar" });
    expect(where).not.toContain("zar");
    expect(args).toContain("ZAR");
  });

  test("status becomes positional param", () => {
    const { where, args } = buildWhere(ORG_ID, { status: "verified" });
    expect(args).toContain("verified");
    expect(where).toContain("$2");
  });

  test("all filters produce correct param count", () => {
    const filters: Filters = {
      merchant_contains: "Uber",
      category: "travel",
      date_from: "2026-01-01",
      date_to: "2026-06-30",
      amount_min: 10,
      amount_max: 1000,
      currency: "ZAR",
      status: "verified",
    };
    const { args } = buildWhere(ORG_ID, filters);
    // 1 (org) + 8 filters = 9 params total
    expect(args).toHaveLength(9);
  });

  test("empty string filters are ignored (whitespace trimmed)", () => {
    const { where, args } = buildWhere(ORG_ID, { merchant_contains: "   ", category: "" });
    // Empty/whitespace filters should be ignored.
    expect(args).toHaveLength(1); // only orgId
    expect(where).toBe("organization_id = $1");
  });

  test("WHERE clause never contains raw SQL injection from filter values", () => {
    const injections = [
      "'; DELETE FROM transactions WHERE '1'='1",
      "1 OR 1=1",
      "UNION SELECT * FROM users",
    ];
    for (const inj of injections) {
      const { where } = buildWhere(ORG_ID, { merchant_contains: inj });
      // None of the injection keywords should appear in the WHERE clause SQL.
      expect(where.toLowerCase()).not.toContain("delete");
      expect(where.toLowerCase()).not.toContain("union");
      expect(where.toLowerCase()).not.toContain("select");
    }
  });
});

// ─── isValidIntent ────────────────────────────────────────────────────────────

describe("isValidIntent", () => {
  test("all valid intents pass", () => {
    for (const intent of VALID_INTENTS) {
      expect(isValidIntent(intent)).toBe(true);
    }
  });

  test("invalid intents fail", () => {
    expect(isValidIntent("")).toBe(false);
    expect(isValidIntent("unknown")).toBe(false);
    expect(isValidIntent("SELECT * FROM users")).toBe(false);
    expect(isValidIntent("List")).toBe(false); // case sensitive
  });
});

// ─── Summary functions ────────────────────────────────────────────────────────

describe("summarizeList", () => {
  test("no receipts found", () => {
    expect(summarizeList({}, 0)).toBe("No receipts found.");
  });
  test("single receipt", () => {
    expect(summarizeList({}, 1)).toBe("Found 1 receipt.");
  });
  test("multiple receipts", () => {
    expect(summarizeList({}, 5)).toBe("Found 5 receipts.");
  });
  test("includes merchant filter description", () => {
    expect(summarizeList({ merchant_contains: "Uber" }, 3)).toContain("Uber");
  });
  test("includes date range description", () => {
    const s = summarizeList({ date_from: "2026-01-01", date_to: "2026-01-31" }, 2);
    expect(s).toContain("between");
    expect(s).toContain("2026-01-01");
  });
});

describe("summarizeSum", () => {
  test("no matching receipts", () => {
    const t: Totals = { count: 0 };
    expect(summarizeSum({}, t)).toBe("No matching receipts.");
  });
  test("single receipt with currency", () => {
    const t: Totals = { amount: 250.5, count: 1, currency: "ZAR" };
    const s = summarizeSum({}, t);
    expect(s).toContain("ZAR");
    expect(s).toContain("250.50");
    expect(s).toContain("1 receipt");
  });
  test("plural receipts", () => {
    const t: Totals = { amount: 1000, count: 5, currency: "USD" };
    const s = summarizeSum({}, t);
    expect(s).toContain("5 receipts");
  });
});

describe("summarizeCount", () => {
  test("singular receipt", () => {
    expect(summarizeCount({}, 1)).toBe("1 receipt.");
  });
  test("plural receipts", () => {
    expect(summarizeCount({}, 0)).toBe("0 receipts.");
    expect(summarizeCount({}, 10)).toBe("10 receipts.");
  });
  test("includes filter description", () => {
    const s = summarizeCount({ category: "meals" }, 3);
    expect(s).toContain("meals");
  });
});

describe("summarizeGroups", () => {
  const groups: Group[] = [
    { key: "Uber", total: 500, count: 5 },
    { key: "Bolt", total: 300, count: 3 },
  ];

  test("merchant grouping label", () => {
    const s = summarizeGroups("merchant", {}, groups);
    expect(s).toContain("Top merchants by spend");
    expect(s).toContain("2 shown");
  });
  test("category grouping label", () => {
    const s = summarizeGroups("category", {}, groups);
    expect(s).toContain("Spend by category");
  });
  test("month grouping label", () => {
    const s = summarizeGroups("month", {}, groups);
    expect(s).toContain("Spend by month");
  });
  test("unknown grouping fallback", () => {
    const s = summarizeGroups("weird", {}, groups);
    expect(s).toContain("Breakdown");
  });
  test("empty groups → no matching receipts", () => {
    expect(summarizeGroups("merchant", {}, [])).toBe("No matching receipts.");
  });
  test("includes filter description when present", () => {
    const s = summarizeGroups("merchant", { date_from: "2026-01-01" }, groups);
    expect(s).toContain("from 2026-01-01");
  });
});

// ─── buildWhere index correctness ─────────────────────────────────────────────

describe("buildWhere positional index correctness", () => {
  test("conditions reference correct $N placeholders in sequence", () => {
    const filters: Filters = {
      merchant_contains: "test",
      category: "meals",
      date_from: "2026-01-01",
    };
    const { where, args } = buildWhere(ORG_ID, filters);
    // Each filter should reference the param at the right offset.
    // arg index 0 = orgId ($1), 1 = merchant ($2), 2 = category ($3), 3 = date_from ($4)
    expect(args[0]).toBe(ORG_ID);
    // Merchant is escaped via escapeLike but still contains "test"
    expect(String(args[1])).toContain("test");
    expect(args[2]).toBe("meals");
    expect(args[3]).toBe("2026-01-01");
    // WHERE should reference $1 $2 $3 $4
    expect(where).toContain("$1");
    expect(where).toContain("$2");
    expect(where).toContain("$3");
    expect(where).toContain("$4");
  });
});
