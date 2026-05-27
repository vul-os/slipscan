/**
 * FX sync cron — port of backend/internal/fx/scheduler.go.
 *
 * syncFxRates(env):
 *   Fetches today's exchange rates from Frankfurter (or exchangerate-api.com
 *   when EXCHANGE_RATE_API_KEY is set) and upserts them into fx_rates.
 *
 *   Wire into cron/scheduled.ts on the "0 * * * *" (hourly) schedule.
 *   The Cloudflare cron trigger replaces the Go ticker+leader-flag pattern:
 *   CF Workers guarantee a single invocation per trigger so no thundering-herd
 *   guard is needed.
 */
import type { Env } from "../../bindings";
import { fetchRates } from "./client";
import { upsertRates } from "./queries";

/** Source label stored in fx_rates.source. */
function sourceLabel(apiKey?: string): string {
  return apiKey ? "exchangerate-api.com" : "frankfurter.app";
}

/**
 * Fetch latest FX rates and upsert into fx_rates.
 * Exported for wiring in the Worker's scheduled() handler.
 */
export async function syncFxRates(env: Env): Promise<void> {
  const base   = env.EXCHANGE_RATE_BASE ?? "USD";
  const apiKey = env.EXCHANGE_RATE_API_KEY;
  const source = sourceLabel(apiKey);

  console.log(`fx: sync start (base=${base} source=${source})`);

  const result = await fetchRates(base, apiKey);

  await upsertRates(env, result, source);

  console.log(
    `fx: synced ${Object.keys(result.rates).length} rates` +
    ` (base=${result.base} as_of=${result.asOf.toISOString().slice(0, 10)})`,
  );
}
