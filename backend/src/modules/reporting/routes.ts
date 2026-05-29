/**
 * Reporting routes — port of Go internal/reporting/handlers.go.
 *
 * Route (absolute from root):
 *   GET /orgs/:orgID/reports/:name
 *       ?from=YYYY-MM-DD &to=YYYY-MM-DD [&format=csv|json]
 *
 * The integrator mounts this default-export router at "/".
 *
 * Report names (gated by org kind):
 *   business: profit-and-loss, balance-sheet, vat-summary
 *   personal: cash-flow, spending-trend, net-worth
 *
 * CSV path: returns raw text with Content-Type: text/csv + Content-Disposition.
 * JSON path: { report: name, data: <report object> }.
 *
 * FROZEN foundation API — import only, never modify:
 *   Hono / AppEnv | queryRows, queryOne, withOrg | requireMember | writeError
 *   money utilities: dec, money, sum
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireMember } from "../../middleware/org";
import { writeError } from "../../lib/errors";
import {
  fetchOrgKind,
  fetchPLLines,
  fetchBSLines,
  fetchVATLines,
  fetchCashFlowRows,
  fetchSpendingTrendRows,
  fetchNetWorthSeries,
} from "./queries";
import {
  validateReport,
  buildPL,
  buildBalanceSheet,
  buildVAT,
  buildCashFlow,
  buildSpendingTrend,
  buildNetWorth,
  ErrUnknownReport,
  ErrWrongOrgKind,
} from "./reports";
import { writeCSV } from "./csv";
import type { AnyReport } from "./csv";

// ─── Router ──────────────────────────────────────────────────────────────────

const router = new Hono<AppEnv>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse and validate the ?from and ?to query params. */
function parsePeriod(
  fromStr: string | undefined,
  toStr: string | undefined,
): { from: string; to: string } | { error: string } {
  if (!fromStr || !toStr) {
    return { error: "from and to query parameters are required (YYYY-MM-DD)" };
  }
  if (!DATE_RE.test(fromStr)) return { error: "from must be YYYY-MM-DD" };
  if (!DATE_RE.test(toStr))   return { error: "to must be YYYY-MM-DD" };
  if (fromStr > toStr)         return { error: "to must not be before from" };
  return { from: fromStr, to: toStr };
}

// ─── Route ───────────────────────────────────────────────────────────────────

/**
 * GET /orgs/:orgID/reports/:name
 * requireMember validates org membership (sets orgRole in context).
 */
router.get("/orgs/:orgID/reports/:name", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const reportName = c.req.param("name");

  // Parse period.
  const fromStr = c.req.query("from");
  const toStr = c.req.query("to");
  const parsed = parsePeriod(fromStr, toStr);
  if ("error" in parsed) {
    return writeError(c, 400, "invalid_period", parsed.error);
  }
  const { from, to } = parsed;

  // Look up org kind.
  let orgKind: string | null;
  try {
    orgKind = await fetchOrgKind(c.env, orgId);
  } catch {
    return writeError(c, 500, "lookup_failed", "could not look up organization");
  }
  if (orgKind === null) {
    return writeError(c, 404, "org_not_found", "organization not found");
  }

  // Validate report name and org-kind gate.
  try {
    validateReport(reportName, orgKind);
  } catch (err) {
    if (err instanceof ErrWrongOrgKind) {
      return writeError(c, 403, "wrong_org_kind", err.message);
    }
    if (err instanceof ErrUnknownReport) {
      return writeError(c, 404, "unknown_report", err.message);
    }
    return writeError(c, 400, "invalid_report", String(err));
  }

  // Decide format: ?format=csv or Accept: text/csv.
  const formatParam = (c.req.query("format") ?? "").toLowerCase();
  const acceptHeader = c.req.header("Accept") ?? "";
  const wantCSV = formatParam === "csv" || acceptHeader.includes("text/csv");

  const period = { from, to };

  // Dispatch to report builder.
  let report: AnyReport;
  try {
    switch (reportName) {
      case "profit-and-loss": {
        const lines = await fetchPLLines(c.env, orgId, from, to);
        report = buildPL(period, lines);
        break;
      }
      case "balance-sheet": {
        const lines = await fetchBSLines(c.env, orgId, to);
        report = buildBalanceSheet(to, lines);
        break;
      }
      case "vat-summary": {
        const lines = await fetchVATLines(c.env, orgId, from, to);
        report = buildVAT(period, lines);
        break;
      }
      case "cash-flow": {
        const rows = await fetchCashFlowRows(c.env, orgId, from, to);
        report = buildCashFlow(period, rows);
        break;
      }
      case "spending-trend": {
        const rows = await fetchSpendingTrendRows(c.env, orgId, from, to);
        report = buildSpendingTrend(period, rows);
        break;
      }
      case "net-worth": {
        const rows = await fetchNetWorthSeries(c.env, orgId, from, to);
        report = buildNetWorth(period, rows);
        break;
      }
      default:
        // Should never reach here — validateReport already rejected unknowns.
        return writeError(c, 404, "unknown_report", "unknown report");
    }
  } catch {
    return writeError(c, 500, "query_failed", "could not query report data");
  }

  // Respond.
  if (wantCSV) {
    const csvString = writeCSV(report);
    const filename = `${reportName}.csv`;
    // Return raw text — NOT JSON. The shared client must receive text/csv as-is.
    return c.body(csvString, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
  }

  return c.json({ report: reportName, data: report });
});

export default router;
