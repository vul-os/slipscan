/**
 * Finance routes — port of Go backend/internal/finance/handlers.go.
 *
 * Implements (all require requireMember):
 *   GET  /orgs/:orgID/spending
 *   GET  /orgs/:orgID/spending/:categoryID
 *   POST /orgs/:orgID/budgets
 *   GET  /orgs/:orgID/budgets
 *   GET  /orgs/:orgID/budgets/:budgetID/progress
 *   DELETE /orgs/:orgID/budgets/:budgetID
 *   POST /orgs/:orgID/goals
 *   GET  /orgs/:orgID/goals
 *   GET  /orgs/:orgID/goals/:goalID
 *   PATCH  /orgs/:orgID/goals/:goalID
 *   DELETE /orgs/:orgID/goals/:goalID
 *   GET  /orgs/:orgID/net-worth
 *   GET  /orgs/:orgID/net-worth/history
 *
 * ROUTING: absolute paths from root; integrator mounts this router at "/".
 *
 * MONEY CONTRACT: amounts leave this file as parseFloat(money(decimal)) which
 * is safe at 2dp currency scale (14-digit NUMERIC). The Go handler also
 * serialises via float64 JSON.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types/app";
import { requireMember } from "../../middleware/org";
import { writeError } from "../../lib/errors";
import { money } from "../../lib/money";
import {
  spendingBreakdown,
  transactionsByCategory,
  createBudget,
  listBudgets,
  getBudget,
  deleteBudget,
  budgetProgress,
  createGoal,
  listGoals,
  getGoal,
  updateGoalAmount,
  deleteGoal,
  netWorthNow,
  netWorthTimeSeries,
  NotFoundError,
} from "./queries";
import type {
  CategoryTotal,
  BudgetRow,
  BudgetLineWithActual,
  BudgetWithLines,
  GoalRow,
  BudgetOut,
  BudgetLineOut,
  GoalOut,
} from "./types";
import Decimal from "decimal.js";

const router = new Hono<AppEnv>();

// ─── helpers ──────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUUID(s: string): boolean {
  return UUID_RE.test(s);
}

/** Port of Go parseDate — returns YYYY-MM-DD or null. */
function parseDate(s: string | null | undefined): string | null {
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  return s;
}

/** Start of current month in YYYY-MM-DD. */
function startOfMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Today in YYYY-MM-DD. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** One year ago in YYYY-MM-DD. */
function oneYearAgo(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/** Port of Go roundTwo. */
function roundTwo(d: Decimal | string | number): number {
  const dec = new Decimal(d);
  return parseFloat(dec.toFixed(2));
}

// ─── Response serialisers (match Go shapes exactly) ───────────────────────────

function budgetLineOut(l: BudgetLineWithActual): BudgetLineOut {
  const out: BudgetLineOut = {
    id: l.id,
    amount: parseFloat(money(l.amount)),
    rollover: l.rollover,
    actual: parseFloat(money(l.actual)),
    remaining: parseFloat(money(l.remaining)),
  };
  if (l.category_id) out.category_id = l.category_id;
  return out;
}

function budgetOut(bwl: BudgetWithLines): BudgetOut {
  const b = bwl.budget;
  const out: BudgetOut = {
    id: b.id,
    name: b.name,
    period: b.period,
    start_date: typeof b.start_date === "string" ? b.start_date.slice(0, 10) : b.start_date,
    currency: b.currency,
    is_active: b.is_active,
    lines: bwl.lines.map(budgetLineOut),
  };
  if (b.end_date) out.end_date = typeof b.end_date === "string" ? b.end_date.slice(0, 10) : b.end_date;
  return out;
}

function singleBudgetOut(b: BudgetRow): BudgetOut {
  const out: BudgetOut = {
    id: b.id,
    name: b.name,
    period: b.period,
    start_date: typeof b.start_date === "string" ? b.start_date.slice(0, 10) : b.start_date,
    currency: b.currency,
    is_active: b.is_active,
    lines: [],
  };
  if (b.end_date) out.end_date = typeof b.end_date === "string" ? b.end_date.slice(0, 10) : b.end_date;
  return out;
}

function goalOut(g: GoalRow): GoalOut {
  const targetAmt = parseFloat(money(g.target_amount));
  const currentAmt = parseFloat(money(g.current_amount));

  let progressPct = 0;
  if (targetAmt > 0) {
    progressPct = Math.min(100, Math.max(0, (currentAmt / targetAmt) * 100));
  }

  const out: GoalOut = {
    id: g.id,
    name: g.name,
    kind: g.kind,
    target_amount: targetAmt,
    current_amount: currentAmt,
    progress_pct: roundTwo(progressPct),
    currency: g.currency,
    status: g.status,
  };
  if (g.target_date) {
    out.target_date = typeof g.target_date === "string" ? g.target_date.slice(0, 10) : g.target_date;
  }
  if (g.account_id) out.account_id = g.account_id;
  if (g.category_id) out.category_id = g.category_id;
  return out;
}

// ─── Spending ─────────────────────────────────────────────────────────────────

// GET /orgs/:orgID/spending?from=YYYY-MM-DD&to=YYYY-MM-DD&direction=debit|credit
router.get("/orgs/:orgID/spending", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");

  const from = parseDate(c.req.query("from")) ?? startOfMonth();
  const to = parseDate(c.req.query("to")) ?? today();
  const direction = c.req.query("direction") || "debit";

  let totals: CategoryTotal[];
  try {
    totals = await spendingBreakdown(c.env, orgId, userId, from, to, direction);
  } catch {
    return writeError(c, 500, "spending_error", "could not compute spending breakdown");
  }

  const categories = totals.map((ct) => {
    // share_percent is a Decimal (stored on the object from queries.ts)
    const sharePct = roundTwo((ct as unknown as { share_percent: Decimal }).share_percent);
    const out: {
      category_name: string;
      kind: string;
      total_amount: number;
      share_percent: number;
      tx_count: number;
      category_id?: string;
    } = {
      category_name: ct.category_name,
      kind: ct.kind,
      total_amount: parseFloat(money(ct.total_amount)),
      share_percent: sharePct,
      tx_count: ct.tx_count,
    };
    if (ct.category_id) out.category_id = ct.category_id;
    return out;
  });

  return c.json({ from, to, direction, categories }, 200);
});

// GET /orgs/:orgID/spending/:categoryID
router.get("/orgs/:orgID/spending/:categoryID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");
  const rawCat = c.req.param("categoryID");

  let categoryId: string | null = null;
  if (rawCat !== "uncategorized") {
    if (!isUUID(rawCat)) {
      return writeError(c, 400, "invalid_category_id", "invalid category id");
    }
    categoryId = rawCat;
  }

  const from = parseDate(c.req.query("from")) ?? startOfMonth();
  const to = parseDate(c.req.query("to")) ?? today();

  let txns;
  try {
    txns = await transactionsByCategory(c.env, orgId, userId, categoryId, from, to, 50, 0);
  } catch {
    return writeError(c, 500, "drill_error", "could not fetch transactions");
  }

  const transactions = txns.map((t) => {
    const out: {
      id: string;
      direction: string;
      posted_date?: string;
      merchant?: string;
      description?: string;
      amount?: number;
      currency?: string;
      category_name?: string;
    } = { id: t.id, direction: t.direction };
    if (t.posted_date) out.posted_date = t.posted_date.slice(0, 10);
    if (t.merchant) out.merchant = t.merchant;
    if (t.description) out.description = t.description;
    if (t.amount != null) out.amount = parseFloat(money(t.amount));
    if (t.currency) out.currency = t.currency;
    if (t.category_name) out.category_name = t.category_name;
    return out;
  });

  return c.json({ category_id: rawCat, transactions }, 200);
});

// ─── Budgets ──────────────────────────────────────────────────────────────────

// POST /orgs/:orgID/budgets
router.post("/orgs/:orgID/budgets", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be JSON");
  }

  const name = typeof body.name === "string" ? body.name : "";
  const period = typeof body.period === "string" ? body.period : "";
  const startDateRaw = typeof body.start_date === "string" ? body.start_date : "";
  const endDateRaw = typeof body.end_date === "string" ? body.end_date : "";
  const currency = typeof body.currency === "string" ? body.currency : "";

  const startDate = parseDate(startDateRaw);
  if (!startDate) {
    return writeError(c, 400, "invalid_start_date", "start_date must be YYYY-MM-DD");
  }
  let endDate: string | undefined;
  if (endDateRaw) {
    const ed = parseDate(endDateRaw);
    if (!ed) {
      return writeError(c, 400, "invalid_end_date", "end_date must be YYYY-MM-DD");
    }
    endDate = ed;
  }

  // Parse lines
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  const lines: { category_id?: string; amount: number; rollover: boolean }[] = [];
  for (const l of rawLines) {
    if (!l || typeof l !== "object") continue;
    const line = l as Record<string, unknown>;
    let catId: string | undefined;
    if (line.category_id != null && line.category_id !== "") {
      if (typeof line.category_id !== "string" || !isUUID(line.category_id)) {
        return writeError(c, 400, "invalid_category_id", "category_id must be a valid UUID");
      }
      catId = line.category_id;
    }
    lines.push({
      category_id: catId,
      amount: typeof line.amount === "number" ? line.amount : parseFloat(String(line.amount ?? 0)),
      rollover: Boolean(line.rollover),
    });
  }

  let bwl;
  try {
    bwl = await createBudget(c.env, orgId, userId, { name, period, start_date: startDate, end_date: endDate, currency }, lines);
  } catch (e) {
    return writeError(c, 400, "create_budget_failed", e instanceof Error ? e.message : "create failed");
  }

  return c.json(budgetOut(bwl), 201);
});

// GET /orgs/:orgID/budgets?active=true
router.get("/orgs/:orgID/budgets", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");
  const activeOnly = c.req.query("active") === "true";

  let budgets;
  try {
    budgets = await listBudgets(c.env, orgId, userId, activeOnly);
  } catch {
    return writeError(c, 500, "list_budgets_failed", "could not list budgets");
  }

  return c.json({ budgets: budgets.map(singleBudgetOut) }, 200);
});

// GET /orgs/:orgID/budgets/:budgetID/progress
router.get("/orgs/:orgID/budgets/:budgetID/progress", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");
  const budgetId = c.req.param("budgetID");

  if (!isUUID(budgetId)) {
    return writeError(c, 400, "invalid_budget_id", "invalid budget id");
  }

  const from = parseDate(c.req.query("from")) ?? startOfMonth();
  const to = parseDate(c.req.query("to")) ?? today();

  let bwl;
  try {
    bwl = await budgetProgress(c.env, orgId, userId, budgetId, from, to);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return writeError(c, 404, "not_found", "budget not found");
    }
    return writeError(c, 500, "progress_failed", "could not compute budget progress");
  }

  return c.json(budgetOut(bwl), 200);
});

// DELETE /orgs/:orgID/budgets/:budgetID
router.delete("/orgs/:orgID/budgets/:budgetID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");
  const budgetId = c.req.param("budgetID");

  if (!isUUID(budgetId)) {
    return writeError(c, 400, "invalid_budget_id", "invalid budget id");
  }

  try {
    await deleteBudget(c.env, orgId, userId, budgetId);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return writeError(c, 404, "not_found", "budget not found");
    }
    return writeError(c, 500, "delete_failed", "could not delete budget");
  }

  return c.body(null, 204);
});

// ─── Goals ────────────────────────────────────────────────────────────────────

// POST /orgs/:orgID/goals
router.post("/orgs/:orgID/goals", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be JSON");
  }

  const name = typeof body.name === "string" ? body.name : "";
  const kind = typeof body.kind === "string" ? body.kind : "";
  const targetAmount = typeof body.target_amount === "number" ? body.target_amount : parseFloat(String(body.target_amount ?? 0));
  const currentAmount = typeof body.current_amount === "number" ? body.current_amount : parseFloat(String(body.current_amount ?? 0));
  const currency = typeof body.currency === "string" ? body.currency : "";

  let targetDate: string | undefined;
  if (body.target_date && typeof body.target_date === "string") {
    const td = parseDate(body.target_date);
    if (!td) {
      return writeError(c, 400, "invalid_target_date", "target_date must be YYYY-MM-DD");
    }
    targetDate = td;
  }

  let accountId: string | undefined;
  if (body.account_id && typeof body.account_id === "string") {
    if (!isUUID(body.account_id)) {
      return writeError(c, 400, "invalid_account_id", "account_id must be a valid UUID");
    }
    accountId = body.account_id;
  }

  let categoryId: string | undefined;
  if (body.category_id && typeof body.category_id === "string") {
    if (!isUUID(body.category_id)) {
      return writeError(c, 400, "invalid_category_id", "category_id must be a valid UUID");
    }
    categoryId = body.category_id;
  }

  let g: GoalRow;
  try {
    g = await createGoal(c.env, orgId, userId, {
      name,
      kind,
      target_amount: targetAmount,
      current_amount: currentAmount,
      target_date: targetDate,
      currency,
      account_id: accountId,
      category_id: categoryId,
    });
  } catch (e) {
    return writeError(c, 400, "create_goal_failed", e instanceof Error ? e.message : "create failed");
  }

  return c.json(goalOut(g), 201);
});

// GET /orgs/:orgID/goals?status=active
router.get("/orgs/:orgID/goals", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");
  const statusFilter = c.req.query("status") ?? "";

  let goals;
  try {
    goals = await listGoals(c.env, orgId, userId, statusFilter);
  } catch {
    return writeError(c, 500, "list_goals_failed", "could not list goals");
  }

  return c.json({ goals: goals.map(goalOut) }, 200);
});

// GET /orgs/:orgID/goals/:goalID
router.get("/orgs/:orgID/goals/:goalID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");
  const goalId = c.req.param("goalID");

  if (!isUUID(goalId)) {
    return writeError(c, 400, "invalid_goal_id", "invalid goal id");
  }

  let g: GoalRow;
  try {
    g = await getGoal(c.env, orgId, userId, goalId);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return writeError(c, 404, "not_found", "goal not found");
    }
    return writeError(c, 500, "get_goal_failed", "could not fetch goal");
  }

  return c.json(goalOut(g), 200);
});

// PATCH /orgs/:orgID/goals/:goalID
router.patch("/orgs/:orgID/goals/:goalID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");
  const goalId = c.req.param("goalID");

  if (!isUUID(goalId)) {
    return writeError(c, 400, "invalid_goal_id", "invalid goal id");
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return writeError(c, 400, "invalid_body", "request body must be JSON");
  }

  const currentAmount = typeof body.current_amount === "number"
    ? body.current_amount
    : parseFloat(String(body.current_amount ?? 0));
  const status = typeof body.status === "string" ? body.status : "";

  let g: GoalRow;
  try {
    g = await updateGoalAmount(c.env, orgId, userId, goalId, currentAmount, status);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return writeError(c, 404, "not_found", "goal not found");
    }
    return writeError(c, 400, "patch_goal_failed", e instanceof Error ? e.message : "update failed");
  }

  return c.json(goalOut(g), 200);
});

// DELETE /orgs/:orgID/goals/:goalID
router.delete("/orgs/:orgID/goals/:goalID", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");
  const goalId = c.req.param("goalID");

  if (!isUUID(goalId)) {
    return writeError(c, 400, "invalid_goal_id", "invalid goal id");
  }

  try {
    await deleteGoal(c.env, orgId, userId, goalId);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return writeError(c, 404, "not_found", "goal not found");
    }
    return writeError(c, 500, "delete_failed", "could not delete goal");
  }

  return c.body(null, 204);
});

// ─── Net worth ────────────────────────────────────────────────────────────────

// GET /orgs/:orgID/net-worth?currency=ZAR
router.get("/orgs/:orgID/net-worth", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");
  const currency = c.req.query("currency") || "ZAR";

  let snap;
  try {
    snap = await netWorthNow(c.env, orgId, userId, currency);
  } catch {
    return writeError(c, 500, "net_worth_error", "could not compute net worth");
  }

  return c.json(
    {
      as_of: snap.as_of,
      base_currency: snap.base_currency,
      total_assets: parseFloat(money(snap.total_assets)),
      total_holdings: parseFloat(money(snap.total_holdings)),
      total_liabs: parseFloat(money(snap.total_liabs)),
      net_worth: parseFloat(money(snap.net_worth)),
    },
    200,
  );
});

// GET /orgs/:orgID/net-worth/history?from=YYYY-MM-DD&to=YYYY-MM-DD&currency=ZAR
router.get("/orgs/:orgID/net-worth/history", requireMember, async (c) => {
  const orgId = c.req.param("orgID");
  const userId = c.get("userId");
  const currency = c.req.query("currency") || "ZAR";
  const from = parseDate(c.req.query("from")) ?? oneYearAgo();
  const to = parseDate(c.req.query("to")) ?? today();

  let points;
  try {
    points = await netWorthTimeSeries(c.env, orgId, userId, currency, from, to);
  } catch {
    return writeError(c, 500, "time_series_error", "could not compute net worth history");
  }

  return c.json(
    {
      currency,
      points: points.map((p) => ({
        as_of: p.as_of.slice(0, 10),
        net_worth: roundTwo(p.net_worth),
      })),
    },
    200,
  );
});

export default router;
