/**
 * Finance queries — raw parameterized SQL ported 1:1 from Go
 * backend/internal/finance/store.go.
 *
 * MONEY CONTRACT: All NUMERIC columns arrive as strings from Neon.
 * Math is done in lib/money (decimal.js). The callers convert final results
 * to Number only at the JSON boundary in routes.ts (via parseFloat on the
 * already-rounded 2dp string — safe at currency scale).
 *
 * ISOLATION: every org-scoped query includes WHERE organization_id = $
 * (belt-and-suspenders on top of RLS set by withOrg).
 */
import { withOrg, queryRows } from "../../db/client";
import type { Query } from "../../db/client";
import type { Env } from "../../bindings";
import { dec, add, sub, mul, sum } from "../../lib/money";
import type {
  CategoryTotal,
  SpendingRow,
  TransactionSummaryRow,
  BudgetRow,
  BudgetLineRow,
  BudgetLineWithActual,
  BudgetWithLines,
  CreateBudgetInput,
  BudgetLineInput,
  GoalRow,
  CreateGoalInput,
  ValueRow,
  FxRateRow,
  DateRow,
} from "./types";
import Decimal from "decimal.js";

// ─── Sentinel errors ──────────────────────────────────────────────────────────

export class NotFoundError extends Error {
  constructor(msg = "not found") {
    super(msg);
    this.name = "NotFoundError";
  }
}

// ─── Validation helpers ───────────────────────────────────────────────────────

const VALID_PERIODS = new Set(["weekly", "monthly", "quarterly", "yearly"]);
const VALID_GOAL_KINDS = new Set(["savings", "debt_payoff", "spending"]);
const VALID_GOAL_STATUSES = new Set(["active", "achieved", "abandoned"]);

function validateBudgetInput(input: CreateBudgetInput): void {
  if (!input.name.trim()) throw new Error("budget name is required");
  if (!VALID_PERIODS.has(input.period))
    throw new Error(
      `invalid period "${input.period}": must be weekly, monthly, quarterly, or yearly`,
    );
  if (!input.currency) throw new Error("currency is required");
  if (!input.start_date) throw new Error("start_date is required");
}

function validateGoalInput(input: CreateGoalInput): void {
  if (!input.name.trim()) throw new Error("goal name is required");
  if (!VALID_GOAL_KINDS.has(input.kind))
    throw new Error(
      `invalid kind "${input.kind}": must be savings, debt_payoff, or spending`,
    );
  if (input.target_amount <= 0)
    throw new Error("target_amount must be positive");
  if (!input.currency) throw new Error("currency is required");
}

// ─── Spending breakdown ───────────────────────────────────────────────────────

/**
 * Port of Go Store.SpendingBreakdown.
 * Aggregates spend per category; computes share % in TS using decimal.js.
 */
export async function spendingBreakdown(
  env: Env,
  orgId: string,
  userId: string,
  from: string,
  to: string,
  direction: string,
): Promise<CategoryTotal[]> {
  if (direction !== "debit" && direction !== "credit") direction = "debit";

  const rows = await withOrg(env, orgId, userId, async (q) =>
    q(
      `
      SELECT
        t.category_id,
        c.name                       AS category_name,
        c.kind                       AS category_kind,
        COALESCE(SUM(t.amount), 0)   AS total_amount,
        COUNT(*)                     AS tx_count
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.organization_id = $1
        AND t.direction        = $2
        AND t.posted_date     >= $3
        AND t.posted_date     <= $4
        AND t.status          != 'rejected'
      GROUP BY t.category_id, c.name, c.kind
      ORDER BY total_amount DESC
    `,
      [orgId, direction, from, to],
    ),
  );

  const raw = rows as unknown as SpendingRow[];

  // Compute grand total for share %.
  const grandTotal = sum(raw.map((r) => r.total_amount));

  return raw.map((r) => {
    const totalAmt = dec(r.total_amount);
    let sharePct = new Decimal(0);
    if (!grandTotal.isZero()) {
      sharePct = totalAmt.div(grandTotal).times(100);
    }
    return {
      category_id: r.category_id ?? null,
      category_name: r.category_name ?? "Uncategorized",
      kind: r.category_kind ?? "expense",
      total_amount: r.total_amount,
      share_percent: sharePct,
      tx_count: Number(r.tx_count),
    } as unknown as CategoryTotal & { share_percent: Decimal };
  }) as unknown as CategoryTotal[];
}

/**
 * Port of Go Store.TransactionsByCategory.
 * Pass null categoryId for uncategorized.
 */
export async function transactionsByCategory(
  env: Env,
  orgId: string,
  userId: string,
  categoryId: string | null,
  from: string,
  to: string,
  limit = 50,
  offset = 0,
): Promise<TransactionSummaryRow[]> {
  if (limit <= 0 || limit > 200) limit = 50;

  const rows = await withOrg(env, orgId, userId, async (q) => {
    if (categoryId === null) {
      return q(
        `
        SELECT t.id, t.posted_date, t.merchant, t.description,
               t.amount, t.currency, t.direction, c.name AS category_name
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.organization_id = $1
          AND t.category_id     IS NULL
          AND t.posted_date    >= $2
          AND t.posted_date    <= $3
          AND t.status         != 'rejected'
        ORDER BY t.posted_date DESC NULLS LAST, t.created_at DESC
        LIMIT $4 OFFSET $5
      `,
        [orgId, from, to, limit, offset],
      );
    } else {
      return q(
        `
        SELECT t.id, t.posted_date, t.merchant, t.description,
               t.amount, t.currency, t.direction, c.name AS category_name
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.organization_id = $1
          AND t.category_id     = $2
          AND t.posted_date    >= $3
          AND t.posted_date    <= $4
          AND t.status         != 'rejected'
        ORDER BY t.posted_date DESC NULLS LAST, t.created_at DESC
        LIMIT $5 OFFSET $6
      `,
        [orgId, categoryId, from, to, limit, offset],
      );
    }
  });

  return rows as unknown as TransactionSummaryRow[];
}

// ─── Budgets ──────────────────────────────────────────────────────────────────

/**
 * Port of Go Store.CreateBudget — inserts budget + lines in one transaction.
 */
export async function createBudget(
  env: Env,
  orgId: string,
  userId: string,
  input: CreateBudgetInput,
  lines: BudgetLineInput[],
): Promise<BudgetWithLines> {
  validateBudgetInput(input);

  return withOrg(env, orgId, userId, async (q) => {
    // Insert budget
    const budgetRows = await q(
      `
      INSERT INTO budgets (organization_id, name, period, start_date, end_date, currency)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, organization_id, name, period, start_date, end_date,
                currency, is_active, created_at, updated_at
    `,
      [
        orgId,
        input.name,
        input.period,
        input.start_date,
        input.end_date ?? null,
        input.currency,
      ],
    );
    if (!budgetRows.length) throw new Error("budget insert returned no rows");
    const budget = budgetRows[0] as unknown as BudgetRow;

    // Insert lines
    const insertedLines = await insertBudgetLines(q, budget.id, orgId, lines);

    return { budget, lines: insertedLines.map((l) => ({ ...l, actual: "0.00", remaining: l.amount })) };
  });
}

async function insertBudgetLines(
  q: Query,
  budgetId: string,
  orgId: string,
  lines: BudgetLineInput[],
): Promise<BudgetLineRow[]> {
  const out: BudgetLineRow[] = [];
  for (const l of lines) {
    const rows = await q(
      `
      INSERT INTO budget_lines (budget_id, organization_id, category_id, amount, rollover)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, budget_id, category_id, amount, rollover
    `,
      [budgetId, orgId, l.category_id ?? null, l.amount, l.rollover],
    );
    if (!rows.length) throw new Error("budget_line insert returned no rows");
    out.push(rows[0] as unknown as BudgetLineRow);
  }
  return out;
}

/**
 * Port of Go Store.GetBudget — fetches budget + lines.
 */
export async function getBudget(
  env: Env,
  orgId: string,
  userId: string,
  budgetId: string,
): Promise<BudgetWithLines> {
  return withOrg(env, orgId, userId, async (q) => {
    const brows = await q(
      `
      SELECT id, organization_id, name, period, start_date, end_date,
             currency, is_active, created_at, updated_at
      FROM budgets
      WHERE id = $1 AND organization_id = $2
    `,
      [budgetId, orgId],
    );
    if (!brows.length) throw new NotFoundError("budget not found");
    const budget = brows[0] as unknown as BudgetRow;
    const lines = await listBudgetLines(q, budgetId);
    return { budget, lines: lines.map((l) => ({ ...l, actual: "0.00", remaining: l.amount })) };
  });
}

async function listBudgetLines(q: Query, budgetId: string): Promise<BudgetLineRow[]> {
  const rows = await q(
    `
    SELECT id, budget_id, category_id, amount, rollover
    FROM budget_lines
    WHERE budget_id = $1
    ORDER BY id
  `,
    [budgetId],
  );
  return rows as unknown as BudgetLineRow[];
}

/**
 * Port of Go Store.ListBudgets.
 */
export async function listBudgets(
  env: Env,
  orgId: string,
  userId: string,
  activeOnly: boolean,
): Promise<BudgetRow[]> {
  let sql = `
    SELECT id, organization_id, name, period, start_date, end_date,
           currency, is_active, created_at, updated_at
    FROM budgets
    WHERE organization_id = $1
  `;
  if (activeOnly) sql += " AND is_active = TRUE";
  sql += " ORDER BY start_date DESC";

  const rows = await withOrg(env, orgId, userId, (q) => q(sql, [orgId]));
  return rows as unknown as BudgetRow[];
}

/**
 * Port of Go Store.DeleteBudget — soft-delete (is_active = false).
 */
export async function deleteBudget(
  env: Env,
  orgId: string,
  userId: string,
  budgetId: string,
): Promise<void> {
  const rows = await withOrg(env, orgId, userId, (q) =>
    q(
      `
      UPDATE budgets SET is_active = FALSE, updated_at = NOW()
      WHERE id = $1 AND organization_id = $2
      RETURNING id
    `,
      [budgetId, orgId],
    ),
  );
  if (!rows.length) throw new NotFoundError("budget not found");
}

/**
 * Port of Go Store.BudgetProgress — fetches actual spend per line.
 */
export async function budgetProgress(
  env: Env,
  orgId: string,
  userId: string,
  budgetId: string,
  from: string,
  to: string,
): Promise<BudgetWithLines> {
  return withOrg(env, orgId, userId, async (q) => {
    const brows = await q(
      `
      SELECT id, organization_id, name, period, start_date, end_date,
             currency, is_active, created_at, updated_at
      FROM budgets
      WHERE id = $1 AND organization_id = $2
    `,
      [budgetId, orgId],
    );
    if (!brows.length) throw new NotFoundError("budget not found");
    const budget = brows[0] as unknown as BudgetRow;
    const lines = await listBudgetLines(q, budgetId);

    if (!lines.length) {
      return { budget, lines: [] };
    }

    // Collect category IDs with a defined category.
    const catIds = lines
      .filter((l) => l.category_id !== null)
      .map((l) => l.category_id as string);

    // Build actual spend map: categoryId (or "") → NUMERIC string.
    const actualMap = await actualSpendByCategory(q, orgId, from, to, catIds);

    const linesWithActual: BudgetLineWithActual[] = lines.map((l) => {
      const key = l.category_id ?? "";
      const actual = dec(actualMap[key] ?? "0");
      const amount = dec(l.amount);
      const remaining = sub(amount, actual);
      return {
        ...l,
        actual: actual.toFixed(2),
        remaining: remaining.toFixed(2),
      };
    });

    return { budget, lines: linesWithActual };
  });
}

/**
 * Port of Go Store.actualSpendByCategory.
 * Returns a map of category_id → total_amount (NUMERIC string).
 * The empty-string key represents uncategorized transactions.
 */
async function actualSpendByCategory(
  q: Query,
  orgId: string,
  from: string,
  to: string,
  catIds: string[],
): Promise<Record<string, string>> {
  let sql = `
    SELECT category_id, COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE organization_id = $1
      AND direction       = 'debit'
      AND posted_date    >= $2
      AND posted_date    <= $3
      AND status         != 'rejected'
  `;
  if (catIds.length > 0) {
    // Safe: catIds are UUIDs validated by the handler.
    const placeholders = catIds.map((_, i) => `$${i + 4}`).join(", ");
    sql += ` AND category_id IN (${placeholders})`;
  }
  sql += " GROUP BY category_id";

  const params: unknown[] = [orgId, from, to, ...catIds];
  const rows = await q(sql, params);

  const out: Record<string, string> = {};
  for (const row of rows) {
    const r = row as { category_id: string | null; total: string };
    const key = r.category_id ?? "";
    out[key] = r.total;
  }
  return out;
}

// ─── Goals ────────────────────────────────────────────────────────────────────

/**
 * Port of Go Store.CreateGoal.
 */
export async function createGoal(
  env: Env,
  orgId: string,
  userId: string,
  input: CreateGoalInput,
): Promise<GoalRow> {
  validateGoalInput(input);

  const rows = await withOrg(env, orgId, userId, (q) =>
    q(
      `
      INSERT INTO goals
        (organization_id, account_id, category_id, name, kind,
         target_amount, current_amount, target_date, currency)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, organization_id, account_id, category_id, name, kind,
                target_amount, current_amount, target_date, currency, status,
                created_at, updated_at
    `,
      [
        orgId,
        input.account_id ?? null,
        input.category_id ?? null,
        input.name,
        input.kind,
        input.target_amount,
        input.current_amount,
        input.target_date ?? null,
        input.currency,
      ],
    ),
  );
  if (!rows.length) throw new Error("goal insert returned no rows");
  return rows[0] as unknown as GoalRow;
}

/**
 * Port of Go Store.ListGoals.
 */
export async function listGoals(
  env: Env,
  orgId: string,
  userId: string,
  statusFilter: string,
): Promise<GoalRow[]> {
  const args: unknown[] = [orgId];
  let sql = `
    SELECT id, organization_id, account_id, category_id, name, kind,
           target_amount, current_amount, target_date, currency, status,
           created_at, updated_at
    FROM goals
    WHERE organization_id = $1
  `;
  if (statusFilter) {
    args.push(statusFilter);
    sql += ` AND status = $${args.length}`;
  }
  sql += " ORDER BY created_at DESC";

  const rows = await withOrg(env, orgId, userId, (q) => q(sql, args));
  return rows as unknown as GoalRow[];
}

/**
 * Port of Go Store.GetGoal.
 */
export async function getGoal(
  env: Env,
  orgId: string,
  userId: string,
  goalId: string,
): Promise<GoalRow> {
  const rows = await withOrg(env, orgId, userId, (q) =>
    q(
      `
      SELECT id, organization_id, account_id, category_id, name, kind,
             target_amount, current_amount, target_date, currency, status,
             created_at, updated_at
      FROM goals
      WHERE id = $1 AND organization_id = $2
    `,
      [goalId, orgId],
    ),
  );
  if (!rows.length) throw new NotFoundError("goal not found");
  return rows[0] as unknown as GoalRow;
}

/**
 * Port of Go Store.UpdateGoalAmount.
 */
export async function updateGoalAmount(
  env: Env,
  orgId: string,
  userId: string,
  goalId: string,
  currentAmount: number,
  status: string,
): Promise<GoalRow> {
  if (status && !VALID_GOAL_STATUSES.has(status)) {
    throw new Error(`invalid status "${status}"`);
  }

  const args: unknown[] = [goalId, orgId, currentAmount];
  let sql = `
    UPDATE goals
    SET current_amount = $3, updated_at = NOW()
  `;
  if (status) {
    args.push(status);
    sql += `, status = $${args.length}`;
  }
  sql += " WHERE id = $1 AND organization_id = $2";
  sql +=
    " RETURNING id, organization_id, account_id, category_id, name, kind, target_amount, current_amount, target_date, currency, status, created_at, updated_at";

  const rows = await withOrg(env, orgId, userId, (q) => q(sql, args));
  if (!rows.length) throw new NotFoundError("goal not found");
  return rows[0] as unknown as GoalRow;
}

/**
 * Port of Go Store.DeleteGoal — marks as abandoned.
 */
export async function deleteGoal(
  env: Env,
  orgId: string,
  userId: string,
  goalId: string,
): Promise<void> {
  const rows = await withOrg(env, orgId, userId, (q) =>
    q(
      `
      UPDATE goals SET status = 'abandoned', updated_at = NOW()
      WHERE id = $1 AND organization_id = $2
      RETURNING id
    `,
      [goalId, orgId],
    ),
  );
  if (!rows.length) throw new NotFoundError("goal not found");
}

// ─── Net worth ────────────────────────────────────────────────────────────────

/**
 * Port of Go Store.latestFXRates.
 * Returns map of quote_currency → rate (Decimal).
 * rate is: 1 baseCurrency = rate quoteCurrency.
 * To convert from quote to base: amount_in_base = amount_in_quote / rate.
 */
export async function latestFxRates(
  env: Env,
  baseCurrency: string,
): Promise<Map<string, Decimal>> {
  const rows = await queryRows(
    env,
    `
    SELECT DISTINCT ON (quote)
      quote, rate
    FROM fx_rates
    WHERE base = $1
    ORDER BY quote, as_of DESC
  `,
    [baseCurrency],
  );
  const map = new Map<string, Decimal>();
  for (const row of rows as unknown as FxRateRow[]) {
    map.set(row.quote, dec(row.rate));
  }
  return map;
}

/** Convert an amount from `currency` to baseCurrency using the rate map. */
function convertToBase(
  amount: string,
  currency: string,
  baseCurrency: string,
  fxRates: Map<string, Decimal>,
): Decimal {
  const amt = dec(amount);
  if (currency === baseCurrency || !currency) return amt;
  const rate = fxRates.get(currency);
  if (rate && !rate.isZero()) {
    // rate = quoteCurrency per 1 baseCurrency → divide to get base
    return amt.div(rate);
  }
  // No rate: best-effort, treat as already in base
  return amt;
}

/**
 * Port of Go Store.latestAssetValuations.
 */
async function latestAssetValuations(q: Query, orgId: string): Promise<ValueRow[]> {
  const rows = await q(
    `
    SELECT DISTINCT ON (av.asset_id)
      av.value::text AS value, av.currency
    FROM asset_valuations av
    JOIN assets a ON a.id = av.asset_id
    WHERE av.organization_id = $1
      AND a.is_archived = FALSE
    ORDER BY av.asset_id, av.as_of DESC
  `,
    [orgId],
  );
  return rows as unknown as ValueRow[];
}

/**
 * Port of Go Store.holdingsValue.
 */
async function holdingsValue(q: Query, orgId: string): Promise<ValueRow[]> {
  const rows = await q(
    `
    SELECT
      (quantity * COALESCE(current_price, 0))::text AS value,
      COALESCE(price_currency, cost_currency, 'ZAR') AS currency
    FROM holdings
    WHERE organization_id = $1
      AND is_archived = FALSE
      AND current_price IS NOT NULL
  `,
    [orgId],
  );
  return rows as unknown as ValueRow[];
}

/**
 * Port of Go Store.latestLiabilityBalances.
 */
async function latestLiabilityBalances(q: Query, orgId: string): Promise<ValueRow[]> {
  const rows = await q(
    `
    SELECT DISTINCT ON (lb.liability_id)
      lb.balance::text AS value, lb.currency
    FROM liability_balances lb
    JOIN liabilities l ON l.id = lb.liability_id
    WHERE lb.organization_id = $1
      AND l.is_archived = FALSE
    ORDER BY lb.liability_id, lb.as_of DESC
  `,
    [orgId],
  );
  return rows as unknown as ValueRow[];
}

/**
 * Port of Go Store.NetWorthNow.
 */
export async function netWorthNow(
  env: Env,
  orgId: string,
  userId: string,
  baseCurrency: string,
): Promise<{
  as_of: string;
  base_currency: string;
  total_assets: Decimal;
  total_holdings: Decimal;
  total_liabs: Decimal;
  net_worth: Decimal;
}> {
  const fxRates = await latestFxRates(env, baseCurrency);

  const [assets, holdings, liabs] = await withOrg(env, orgId, userId, async (q) => {
    return Promise.all([
      latestAssetValuations(q, orgId),
      holdingsValue(q, orgId),
      latestLiabilityBalances(q, orgId),
    ]);
  });

  const totalAssets = sum(assets.map((a) => convertToBase(a.value, a.currency, baseCurrency, fxRates)));
  const totalHoldings = sum(holdings.map((h) => convertToBase(h.value, h.currency, baseCurrency, fxRates)));
  const totalLiabs = sum(liabs.map((l) => convertToBase(l.value, l.currency, baseCurrency, fxRates)));
  const netWorth = add(add(totalAssets, totalHoldings), totalLiabs.neg());

  const asOf = new Date().toISOString().slice(0, 10);

  return {
    as_of: asOf,
    base_currency: baseCurrency,
    total_assets: totalAssets,
    total_holdings: totalHoldings,
    total_liabs: totalLiabs,
    net_worth: netWorth,
  };
}

/**
 * Port of Go Store.NetWorthTimeSeries.
 * Collects distinct as_of dates, then computes net worth at each date.
 */
export async function netWorthTimeSeries(
  env: Env,
  orgId: string,
  userId: string,
  baseCurrency: string,
  from: string,
  to: string,
): Promise<Array<{ as_of: string; net_worth: Decimal }>> {
  const fxRates = await latestFxRates(env, baseCurrency);

  return withOrg(env, orgId, userId, async (q) => {
    // Collect distinct dates from asset_valuations and liability_balances
    const dateRows = await q(
      `
      SELECT DISTINCT as_of::text AS as_of
      FROM (
        SELECT av.as_of FROM asset_valuations av WHERE av.organization_id = $1
        UNION
        SELECT lb.as_of FROM liability_balances lb WHERE lb.organization_id = $1
      ) d
      WHERE as_of >= $2 AND as_of <= $3
      ORDER BY as_of ASC
    `,
      [orgId, from, to],
    );
    const dates = (dateRows as unknown as DateRow[]).map((r) => r.as_of);

    const points: Array<{ as_of: string; net_worth: Decimal }> = [];

    for (const asOf of dates) {
      // Assets at date
      const assetRows = await q(
        `
        SELECT DISTINCT ON (av.asset_id)
          av.value::text AS value, av.currency
        FROM asset_valuations av
        JOIN assets a ON a.id = av.asset_id
        WHERE av.organization_id = $1
          AND av.as_of           <= $2
          AND a.is_archived       = FALSE
        ORDER BY av.asset_id, av.as_of DESC
      `,
        [orgId, asOf],
      );
      const assetTotal = sum(
        (assetRows as unknown as ValueRow[]).map((a) =>
          convertToBase(a.value, a.currency, baseCurrency, fxRates),
        ),
      );

      // Liabilities at date
      const liabRows = await q(
        `
        SELECT DISTINCT ON (lb.liability_id)
          lb.balance::text AS value, lb.currency
        FROM liability_balances lb
        JOIN liabilities l ON l.id = lb.liability_id
        WHERE lb.organization_id = $1
          AND lb.as_of           <= $2
          AND l.is_archived       = FALSE
        ORDER BY lb.liability_id, lb.as_of DESC
      `,
        [orgId, asOf],
      );
      const liabTotal = sum(
        (liabRows as unknown as ValueRow[]).map((l) =>
          convertToBase(l.value, l.currency, baseCurrency, fxRates),
        ),
      );

      // Holdings: use current price (best-effort, no price history) — matches Go behaviour
      const holdRows = await holdingsValue(q, orgId);
      const holdTotal = sum(
        holdRows.map((h) => convertToBase(h.value, h.currency, baseCurrency, fxRates)),
      );

      const netWorth = add(add(assetTotal, holdTotal), liabTotal.neg());
      points.push({ as_of: asOf, net_worth: netWorth });
    }

    return points;
  });
}
