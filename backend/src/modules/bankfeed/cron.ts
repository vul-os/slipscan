/**
 * Bankfeed cron processor — port of backend/internal/bankfeed/syncer.SyncAll
 * and scheduler.go, adapted for Cloudflare Workers' scheduled() handler.
 *
 * Usage: the integrator wires this into cron/scheduled.ts:
 *
 *   import { syncBankFeeds } from "../modules/bankfeed/cron";
 *   // in handleScheduled:
 *   if (event.cron === "0 *\/4 * * *") {  // every 4 hours
 *     await syncBankFeeds(env);
 *   }
 *
 * This module does NOT edit index.ts or scheduled.ts — the integrator wires it.
 *
 * Sync window: connections whose last_synced_at is older than 4 hours
 * (matching Go's 4-hour default poll interval).
 */
import type { Env } from "../../bindings";
import { listDueConnections } from "./queries";
import { syncConnection } from "./syncer";
import { stitchConfigured } from "./stitch";

const SYNC_MIN_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * syncBankFeeds — port of Syncer.SyncAll + Scheduler behaviour.
 *
 * Fetches all bank_feed_connections that are 'connected' and due for a sync,
 * then runs syncConnection on each. Errors are logged per-connection but do
 * not abort the batch (mirrors Go's continue-on-error pattern).
 *
 * When STITCH_CLIENT_ID is unset, the function logs a warning and returns
 * immediately (provider not configured).
 */
export async function syncBankFeeds(env: Env): Promise<void> {
  if (!stitchConfigured(env)) {
    console.log("bankfeed: cron: Stitch not configured — skipping sync");
    return;
  }

  let conns;
  try {
    conns = await listDueConnections(env, SYNC_MIN_AGE_MS);
  } catch (e) {
    console.error("bankfeed: cron: list due connections:", e);
    return;
  }

  if (conns.length === 0) {
    console.log("bankfeed: cron: no connections due for sync");
    return;
  }

  console.log(`bankfeed: cron: syncing ${conns.length} connection(s)`);

  for (const conn of conns) {
    try {
      await syncConnection(env, conn);
    } catch (e) {
      // Per-connection errors are already logged inside syncConnection.
      console.error(
        `bankfeed: cron: sync connection ${conn.id} (${conn.provider} ${conn.institutionName}):`,
        e,
      );
      // Continue with remaining connections — mirrors Go scheduler.poll.
    }
  }
}
