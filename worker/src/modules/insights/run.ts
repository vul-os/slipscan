/**
 * Insights run — port of Go backend/internal/insights/run.go.
 *
 * Executes a structured Query against the transactions table for a single org.
 * All filters become positional SQL parameters; the model can never inject SQL.
 */
import type { Env } from "../../bindings";
import type { Query, InsightResult } from "./types";
import { buildWhere, runListSafe, runSum, runCount, runGroup, runByMonth } from "./queries";
import { summarizeList, summarizeSum, summarizeCount, summarizeGroups } from "./summary";

/**
 * Port of Go Run — dispatches to the right runner based on intent.
 */
export async function run(env: Env, orgId: string, q: Query): Promise<InsightResult> {
  const { where, args } = buildWhere(orgId, q.filters);
  const res: InsightResult = {
    intent: q.intent,
    filters: q.filters,
    summary: "",
  };

  switch (q.intent) {
    case "list": {
      const docs = await runListSafe(env, where, args, q.limit ?? 0);
      res.documents = docs;
      res.summary = summarizeList(q.filters, docs.length);
      break;
    }
    case "sum": {
      const totals = await runSum(env, where, args);
      res.totals = totals;
      res.summary = summarizeSum(q.filters, totals);
      break;
    }
    case "count": {
      const count = await runCount(env, where, args);
      res.totals = { count };
      res.summary = summarizeCount(q.filters, count);
      break;
    }
    case "top_merchants": {
      const groups = await runGroup(env, "merchant", where, args);
      res.groups = groups;
      res.summary = summarizeGroups("merchant", q.filters, groups);
      break;
    }
    case "by_category": {
      const groups = await runGroup(env, "category", where, args);
      res.groups = groups;
      res.summary = summarizeGroups("category", q.filters, groups);
      break;
    }
    case "by_month": {
      const groups = await runByMonth(env, where, args);
      res.groups = groups;
      res.summary = summarizeGroups("month", q.filters, groups);
      break;
    }
    default: {
      throw new Error(`unsupported intent "${q.intent}"`);
    }
  }

  return res;
}
