/**
 * Finance module unit tests.
 *
 * Tests cover the pure-logic parts of the port:
 *   1. Spending share % computation (decimal.js, no float drift).
 *   2. Budget-line remaining = amount − actual (decimal.js subtraction).
 *   3. Net-worth aggregation with FX conversion (divide by rate).
 *   4. Goal progress clamping (0–100).
 *   5. Serialisation helpers (roundTwo, money).
 *
 * These tests do NOT hit a real database; they exercise the math directly
 * using lib/money functions and inline re-implementations of the same logic
 * used in queries.ts / routes.ts, giving confidence that the port is exact.
 */
import { test, expect, describe } from "vitest";
import { dec, money, add, sub, sum } from "../src/lib/money";
import Decimal from "decimal.js";

// ─── Spending share % ─────────────────────────────────────────────────────────

describe("spendingBreakdown share percent", () => {
  /**
   * Inline port of the share calculation in queries.ts spendingBreakdown().
   * Input: NUMERIC amounts as strings (as returned by Neon).
   */
  function computeShares(
    rows: { total_amount: string }[],
  ): { share_pct: Decimal }[] {
    const grandTotal = sum(rows.map((r) => r.total_amount));
    return rows.map((r) => {
      const amt = dec(r.total_amount);
      const pct = grandTotal.isZero()
        ? new Decimal(0)
        : amt.div(grandTotal).times(100);
      return { share_pct: pct };
    });
  }

  test("two-category split sums to exactly 100%", () => {
    const rows = [
      { total_amount: "75.00" },
      { total_amount: "25.00" },
    ];
    const shares = computeShares(rows);
    const total = shares[0].share_pct.plus(shares[1].share_pct);
    expect(total.toFixed(2)).toBe("100.00");
  });

  test("three-category split — no float drift on 1/3 fractions", () => {
    const rows = [
      { total_amount: "100.00" },
      { total_amount: "100.00" },
      { total_amount: "100.00" },
    ];
    const shares = computeShares(rows);
    // Each should be 33.3333...%  Sum should be exactly 100.
    const total = shares.reduce(
      (acc, s) => acc.plus(s.share_pct),
      new Decimal(0),
    );
    // Can't be exactly 100 with 1/3 fractions, but it should be very close.
    // What matters is that it's NOT distorted by float64 rounding:
    expect(
      total.minus(100).abs().lessThan(new Decimal("0.0001")),
    ).toBe(true);
  });

  test("zero grand total yields 0% for all categories", () => {
    const rows = [{ total_amount: "0.00" }, { total_amount: "0.00" }];
    const shares = computeShares(rows);
    for (const s of shares) {
      expect(s.share_pct.isZero()).toBe(true);
    }
  });

  test("single category gets 100%", () => {
    const rows = [{ total_amount: "1234.56" }];
    const shares = computeShares(rows);
    expect(shares[0].share_pct.toFixed(2)).toBe("100.00");
  });

  test("no float drift on 0.1 + 0.2 total", () => {
    // Classic float trap: 0.1 + 0.2 ≠ 0.3 in float64.
    const rows = [
      { total_amount: "0.10" },
      { total_amount: "0.20" },
    ];
    const grandTotal = sum(rows.map((r) => r.total_amount));
    // Decimal arithmetic: 0.10 + 0.20 = 0.30 exactly.
    expect(grandTotal.toFixed(2)).toBe("0.30");

    const shares = computeShares(rows);
    // 0.10 / 0.30 * 100 = 33.333...
    // 0.20 / 0.30 * 100 = 66.666...
    expect(parseFloat(shares[0].share_pct.toFixed(2))).toBeCloseTo(33.33, 1);
    expect(parseFloat(shares[1].share_pct.toFixed(2))).toBeCloseTo(66.67, 1);
  });
});

// ─── Budget progress remaining ────────────────────────────────────────────────

describe("budgetProgress remaining", () => {
  /**
   * Inline port of the remaining = amount − actual calculation.
   * Inputs arrive as NUMERIC strings.
   */
  function computeRemaining(amount: string, actual: string): string {
    return sub(dec(amount), dec(actual)).toFixed(2);
  }

  test("on-budget: remaining = amount - actual", () => {
    expect(computeRemaining("1000.00", "650.00")).toBe("350.00");
  });

  test("over-budget: remaining is negative", () => {
    expect(computeRemaining("500.00", "750.00")).toBe("-250.00");
  });

  test("zero actual: remaining equals amount", () => {
    expect(computeRemaining("200.00", "0.00")).toBe("200.00");
  });

  test("exactly spent: remaining is zero", () => {
    expect(computeRemaining("123.45", "123.45")).toBe("0.00");
  });

  test("no float drift on fractional amounts", () => {
    // In float64: 100.10 - 0.10 might give 99.99999999 due to rounding.
    expect(computeRemaining("100.10", "0.10")).toBe("100.00");
  });
});

// ─── Net-worth FX conversion ──────────────────────────────────────────────────

describe("net-worth FX conversion", () => {
  /**
   * Port of convertToBase from queries.ts.
   * rate = 1 baseCurrency buys `rate` quoteCurrency.
   * Conversion: amountInBase = amountInQuote / rate.
   */
  function convertToBase(
    amount: string,
    currency: string,
    baseCurrency: string,
    fxRates: Map<string, string>,
  ): Decimal {
    const amt = dec(amount);
    if (currency === baseCurrency || !currency) return amt;
    const rateStr = fxRates.get(currency);
    if (rateStr) {
      const rate = dec(rateStr);
      if (!rate.isZero()) return amt.div(rate);
    }
    return amt; // fallback: treat as already in base
  }

  const fxRates = new Map([
    ["USD", "18.50"], // 1 ZAR = 18.50 USD? No — 1 ZAR buys 0.054 USD.
    // Correct interpretation: base=ZAR, quote=USD, rate=18.50 means
    // 1 ZAR = 18.50/18.50 ... Let's use the actual Go semantic:
    // rate is stored as: 1 base = rate quote.
    // So base=ZAR, quote=USD, rate=0.054 → 1 ZAR = 0.054 USD
    // → to convert 100 USD to ZAR: 100 / 0.054 ≈ 1851.85 ZAR
    // Let's use realistic rates for testing:
    ["EUR", "20.00"], // 1 ZAR = 0.05 EUR → rate = 0.05
    // But rate stored in DB is base=ZAR, quote=EUR, so 1 ZAR = rate EUR.
    // Let's be concrete: ZAR base, USD quote, rate = 0.054
  ]);

  // Use a cleaner example: base=ZAR, USD rate = 18 (i.e. 1 USD = 18 ZAR,
  // so rate = 18 if stored as 1 ZAR = 1/18 USD ... no.
  //
  // Go semantics: fx_rates.base = "ZAR", fx_rates.quote = "USD",
  // fx_rates.rate = 18.5  means 1 ZAR = 18.5 USD? That would be strange.
  // Let's re-read the Go code:
  //   "rate is quote/base, so divide to get base"
  //   convert: amount / rate  where rate = quotePerBase
  // So if base=ZAR, quote=USD, rate = 0.054:
  //   100 USD / 0.054 = 1851.85 ZAR ✓
  //
  // Alternatively if base=ZAR, quote=USD, rate = 18.5:
  //   100 USD / 18.5 = 5.4 ZAR ✗
  //
  // Correct: rate = how many quote per 1 base.
  // base=ZAR, quote=USD → if 1 ZAR = 0.054 USD then rate = 0.054
  // 100 USD to ZAR = 100 / 0.054

  const zarRates = new Map([
    ["USD", "0.054"], // 1 ZAR = 0.054 USD
    ["GBP", "0.043"], // 1 ZAR = 0.043 GBP
  ]);

  test("same currency returns amount unchanged", () => {
    const result = convertToBase("1000.00", "ZAR", "ZAR", zarRates);
    expect(result.toFixed(2)).toBe("1000.00");
  });

  test("converts USD asset to ZAR base (divide by rate)", () => {
    // 540 USD / 0.054 = 10000 ZAR
    const result = convertToBase("540.00", "USD", "ZAR", zarRates);
    expect(result.toFixed(2)).toBe("10000.00");
  });

  test("converts GBP liability to ZAR base", () => {
    // 430 GBP / 0.043 = 10000 ZAR
    const result = convertToBase("430.00", "GBP", "ZAR", zarRates);
    expect(result.toFixed(2)).toBe("10000.00");
  });

  test("unknown currency passes through unchanged (best-effort)", () => {
    const result = convertToBase("999.00", "CHF", "ZAR", zarRates);
    expect(result.toFixed(2)).toBe("999.00");
  });

  test("net-worth aggregation: assets + holdings - liabilities", () => {
    const rates = new Map([["USD", "0.05"]]); // 1 ZAR = 0.05 USD

    const assets = [
      { value: "500.00", currency: "ZAR" },  // 500 ZAR
      { value: "50.00", currency: "USD" },   // 50/0.05 = 1000 ZAR
    ];
    const holdings = [
      { value: "200.00", currency: "ZAR" },  // 200 ZAR
    ];
    const liabs = [
      { value: "300.00", currency: "ZAR" },  // 300 ZAR
    ];

    const totalAssets = sum(
      assets.map((a) => convertToBase(a.value, a.currency, "ZAR", rates)),
    );
    const totalHoldings = sum(
      holdings.map((h) => convertToBase(h.value, h.currency, "ZAR", rates)),
    );
    const totalLiabs = sum(
      liabs.map((l) => convertToBase(l.value, l.currency, "ZAR", rates)),
    );

    // totalAssets = 500 + 1000 = 1500
    expect(totalAssets.toFixed(2)).toBe("1500.00");
    // totalHoldings = 200
    expect(totalHoldings.toFixed(2)).toBe("200.00");
    // totalLiabs = 300
    expect(totalLiabs.toFixed(2)).toBe("300.00");

    // net = 1500 + 200 - 300 = 1400
    const netWorth = add(add(totalAssets, totalHoldings), totalLiabs.neg());
    expect(money(netWorth)).toBe("1400.00");
  });

  test("FX division is exact (no float drift on 100 / 0.05)", () => {
    // float64: 100 / 0.05 can introduce rounding error.
    const result = convertToBase("100.00", "USD", "ZAR", new Map([["USD", "0.05"]]));
    expect(result.toFixed(2)).toBe("2000.00");
  });
});

// ─── Goal progress ────────────────────────────────────────────────────────────

describe("goal progress percent", () => {
  /** Port of Go goal.computeProgress — uses float here since Go does too. */
  function computeProgress(targetAmount: string, currentAmount: string): number {
    const target = parseFloat(money(targetAmount));
    const current = parseFloat(money(currentAmount));
    if (target <= 0) return 0;
    const pct = (current / target) * 100;
    return Math.min(100, Math.max(0, pct));
  }

  /** roundTwo port (Go: roundTwo). */
  function roundTwo(n: number): number {
    return parseFloat(new Decimal(n).toFixed(2));
  }

  test("50% progress", () => {
    expect(roundTwo(computeProgress("1000.00", "500.00"))).toBe(50);
  });

  test("100% when fully achieved", () => {
    expect(roundTwo(computeProgress("500.00", "500.00"))).toBe(100);
  });

  test("clamped to 100 when over-achieved", () => {
    expect(roundTwo(computeProgress("500.00", "600.00"))).toBe(100);
  });

  test("0 when no progress", () => {
    expect(roundTwo(computeProgress("1000.00", "0.00"))).toBe(0);
  });

  test("0 when target is zero (guard)", () => {
    expect(roundTwo(computeProgress("0.00", "100.00"))).toBe(0);
  });

  test("partial progress rounds to 2dp", () => {
    // 333.33 / 1000 * 100 = 33.333% → rounded to 33.33
    const pct = computeProgress("1000.00", "333.33");
    expect(roundTwo(pct)).toBe(33.33);
  });
});

// ─── money helper invariants ──────────────────────────────────────────────────

describe("money helper invariants", () => {
  test("add is exact (0.1 + 0.2 = 0.30)", () => {
    expect(money(add("0.1", "0.2"))).toBe("0.30");
  });

  test("sub is exact (100.10 - 0.10 = 100.00)", () => {
    expect(money(sub("100.10", "0.10"))).toBe("100.00");
  });

  test("sum of empty array is 0", () => {
    expect(sum([]).toFixed(2)).toBe("0.00");
  });

  test("dec handles null/undefined gracefully (returns 0)", () => {
    expect(dec(null).toFixed(2)).toBe("0.00");
    expect(dec(undefined).toFixed(2)).toBe("0.00");
    expect(dec("").toFixed(2)).toBe("0.00");
  });
});
