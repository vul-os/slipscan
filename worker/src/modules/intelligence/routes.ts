/**
 * Intelligence routes — port of Go backend/internal/intelligence/handlers.go.
 *
 * Implements (all require requireMember):
 *   GET /orgs/:orgID/forecast?horizon=<months>
 *   GET /orgs/:orgID/anomalies
 *   GET /orgs/:orgID/tax-readiness
 *
 * ROUTING: absolute paths from root; integrator mounts this router at "/".
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireAuth } from "../../middleware/auth";
import { requireMember } from "../../middleware/org";
import { writeError } from "../../lib/errors";
import {
  listActiveRecurring,
  historicalMonthlyTotals,
  orgCurrency,
  recentTransactions,
  categorySpendHistory,
  reconciledTransactionIds,
  getTaxReadinessData,
} from "./queries";
import { computeForecast, detectDuplicates, detectUnusualSpend, detectMissingReceipts, computeTaxReadiness } from "./compute";

const router = new Hono<AppEnv>();

// GET /orgs/:orgID/forecast?horizon=<months>
// Projects monthly cash-flow from recurring_transactions + historical averages.
// Response: { horizon, currency, points: [...], assumptions: [...] }
router.get("/orgs/:orgID/forecast", requireAuth, requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  // Parse optional horizon query param (default 3, range 1–24).
  let horizon = 3;
  const rawHorizon = c.req.query("horizon");
  if (rawHorizon !== undefined && rawHorizon !== "") {
    const n = parseInt(rawHorizon, 10);
    if (isNaN(n) || n < 1 || n > 24) {
      return writeError(c, 400, "invalid_horizon", "horizon must be an integer 1–24");
    }
    horizon = n;
  }

  let currency: string;
  try {
    currency = await orgCurrency(c.env, orgId);
  } catch {
    return writeError(c, 500, "currency_error", "could not determine org currency");
  }

  let history;
  try {
    history = await historicalMonthlyTotals(c.env, orgId, 12);
  } catch {
    return writeError(c, 500, "history_error", "could not fetch transaction history");
  }

  let recurring;
  try {
    recurring = await listActiveRecurring(c.env, orgId);
  } catch {
    return writeError(c, 500, "recurring_error", "could not fetch recurring transactions");
  }

  const result = computeForecast(history, recurring, horizon, currency);
  return c.json(result, 200);
});

// GET /orgs/:orgID/anomalies
// Returns typed anomaly list: duplicates, unusual spend, missing receipts.
// Response: { anomalies: [{ id, type, severity, title, description, amount?,
// currency?, transaction_id?, detected_at }] }
router.get("/orgs/:orgID/anomalies", requireAuth, requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const now = new Date();

  let txs;
  try {
    txs = await recentTransactions(c.env, orgId, 90);
  } catch {
    return writeError(c, 500, "transactions_error", "could not fetch transactions");
  }

  let history;
  try {
    history = await categorySpendHistory(c.env, orgId, 12);
  } catch {
    return writeError(c, 500, "history_error", "could not fetch category history");
  }

  let reconciledIds;
  try {
    reconciledIds = await reconciledTransactionIds(c.env, orgId);
  } catch {
    return writeError(c, 500, "recon_error", "could not fetch reconciliation data");
  }

  const anomalies = [
    ...detectDuplicates(txs, now),
    ...detectUnusualSpend(txs, history, now),
    ...detectMissingReceipts(txs, reconciledIds, now),
  ];

  return c.json({ anomalies }, 200);
});

// GET /orgs/:orgID/tax-readiness
// Returns a 0–100 readiness score, VAT position, document coverage,
// and unreconciled count.
// Response: { score, vat_position?, documented_expense_pct, unreconciled_count,
// components: [{ label, status, detail }] }
router.get("/orgs/:orgID/tax-readiness", requireAuth, requireMember, async (c) => {
  const orgId = c.req.param("orgID");

  let data;
  try {
    data = await getTaxReadinessData(c.env, orgId, 365);
  } catch {
    return writeError(c, 500, "tax_readiness_error", "could not compute tax readiness");
  }

  const result = computeTaxReadiness(data);
  return c.json(result, 200);
});

export default router;
