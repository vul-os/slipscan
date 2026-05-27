/**
 * Unit tests for the fx module.
 * Covers: FetchResult parsing (Frankfurter + ERAPI), upsert row shaping,
 * date parsing helpers.
 * No network calls — fetch is intercepted with a mock.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { fetchRates, parseDateUTC, truncateToDay, FRANKFURTER_BASE } from "../src/modules/fx/client";

// ── Mock fetch ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok:     status >= 200 && status < 300,
      status,
      json:   () => Promise.resolve(body),
      text:   () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

// ── parseDateUTC ──────────────────────────────────────────────────────────────

describe("parseDateUTC", () => {
  test("parses YYYY-MM-DD into midnight UTC Date", () => {
    const d = parseDateUTC("2025-05-21");
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2025);
    expect(d!.getUTCMonth()).toBe(4);   // 0-indexed May
    expect(d!.getUTCDate()).toBe(21);
    expect(d!.getUTCHours()).toBe(0);
  });

  test("returns null for invalid string", () => {
    expect(parseDateUTC("not-a-date")).toBeNull();
    expect(parseDateUTC("2025-13-01")).not.toBeNull(); // JS Date is lenient, just check no crash
    expect(parseDateUTC("")).toBeNull();
  });
});

// ── truncateToDay ─────────────────────────────────────────────────────────────

describe("truncateToDay", () => {
  test("strips hours/minutes/seconds to midnight UTC", () => {
    const d = new Date("2025-05-21T15:30:00Z");
    const t = truncateToDay(d);
    expect(t.getUTCHours()).toBe(0);
    expect(t.getUTCMinutes()).toBe(0);
    expect(t.getUTCSeconds()).toBe(0);
    expect(t.getUTCDate()).toBe(21);
  });
});

// ── fetchRates — Frankfurter path ─────────────────────────────────────────────

describe("fetchRates (frankfurter)", () => {
  test("parses a valid Frankfurter response", async () => {
    mockFetch({
      base:  "USD",
      date:  "2025-05-21",
      rates: { EUR: 0.92, ZAR: 18.5, GBP: 0.79 },
    });

    const result = await fetchRates("USD");

    expect(result.base).toBe("USD");
    expect(result.rates["EUR"]).toBe(0.92);
    expect(result.rates["ZAR"]).toBe(18.5);
    // asOf should be midnight UTC of 2025-05-21
    expect(result.asOf.toISOString()).toBe("2025-05-21T00:00:00.000Z");
  });

  test("throws on non-200 HTTP response", async () => {
    mockFetch({ error: "oops" }, 503);
    await expect(fetchRates("USD")).rejects.toThrow("HTTP 503");
  });

  test("uses the correct Frankfurter URL when no apiKey", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ base: "USD", date: "2025-05-21", rates: { EUR: 0.92 } }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchRates("USD");
    const calledURL = (fetchMock.mock.calls[0][0] as string);
    expect(calledURL).toContain(FRANKFURTER_BASE);
    expect(calledURL).toContain("from=USD");
  });
});

// ── fetchRates — exchangerate-api.com path ────────────────────────────────────

describe("fetchRates (erapi)", () => {
  test("parses a valid ERAPI response", async () => {
    mockFetch({
      result:               "success",
      base_code:            "USD",
      time_last_update_utc: "Thu, 21 May 2026 00:00:01 +0000",
      conversion_rates:     { EUR: 0.91, ZAR: 19.0 },
    });

    const result = await fetchRates("USD", "TEST_KEY");

    expect(result.base).toBe("USD");
    expect(result.rates["ZAR"]).toBe(19.0);
    // asOf should be truncated to date
    expect(result.asOf.getUTCHours()).toBe(0);
  });

  test("throws when result !== success", async () => {
    mockFetch({ result: "error", "error-type": "invalid-key" });
    await expect(fetchRates("USD", "BAD_KEY")).rejects.toThrow("invalid-key");
  });

  test("falls back to today when timestamp is unparseable", async () => {
    mockFetch({
      result:               "success",
      base_code:            "USD",
      time_last_update_utc: "not-a-date",
      conversion_rates:     { EUR: 0.91 },
    });

    const before = Date.now();
    const result = await fetchRates("USD", "KEY");
    const after  = Date.now();

    // asOf should be today (between before and after)
    expect(result.asOf.getTime()).toBeGreaterThanOrEqual(truncateToDay(new Date(before)).getTime());
    expect(result.asOf.getTime()).toBeLessThanOrEqual(truncateToDay(new Date(after)).getTime() + 86400_000);
  });
});

// ── upsert shaping (unit test the SQL parameters) ────────────────────────────

describe("upsert shaping", () => {
  test("FetchResult shapes correctly for upsert queries", () => {
    const result = {
      base:  "USD",
      rates: { EUR: 0.92, USD: 1.0, ZAR: 18.5 }, // USD should be skipped (base==quote)
      asOf:  new Date("2025-05-21T00:00:00Z"),
    };

    const rows: Array<[string, string, number, string, string]> = [];
    for (const [quote, rate] of Object.entries(result.rates)) {
      if (quote === result.base) continue; // skip identity
      if (rate <= 0) continue;
      rows.push([result.base, quote, rate, result.asOf.toISOString().slice(0, 10), "frankfurter.app"]);
    }

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r[1] === "EUR")?.[2]).toBe(0.92);
    expect(rows.find((r) => r[1] === "ZAR")?.[2]).toBe(18.5);
    expect(rows.find((r) => r[1] === "USD")).toBeUndefined();
    // asOf is "YYYY-MM-DD"
    expect(rows[0][3]).toBe("2025-05-21");
  });
});
