/**
 * Insights module types — port of Go backend/internal/insights/query.go.
 *
 * The model never produces SQL. It produces a typed Query (intent + a fixed
 * set of filters), and the SQL builder turns that into a parameterised
 * statement. A malicious or confused model can't cause SQL injection — the
 * worst it can do is filter by an unhelpful value.
 */
import { CATEGORIES } from "../../lib/gemini";

/** Intent is what the user is asking for, drawn from a closed enum. */
export type Intent =
  | "list"            // Return matching transactions
  | "sum"             // Total spend across matches
  | "count"           // How many transactions match
  | "top_merchants"   // Group by merchant, sum
  | "by_category"     // Group by category, sum
  | "by_month";       // Group by YYYY-MM, sum

export const VALID_INTENTS: Intent[] = [
  "list", "sum", "count", "top_merchants", "by_category", "by_month",
];

export function isValidIntent(s: string): s is Intent {
  return (VALID_INTENTS as string[]).includes(s);
}

/** Filters is the closed set of conditions the model can produce. */
export interface Filters {
  merchant_contains?: string;  // substring match
  category?: string;           // must be in CATEGORIES
  date_from?: string;          // YYYY-MM-DD
  date_to?: string;            // YYYY-MM-DD
  amount_min?: number;
  amount_max?: number;
  currency?: string;           // 3-letter
  status?: string;             // pending|verified|rejected
}

/** Query is what the model emits. Limit is bounded by the runner. */
export interface Query {
  intent: Intent;
  filters: Filters;
  limit?: number;
}

/** Document is the slim shape Run returns for "list" intent. */
export interface InsightDocument {
  id: string;
  merchant?: string;
  amount?: number;
  currency?: string;
  transaction_date?: string;
  category?: string;
  status: string;
  created_at: string;
}

/** Group is one row of an aggregated breakdown. */
export interface Group {
  key: string;
  total: number;
  count: number;
}

/** Totals is what we return for sum/count intents. */
export interface Totals {
  amount?: number;
  count: number;
  currency?: string;
}

/** Result is the union answer for any intent. Frontend picks fields based on intent. */
export interface InsightResult {
  intent: Intent;
  filters: Filters;
  summary: string;
  documents?: InsightDocument[];
  groups?: Group[];
  totals?: Totals;
}

// Re-export categories for use in translate.ts
export { CATEGORIES };
