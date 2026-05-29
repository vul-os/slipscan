/**
 * Cron dispatcher (free-tier replacement for the Go background goroutines).
 * Wired into the Worker's scheduled() handler; routes by event.cron.
 *   * * * * *    → document extraction poll + email outbox delivery
 *   0 * * * *    → merchant-signal aggregation + FX rate sync
 *   0 *\/4 * * *  → bank-feed sync
 */
import type { Env } from "../bindings";
import { processPendingExtractions } from "../modules/extract/cron";
import { aggregateSignals } from "../modules/classify/signals";
import { deliverOutbox } from "../modules/email/outbox";
import { syncFxRates } from "../modules/fx/cron";
import { syncBankFeeds } from "../modules/bankfeed/cron";

async function safe(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`cron: ${label}:`, e);
  }
}

export async function handleScheduled(
  event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const cron = event.cron;

  // Every minute: extraction pipeline + outbound email delivery.
  await safe("extraction", () => processPendingExtractions(env, 10));
  await safe("outbox", () => deliverOutbox(env));

  // Hourly: cross-tenant signal aggregation + FX rates.
  if (cron === "0 * * * *") {
    await safe("signals", () => aggregateSignals(env));
    await safe("fx", () => syncFxRates(env));
  }

  // Every 4 hours: bank-feed sync.
  if (cron === "0 */4 * * *") {
    await safe("bankfeed", () => syncBankFeeds(env));
  }
}
