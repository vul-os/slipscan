// Money/date formatting helpers. Prefer these to ad-hoc toFixed/toLocaleDateString
// so display rules stay consistent and tabular numerals line up everywhere.

const DEFAULT_LOCALE = "en-ZA";
const DEFAULT_CURRENCY = "ZAR";

export function formatMoney(amount, currency) {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
  const ccy = (currency || DEFAULT_CURRENCY).toUpperCase();
  try {
    return new Intl.NumberFormat(DEFAULT_LOCALE, {
      style: "currency",
      currency: ccy,
      currencyDisplay: "symbol",
    }).format(amount);
  } catch {
    return `${ccy} ${amount.toFixed(2)}`;
  }
}

export function formatNumber(amount, opts) {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
  return new Intl.NumberFormat(DEFAULT_LOCALE, opts).format(amount);
}

export function formatDate(value) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, { day: "2-digit", month: "short", year: "numeric" }).format(d);
}

export function formatDateLong(value) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, { day: "2-digit", month: "long", year: "numeric" }).format(d);
}

export function formatRelative(value) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(DEFAULT_LOCALE, { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return formatDate(d);
}

export function initials(name, fallback = "?") {
  if (!name) return fallback;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
