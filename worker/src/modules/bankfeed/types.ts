/**
 * Bankfeed domain types — port of backend/internal/bankfeed/provider.go +
 * parts of store.go.
 */

// ─── Provider names ────────────────────────────────────────────────────────────

export type ProviderName =
  | "stitch"
  | "plaid"
  | "manual"
  | "yodlee"
  | "truelayer"
  | "salt_edge";

// ─── Feed status (mirrors bank_feed_status DB enum) ────────────────────────────

export type FeedStatus =
  | "pending"
  | "connected"
  | "reauth_required"
  | "error"
  | "disconnected";

// ─── Provider domain types ─────────────────────────────────────────────────────

export interface LinkedAccount {
  providerAccountId: string;
  providerItemId: string;
  institutionId: string;
  institutionName: string;
  mask: string;
  currency: string;
  accountType: string;
}

export interface ProviderTransaction {
  providerTxnId: string;
  /** ISO-8601 date string. */
  date: string;
  description: string;
  /** Always positive; direction tells debit/credit. */
  amount: number;
  currency: string;
  direction: "debit" | "credit";
  balance: number | null;
  raw: Record<string, unknown>;
}

// ─── DB row mirrors ────────────────────────────────────────────────────────────

export interface Connection {
  id: string;
  organizationId: string;
  accountId: string | null;
  createdBy: string | null;
  provider: string;
  providerItemId: string;
  providerAccountId: string;
  institutionName: string;
  institutionId: string;
  mask: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  cursor: string;
  status: FeedStatus;
  errorCode: string | null;
  errorMessage: string | null;
  lastSyncedAt: string | null;
  consentExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── OAuth state ────────────────────────────────────────────────────────────────
//
// The Go implementation uses an in-memory map[string]uuid.UUID for CSRF state,
// which is not viable on Cloudflare Workers (stateless, potentially multiple
// isolates). We persist short-lived state in a DB table:
//   oauth_pkce_states(state TEXT PK, org_id UUID, expires_at TIMESTAMPTZ)
// If the table is not available we fall back to env.RATE_LIMIT KV (if present).
// The handler documents which mechanism is active.

export interface OAuthState {
  orgId: string;
  /** ISO-8601 expiry (15 minutes from creation). */
  expiresAt: string;
}
