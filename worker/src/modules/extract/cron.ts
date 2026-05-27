/**
 * Extract cron processor — port of the Go cron batch-claim pattern.
 *
 * processPendingExtractions(env, limit):
 *   Claims documents WHERE status='pending' using FOR UPDATE SKIP LOCKED,
 *   transitions them to 'processing', then runs extractDocument for each one.
 *
 * Export this function from cron.ts; the integrator wires it into the
 * Worker's scheduled() handler — do NOT edit worker/src/index.ts.
 *
 * Example wiring (in the integrator's index.ts / cron handler):
 *   import { processPendingExtractions } from "./modules/extract/cron";
 *   export default {
 *     async scheduled(event, env, ctx) {
 *       ctx.waitUntil(processPendingExtractions(env, 10));
 *     },
 *   };
 */
import type { Env } from "../../bindings";
import { claimPendingDocuments } from "./queries";
import { extractDocument } from "./service";

/**
 * Claim up to `limit` pending documents and run the extraction pipeline on
 * each one. Runs claims + extraction concurrently per claimed batch.
 *
 * @param env   Worker environment bindings.
 * @param limit Maximum number of documents to process in this invocation.
 */
export async function processPendingExtractions(env: Env, limit = 10): Promise<void> {
  let claimed: Array<{ id: string; organization_id: string }>;
  try {
    claimed = await claimPendingDocuments(env, limit);
  } catch (e) {
    console.error("extract cron: claim pending documents failed:", e);
    return;
  }

  if (claimed.length === 0) {
    return;
  }

  console.log(`extract cron: processing ${claimed.length} pending document(s)`);

  // Run all claimed documents concurrently (each has its own DB transaction).
  const results = await Promise.allSettled(
    claimed.map((doc) =>
      extractDocument(env, doc.organization_id, doc.id).catch((e) => {
        console.error(`extract cron: doc=${doc.id} failed:`, e);
        throw e;
      }),
    ),
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed    = results.filter((r) => r.status === "rejected").length;
  console.log(`extract cron: done — succeeded=${succeeded} failed=${failed}`);
}
