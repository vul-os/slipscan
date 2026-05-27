/**
 * FX rate client — port of backend/internal/fx/client.go.
 *
 * Provider choice (matches Go comments):
 *  - Default: frankfurter.app  — free, no key, ECB data, covers ZAR + majors.
 *  - If EXCHANGE_RATE_API_KEY is set: exchangerate-api.com v6 (keyed).
 *
 * No timer/scheduler here — the Worker's scheduled() handler is the scheduler.
 * Export syncFxRates(env) for wiring into cron/scheduled.ts.
 */

export const FRANKFURTER_BASE = "https://api.frankfurter.app";
export const ER_API_BASE      = "https://v6.exchangerate-api.com/v6";

export interface FetchResult {
  base:  string;
  rates: Record<string, number>; // quote → rate
  asOf:  Date;                   // truncated to midnight UTC
}

// ── Frankfurter response shape ────────────────────────────────────────────────

interface FrankfurterResponse {
  base:  string;
  date:  string;            // "2025-05-21"
  rates: Record<string, number>;
}

// ── exchangerate-api.com v6 response shape ────────────────────────────────────

interface ERAPIResponse {
  result:               string; // "success" | "error"
  "error-type"?:        string;
  base_code:            string;
  time_last_update_utc: string; // RFC1123Z, e.g. "Thu, 21 May 2026 00:00:01 +0000"
  conversion_rates:     Record<string, number>;
}

// ── Main fetch entry-point ────────────────────────────────────────────────────

/**
 * Fetch today's rates for all currencies relative to `base`.
 * When apiKey is non-empty exchangerate-api.com v6 is used, otherwise
 * Frankfurter is used (free, no sign-up).
 *
 * The baseURL parameter is for test injection only (not exported).
 */
export async function fetchRates(
  base:    string,
  apiKey?: string,
  baseURL?: string,
): Promise<FetchResult> {
  if (apiKey) {
    return fetchERAPI(base, apiKey, baseURL ?? ER_API_BASE);
  }
  return fetchFrankfurter(base, baseURL ?? FRANKFURTER_BASE);
}

// ── Frankfurter ───────────────────────────────────────────────────────────────

async function fetchFrankfurter(base: string, baseURL: string): Promise<FetchResult> {
  const url  = `${baseURL}/latest?from=${encodeURIComponent(base)}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });

  if (!resp.ok) {
    throw new Error(`fx: provider returned HTTP ${resp.status}`);
  }

  const body = (await resp.json()) as FrankfurterResponse;

  const asOf = parseDateUTC(body.date);
  if (!asOf) throw new Error(`fx: parse date "${body.date}"`);

  return { base: body.base, rates: body.rates, asOf };
}

// ── exchangerate-api.com v6 ───────────────────────────────────────────────────

async function fetchERAPI(base: string, apiKey: string, baseURL: string): Promise<FetchResult> {
  const url  = `${baseURL}/${encodeURIComponent(apiKey)}/latest/${encodeURIComponent(base)}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });

  if (!resp.ok) {
    throw new Error(`fx: provider returned HTTP ${resp.status}`);
  }

  const body = (await resp.json()) as ERAPIResponse;

  if (body.result !== "success") {
    throw new Error(`fx: provider error: ${body["error-type"] ?? "unknown"}`);
  }

  // Parse RFC1123Z timestamp then truncate to date midnight UTC.
  let asOf: Date;
  const parsed = new Date(body.time_last_update_utc);
  if (isNaN(parsed.getTime())) {
    asOf = truncateToDay(new Date());
  } else {
    asOf = truncateToDay(parsed);
  }

  return { base: body.base_code, rates: body.conversion_rates, asOf };
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Parse "YYYY-MM-DD" string to a Date at midnight UTC; returns null on failure. */
export function parseDateUTC(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/** Truncate a Date to midnight UTC (strips hours/mins/secs/ms). */
export function truncateToDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
