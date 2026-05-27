/**
 * Cron dispatcher (free-tier replacement for the Go background goroutines).
 * Wired into the Worker's scheduled() handler; routes by event.cron.
 * Wave 1: document extraction poll (every minute) + merchant-signal
 * aggregation (hourly). Later waves add FX, bankfeed, and email-outbox.
 */
import type { Env } from "../bindings";
import { processPendingExtractions } from "../modules/extract/cron";
import { aggregateSignals } from "../modules/classify/signals";

export async function handleScheduled(
  event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // Every minute: claim + extract pending documents (FOR UPDATE SKIP LOCKED).
  try {
    await processPendingExtractions(env, 10);
  } catch (e) {
    console.error("cron: extraction:", e);
  }

  // Hourly: cross-tenant merchant-signal aggregation.
  if (event.cron === "0 * * * *") {
    try {
      await aggregateSignals(env);
    } catch (e) {
      console.error("cron: signals:", e);
    }
  }
}
