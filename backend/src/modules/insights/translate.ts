/**
 * Insights translator — port of Go backend/internal/insights/translate.go.
 *
 * Turns a natural-language question into a structured Query using Gemini's
 * responseSchema. The model has no access to data — it only emits a filter;
 * we run the actual query.
 */
import { Gemini, CATEGORIES } from "../../lib/gemini";
import type { Query, Filters, Intent } from "./types";
import { isValidIntent } from "./types";

/**
 * querySchema mirrors the Query struct.  Intent and category are closed enums
 * so we get an immediate validation error instead of a silent surprise.
 */
const querySchema = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["list", "sum", "count", "top_merchants", "by_category", "by_month"],
    },
    filters: {
      type: "object",
      properties: {
        merchant_contains: { type: "string", nullable: true },
        category:          { type: "string", nullable: true, enum: [...CATEGORIES] },
        date_from:         { type: "string", nullable: true },
        date_to:           { type: "string", nullable: true },
        amount_min:        { type: "number", nullable: true },
        amount_max:        { type: "number", nullable: true },
        currency:          { type: "string", nullable: true },
        status:            { type: "string", nullable: true, enum: ["pending", "verified", "rejected"] },
      },
    },
    limit: { type: "integer", nullable: true },
  },
  required: ["intent"],
};

/**
 * Port of Go Translator.Translate — calls Gemini and returns the parsed Query.
 * The current date goes into the prompt so relative phrases resolve correctly.
 */
export async function translate(apiKey: string, question: string): Promise<Query> {
  const gemini = new Gemini(apiKey);
  const now = new Date().toISOString().slice(0, 10);
  const prompt = `You translate a user's question about their receipts into a structured query.

Today is ${now}. The user's question:
"${question.trim()}"

Pick the single best intent:
- list: show me individual receipts
- sum: total spend ("how much did I spend on X")
- count: how many receipts match
- top_merchants: rank merchants by spend ("who do I spend the most with")
- by_category: break spend down by category
- by_month: break spend down by month

Set only the filters that are explicitly implied. Convert relative dates
(today, this week, last month, year-to-date) into concrete date_from/date_to
ranges. Categories must be one of: ${CATEGORIES.join(", ")}.
If the user says "show me" or "list" without an aggregation hint, use list with limit 25.`;

  const raw = await gemini.generateJSON(prompt, querySchema, 0.0);
  const parsed = JSON.parse(raw) as {
    intent?: string;
    filters?: Filters;
    limit?: number;
  };

  const intent = parsed.intent ?? "";
  if (!isValidIntent(intent)) {
    throw new Error(`translate: invalid intent "${intent}"`);
  }

  return {
    intent: intent as Intent,
    filters: parsed.filters ?? {},
    limit: parsed.limit ?? 0,
  };
}
