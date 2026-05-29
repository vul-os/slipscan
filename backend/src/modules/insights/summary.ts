/**
 * Insights summaries — port of Go backend/internal/insights/summary.go.
 *
 * Summaries are deterministic — generated from actual query results, not by
 * asking the model to summarise (which would hallucinate numbers).
 */
import type { Filters, Totals, Group } from "./types";

// ─── Public summarizers ───────────────────────────────────────────────────────

/** Port of Go summarizeList. */
export function summarizeList(f: Filters, n: number): string {
  let base: string;
  if (n === 0) {
    base = "No receipts found";
  } else if (n === 1) {
    base = "Found 1 receipt";
  } else {
    base = `Found ${n} receipts`;
  }
  const extra = describeFilter(f);
  return extra ? `${base} ${extra}.` : `${base}.`;
}

/** Port of Go summarizeSum. */
export function summarizeSum(f: Filters, t: Totals): string {
  if (t.count === 0) return "No matching receipts.";
  const currency = t.currency ? `${t.currency} ` : "";
  const plural = t.count === 1 ? "receipt" : "receipts";
  const amount = t.amount != null ? t.amount : 0;
  let base = `Total ${currency}${formatAmount(amount)} across ${t.count} ${plural}`;
  const extra = describeFilter(f);
  if (extra) base += ` ${extra}`;
  return `${base}.`;
}

/** Port of Go summarizeCount. */
export function summarizeCount(f: Filters, n: number): string {
  const plural = n === 1 ? "receipt" : "receipts";
  let base = `${n} ${plural}`;
  const extra = describeFilter(f);
  if (extra) base += ` ${extra}`;
  return `${base}.`;
}

/** Port of Go summarizeGroups. */
export function summarizeGroups(grouping: string, f: Filters, groups: Group[]): string {
  if (groups.length === 0) return "No matching receipts.";
  let head: string;
  switch (grouping) {
    case "merchant":
      head = `Top merchants by spend (${groups.length} shown)`;
      break;
    case "category":
      head = `Spend by category (${groups.length} shown)`;
      break;
    case "month":
      head = `Spend by month (${groups.length} shown)`;
      break;
    default:
      head = `Breakdown (${groups.length} rows)`;
  }
  const extra = describeFilter(f);
  if (extra) head += ` ${extra}`;
  return `${head}.`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Port of Go describeFilter — renders active filters as a human phrase. */
function describeFilter(f: Filters): string {
  const parts: string[] = [];

  if (f.merchant_contains) {
    parts.push(`matching "${f.merchant_contains}"`);
  }
  if (f.category) {
    parts.push(`in ${f.category}`);
  }
  if (f.date_from && f.date_to) {
    parts.push(`between ${f.date_from} and ${f.date_to}`);
  } else if (f.date_from) {
    parts.push(`from ${f.date_from}`);
  } else if (f.date_to) {
    parts.push(`up to ${f.date_to}`);
  }
  if (f.amount_min != null && f.amount_max != null) {
    parts.push(`between ${formatAmount(f.amount_min)} and ${formatAmount(f.amount_max)}`);
  } else if (f.amount_min != null) {
    parts.push(`over ${formatAmount(f.amount_min)}`);
  } else if (f.amount_max != null) {
    parts.push(`under ${formatAmount(f.amount_max)}`);
  }
  if (f.currency) {
    parts.push(`in ${f.currency}`);
  }
  if (f.status) {
    parts.push(`(${f.status})`);
  }
  return parts.join(" ");
}

/** Port of Go formatAmount — tabular two-decimal representation. */
function formatAmount(f: number): string {
  return f.toFixed(2);
}
