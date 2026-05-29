/**
 * DB queries for Xero integration — port of backend/internal/accounting_export/store.go.
 *
 * Covers: accounting_export_mappings, oauth_grants, contacts, transactions
 * (+ accounts + tax_rates joins).
 *
 * Uses queryRows/queryOne (no org RLS required for oauth_grants; contacts +
 * transactions always include WHERE organization_id = $).
 */
import { queryRows, queryOne } from "../../db/client";
import type { Env } from "../../bindings";
import type { Mapping, Grant, Contact, Transaction } from "./types";
import { ERR_MAPPING_NOT_FOUND, ERR_GRANT_NOT_FOUND } from "./types";

// ── Mapping operations ────────────────────────────────────────────────────────

/** Look up one mapping row. Throws ERR_MAPPING_NOT_FOUND when absent. */
export async function getMapping(
  env:       Env,
  orgId:     string,
  provider:  string,
  localType: string,
  localId:   string,
): Promise<Mapping> {
  const row = await queryOne(
    env,
    `SELECT id, organization_id, provider, local_type, local_id, external_id,
            last_synced_at, sync_error, created_at, updated_at
       FROM accounting_export_mappings
      WHERE organization_id = $1 AND provider = $2
        AND local_type = $3 AND local_id = $4`,
    [orgId, provider, localType, localId],
  );
  if (!row) throw new Error(ERR_MAPPING_NOT_FOUND);
  return rowToMapping(row);
}

/** Upsert a mapping row. On conflict: update external_id, clear sync_error, set last_synced_at. */
export async function upsertMapping(
  env:        Env,
  orgId:      string,
  provider:   string,
  localType:  string,
  localId:    string,
  externalId: string,
): Promise<void> {
  await queryRows(
    env,
    `INSERT INTO accounting_export_mappings
       (organization_id, provider, local_type, local_id, external_id, last_synced_at, sync_error)
     VALUES ($1, $2, $3, $4, $5, NOW(), NULL)
     ON CONFLICT (organization_id, provider, local_type, local_id)
     DO UPDATE SET external_id    = EXCLUDED.external_id,
                   last_synced_at = NOW(),
                   sync_error     = NULL`,
    [orgId, provider, localType, localId, externalId],
  );
}

/** Store an error message for the last push attempt. */
export async function recordSyncError(
  env:       Env,
  orgId:     string,
  provider:  string,
  localType: string,
  localId:   string,
  syncErr:   string,
): Promise<void> {
  await queryRows(
    env,
    `INSERT INTO accounting_export_mappings
       (organization_id, provider, local_type, local_id, external_id, sync_error)
     VALUES ($1, $2, $3, $4, '', $5)
     ON CONFLICT (organization_id, provider, local_type, local_id)
     DO UPDATE SET sync_error = EXCLUDED.sync_error`,
    [orgId, provider, localType, localId, syncErr],
  );
}

/** List all mappings for an org + provider, ordered newest first. */
export async function listMappings(
  env:      Env,
  orgId:    string,
  provider: string,
): Promise<Mapping[]> {
  const rows = await queryRows(
    env,
    `SELECT id, organization_id, provider, local_type, local_id, external_id,
            last_synced_at, sync_error, created_at, updated_at
       FROM accounting_export_mappings
      WHERE organization_id = $1 AND provider = $2
      ORDER BY created_at DESC`,
    [orgId, provider],
  );
  return rows.map(rowToMapping);
}

// ── OAuth grant operations ────────────────────────────────────────────────────

/** Fetch the active oauth_grants row for (org, provider). Throws ERR_GRANT_NOT_FOUND. */
export async function getGrant(env: Env, orgId: string, provider: string): Promise<Grant> {
  const row = await queryOne(
    env,
    `SELECT id, organization_id, account_email,
            access_token_encrypted, refresh_token_encrypted, token_type, expires_at
       FROM oauth_grants
      WHERE organization_id = $1 AND provider = $2 AND revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [orgId, provider],
  );
  if (!row) throw new Error(ERR_GRANT_NOT_FOUND);
  return rowToGrant(row);
}

/** Upsert an oauth_grants row. On conflict (org, provider, account_email): refresh tokens. */
export async function upsertGrant(
  env:          Env,
  orgId:        string,
  userId:       string,
  provider:     string,
  accountEmail: string,
  tokenType:    string,
  accessEnc:    string,
  refreshEnc:   string,
  expiresAt:    Date,
): Promise<void> {
  await queryRows(
    env,
    `INSERT INTO oauth_grants
       (organization_id, user_id, provider, account_email,
        access_token_encrypted, refresh_token_encrypted, token_type, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (organization_id, provider, account_email)
     DO UPDATE SET access_token_encrypted  = EXCLUDED.access_token_encrypted,
                   refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
                   token_type              = EXCLUDED.token_type,
                   expires_at              = EXCLUDED.expires_at,
                   revoked_at              = NULL`,
    [orgId, userId, provider, accountEmail, accessEnc, refreshEnc, tokenType, expiresAt.toISOString()],
  );
}

/** Replace token material on an existing grant row (used by refresh path). */
export async function updateGrantTokens(
  env:       Env,
  grantId:   string,
  accessEnc: string,
  refreshEnc: string,
  expiresAt: Date,
): Promise<void> {
  await queryRows(
    env,
    `UPDATE oauth_grants
        SET access_token_encrypted  = $1,
            refresh_token_encrypted = $2,
            expires_at              = $3
      WHERE id = $4`,
    [accessEnc, refreshEnc, expiresAt.toISOString(), grantId],
  );
}

/** Mark the active grant for (org, provider) as revoked. */
export async function revokeGrant(env: Env, orgId: string, provider: string): Promise<void> {
  await queryRows(
    env,
    `UPDATE oauth_grants SET revoked_at = NOW()
      WHERE organization_id = $1 AND provider = $2 AND revoked_at IS NULL`,
    [orgId, provider],
  );
}

// ── Persist OAuth state (for callback CSRF) ───────────────────────────────────

/**
 * Persist a short-lived OAuth state nonce → orgId mapping in DB so it
 * survives across Worker instances (replaces the Go in-memory sync.Map).
 * TTL: 10 minutes. Uses the oauth_states table if it exists; callers
 * handle ErrGrantNotFound-style errors if the table is missing.
 */
export async function saveOAuthState(env: Env, state: string, orgId: string): Promise<void> {
  await queryRows(
    env,
    `INSERT INTO oauth_states (state, organization_id, expires_at)
     VALUES ($1, $2, now() + interval '10 minutes')
     ON CONFLICT (state) DO UPDATE
       SET organization_id = EXCLUDED.organization_id,
           expires_at      = EXCLUDED.expires_at`,
    [state, orgId],
  );
}

/**
 * Consume an OAuth state nonce. Returns the orgId if valid and unexpired,
 * or null if not found / expired. Deletes the row on success.
 */
export async function consumeOAuthState(env: Env, state: string): Promise<string | null> {
  const rows = await queryRows(
    env,
    `DELETE FROM oauth_states
      WHERE state = $1 AND expires_at > now()
      RETURNING organization_id`,
    [state],
  );
  if (!rows.length) return null;
  return rows[0].organization_id as string;
}

// ── Data read operations ──────────────────────────────────────────────────────

/** Fetch a contact row for push. */
export async function getContact(env: Env, orgId: string, contactId: string): Promise<Contact> {
  const row = await queryOne(
    env,
    `SELECT id, name, COALESCE(legal_name,''), COALESCE(email,''),
            COALESCE(phone,''), COALESCE(tax_number,''),
            COALESCE(address_line1,''), COALESCE(address_line2,''),
            COALESCE(city,''), COALESCE(region,''),
            COALESCE(postal_code,''), COALESCE(country,''), kind
       FROM contacts
      WHERE organization_id = $1 AND id = $2 AND NOT is_archived`,
    [orgId, contactId],
  );
  if (!row) throw new Error("contact not found");
  return rowToContact(row);
}

/** List contacts with no clean mapping for the given provider. */
export async function listUnexportedContacts(env: Env, orgId: string, provider: string): Promise<Contact[]> {
  const rows = await queryRows(
    env,
    `SELECT c.id, c.name, COALESCE(c.legal_name,''), COALESCE(c.email,''),
            COALESCE(c.phone,''), COALESCE(c.tax_number,''),
            COALESCE(c.address_line1,''), COALESCE(c.address_line2,''),
            COALESCE(c.city,''), COALESCE(c.region,''),
            COALESCE(c.postal_code,''), COALESCE(c.country,''), c.kind
       FROM contacts c
       LEFT JOIN accounting_export_mappings m
         ON m.local_id = c.id
        AND m.local_type = 'contact'
        AND m.organization_id = c.organization_id
        AND m.provider = $2
      WHERE c.organization_id = $1
        AND NOT c.is_archived
        AND (m.id IS NULL OR m.sync_error IS NOT NULL)
      ORDER BY c.name`,
    [orgId, provider],
  );
  return rows.map(rowToContact);
}

/** Fetch a transaction row (with account + tax_rate joins) for push. */
export async function getTransaction(env: Env, orgId: string, txId: string): Promise<Transaction> {
  const row = await queryOne(
    env,
    `SELECT t.id,
            COALESCE(t.posted_date, CURRENT_DATE),
            t.direction,
            COALESCE(t.merchant, ''),
            COALESCE(t.description, ''),
            COALESCE(t.amount, 0),
            COALESCE(t.currency, 'ZAR'),
            COALESCE(t.tax, 0),
            COALESCE(a.code, ''),
            COALESCE(tr.code, ''),
            COALESCE(t.contact_id::text, '00000000-0000-0000-0000-000000000000')
       FROM transactions t
       LEFT JOIN accounts  a  ON a.id  = t.account_id
       LEFT JOIN tax_rates tr ON tr.id = t.tax_rate_id
      WHERE t.organization_id = $1 AND t.id = $2`,
    [orgId, txId],
  );
  if (!row) throw new Error("transaction not found");
  return rowToTransaction(row);
}

/** List verified transactions with no clean mapping for the given provider. */
export async function listUnexportedTransactions(env: Env, orgId: string, provider: string): Promise<Transaction[]> {
  const rows = await queryRows(
    env,
    `SELECT t.id,
            COALESCE(t.posted_date, CURRENT_DATE),
            t.direction,
            COALESCE(t.merchant, ''),
            COALESCE(t.description, ''),
            COALESCE(t.amount, 0),
            COALESCE(t.currency, 'ZAR'),
            COALESCE(t.tax, 0),
            COALESCE(a.code, ''),
            COALESCE(tr.code, ''),
            COALESCE(t.contact_id::text, '00000000-0000-0000-0000-000000000000')
       FROM transactions t
       LEFT JOIN accounts  a  ON a.id  = t.account_id
       LEFT JOIN tax_rates tr ON tr.id = t.tax_rate_id
       LEFT JOIN accounting_export_mappings m
         ON m.local_id = t.id
        AND m.local_type = 'transaction'
        AND m.organization_id = t.organization_id
        AND m.provider = $2
      WHERE t.organization_id = $1
        AND t.status = 'verified'
        AND (m.id IS NULL OR m.sync_error IS NOT NULL)
      ORDER BY t.posted_date DESC NULLS LAST`,
    [orgId, provider],
  );
  return rows.map(rowToTransaction);
}

// ── Row mappers ───────────────────────────────────────────────────────────────

type AnyRow = Record<string, unknown>;

function rowToMapping(row: AnyRow): Mapping {
  return {
    id:             row.id             as string,
    organizationId: row.organization_id as string,
    provider:       row.provider        as string,
    localType:      row.local_type      as string,
    localId:        row.local_id        as string,
    externalId:     row.external_id     as string,
    lastSyncedAt:   row.last_synced_at  ? new Date(row.last_synced_at as string) : null,
    syncError:      (row.sync_error as string | null) ?? null,
    createdAt:      new Date(row.created_at as string),
    updatedAt:      new Date(row.updated_at as string),
  };
}

function rowToGrant(row: AnyRow): Grant {
  return {
    id:                    row.id                     as string,
    organizationId:        row.organization_id         as string,
    accountEmail:          (row.account_email as string | null) ?? null,
    accessTokenEncrypted:  row.access_token_encrypted  as string,
    refreshTokenEncrypted: row.refresh_token_encrypted as string,
    tokenType:             (row.token_type as string | null) ?? null,
    expiresAt:             row.expires_at ? new Date(row.expires_at as string) : null,
  };
}

function rowToContact(row: AnyRow): Contact {
  // SELECT returns positional values (no named columns for COALESCE aliases)
  // so we rely on the column order from the query.
  const vals = Object.values(row);
  return {
    id:           vals[0]  as string,
    name:         vals[1]  as string,
    legalName:    vals[2]  as string,
    email:        vals[3]  as string,
    phone:        vals[4]  as string,
    taxNumber:    vals[5]  as string,
    addressLine1: vals[6]  as string,
    addressLine2: vals[7]  as string,
    city:         vals[8]  as string,
    region:       vals[9]  as string,
    postalCode:   vals[10] as string,
    country:      vals[11] as string,
    kind:         vals[12] as string,
  };
}

function rowToTransaction(row: AnyRow): Transaction {
  const vals = Object.values(row);
  return {
    id:          vals[0]  as string,
    postedDate:  new Date(vals[1] as string),
    direction:   vals[2]  as string,
    merchant:    vals[3]  as string,
    description: vals[4]  as string,
    amount:      Number(vals[5]),
    currency:    vals[6]  as string,
    tax:         Number(vals[7]),
    accountCode: vals[8]  as string,
    taxRateCode: vals[9]  as string,
    contactId:   vals[10] as string,
  };
}
