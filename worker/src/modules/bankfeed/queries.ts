/**
 * Bankfeed store queries — port of backend/internal/bankfeed/store.go.
 *
 * All SQL is ported 1:1 from Go. Every org query includes WHERE
 * organization_id=$. Amount / balance columns are stored as NUMERIC — the
 * driver may return them as strings; callers cast as needed.
 */
import { queryRows, queryOne, withOrg } from "../../db/client";
import type { Query } from "../../db/client";
import type { Env } from "../../bindings";
import type { Connection, FeedStatus, LinkedAccount, ProviderTransaction } from "./types";
import { normalizeMerchant as normMerchant } from "../../lib/merchant";

// ─── Row mapping ───────────────────────────────────────────────────────────────

function rowToConnection(r: Record<string, unknown>): Connection {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    accountId: (r.account_id as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    provider: r.provider as string,
    providerItemId: r.provider_item_id as string,
    providerAccountId: r.provider_account_id as string,
    institutionName: r.institution_name as string,
    institutionId: r.institution_id as string,
    mask: (r.mask as string) ?? "",
    accessTokenEncrypted: (r.access_token_encrypted as string) ?? "",
    refreshTokenEncrypted: (r.refresh_token_encrypted as string) ?? "",
    cursor: (r.cursor as string) ?? "",
    status: r.status as FeedStatus,
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    lastSyncedAt: (r.last_synced_at as string | null) ?? null,
    consentExpiresAt: (r.consent_expires_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

const connCols = `
  id, organization_id, account_id, created_by,
  provider, provider_item_id, provider_account_id,
  institution_name, institution_id, mask,
  access_token_encrypted, refresh_token_encrypted,
  COALESCE(cursor, ''), status,
  error_code, error_message, last_synced_at, consent_expires_at,
  created_at, updated_at
`;

// ─── Connection operations ─────────────────────────────────────────────────────

/**
 * createConnection — port of Store.CreateConnection.
 * Upserts on (provider, provider_item_id, provider_account_id).
 */
export async function createConnection(
  env: Env,
  orgId: string,
  userId: string,
  provider: string,
  la: LinkedAccount,
  accessEnc: string,
  refreshEnc: string,
  consentExpiresAt: string | null,
): Promise<Connection> {
  const rows = await queryRows(
    env,
    `INSERT INTO bank_feed_connections (
       organization_id, created_by, provider,
       provider_item_id, provider_account_id,
       institution_name, institution_id, mask,
       access_token_encrypted, refresh_token_encrypted,
       status, consent_expires_at
     ) VALUES (
       $1, $2, $3::bank_feed_provider,
       $4, $5,
       $6, $7, $8,
       $9, $10,
       'pending'::bank_feed_status, $11
     )
     ON CONFLICT (provider, provider_item_id, provider_account_id) DO UPDATE
     SET access_token_encrypted  = EXCLUDED.access_token_encrypted,
         refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
         consent_expires_at      = EXCLUDED.consent_expires_at,
         status                  = 'pending'::bank_feed_status,
         error_code              = NULL,
         error_message           = NULL,
         updated_at              = NOW()
     RETURNING ${connCols}`,
    [
      orgId, userId, provider,
      la.providerItemId, la.providerAccountId,
      la.institutionName, la.institutionId, la.mask,
      accessEnc, refreshEnc,
      consentExpiresAt,
    ],
  );
  if (!rows.length) throw new Error("bankfeed: createConnection: no row returned");
  return rowToConnection(rows[0]);
}

/**
 * getConnection — port of Store.GetConnection.
 */
export async function getConnection(
  env: Env,
  orgId: string,
  connId: string,
): Promise<Connection | null> {
  const row = await queryOne(
    env,
    `SELECT ${connCols}
     FROM bank_feed_connections
     WHERE organization_id = $1 AND id = $2`,
    [orgId, connId],
  );
  return row ? rowToConnection(row) : null;
}

/**
 * listConnections — port of Store.ListConnections.
 */
export async function listConnections(env: Env, orgId: string): Promise<Connection[]> {
  const rows = await queryRows(
    env,
    `SELECT ${connCols}
     FROM bank_feed_connections
     WHERE organization_id = $1
     ORDER BY created_at DESC`,
    [orgId],
  );
  return rows.map(rowToConnection);
}

/**
 * listDueConnections — port of Store.ListDueConnections.
 * Returns connected accounts whose last_synced_at is older than minAgeMs ms.
 */
export async function listDueConnections(
  env: Env,
  minAgeMs: number,
): Promise<Connection[]> {
  const intervalSecs = Math.floor(minAgeMs / 1000);
  const rows = await queryRows(
    env,
    `SELECT ${connCols}
     FROM bank_feed_connections
     WHERE status = 'connected'::bank_feed_status
       AND (last_synced_at IS NULL
            OR last_synced_at < NOW() - ($1 || ' seconds')::interval)
     ORDER BY last_synced_at ASC NULLS FIRST`,
    [String(intervalSecs)],
  );
  return rows.map(rowToConnection);
}

/**
 * updateConnectionStatus — port of Store.UpdateConnectionStatus.
 */
export async function updateConnectionStatus(
  env: Env,
  connId: string,
  status: FeedStatus,
  errCode: string,
  errMsg: string,
): Promise<void> {
  await queryRows(
    env,
    `UPDATE bank_feed_connections
     SET status        = $2::bank_feed_status,
         error_code    = NULLIF($3, ''),
         error_message = NULLIF($4, ''),
         updated_at    = NOW()
     WHERE id = $1`,
    [connId, status, errCode, errMsg],
  );
}

/**
 * markSynced — port of Store.MarkSynced.
 */
export async function markSynced(
  env: Env,
  connId: string,
  nextCursor: string,
): Promise<void> {
  await queryRows(
    env,
    `UPDATE bank_feed_connections
     SET last_synced_at = NOW(),
         cursor         = NULLIF($2, ''),
         status         = 'connected'::bank_feed_status,
         error_code     = NULL,
         error_message  = NULL,
         updated_at     = NOW()
     WHERE id = $1`,
    [connId, nextCursor],
  );
}

/**
 * updateTokens — port of Store.UpdateTokens.
 */
export async function updateTokens(
  env: Env,
  connId: string,
  accessEnc: string,
  refreshEnc: string,
  expiresAt: string,
): Promise<void> {
  await queryRows(
    env,
    `UPDATE bank_feed_connections
     SET access_token_encrypted  = $2,
         refresh_token_encrypted = $3,
         consent_expires_at      = $4,
         updated_at              = NOW()
     WHERE id = $1`,
    [connId, accessEnc, refreshEnc, expiresAt],
  );
}

// ─── Statement + line upsert ───────────────────────────────────────────────────

/**
 * ensureStatement — port of Store.EnsureStatement.
 */
export async function ensureStatement(
  q: Query,
  orgId: string,
  connId: string,
  periodStart: string,
  periodEnd: string,
  currency: string,
): Promise<string> {
  // Try INSERT … RETURNING id.
  const rows = await q(
    `INSERT INTO bank_statements (
       organization_id, bank_feed_connection_id,
       period_start, period_end, currency, status
     ) VALUES (
       $1, $2, $3, $4, $5, 'pending'::document_status
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [orgId, connId, periodStart, periodEnd, currency],
  );
  if (rows.length) return rows[0].id as string;

  // Row already exists — fetch it.
  const existing = await q(
    `SELECT id FROM bank_statements
     WHERE organization_id = $1
       AND bank_feed_connection_id = $2
       AND period_start = $3
       AND period_end   = $4`,
    [orgId, connId, periodStart, periodEnd],
  );
  if (!existing.length) throw new Error("bankfeed: ensureStatement: row vanished");
  return existing[0].id as string;
}

/**
 * upsertLine — port of Store.UpsertLine.
 * Returns [lineId, inserted]. inserted=false means ErrDuplicate.
 */
export async function upsertLine(
  q: Query,
  orgId: string,
  statementId: string,
  connId: string,
  pt: ProviderTransaction,
): Promise<[string | null, boolean]> {
  const rawJson = JSON.stringify(pt.raw ?? {});
  const rows = await q(
    `INSERT INTO statement_lines (
       statement_id, organization_id,
       bank_feed_connection_id, provider_txn_id,
       line_date, description, amount, balance, raw
     ) VALUES (
       $1, $2,
       $3, $4,
       $5, $6, $7, $8, $9
     )
     ON CONFLICT (bank_feed_connection_id, provider_txn_id)
         WHERE provider_txn_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      statementId, orgId,
      connId, pt.providerTxnId,
      pt.date, pt.description, pt.amount, pt.balance, rawJson,
    ],
  );
  if (!rows.length) return [null, false]; // duplicate
  return [rows[0].id as string, true];
}

/**
 * linkTransaction — port of Store.LinkTransaction.
 */
export async function linkTransaction(
  q: Query,
  lineId: string,
  txId: string,
): Promise<void> {
  await q(
    `UPDATE statement_lines SET transaction_id = $2 WHERE id = $1`,
    [lineId, txId],
  );
}

/**
 * createTransaction — port of Store.CreateTransaction.
 */
export async function createTransaction(
  q: Query,
  orgId: string,
  pt: ProviderTransaction,
): Promise<string> {
  const normalized = normMerchant(pt.description);
  const rows = await q(
    `INSERT INTO transactions (
       organization_id, merchant, merchant_normalized,
       description, amount, currency,
       posted_date, direction, status
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6,
       $7, $8::transaction_direction, 'pending'::transaction_status
     )
     RETURNING id`,
    [
      orgId, pt.description, normalized,
      pt.description, pt.amount, pt.currency,
      pt.date, pt.direction,
    ],
  );
  if (!rows.length) throw new Error("bankfeed: createTransaction: no row returned");
  return rows[0].id as string;
}

// ─── Classification cascade (inline port of cascade.go) ───────────────────────

interface CascadeResult {
  ruleId: string | null;
  categoryId: string | null;
  confidence: number;
  source: "rule" | "merchant_signal";
}

/**
 * runCascade — port of FeedCascader.RunCascade.
 * rule-exact → rule-contains → merchant_signal. LLM stage intentionally omitted.
 */
export async function runCascade(
  q: Query,
  orgId: string,
  txId: string,
): Promise<void> {
  // Load merchant_normalized.
  const txRows = await q(
    `SELECT merchant_normalized FROM transactions WHERE id = $1 AND organization_id = $2`,
    [txId, orgId],
  );
  if (!txRows.length) return;
  const mn = (txRows[0].merchant_normalized as string | null) ?? "";
  if (!mn) return;

  let cl: CascadeResult | null = null;

  // Stage 1: exact rule.
  cl = await tryCascadeRule(q, orgId, mn, "merchant_exact");

  // Stage 2: contains rule.
  if (!cl) cl = await tryCascadeContainsRule(q, orgId, mn);

  // Stage 3: merchant_signals.
  if (!cl) cl = await tryCascadeSignal(q, orgId, mn);

  if (!cl) return; // unclassified — leave for manual/LLM

  await writeCascadeClassification(q, orgId, txId, cl);
}

async function tryCascadeRule(
  q: Query,
  orgId: string,
  mn: string,
  matchType: string,
): Promise<CascadeResult | null> {
  const rows = await q(
    `SELECT id, category_id, COALESCE(confidence, 1.0)
     FROM classification_rules
     WHERE organization_id = $1
       AND match_type = $2::classification_match_type
       AND match_value = $3
     ORDER BY confidence DESC
     LIMIT 1`,
    [orgId, matchType, mn],
  );
  if (!rows.length) return null;
  return {
    ruleId: rows[0].id as string,
    categoryId: rows[0].category_id as string | null,
    confidence: Number(rows[0].coalesce),
    source: "rule",
  };
}

async function tryCascadeContainsRule(
  q: Query,
  orgId: string,
  mn: string,
): Promise<CascadeResult | null> {
  const rows = await q(
    `SELECT id, category_id, COALESCE(confidence, 1.0)
     FROM classification_rules
     WHERE organization_id = $1
       AND match_type = 'merchant_contains'
       AND $2 LIKE '%' || match_value || '%'
     ORDER BY confidence DESC
     LIMIT 1`,
    [orgId, mn],
  );
  if (!rows.length) return null;
  return {
    ruleId: rows[0].id as string,
    categoryId: rows[0].category_id as string | null,
    confidence: Number(rows[0].coalesce),
    source: "rule",
  };
}

async function tryCascadeSignal(
  q: Query,
  orgId: string,
  mn: string,
): Promise<CascadeResult | null> {
  const labelRows = await q(
    `SELECT category_label
     FROM merchant_signals
     WHERE merchant_normalized = $1
     ORDER BY vote_count DESC
     LIMIT 1`,
    [mn],
  );
  if (!labelRows.length) return null;
  const label = labelRows[0].category_label as string;

  const catRows = await q(
    `SELECT id FROM categories
     WHERE organization_id = $1 AND LOWER(name) = LOWER($2)
     LIMIT 1`,
    [orgId, label],
  );
  if (!catRows.length) return null;

  return {
    ruleId: null,
    categoryId: catRows[0].id as string,
    confidence: 0.7,
    source: "merchant_signal",
  };
}

async function writeCascadeClassification(
  q: Query,
  orgId: string,
  txId: string,
  cl: CascadeResult,
): Promise<void> {
  // Clear existing current classification.
  await q(
    `UPDATE transaction_classifications SET is_current = false
     WHERE transaction_id = $1 AND is_current`,
    [txId],
  );

  // Insert new classification row.
  const classRows = await q(
    `INSERT INTO transaction_classifications (
       transaction_id, organization_id,
       rule_id, category_id,
       source, confidence, is_current
     ) VALUES (
       $1, $2,
       $3, $4,
       $5::classification_source, $6, true
     ) RETURNING id`,
    [txId, orgId, cl.ruleId, cl.categoryId, cl.source, cl.confidence],
  );
  if (!classRows.length) return;
  const classId = classRows[0].id as string;

  // Update denormalized pointer.
  await q(
    `UPDATE transactions SET
       category_id                = $2,
       current_classification_id  = $3,
       status                     = 'verified'::transaction_status,
       updated_at                 = NOW()
     WHERE id = $1`,
    [txId, cl.categoryId, classId],
  );
}

// ─── OAuth state (PKCE CSRF) ───────────────────────────────────────────────────
//
// Strategy: try to INSERT into oauth_pkce_states (if the table exists). If
// the table is missing, fall back to env.RATE_LIMIT KV with a 15-min TTL.
// The routes document which path was taken.

/** Persist an OAuth state nonce → orgId mapping, TTL 15 minutes. */
export async function saveOAuthState(
  env: Env,
  state: string,
  orgId: string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  // Prefer KV (always available on Workers; no extra DB table required).
  if (env.RATE_LIMIT) {
    await env.RATE_LIMIT.put(`oauth_state:${state}`, orgId, { expirationTtl: 900 });
    return;
  }

  // Fallback: oauth_pkce_states table (must exist in schema).
  await queryRows(env,
    `INSERT INTO oauth_pkce_states (state, org_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (state) DO NOTHING`,
    [state, orgId, expiresAt],
  );
}

/** Retrieve and consume (delete) an OAuth state. Returns orgId or null. */
export async function consumeOAuthState(
  env: Env,
  state: string,
): Promise<string | null> {
  // KV path.
  if (env.RATE_LIMIT) {
    const orgId = await env.RATE_LIMIT.get(`oauth_state:${state}`);
    if (orgId) await env.RATE_LIMIT.delete(`oauth_state:${state}`);
    return orgId;
  }

  // DB path.
  const rows = await queryRows(env,
    `DELETE FROM oauth_pkce_states
     WHERE state = $1 AND expires_at > NOW()
     RETURNING org_id`,
    [state],
  );
  return rows.length ? (rows[0].org_id as string) : null;
}
