/**
 * Document processing pipeline — shared orchestration for upload-time and cron.
 *
 * processDocument(env, orgId, docId):
 *   1. extractDocument  — status: queued/processing → extracted | failed
 *   2. classifyDocument — creates transactions + runs classification cascade
 *
 * Both the upload handler (via waitUntil) and the extraction cron use this
 * function so the two paths can't drift apart.
 *
 * Idempotency: extractDocument already guards against re-running on a doc
 * that is in 'processing' or 'extracted' (status transitions in the DB), and
 * classifyDocument errors are logged but don't wedge status. A doc that
 * failed extraction keeps status='failed'; classifyDocument is not called.
 */
import type { Env } from "../../bindings";
import { extractDocument } from "../extract/service";
import { classifyDocument } from "../classify/service";

/**
 * Run the full extraction → classification pipeline for a single document.
 * Safe to call from both waitUntil (upload handler) and the cron safety-net.
 *
 * @throws Never — all errors are caught and logged so a failure in this
 *         function cannot break a waitUntil call or leave the caller wedged.
 */
export async function processDocument(
  env: Env,
  orgId: string,
  docId: string,
): Promise<void> {
  // Step 1: extract
  let extractionId: string;
  try {
    extractionId = await extractDocument(env, orgId, docId);
  } catch (e) {
    // extractDocument already set status='failed' and logged.  We just record
    // the error here so the caller can trace the failure.
    console.error(`pipeline: extraction failed doc=${docId}:`, e);
    return; // do NOT attempt classification on a failed extraction
  }

  // Step 2: classify (extraction succeeded)
  try {
    await classifyDocument(env, orgId, docId);
    console.log(`pipeline: classify done doc=${docId} extraction=${extractionId}`);
  } catch (e) {
    // Classification errors are non-fatal for the document status; the
    // extraction already succeeded and the document row reflects that.
    console.error(`pipeline: classification failed doc=${docId}:`, e);
  }
}
