/**
 * Intelligence compute — port of Go backend/internal/intelligence/compute.go.
 * Pure functions: no I/O, no side effects. Safe to unit-test directly.
 */
import type {
  MonthlyTotals,
  RecurringRow,
  ForecastPoint,
  ForecastResult,
  TxRow,
  Anomaly,
  TaxReadinessData,
  TaxReadinessResult,
  TaxComponent,
} from "./types";

// ─── Math helpers ─────────────────────────────────────────────────────────────

/** Port of Go roundTwo — round to 2 decimal places (same half-up logic). */
export function roundTwo(f: number): number {
  const shifted = f * 100;
  const rounded = shifted < 0 ? Math.ceil(shifted - 0.5) : Math.floor(shifted + 0.5);
  return rounded / 100;
}

function mean(vals: number[]): number {
  if (vals.length === 0) return 0;
  let s = 0;
  for (const v of vals) s += v;
  return s / vals.length;
}

function stddev(vals: number[], m: number): number {
  if (vals.length < 2) return 0;
  let s = 0;
  for (const v of vals) {
    const d = v - m;
    s += d * d;
  }
  return Math.sqrt(s / vals.length);
}

// ─── Forecast ─────────────────────────────────────────────────────────────────

/** Port of Go frequencyMonthlyMultiplier. */
export function frequencyMonthlyMultiplier(freq: string): number {
  switch (freq) {
    case "weekly":    return 52.0 / 12.0;  // ~4.33
    case "biweekly":  return 26.0 / 12.0;  // ~2.17
    case "monthly":   return 1.0;
    case "quarterly": return 1.0 / 3.0;
    case "yearly":    return 1.0 / 12.0;
    default:          return 1.0;
  }
}

/** Port of Go joinMerchants — sorts, caps at max, joins with ", ". */
function joinMerchants(ms: string[], max: number): string {
  const sorted = [...ms].sort();
  if (sorted.length > max) {
    return `${sorted.slice(0, max).join(", ")} and more`;
  }
  return sorted.join(", ");
}

/**
 * Port of Go projectRecurring — sums monthly recurring outflows.
 * Recurring rows without an expected_amount are skipped.
 * All recurring treated as outflows (Go assumption surfaced in response).
 */
export function projectRecurring(rows: RecurringRow[]): { outflow: number; merchants: string[] } {
  const seen = new Set<string>();
  const merchants: string[] = [];
  let outflow = 0;
  for (const r of rows) {
    if (r.expected_amount == null || r.expected_amount <= 0) continue;
    const mult = frequencyMonthlyMultiplier(r.frequency);
    const monthly = r.expected_amount * mult;
    outflow += monthly;
    if (!seen.has(r.merchant_normalized)) {
      seen.add(r.merchant_normalized);
      merchants.push(r.merchant_normalized);
    }
  }
  return { outflow, merchants };
}

/**
 * Port of Go ComputeForecast — builds horizon-month cash-flow projection.
 * history must be ordered oldest → newest.
 */
export function computeForecast(
  history: MonthlyTotals[],
  recurring: RecurringRow[],
  horizon: number,
  currency: string,
): ForecastResult {
  if (horizon < 1) horizon = 3;
  if (horizon > 24) horizon = 24;

  // Historical averages.
  let totalIn = 0;
  let totalOut = 0;
  for (const h of history) {
    totalIn += h.in;
    totalOut += h.out;
  }
  const n = history.length;
  let avgIn = 0;
  let avgOut = 0;
  if (n > 0) {
    avgIn = totalIn / n;
    avgOut = totalOut / n;
  }

  // Recurring contribution.
  const { outflow: recurOut, merchants: recurMerchants } = projectRecurring(recurring);

  // Blend: use average as base; if recurring outflow > avg outflow, use recurring.
  const blendedOut = recurOut > avgOut ? recurOut : avgOut;
  const blendedIn = avgIn;

  // Build projection points — project from next month.
  const now = new Date();
  const startYear = now.getUTCFullYear();
  const startMonth = now.getUTCMonth() + 1; // 1-based

  // next month
  let projYear = startYear;
  let projMonth = startMonth + 1;
  if (projMonth > 12) { projMonth = 1; projYear++; }

  const points: ForecastPoint[] = [];
  let balance = 0.0;

  for (let i = 0; i < horizon; i++) {
    // month label
    let y = projYear;
    let m = projMonth + i;
    while (m > 12) { m -= 12; y++; }
    const label = `${y}-${String(m).padStart(2, "0")}`;

    const net = blendedIn - blendedOut;
    balance += net;
    points.push({
      month: label,
      projected_inflow: roundTwo(blendedIn),
      projected_outflow: roundTwo(blendedOut),
      projected_net: roundTwo(net),
      projected_balance: roundTwo(balance),
    });
  }

  // Surface assumptions.
  const assumptions: string[] = [];
  if (history.length === 0) {
    assumptions.push("No transaction history available; projection uses zero baseline");
  } else {
    assumptions.push(`Historical averages computed from ${history.length} month(s) of data`);
  }
  if (recurMerchants.length > 0) {
    assumptions.push(`${recurMerchants.length} recurring merchant(s) included: ${joinMerchants(recurMerchants, 5)}`);
  } else {
    assumptions.push("No active recurring transactions found");
  }
  assumptions.push("Recurring transactions treated as outflows (expense); override if merchant is income source");
  assumptions.push("Projection uses flat average; seasonality not modelled");

  return { horizon, currency, points, assumptions };
}

// ─── Anomaly detection ────────────────────────────────────────────────────────

const HIGH_VALUE_THRESHOLD = 500.0;
const DUPLICATE_DATE_WINDOW_DAYS = 3;

/**
 * Port of Go DetectDuplicates — finds pairs sharing merchant + amount within date window.
 */
export function detectDuplicates(txs: TxRow[], detectedAt: Date): Anomaly[] {
  // Group by merchant + amount (rounded to cents).
  const groups = new Map<string, { id: string; date: Date; amt: number; cur: string }[]>();

  for (const t of txs) {
    if (t.merchant_normalized == null || t.amount == null || t.posted_date == null) continue;
    const amtCents = Math.round(t.amount * 100);
    const key = `${t.merchant_normalized}:${amtCents}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({
      id: t.id,
      date: new Date(t.posted_date),
      amt: t.amount,
      cur: t.currency ?? "",
    });
  }

  const anomalies: Anomaly[] = [];
  const seen = new Set<string>();
  const windowMs = DUPLICATE_DATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    // Sort by date ascending.
    entries.sort((a, b) => a.date.getTime() - b.date.getTime());

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const delta = Math.abs(entries[j].date.getTime() - entries[i].date.getTime());
        if (delta > windowMs) break; // sorted, no point continuing

        const pairKey = `${entries[i].id}+${entries[j].id}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const amt = entries[i].amt;
        const cur = entries[i].cur;
        const txId = entries[j].id; // flag the later one
        anomalies.push({
          id: `dup-${entries[i].id.slice(0, 8)}`,
          type: "duplicate",
          severity: "high",
          title: "Possible duplicate transaction",
          description: `Two transactions of ${amt.toFixed(2)} from "${entries[i].id.slice(0, 8)}" within ${DUPLICATE_DATE_WINDOW_DAYS} days`,
          amount: amt,
          currency: cur,
          transaction_id: txId,
          detected_at: detectedAt.toISOString(),
        });
      }
    }
  }
  return anomalies;
}

/**
 * Port of Go DetectUnusualSpend — z-score per category, threshold 2.5.
 * history: Map of categoryID → monthly amounts.
 */
export function detectUnusualSpend(
  txs: TxRow[],
  history: Map<string, number[]>,
  detectedAt: Date,
): Anomaly[] {
  const Z_THRESHOLD = 2.5;

  // Compute per-category stats.
  const catStats = new Map<string, { mean: number; stddev: number }>();
  for (const [catId, vals] of history.entries()) {
    if (vals.length < 2) continue; // need at least 2 points
    const m = mean(vals);
    let sd = stddev(vals, m);
    if (sd < 1.0) sd = 1.0; // floor
    catStats.set(catId, { mean: m, stddev: sd });
  }

  const anomalies: Anomaly[] = [];
  for (const t of txs) {
    if (t.category_id == null || t.amount == null || t.direction !== "debit") continue;
    const cs = catStats.get(t.category_id);
    if (!cs) continue;
    const z = (t.amount - cs.mean) / cs.stddev;
    if (z < Z_THRESHOLD) continue;

    const sev = z > 4.0 ? "high" : "medium";
    anomalies.push({
      id: `usp-${t.id.slice(0, 8)}`,
      type: "unusual_spend",
      severity: sev,
      title: "Unusual spend in category",
      description: `Transaction of ${t.amount.toFixed(2)} is ${z.toFixed(1)} standard deviations above category average (${cs.mean.toFixed(2)})`,
      amount: t.amount,
      currency: t.currency ?? undefined,
      transaction_id: t.id,
      detected_at: detectedAt.toISOString(),
    });
  }
  return anomalies;
}

/**
 * Port of Go DetectMissingReceipts — high-value debits without reconciled docs.
 */
export function detectMissingReceipts(
  txs: TxRow[],
  reconciledIds: Set<string>,
  detectedAt: Date,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const t of txs) {
    if (t.direction !== "debit") continue;
    if (t.amount == null || t.amount < HIGH_VALUE_THRESHOLD) continue;
    if (reconciledIds.has(t.id)) continue;

    anomalies.push({
      id: `rcpt-${t.id.slice(0, 8)}`,
      type: "missing_receipt",
      severity: "medium",
      title: "High-value transaction without reconciled document",
      description: `Transaction of ${t.amount.toFixed(2)} has no confirmed or auto-matched document`,
      amount: t.amount,
      currency: t.currency ?? undefined,
      transaction_id: t.id,
      detected_at: detectedAt.toISOString(),
    });
  }
  return anomalies;
}

// ─── Tax readiness ────────────────────────────────────────────────────────────

/**
 * Port of Go ComputeTaxReadiness — 0–100 score from three components.
 *   1. VAT position: 40 pts (40 if net ≥ 0, 20 if net < 0, 0 if no VAT data)
 *   2. Doc coverage: 40 pts × documented_pct
 *   3. Reconciliation penalty: max 20 pts, reduced by 1 per 10 unreconciled
 */
export function computeTaxReadiness(data: TaxReadinessData): TaxReadinessResult {
  const components: TaxComponent[] = [];

  // Component 1: VAT tracking.
  let vatScore = 0.0;
  let vatPosition: number | undefined;
  const hasVAT = data.vat_output > 0 || data.vat_input > 0;
  if (hasVAT) {
    const pos = data.vat_output - data.vat_input;
    vatPosition = pos;
    if (pos >= 0) {
      vatScore = 40.0;
      components.push({
        label: "VAT position",
        status: "ok",
        detail: `Net VAT payable: ${pos.toFixed(2)} (output ${data.vat_output.toFixed(2)}, input ${data.vat_input.toFixed(2)})`,
      });
    } else {
      vatScore = 20.0;
      components.push({
        label: "VAT position",
        status: "warn",
        detail: `Net VAT refund position: ${pos.toFixed(2)} — verify input tax claims`,
      });
    }
  } else {
    vatScore = 0.0;
    components.push({
      label: "VAT position",
      status: "warn",
      detail: "No VAT-tagged transactions found; assign tax rates to enable VAT tracking",
    });
  }

  // Component 2: Document coverage.
  let docPct = 0.0;
  if (data.total_expenses > 0) {
    docPct = (data.documented_expenses / data.total_expenses) * 100;
  }
  const docScore = (docPct / 100) * 40;
  const docStatus: "ok" | "warn" | "error" = docPct < 50 ? "error" : docPct < 80 ? "warn" : "ok";
  components.push({
    label: "Expense documentation",
    status: docStatus,
    detail: `${Math.round(docPct)}% of expense transactions have a supporting document (${data.documented_expenses} of ${data.total_expenses})`,
  });

  // Component 3: Reconciliation.
  let reconScore = 20.0 - data.unreconciled_count / 10.0;
  if (reconScore < 0) reconScore = 0;
  const reconStatus: "ok" | "warn" | "error" =
    data.unreconciled_count > 50 ? "error" :
    data.unreconciled_count > 10 ? "warn" : "ok";
  components.push({
    label: "Reconciliation",
    status: reconStatus,
    detail: `${data.unreconciled_count} expense transaction(s) lack a reconciled bank statement line`,
  });

  let score = vatScore + docScore + reconScore;
  if (score > 100) score = 100;
  if (score < 0) score = 0;

  const result: TaxReadinessResult = {
    score: roundTwo(score),
    documented_expense_pct: roundTwo(docPct),
    unreconciled_count: data.unreconciled_count,
    components,
  };
  if (vatPosition !== undefined) result.vat_position = vatPosition;
  return result;
}
