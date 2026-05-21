import { describe, it, expect } from "vitest";
import {
  formatMoney,
  formatDate,
  formatConfidence,
  confidenceLevel,
} from "../format.js";

// ---------------------------------------------------------------------------
// formatMoney
// ---------------------------------------------------------------------------
describe("formatMoney", () => {
  it("returns an em dash for null amount", () => {
    expect(formatMoney(null)).toBe("—");
  });

  it("returns an em dash for undefined amount", () => {
    expect(formatMoney(undefined)).toBe("—");
  });

  it("returns an em dash for NaN", () => {
    expect(formatMoney(NaN)).toBe("—");
  });

  it("formats a positive ZAR amount (default currency)", () => {
    // The formatter uses en-ZA locale with ZAR currency. The exact symbol
    // string can vary by ICU version (e.g. "R" vs "ZAR"), so we assert the
    // numeric part appears and the result is a non-empty string.
    const result = formatMoney(1234.5);
    expect(result).not.toBe("—");
    expect(result).toMatch(/1\s*[,.]?\s*234/); // thousands separator varies
    // Contains a currency marker
    expect(result.length).toBeGreaterThan(3);
  });

  it("formats zero correctly", () => {
    const result = formatMoney(0, "ZAR");
    expect(result).not.toBe("—");
  });

  it("uses the provided currency", () => {
    const result = formatMoney(100, "USD");
    expect(result).not.toBe("—");
    // USD symbol or code present in output
    expect(result).toMatch(/USD|US\$|\$/);
  });

  it("handles negative amounts", () => {
    const result = formatMoney(-50, "ZAR");
    expect(result).not.toBe("—");
    expect(result).toMatch(/-|−/); // minus sign (hyphen or unicode)
  });

  it("falls back gracefully for an unknown currency code", () => {
    // An invalid currency causes Intl to throw; the catch block returns
    // "FAKE 100.00" style string.
    const result = formatMoney(100, "FAKE");
    expect(result).toContain("100");
  });
});

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------
describe("formatDate", () => {
  it("returns em dash for null", () => {
    expect(formatDate(null)).toBe("—");
  });

  it("returns em dash for empty string", () => {
    expect(formatDate("")).toBe("—");
  });

  it("returns em dash for an invalid date string", () => {
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("formats an ISO date string", () => {
    // 2024-03-15 should render as a human date like "15 Mar 2024"
    const result = formatDate("2024-03-15");
    expect(result).not.toBe("—");
    expect(result).toMatch(/2024/);
    expect(result).toMatch(/Mar|03/i);
  });

  it("formats a Date object", () => {
    const d = new Date("2025-01-01T00:00:00Z");
    const result = formatDate(d);
    expect(result).not.toBe("—");
    expect(result).toMatch(/2025/);
  });

  it("handles ISO datetime strings", () => {
    const result = formatDate("2024-07-04T12:00:00.000Z");
    expect(result).not.toBe("—");
    expect(result).toMatch(/2024/);
  });
});

// ---------------------------------------------------------------------------
// formatConfidence
// ---------------------------------------------------------------------------
describe("formatConfidence", () => {
  it("returns em dash for null", () => {
    expect(formatConfidence(null)).toBe("—");
  });

  it("returns em dash for undefined", () => {
    expect(formatConfidence(undefined)).toBe("—");
  });

  it("returns em dash for NaN", () => {
    expect(formatConfidence(NaN)).toBe("—");
  });

  it("formats 0 as 0%", () => {
    expect(formatConfidence(0)).toBe("0%");
  });

  it("formats 1 as 100%", () => {
    expect(formatConfidence(1)).toBe("100%");
  });

  it("formats 0.5 as 50%", () => {
    expect(formatConfidence(0.5)).toBe("50%");
  });

  it("rounds to nearest integer percent", () => {
    // 0.856 → 86%
    expect(formatConfidence(0.856)).toBe("86%");
  });

  it("formats 0.001 as 0%", () => {
    expect(formatConfidence(0.001)).toBe("0%");
  });
});

// ---------------------------------------------------------------------------
// confidenceLevel — bucket mapping
// ---------------------------------------------------------------------------
describe("confidenceLevel", () => {
  it("returns 'unknown' for null", () => {
    expect(confidenceLevel(null)).toBe("unknown");
  });

  it("returns 'unknown' for undefined", () => {
    expect(confidenceLevel(undefined)).toBe("unknown");
  });

  it("returns 'unknown' for NaN", () => {
    expect(confidenceLevel(NaN)).toBe("unknown");
  });

  // High bucket: ≥ 0.85
  it("returns 'high' for exactly 0.85", () => {
    expect(confidenceLevel(0.85)).toBe("high");
  });

  it("returns 'high' for 1.0", () => {
    expect(confidenceLevel(1.0)).toBe("high");
  });

  it("returns 'high' for 0.99", () => {
    expect(confidenceLevel(0.99)).toBe("high");
  });

  // Medium bucket: ≥ 0.60 and < 0.85
  it("returns 'medium' for exactly 0.60", () => {
    expect(confidenceLevel(0.6)).toBe("medium");
  });

  it("returns 'medium' for 0.84", () => {
    expect(confidenceLevel(0.84)).toBe("medium");
  });

  it("returns 'medium' for 0.70", () => {
    expect(confidenceLevel(0.7)).toBe("medium");
  });

  // Low bucket: < 0.60
  it("returns 'low' for 0.59", () => {
    expect(confidenceLevel(0.59)).toBe("low");
  });

  it("returns 'low' for 0.0", () => {
    expect(confidenceLevel(0)).toBe("low");
  });

  it("returns 'low' for 0.001", () => {
    expect(confidenceLevel(0.001)).toBe("low");
  });

  // Edge: just below boundary
  it("returns 'medium' for 0.8499", () => {
    expect(confidenceLevel(0.8499)).toBe("medium");
  });

  it("returns 'low' for 0.5999", () => {
    expect(confidenceLevel(0.5999)).toBe("low");
  });
});
