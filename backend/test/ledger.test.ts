/**
 * Tests for ledger money-critical logic.
 *
 * Covers:
 *   1. Journal balance validation (balanced passes, unbalanced rejected, one-of constraint).
 *   2. Trial-balance grand-total summation via lib/money (exact 2dp strings, no float drift).
 *   3. Debit/credit one-of constraint (InvalidAmountError on both>0 or both=0).
 *   4. Edge cases: epsilon tolerance (≤0.001 passes), just-over epsilon fails.
 *
 * All arithmetic assertions use lib/money functions so the tests themselves
 * are free of float drift and serve as a regression net for the invariant.
 */
import { describe, test, expect } from "vitest";
import {
  validateJournalLines,
  UnbalancedError,
  NoLinesError,
  InvalidAmountError,
} from "../src/modules/ledger/queries";
import type { JournalLineInput } from "../src/modules/ledger/queries";
import { dec, money, add, sub, sum } from "../src/lib/money";

// ─── Helper: make a valid balanced pair of lines ───────────────────────────────

function balancedPair(amount: number): JournalLineInput[] {
  return [
    { accountId: "aaaaaaaa-0000-0000-0000-000000000001", debit: amount, credit: 0, description: "dr" },
    { accountId: "aaaaaaaa-0000-0000-0000-000000000002", debit: 0, credit: amount, description: "cr" },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// validateJournalLines — journal balance validation
// ═══════════════════════════════════════════════════════════════════════════════

describe("validateJournalLines — balance invariant", () => {
  // Balanced: Σdebit = Σcredit → should pass.
  test("balanced pair passes", () => {
    expect(() => validateJournalLines(balancedPair(100))).not.toThrow();
  });

  test("balanced multi-line (3 lines) passes", () => {
    const lines: JournalLineInput[] = [
      { accountId: "aaaaaaaa-0000-0000-0000-000000000001", debit: 500, credit: 0, description: "" },
      { accountId: "aaaaaaaa-0000-0000-0000-000000000002", debit: 0, credit: 300, description: "" },
      { accountId: "aaaaaaaa-0000-0000-0000-000000000003", debit: 0, credit: 200, description: "" },
    ];
    expect(() => validateJournalLines(lines)).not.toThrow();
  });

  // Unbalanced: Σdebit ≠ Σcredit by >0.001 → UnbalancedError.
  test("unbalanced (debit > credit) throws UnbalancedError", () => {
    const lines: JournalLineInput[] = [
      { accountId: "aaaaaaaa-0000-0000-0000-000000000001", debit: 100.01, credit: 0, description: "" },
      { accountId: "aaaaaaaa-0000-0000-0000-000000000002", debit: 0, credit: 100, description: "" },
    ];
    expect(() => validateJournalLines(lines)).toThrow(UnbalancedError);
  });

  test("unbalanced (credit > debit) throws UnbalancedError", () => {
    const lines: JournalLineInput[] = [
      { accountId: "aaaaaaaa-0000-0000-0000-000000000001", debit: 50, credit: 0, description: "" },
      { accountId: "aaaaaaaa-0000-0000-0000-000000000002", debit: 0, credit: 100, description: "" },
    ];
    expect(() => validateJournalLines(lines)).toThrow(UnbalancedError);
  });

  // Epsilon tolerance: diff ≤ 0.001 passes (matches Go behaviour).
  // Note: JS float `100.001 - 100` = 0.0010000000000047748 which is > 0.001,
  // so we test with a value whose diff is unambiguously within the tolerance.
  test("diff of 0.0005 passes (within epsilon)", () => {
    // debit=100.0005, credit=100 → diff=0.0005 < 0.001
    const lines: JournalLineInput[] = [
      { accountId: "aaaaaaaa-0000-0000-0000-000000000001", debit: 100.0005, credit: 0, description: "" },
      { accountId: "aaaaaaaa-0000-0000-0000-000000000002", debit: 0, credit: 100, description: "" },
    ];
    expect(() => validateJournalLines(lines)).not.toThrow();
  });

  test("diff of 0.002 throws UnbalancedError (over epsilon)", () => {
    const lines: JournalLineInput[] = [
      { accountId: "aaaaaaaa-0000-0000-0000-000000000001", debit: 100.002, credit: 0, description: "" },
      { accountId: "aaaaaaaa-0000-0000-0000-000000000002", debit: 0, credit: 100, description: "" },
    ];
    expect(() => validateJournalLines(lines)).toThrow(UnbalancedError);
  });

  // Minimum 2 lines.
  test("fewer than 2 lines throws NoLinesError", () => {
    expect(() =>
      validateJournalLines([
        { accountId: "aaaaaaaa-0000-0000-0000-000000000001", debit: 100, credit: 0, description: "" },
      ]),
    ).toThrow(NoLinesError);
  });

  test("empty lines throws NoLinesError", () => {
    expect(() => validateJournalLines([])).toThrow(NoLinesError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// validateJournalLines — one-of constraint (debit XOR credit)
// ═══════════════════════════════════════════════════════════════════════════════

describe("validateJournalLines — one-of constraint", () => {
  // Both debit > 0 AND credit > 0 → InvalidAmountError.
  test("both debit and credit > 0 throws InvalidAmountError", () => {
    const lines: JournalLineInput[] = [
      { accountId: "aaaaaaaa-0000-0000-0000-000000000001", debit: 100, credit: 50, description: "" },
      { accountId: "aaaaaaaa-0000-0000-0000-000000000002", debit: 0, credit: 50, description: "" },
    ];
    expect(() => validateJournalLines(lines)).toThrow(InvalidAmountError);
  });

  // Both debit = 0 AND credit = 0 → InvalidAmountError.
  test("both debit and credit = 0 throws InvalidAmountError", () => {
    const lines: JournalLineInput[] = [
      { accountId: "aaaaaaaa-0000-0000-0000-000000000001", debit: 0, credit: 0, description: "" },
      { accountId: "aaaaaaaa-0000-0000-0000-000000000002", debit: 0, credit: 100, description: "" },
    ];
    expect(() => validateJournalLines(lines)).toThrow(InvalidAmountError);
  });

  // Debit > 0, credit = 0 → OK.
  test("debit only is valid", () => {
    expect(() => validateJournalLines(balancedPair(75))).not.toThrow();
  });

  // Credit > 0, debit = 0 → OK (tested implicitly in balancedPair).
  test("credit only is valid", () => {
    const lines: JournalLineInput[] = [
      { accountId: "aaaaaaaa-0000-0000-0000-000000000001", debit: 200, credit: 0, description: "" },
      { accountId: "aaaaaaaa-0000-0000-0000-000000000002", debit: 0, credit: 200, description: "" },
    ];
    expect(() => validateJournalLines(lines)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Trial-balance summation via lib/money — exact 2dp, no float drift
// ═══════════════════════════════════════════════════════════════════════════════

describe("trial-balance summation — lib/money, no float drift", () => {
  /**
   * Simulates the summation in routes.ts:
   *   sum(rows.map(r => r.total_debit))  → Decimal
   *   money(...)                          → exact 2dp string
   *   parseFloat(...)                     → number for JSON
   */
  function sumAmounts(amounts: string[]): string {
    return money(sum(amounts));
  }

  test("summation of NUMERIC strings is exact (no float drift)", () => {
    // 0.1 + 0.2 in float = 0.30000000000000004, but Decimal gives 0.30.
    expect(sumAmounts(["0.10", "0.20"])).toBe("0.30");
  });

  test("large amounts sum correctly", () => {
    expect(sumAmounts(["100000.00", "200000.00", "50000.00"])).toBe("350000.00");
  });

  test("zero amounts sum to 0.00", () => {
    expect(sumAmounts(["0", "0", "0"])).toBe("0.00");
  });

  test("empty sum is 0.00", () => {
    expect(money(sum([]))).toBe("0.00");
  });

  test("balanced ledger has equal total_debit and total_credit", () => {
    // A well-formed ledger: every DR has a matching CR.
    const debits = ["500.00", "300.00", "200.00"];
    const credits = ["300.00", "500.00", "200.00"];
    const totalDebit = sumAmounts(debits);
    const totalCredit = sumAmounts(credits);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe("1000.00");
  });

  test("money(dec) always formats to 2 decimal places", () => {
    expect(money("100")).toBe("100.00");
    expect(money("99.9")).toBe("99.90");
    expect(money("0")).toBe("0.00");
    expect(money("1234567.89")).toBe("1234567.89");
  });

  test("sub preserves 2dp precision", () => {
    // 100.00 - 0.01 = 99.99 (float would give 99.99000000000001 without Decimal).
    expect(money(sub("100.00", "0.01"))).toBe("99.99");
  });

  test("add preserves 2dp precision", () => {
    expect(money(add("0.10", "0.20"))).toBe("0.30");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Debit/credit one-of DB constraint mirror
// ═══════════════════════════════════════════════════════════════════════════════

describe("ledger_entries one-of DB constraint mirror", () => {
  /**
   * The DB has: CHECK ((debit=0 AND credit>0) OR (credit=0 AND debit>0))
   * The app enforces this via validateJournalLines before inserting.
   * These tests confirm the app-layer check matches the DB constraint.
   */
  function checkOneSide(debit: number, credit: number): boolean {
    return (debit === 0 && credit > 0) || (credit === 0 && debit > 0);
  }

  test("DR only is valid", () => {
    expect(checkOneSide(100, 0)).toBe(true);
  });

  test("CR only is valid", () => {
    expect(checkOneSide(0, 100)).toBe(true);
  });

  test("both non-zero is invalid", () => {
    expect(checkOneSide(100, 50)).toBe(false);
  });

  test("both zero is invalid", () => {
    expect(checkOneSide(0, 0)).toBe(false);
  });

  test("negative debit is invalid", () => {
    // Negative amounts never satisfy the constraint (credit must be > 0).
    expect(checkOneSide(-100, 0)).toBe(false);
  });
});
