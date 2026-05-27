/**
 * Bankfeed syncer — port of backend/internal/bankfeed/syncer.go.
 *
 * Drives the fetch → upsert → classify pipeline for a single connection.
 * Used by the routes (on-demand sync / webhook) and cron (SyncAll).
 *
 * Classification: inline rule→signal cascade from queries.runCascade.
 * LLM stage intentionally omitted (no document context for feed txns).
 * Re-auth: on 401/token-expired, one refresh attempt; on failure the
 * connection is marked reauth_required.
 */
import type { Env } from "../../bindings";
import { withOrg } from "../../db/client";
import type { Connection } from "./types";
import {
  ensureStatement,
  upsertLine,
  createTransaction,
  linkTransaction,
  runCascade,
  markSynced,
  updateConnectionStatus,
  updateTokens,
} from "./queries";
import {
  fetchTransactions,
  refreshAccessToken,
  stitchConfigured,
} from "./stitch";

// ─── SyncConnection ────────────────────────────────────────────────────────────

/**
 * syncConnection — port of Syncer.SyncConnection.
 * Fetches all pages of transactions since last sync, upserts them, creates
 * transactions rows, runs the classification cascade, and marks synced.
 */
export async function syncConnection(env: Env, conn: Connection): Promise<void> {
  if (!stitchConfigured(env)) {
    throw new Error("bankfeed: Stitch is not configured (STITCH_CLIENT_ID unset)");
  }

  // Determine fetch window.
  let from: string;
  if (conn.lastSyncedAt) {
    // 1-day overlap for late-posting transactions.
    const d = new Date(conn.lastSyncedAt);
    d.setDate(d.getDate() - 1);
    from = d.toISOString().slice(0, 10);
  } else {
    // 90-day initial window.
    const d = new Date();
    d.setDate(d.getDate() - 90);
    from = d.toISOString().slice(0, 10);
  }
  const to = new Date().toISOString().slice(0, 10);

  let accessToken = conn.accessTokenEncrypted;
  let cursor = conn.cursor;
  let newTransactions = 0;

  for (;;) {
    let txns: Awaited<ReturnType<typeof fetchTransactions>>[0];
    let nextCursor: string;

    try {
      [txns, nextCursor] = await fetchTransactions(
        accessToken,
        conn.providerAccountId,
        from,
        to,
        cursor,
      );
    } catch (fetchErr) {
      if (isAuthError(fetchErr)) {
        // Attempt one token refresh.
        try {
          const tok = await refreshAccessToken(env, conn.refreshTokenEncrypted);
          await updateTokens(env, conn.id, tok.accessToken, tok.refreshToken, tok.expiresAt);
          accessToken = tok.accessToken;
          conn.refreshTokenEncrypted = tok.refreshToken;
          // Retry with new token.
          [txns, nextCursor] = await fetchTransactions(
            accessToken,
            conn.providerAccountId,
            from,
            to,
            cursor,
          );
        } catch (refreshErr) {
          await updateConnectionStatus(env, conn.id, "reauth_required", "token_expired",
            `Re-authentication required: ${String(refreshErr)}`);
          throw new Error(`bankfeed: token refresh failed (conn ${conn.id}): ${String(refreshErr)}`);
        }
      } else {
        await updateConnectionStatus(env, conn.id, "error", "fetch_failed", String(fetchErr));
        throw new Error(`bankfeed: fetch transactions (conn ${conn.id}): ${String(fetchErr)}`);
      }
    }

    if (txns.length > 0) {
      const n = await upsertBatch(env, conn, txns, from, to);
      newTransactions += n;
    }

    if (!nextCursor) break;
    cursor = nextCursor;
  }

  await markSynced(env, conn.id, cursor);
  console.log(`bankfeed: synced connection ${conn.id} (${conn.institutionName}): ${newTransactions} new transactions`);
}

// ─── upsertBatch ──────────────────────────────────────────────────────────────

/**
 * upsertBatch — port of Syncer.upsertBatch.
 * Upserts statement + lines + transactions for a batch of provider txns.
 * Returns the count of newly-imported rows.
 */
async function upsertBatch(
  env: Env,
  conn: Connection,
  txns: ReturnType<typeof fetchTransactions> extends Promise<[infer T, string]> ? T : never,
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  const currency = (txns as Array<{ currency: string }>)[0]?.currency || "ZAR";

  return withOrg(env, conn.organizationId, null, async (q) => {
    const statementId = await ensureStatement(
      q, conn.organizationId, conn.id, periodStart, periodEnd, currency,
    );

    let newCount = 0;
    for (const pt of txns as Array<{ providerTxnId: string; date: string; description: string; amount: number; currency: string; direction: "debit" | "credit"; balance: number | null; raw: Record<string, unknown> }>) {
      const [lineId, inserted] = await upsertLine(
        q, conn.organizationId, statementId, conn.id, pt,
      );
      if (!inserted || !lineId) continue; // duplicate

      let txId: string;
      try {
        txId = await createTransaction(q, conn.organizationId, pt);
      } catch (e) {
        console.error(`bankfeed: create transaction for line ${lineId}:`, e);
        continue;
      }

      try {
        await linkTransaction(q, lineId, txId);
      } catch (e) {
        console.error(`bankfeed: link transaction ${txId} → line ${lineId}:`, e);
      }

      // Classification cascade (rule → signal; LLM omitted).
      try {
        await runCascade(q, conn.organizationId, txId);
      } catch (e) {
        console.error(`bankfeed: classify transaction ${txId}:`, e);
        // Non-fatal.
      }

      newCount++;
    }
    return newCount;
  });
}

// ─── Auth-error detection ──────────────────────────────────────────────────────

function isAuthError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return ["401", "unauthorized", "Unauthorized", "token expired", "invalid_token"]
    .some((kw) => msg.includes(kw));
}
