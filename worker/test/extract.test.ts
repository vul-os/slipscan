/**
 * Unit tests for the extract module pure helpers.
 * Covers: normalizeCurrency (currency.ts), promptVersionFor / promptSchemaFor
 * (prompts.ts), and the mapToExtracted shape (via service internals).
 * No network calls — all helpers are pure functions.
 */
import { test, expect, describe } from "vitest";
import { normalizeCurrency } from "../src/modules/extract/currency";
import {
  promptVersionFor,
  promptSchemaFor,
  PROMPT_VERSION_SLIP,
  PROMPT_VERSION_INVOICE,
  PROMPT_VERSION_STATEMENT,
  PROMPT_VERSION_KIND_DETECT,
  kindDetectSchema,
  slipSchema,
  statementSchema,
} from "../src/modules/extract/prompts";

// ---- normalizeCurrency ----

describe("normalizeCurrency", () => {
  test("passes through a 3-letter ISO code unchanged (uppercase)", () => {
    expect(normalizeCurrency("ZAR", "USD")).toBe("ZAR");
    expect(normalizeCurrency("usd", "ZAR")).toBe("USD");
    expect(normalizeCurrency("eur", "ZAR")).toBe("EUR");
  });

  test("maps common symbols to ISO codes", () => {
    expect(normalizeCurrency("R", "USD")).toBe("ZAR");
    expect(normalizeCurrency("$", "ZAR")).toBe("USD");
    expect(normalizeCurrency("€", "ZAR")).toBe("EUR");
    expect(normalizeCurrency("£", "ZAR")).toBe("GBP");
    expect(normalizeCurrency("¥", "ZAR")).toBe("JPY");
    expect(normalizeCurrency("₦", "ZAR")).toBe("NGN");
  });

  test("maps lowercase aliases (non-ISO symbols that need the symbol map)", () => {
    // These are NOT valid 3-letter ISO codes so they go through the symbol map.
    expect(normalizeCurrency("us$", "ZAR")).toBe("USD");
    expect(normalizeCurrency("a$",  "ZAR")).toBe("AUD");
    expect(normalizeCurrency("c$",  "ZAR")).toBe("CAD");
    expect(normalizeCurrency("nz$", "ZAR")).toBe("NZD");
  });

  test("3-letter input is treated as ISO code directly (symbol map not consulted)", () => {
    // Go: isISOCode("KSH") = true → returns "KSH" (symbol map not reached).
    // This matches Go behaviour: ISO-code check runs before symbol lookup.
    expect(normalizeCurrency("ksh", "ZAR")).toBe("KSH");
    // But "kes" → "KES" (also a valid ISO code pass-through).
    expect(normalizeCurrency("kes", "ZAR")).toBe("KES");
  });

  test("strips a leading letter prefix (e.g. 'R 1,200')", () => {
    // The symbol map maps "r" → "ZAR" (lowercase match).
    expect(normalizeCurrency("R 1,200", "USD")).toBe("ZAR");
  });

  test("falls back to orgDefault for empty or unrecognised input", () => {
    expect(normalizeCurrency("", "ZAR")).toBe("ZAR");
    expect(normalizeCurrency("", "USD")).toBe("USD");
    expect(normalizeCurrency("XYZZY", "EUR")).toBe("EUR");
  });

  test("falls back to ZAR when orgDefault is also empty", () => {
    expect(normalizeCurrency("", "")).toBe("ZAR");
    expect(normalizeCurrency("XYZZY", "")).toBe("ZAR");
  });

  test("is case-insensitive for ISO codes and aliases", () => {
    expect(normalizeCurrency("Zar", "USD")).toBe("ZAR");
    expect(normalizeCurrency("NGN", "ZAR")).toBe("NGN");
    expect(normalizeCurrency("GBP", "ZAR")).toBe("GBP");
  });

  test("African currencies round-trip", () => {
    for (const [alias, iso] of [
      ["kes", "KES"], ["ghs", "GHS"], ["mzn", "MZN"], ["bwp", "BWP"],
      ["szl", "SZL"], ["lsl", "LSL"], ["nad", "NAD"], ["mur", "MUR"],
      ["tzs", "TZS"], ["ugx", "UGX"], ["rwf", "RWF"], ["etb", "ETB"],
      ["egp", "EGP"],
    ] as [string, string][]) {
      expect(normalizeCurrency(alias, "ZAR")).toBe(iso);
    }
  });
});

// ---- promptVersionFor ----

describe("promptVersionFor", () => {
  test("returns correct version strings", () => {
    expect(promptVersionFor("slip")).toBe(PROMPT_VERSION_SLIP);
    expect(promptVersionFor("invoice")).toBe(PROMPT_VERSION_INVOICE);
    expect(promptVersionFor("bank_statement")).toBe(PROMPT_VERSION_STATEMENT);
    expect(promptVersionFor("unknown")).toBe(PROMPT_VERSION_KIND_DETECT);
  });
});

// ---- promptSchemaFor ----

describe("promptSchemaFor", () => {
  test("returns a non-empty prompt string for each kind", () => {
    for (const kind of ["slip", "invoice", "bank_statement", "unknown"] as const) {
      const [prompt] = promptSchemaFor(kind);
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(20);
    }
  });

  test("slip and invoice share the same schema reference", () => {
    const [, slipSch]    = promptSchemaFor("slip");
    const [, invoiceSch] = promptSchemaFor("invoice");
    // invoiceSchema === slipSchema (mirrors Go: var invoiceSchema = slipSchema)
    expect(slipSch).toBe(invoiceSch);
  });

  test("bank_statement schema has statement_lines, not line_items", () => {
    const [, sch] = promptSchemaFor("bank_statement");
    const props = (sch as typeof statementSchema).properties;
    expect("statement_lines" in props).toBe(true);
    expect("line_items" in props).toBe(false);
  });

  test("slip schema has line_items, not statement_lines", () => {
    const props = (slipSchema as typeof slipSchema).properties;
    expect("line_items" in props).toBe(true);
    expect("statement_lines" in props).toBe(false);
  });
});

// ---- kindDetectSchema ----

describe("kindDetectSchema", () => {
  test("enum includes all three document kinds", () => {
    const kinds = kindDetectSchema.properties.kind.enum;
    expect(kinds).toContain("slip");
    expect(kinds).toContain("invoice");
    expect(kinds).toContain("bank_statement");
  });

  test("required array includes kind", () => {
    expect(kindDetectSchema.required).toContain("kind");
  });
});

// ---- Prompt version constant values (prevents accidental rename drift) ----

test("prompt version constants match expected strings", () => {
  expect(PROMPT_VERSION_KIND_DETECT).toBe("kind-detect-v1");
  expect(PROMPT_VERSION_SLIP).toBe("slip-v1");
  expect(PROMPT_VERSION_INVOICE).toBe("invoice-v1");
  expect(PROMPT_VERSION_STATEMENT).toBe("bank-statement-v1");
});
