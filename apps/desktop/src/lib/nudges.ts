/**
 * Local nudges engine (docs/ARCHITECTURE.md, "Insights, nudges & anonymous
 * peer benchmarks"): a small rules + stats pass over data the dashboard has
 * already fetched from core. Everything is computed on this machine; nothing
 * ever leaves it.
 *
 * Covered here: budget drift, duplicate charges, recurring-subscription
 * detection.
 */
import type { BudgetWithSpend, Category, Transaction } from "./api/types";
import { fmtMoney, localMonth } from "./format";

export type NudgeKind = "budget" | "duplicate" | "subscription";
export type NudgeSeverity = "info" | "warning" | "danger";

export interface Nudge {
  id: string;
  kind: NudgeKind;
  severity: NudgeSeverity;
  title: string;
  body: string;
}

const SEVERITY_ORDER: Record<NudgeSeverity, number> = {
  danger: 0,
  warning: 1,
  info: 2,
};

/** Days between two ISO timestamps/dates, absolute. */
function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return ms / 86_400_000;
}

/**
 * Budget drift: over budget is a problem now; burning faster than the month
 * is passing (with 15% grace) is a problem soon.
 */
function budgetNudges(budgets: BudgetWithSpend[], month: string): Nudge[] {
  const now = new Date();
  const currentMonth = localMonth(now);
  const daysInMonth = new Date(
    Number(month.slice(0, 4)),
    Number(month.slice(5, 7)),
    0,
  ).getDate();
  const monthProgress =
    month === currentMonth ? Math.min(1, now.getDate() / daysInMonth) : 1;

  const out: Nudge[] = [];
  for (const b of budgets) {
    if (b.amount_minor <= 0) continue;
    const ratio = b.spent_minor / b.amount_minor;
    if (ratio >= 1) {
      out.push({
        id: `budget-over-${b.category_id}`,
        kind: "budget",
        severity: "danger",
        title: `${b.category_name} is over budget`,
        body: `${fmtMoney(b.spent_minor, b.currency)} spent of ${fmtMoney(b.amount_minor, b.currency)} — ${fmtMoney(b.spent_minor - b.amount_minor, b.currency)} over.`,
      });
    } else if (ratio > monthProgress * 1.15 && ratio >= 0.5) {
      out.push({
        id: `budget-drift-${b.category_id}`,
        kind: "budget",
        severity: "warning",
        title: `${b.category_name} is burning fast`,
        body: `${Math.round(ratio * 100)}% used with ${Math.round(monthProgress * 100)}% of the month gone. ${fmtMoney(b.amount_minor - b.spent_minor, b.currency)} left.`,
      });
    }
  }
  return out;
}

/**
 * Duplicate charges: same account, same merchant/description, same outflow
 * amount, posted within 3 days of each other.
 */
function duplicateNudges(transactions: Transaction[]): Nudge[] {
  const out: Nudge[] = [];
  const seenPairs = new Set<string>();
  const byKey = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.amount_minor >= 0) continue;
    const who = (t.merchant ?? t.description).toLowerCase().trim();
    if (!who) continue;
    const key = `${t.account_id}|${who}|${t.amount_minor}`;
    const bucket = byKey.get(key) ?? [];
    bucket.push(t);
    byKey.set(key, bucket);
  }
  for (const bucket of byKey.values()) {
    if (bucket.length < 2) continue;
    const sorted = bucket
      .slice()
      .sort((a, b) => (a.posted_at < b.posted_at ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      if (daysBetween(a.posted_at, b.posted_at) > 3) continue;
      const pairKey = `${a.id}|${b.id}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      out.push({
        id: `dup-${pairKey}`,
        kind: "duplicate",
        severity: "warning",
        title: `Possible duplicate charge: ${b.merchant ?? b.description}`,
        body: `${fmtMoney(b.amount_minor, b.currency)} hit the same account twice within ${Math.max(1, Math.round(daysBetween(a.posted_at, b.posted_at)))} day(s). Worth checking the statement.`,
      });
    }
  }
  return out;
}

/**
 * Subscription detection: the same merchant charging a similar amount (±10%)
 * in two or more distinct months reads as recurring.
 */
function subscriptionNudges(transactions: Transaction[]): Nudge[] {
  const byMerchant = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.amount_minor >= 0 || !t.merchant) continue;
    const key = t.merchant.toLowerCase().trim();
    const bucket = byMerchant.get(key) ?? [];
    bucket.push(t);
    byMerchant.set(key, bucket);
  }

  const out: Nudge[] = [];
  for (const bucket of byMerchant.values()) {
    const months = new Set(bucket.map((t) => t.posted_at.slice(0, 7)));
    if (months.size < 2) continue;
    const amounts = bucket.map((t) => -t.amount_minor);
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    if (max > min * 1.1) continue; // not steady enough to be a subscription
    const latest = bucket.reduce((a, b) => (a.posted_at > b.posted_at ? a : b));
    const typical = Math.round(amounts.reduce((s, a) => s + a, 0) / amounts.length);
    out.push({
      id: `sub-${latest.merchant!.toLowerCase().replaceAll(/\s+/g, "-")}`,
      kind: "subscription",
      severity: "info",
      title: `Recurring: ${latest.merchant}`,
      body: `Looks like a subscription of about ${fmtMoney(typical, latest.currency)}/month (seen in ${months.size} months). Still worth it?`,
    });
  }
  return out;
}

/** Compute all nudges, most severe first, capped at `limit`. */
export function computeNudges(
  input: {
    transactions: Transaction[];
    budgets: BudgetWithSpend[];
    categories: Category[];
    month: string;
  },
  limit = 6,
): Nudge[] {
  // Transfers between own accounts are not spending signals.
  const transferIds = new Set(
    input.categories.filter((c) => c.kind === "transfer").map((c) => c.id),
  );
  const spendTxns = input.transactions.filter(
    (t) => !(t.category_id && transferIds.has(t.category_id)),
  );
  return [
    ...budgetNudges(input.budgets, input.month),
    ...duplicateNudges(spendTxns),
    ...subscriptionNudges(spendTxns),
  ]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, limit);
}
