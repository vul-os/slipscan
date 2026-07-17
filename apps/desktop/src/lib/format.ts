/** Formatting helpers. Money arrives as integer minor units — never floats. */

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

/** `84235` → `R 842,35`. Pass `signed` to always show +/−. */
export function fmtMoney(
  minor: number,
  currency = "ZAR",
  opts: { signed?: boolean } = {},
): string {
  const abs = moneyFmt(currency).format(Math.abs(minor) / 100);
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
 * Parse a user-typed amount into integer minor units.
 * Accepts `1 234,56`, `1234.56`, `R 500`, `-84,10`. Returns null on garbage.
 */
export function parseMoneyInput(raw: string): number | null {
  let s = raw.trim().replace(/[Rr]\s*/, "").replace(/\s+/g, "");
  if (s === "") return null;
  let negative = false;
  if (s.startsWith("-") || s.startsWith("−")) {
    negative = true;
    s = s.slice(1);
  }
  // Treat the last `.` or `,` as the decimal separator; strip the rest.
  const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let whole = s;
  let frac = "";
  if (lastSep !== -1 && s.length - lastSep - 1 <= 2) {
    whole = s.slice(0, lastSep);
    frac = s.slice(lastSep + 1);
  }
  whole = whole.replace(/[.,]/g, "");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
  if (whole === "" && frac === "") return null;
  const minor =
    Number(whole || "0") * 100 + Number((frac || "0").padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

/** Minor units → plain editable string: `84235` → `842.35`. */
export function minorToInput(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
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
