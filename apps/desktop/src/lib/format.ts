/** Formatting helpers. Money arrives as integer minor units — never floats. */

// ISO-4217 minor-unit exponents (mirrors slipscan-extract/src/currency.rs).
const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF",
  "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** ISO-4217 minor-unit exponent: 0 for JPY-class, 3 for BHD-class, else 2. */
export function minorExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** Minor units per whole unit for a currency (10^exponent). */
export function minorFactor(currency: string): number {
  return 10 ** minorExponent(currency);
}

const moneyFmtCache = new Map<string, Intl.NumberFormat>();

function moneyFmt(currency: string): Intl.NumberFormat {
  let fmt = moneyFmtCache.get(currency);
  if (!fmt) {
    // en-ZA renders ZAR as `R 1 234,56` — matches SA slip conventions.
    fmt = new Intl.NumberFormat("en-ZA", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    });
    moneyFmtCache.set(currency, fmt);
  }
  return fmt;
}

/**
 * `84235` → `R 842,35`. Pass `signed` to always show +/−.
 * Exponent-aware: JPY-class minor units divide by 1, BHD-class by 1000.
 */
export function fmtMoney(
  minor: number,
  currency = "ZAR",
  opts: { signed?: boolean } = {},
): string {
  const abs = moneyFmt(currency).format(Math.abs(minor) / minorFactor(currency));
  if (minor < 0) return `−${abs}`;
  if (opts.signed && minor > 0) return `+${abs}`;
  return abs;
}

const dateFmt = new Intl.DateTimeFormat("en-ZA", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** ISO-8601 UTC in, local short date out: `16 Jul 2026`. */
export function fmtDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}

const monthFmt = new Intl.DateTimeFormat("en-ZA", {
  month: "long",
  year: "numeric",
});

/** `2026-07` → `July 2026`. */
export function fmtMonth(month: string): string {
  return monthFmt.format(new Date(`${month}-01T12:00:00Z`));
}

/** `0.97` → `97%`. */
export function fmtPct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * Parse a user-typed amount into integer minor units for `currency`.
 * Accepts `1 234,56`, `1234.56`, `R 500`, `-84,10`. Returns null on garbage.
 * Exponent-aware: `1234` JPY → 1234 minor; `1.234` BHD → 1234 minor.
 */
export function parseMoneyInput(raw: string, currency = "ZAR"): number | null {
  const exp = minorExponent(currency);
  let s = raw.trim().replace(/[Rr]\s*/, "").replace(/\s+/g, "");
  if (s === "") return null;
  let negative = false;
  if (s.startsWith("-") || s.startsWith("−")) {
    negative = true;
    s = s.slice(1);
  }
  // Treat the last `.` or `,` as the decimal separator (when the currency
  // has decimals and few enough digits follow); strip the rest.
  const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let whole = s;
  let frac = "";
  if (lastSep !== -1 && exp > 0 && s.length - lastSep - 1 <= exp) {
    whole = s.slice(0, lastSep);
    frac = s.slice(lastSep + 1);
  }
  whole = whole.replace(/[.,]/g, "");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
  if (whole === "" && frac === "") return null;
  const minor =
    Number(whole || "0") * minorFactor(currency) +
    (exp > 0 ? Number((frac || "0").padEnd(exp, "0")) : 0);
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

/** Minor units → plain editable string: `84235` → `842.35` (exponent-aware). */
export function minorToInput(minor: number, currency = "ZAR"): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const exp = minorExponent(currency);
  if (exp === 0) return `${sign}${abs}`;
  const factor = minorFactor(currency);
  return `${sign}${Math.floor(abs / factor)}.${String(abs % factor).padStart(exp, "0")}`;
}

/** Short relative time: `2h ago`, `3d ago`. Falls back to the date. */
export function fmtRelative(iso: string, now = new Date()): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((now.getTime() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(iso);
}

/** Last day of a `YYYY-MM` month as `YYYY-MM-DD` (leap-year aware). */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

/** Shift a `YYYY-MM` month by n months. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
