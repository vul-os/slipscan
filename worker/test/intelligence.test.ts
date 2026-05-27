/**
 * Intelligence module unit tests.
 *
 * Tests cover the pure-compute functions in compute.ts:
 *   1. frequencyMonthlyMultiplier — all five known frequencies.
 *   2. projectRecurring — outflow accumulation + merchant dedup.
 *   3. computeForecast — horizon clamping, blending logic, assumption messages.
 *   4. detectDuplicates — within/outside window, pair-keying.
 *   5. detectUnusualSpend — z-score threshold, severity tiers.
 *   6. detectMissingReceipts — threshold + reconciled-ID exclusion.
 *   7. computeTaxReadiness — VAT branches, doc coverage, reconciliation penalty.
 *   8. roundTwo — half-up rounding for positive and negative values.
 *
 * No database; no network. Pure functions only.
 */
import { test, expect, describe } from "vitest";
import {
  frequencyMonthlyMultiplier,
  projectRecurring,
  computeForecast,
  detectDuplicates,
  detectUnusualSpend,
  detectMissingReceipts,
  computeTaxReadiness,
  roundTwo,
} from "../src/modules/intelligence/compute";
import type { RecurringRow, MonthlyTotals, TxRow, TaxReadinessData } from "../src/modules/intelligence/types";

// ─── roundTwo ─────────────────────────────────────────────────────────────────

describe("roundTwo", () => {
  test("rounds to 2 decimal places for positive value", () => {
    // Note: 1.005 * 100 = 100.49999... in IEEE 754 — same behaviour as Go.
    // Use unambiguous cases.
    expect(roundTwo(1.006)).toBe(1.01);
    expect(roundTwo(1.004)).toBe(1.00);
    expect(roundTwo(3.14159)).toBe(3.14);
    expect(roundTwo(2.555)).toBe(2.56); // 2.555*100=255.5 exactly representable? yes
    expect(roundTwo(100.5)).toBe(100.5);
  });

  test("rounds to 2 decimal places for negative value", () => {
    // -1.005 * 100 = -100.49999... same IEEE 754 edge case as Go roundTwo.
    expect(roundTwo(-1.006)).toBe(-1.01);
    expect(roundTwo(-3.14159)).toBe(-3.14);
  });

  test("zero is zero", () => {
    expect(roundTwo(0)).toBe(0);
  });
});

// ─── frequencyMonthlyMultiplier ───────────────────────────────────────────────

describe("frequencyMonthlyMultiplier", () => {
  test("weekly ~ 4.33", () => {
    expect(frequencyMonthlyMultiplier("weekly")).toBeCloseTo(52 / 12, 5);
  });
  test("biweekly ~ 2.17", () => {
    expect(frequencyMonthlyMultiplier("biweekly")).toBeCloseTo(26 / 12, 5);
  });
  test("monthly = 1", () => {
    expect(frequencyMonthlyMultiplier("monthly")).toBe(1.0);
  });
  test("quarterly = 1/3", () => {
    expect(frequencyMonthlyMultiplier("quarterly")).toBeCloseTo(1 / 3, 5);
  });
  test("yearly = 1/12", () => {
    expect(frequencyMonthlyMultiplier("yearly")).toBeCloseTo(1 / 12, 5);
  });
  test("unknown defaults to 1", () => {
    expect(frequencyMonthlyMultiplier("unknown")).toBe(1.0);
    expect(frequencyMonthlyMultiplier("")).toBe(1.0);
  });
});

// ─── projectRecurring ─────────────────────────────────────────────────────────

describe("projectRecurring", () => {
  test("sums monthly outflows correctly", () => {
    const rows: RecurringRow[] = [
      { id: "1", merchant_normalized: "Netflix", category_id: null, expected_amount: 100, currency: "ZAR", frequency: "monthly", next_expected_date: null },
      { id: "2", merchant_normalized: "Gym", category_id: null, expected_amount: 200, currency: "ZAR", frequency: "monthly", next_expected_date: null },
    ];
    const { outflow, merchants } = projectRecurring(rows);
    expect(outflow).toBeCloseTo(300, 5);
    expect(merchants).toHaveLength(2);
  });

  test("skips rows with null expected_amount", () => {
    const rows: RecurringRow[] = [
      { id: "1", merchant_normalized: "Netflix", category_id: null, expected_amount: null, currency: null, frequency: "monthly", next_expected_date: null },
    ];
    const { outflow } = projectRecurring(rows);
    expect(outflow).toBe(0);
  });

  test("skips rows with expected_amount <= 0", () => {
    const rows: RecurringRow[] = [
      { id: "1", merchant_normalized: "Refund", category_id: null, expected_amount: 0, currency: null, frequency: "monthly", next_expected_date: null },
      { id: "2", merchant_normalized: "Negative", category_id: null, expected_amount: -50, currency: null, frequency: "monthly", next_expected_date: null },
    ];
    const { outflow } = projectRecurring(rows);
    expect(outflow).toBe(0);
  });

  test("deduplicates merchants", () => {
    const rows: RecurringRow[] = [
      { id: "1", merchant_normalized: "Netflix", category_id: null, expected_amount: 100, currency: null, frequency: "monthly", next_expected_date: null },
      { id: "2", merchant_normalized: "Netflix", category_id: null, expected_amount: 100, currency: null, frequency: "monthly", next_expected_date: null },
    ];
    const { outflow, merchants } = projectRecurring(rows);
    // outflow still doubles (two subscriptions)
    expect(outflow).toBeCloseTo(200, 5);
    // but merchants deduped to one
    expect(merchants).toHaveLength(1);
  });

  test("applies frequency multiplier for weekly", () => {
    const rows: RecurringRow[] = [
      { id: "1", merchant_normalized: "Parking", category_id: null, expected_amount: 10, currency: null, frequency: "weekly", next_expected_date: null },
    ];
    const { outflow } = projectRecurring(rows);
    expect(outflow).toBeCloseTo(10 * (52 / 12), 4);
  });
});

// ─── computeForecast ──────────────────────────────────────────────────────────

describe("computeForecast", () => {
  const history: MonthlyTotals[] = [
    { year: 2026, month: 1, in: 5000, out: 3000 },
    { year: 2026, month: 2, in: 6000, out: 4000 },
  ];

  test("returns correct number of points", () => {
    const result = computeForecast(history, [], 3, "ZAR");
    expect(result.points).toHaveLength(3);
    expect(result.horizon).toBe(3);
    expect(result.currency).toBe("ZAR");
  });

  test("clamps horizon to 1–24", () => {
    expect(computeForecast(history, [], 0, "ZAR").horizon).toBe(3);
    expect(computeForecast(history, [], 100, "ZAR").horizon).toBe(24);
  });

  test("computes projected_net = blended_in - blended_out", () => {
    // avg in = 5500, avg out = 3500, no recurring → blended = 5500, 3500
    const result = computeForecast(history, [], 1, "ZAR");
    expect(result.points[0].projected_inflow).toBeCloseTo(5500, 1);
    expect(result.points[0].projected_outflow).toBeCloseTo(3500, 1);
    expect(result.points[0].projected_net).toBeCloseTo(2000, 1);
  });

  test("uses recurring outflow when it exceeds historical average", () => {
    const recurring: RecurringRow[] = [
      { id: "r1", merchant_normalized: "BigBill", category_id: null, expected_amount: 9000, currency: null, frequency: "monthly", next_expected_date: null },
    ];
    const result = computeForecast(history, recurring, 1, "ZAR");
    // recurring outflow = 9000 > avg out 3500 → blended out = 9000
    expect(result.points[0].projected_outflow).toBeCloseTo(9000, 1);
  });

  test("running balance accumulates across points", () => {
    const result = computeForecast(history, [], 3, "ZAR");
    const net = result.points[0].projected_net;
    expect(result.points[0].projected_balance).toBeCloseTo(net, 2);
    expect(result.points[1].projected_balance).toBeCloseTo(net * 2, 2);
    expect(result.points[2].projected_balance).toBeCloseTo(net * 3, 2);
  });

  test("no history → zero baseline assumption", () => {
    const result = computeForecast([], [], 1, "ZAR");
    expect(result.assumptions.some((a) => a.includes("zero baseline"))).toBe(true);
    expect(result.points[0].projected_inflow).toBe(0);
    expect(result.points[0].projected_outflow).toBe(0);
  });

  test("includes recurring merchant assumption when merchants present", () => {
    const recurring: RecurringRow[] = [
      { id: "r1", merchant_normalized: "Gym", category_id: null, expected_amount: 500, currency: null, frequency: "monthly", next_expected_date: null },
    ];
    const result = computeForecast(history, recurring, 1, "ZAR");
    expect(result.assumptions.some((a) => a.includes("recurring merchant"))).toBe(true);
  });

  test("month labels are sequential YYYY-MM strings", () => {
    const result = computeForecast(history, [], 3, "ZAR");
    for (const p of result.points) {
      expect(p.month).toMatch(/^\d{4}-\d{2}$/);
    }
    // Each month label should be different.
    const labels = result.points.map((p) => p.month);
    expect(new Set(labels).size).toBe(3);
  });
});

// ─── detectDuplicates ─────────────────────────────────────────────────────────

const NOW = new Date("2026-06-01T12:00:00Z");

function makeTx(overrides: Partial<TxRow>): TxRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    posted_date: "2026-05-15T00:00:00Z",
    merchant_normalized: "Uber",
    category_id: null,
    amount: 100,
    currency: "ZAR",
    direction: "debit",
    ...overrides,
  };
}

describe("detectDuplicates", () => {
  test("flags two identical-amount transactions within window", () => {
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", posted_date: "2026-05-10T00:00:00Z" }),
      makeTx({ id: "00000000-0000-0000-0000-000000000002", posted_date: "2026-05-12T00:00:00Z" }),
    ];
    const anomalies = detectDuplicates(txs, NOW);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].type).toBe("duplicate");
    expect(anomalies[0].severity).toBe("high");
  });

  test("does not flag transactions outside the 3-day window", () => {
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", posted_date: "2026-05-01T00:00:00Z" }),
      makeTx({ id: "00000000-0000-0000-0000-000000000002", posted_date: "2026-05-10T00:00:00Z" }),
    ];
    const anomalies = detectDuplicates(txs, NOW);
    expect(anomalies).toHaveLength(0);
  });

  test("different merchants are not flagged", () => {
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", merchant_normalized: "Uber", posted_date: "2026-05-10T00:00:00Z" }),
      makeTx({ id: "00000000-0000-0000-0000-000000000002", merchant_normalized: "Bolt", posted_date: "2026-05-11T00:00:00Z" }),
    ];
    const anomalies = detectDuplicates(txs, NOW);
    expect(anomalies).toHaveLength(0);
  });

  test("different amounts at same merchant not flagged", () => {
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", amount: 100, posted_date: "2026-05-10T00:00:00Z" }),
      makeTx({ id: "00000000-0000-0000-0000-000000000002", amount: 200, posted_date: "2026-05-11T00:00:00Z" }),
    ];
    const anomalies = detectDuplicates(txs, NOW);
    expect(anomalies).toHaveLength(0);
  });

  test("skips transactions with null amount or date", () => {
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", amount: null }),
      makeTx({ id: "00000000-0000-0000-0000-000000000002", posted_date: null }),
    ];
    expect(detectDuplicates(txs, NOW)).toHaveLength(0);
  });
});

// ─── detectUnusualSpend ───────────────────────────────────────────────────────

describe("detectUnusualSpend", () => {
  const catId = "cat-aaaa-bbbb-cccc-ddddeeeeffff";

  // History: mean=100, values spread around it.
  const history = new Map([[catId, [80, 90, 100, 110, 120]]]);

  test("flags transaction > 2.5 stddev above mean as medium", () => {
    // mean ≈ 100, stddev = std([80,90,100,110,120]) ≈ 14.14 → floor=14.14
    // z=2.5 threshold: amount needs to be > 100 + 2.5*14.14 ≈ 135.35
    // Use 200 to be safe.
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", category_id: catId, amount: 200, direction: "debit" }),
    ];
    const anomalies = detectUnusualSpend(txs, history, NOW);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].type).toBe("unusual_spend");
  });

  test("flags z>4 as high severity", () => {
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", category_id: catId, amount: 1000, direction: "debit" }),
    ];
    const anomalies = detectUnusualSpend(txs, history, NOW);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].severity).toBe("high");
  });

  test("does not flag credit transactions", () => {
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", category_id: catId, amount: 1000, direction: "credit" }),
    ];
    expect(detectUnusualSpend(txs, history, NOW)).toHaveLength(0);
  });

  test("skips categories with < 2 historical data points", () => {
    const thinHistory = new Map([[catId, [100]]]);
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", category_id: catId, amount: 999, direction: "debit" }),
    ];
    expect(detectUnusualSpend(txs, thinHistory, NOW)).toHaveLength(0);
  });

  test("does not flag normal spend", () => {
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", category_id: catId, amount: 105, direction: "debit" }),
    ];
    expect(detectUnusualSpend(txs, history, NOW)).toHaveLength(0);
  });
});

// ─── detectMissingReceipts ────────────────────────────────────────────────────

describe("detectMissingReceipts", () => {
  test("flags high-value debit without reconciliation", () => {
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", amount: 1000, direction: "debit" }),
    ];
    const anomalies = detectMissingReceipts(txs, new Set(), NOW);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].type).toBe("missing_receipt");
    expect(anomalies[0].severity).toBe("medium");
  });

  test("does not flag if transaction is reconciled", () => {
    const id = "00000000-0000-0000-0000-000000000001";
    const txs: TxRow[] = [
      makeTx({ id, amount: 1000, direction: "debit" }),
    ];
    expect(detectMissingReceipts(txs, new Set([id]), NOW)).toHaveLength(0);
  });

  test("does not flag below threshold (500)", () => {
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", amount: 499, direction: "debit" }),
    ];
    expect(detectMissingReceipts(txs, new Set(), NOW)).toHaveLength(0);
  });

  test("does not flag credit transactions", () => {
    const txs: TxRow[] = [
      makeTx({ id: "00000000-0000-0000-0000-000000000001", amount: 5000, direction: "credit" }),
    ];
    expect(detectMissingReceipts(txs, new Set(), NOW)).toHaveLength(0);
  });
});

// ─── computeTaxReadiness ──────────────────────────────────────────────────────

describe("computeTaxReadiness", () => {
  test("all-clear scenario gives high score", () => {
    const data: TaxReadinessData = {
      vat_output: 1000,
      vat_input: 600,
      total_expenses: 100,
      documented_expenses: 100,
      unreconciled_count: 0,
    };
    const result = computeTaxReadiness(data);
    // VAT 40 + doc 40 + recon 20 = 100
    expect(result.score).toBe(100);
    expect(result.vat_position).toBeCloseTo(400, 2);
    expect(result.documented_expense_pct).toBe(100);
    expect(result.unreconciled_count).toBe(0);
    expect(result.components).toHaveLength(3);
  });

  test("no VAT data → VAT score 0, component status warn", () => {
    const data: TaxReadinessData = {
      vat_output: 0,
      vat_input: 0,
      total_expenses: 100,
      documented_expenses: 100,
      unreconciled_count: 0,
    };
    const result = computeTaxReadiness(data);
    const vatComp = result.components.find((c) => c.label === "VAT position");
    expect(vatComp?.status).toBe("warn");
    expect(result.vat_position).toBeUndefined();
  });

  test("refund VAT position → 20 pts, status warn", () => {
    const data: TaxReadinessData = {
      vat_output: 300,
      vat_input: 600, // net = -300 (refund)
      total_expenses: 100,
      documented_expenses: 100,
      unreconciled_count: 0,
    };
    const result = computeTaxReadiness(data);
    expect(result.vat_position).toBeCloseTo(-300, 2);
    const vatComp = result.components.find((c) => c.label === "VAT position");
    expect(vatComp?.status).toBe("warn");
    // VAT 20 + doc 40 + recon 20 = 80
    expect(result.score).toBe(80);
  });

  test("low doc coverage → error status", () => {
    const data: TaxReadinessData = {
      vat_output: 1000,
      vat_input: 600,
      total_expenses: 100,
      documented_expenses: 30, // 30%
      unreconciled_count: 0,
    };
    const result = computeTaxReadiness(data);
    const docComp = result.components.find((c) => c.label === "Expense documentation");
    expect(docComp?.status).toBe("error");
    expect(result.documented_expense_pct).toBeCloseTo(30, 1);
  });

  test("unreconciled > 50 → error, score reduction", () => {
    const data: TaxReadinessData = {
      vat_output: 1000,
      vat_input: 600,
      total_expenses: 100,
      documented_expenses: 100,
      unreconciled_count: 200,
    };
    const result = computeTaxReadiness(data);
    const reconComp = result.components.find((c) => c.label === "Reconciliation");
    expect(reconComp?.status).toBe("error");
    // recon score floors at 0 (200/10 = 20 reduction → 20-20=0)
    // VAT 40 + doc 40 + recon 0 = 80
    expect(result.score).toBe(80);
  });

  test("score is capped at 100 and floored at 0", () => {
    // Should never exceed 100
    const dataMax: TaxReadinessData = {
      vat_output: 9999,
      vat_input: 0,
      total_expenses: 100,
      documented_expenses: 100,
      unreconciled_count: 0,
    };
    expect(computeTaxReadiness(dataMax).score).toBe(100);

    // 0 VAT + 0 docs + 200 unreconciled → should floor at 0, not go negative
    const dataMin: TaxReadinessData = {
      vat_output: 0,
      vat_input: 0,
      total_expenses: 100,
      documented_expenses: 0,
      unreconciled_count: 9999,
    };
    expect(computeTaxReadiness(dataMin).score).toBeGreaterThanOrEqual(0);
  });
});
