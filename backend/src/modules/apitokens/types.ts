/**
 * API-token module types — mirrors Go internal/apitokens shapes.
 * Token format: sk_{kind}_{randomBase64url}
 * 12-char prefix: "sk_live_" (8) + first 4 random chars = 12 total.
 * Store: token_hash (SHA-256 hex) + token_prefix (12 chars) + scopes (JSON).
 */
import type { ApiTokenKind } from "../../types/schema";

/** In-memory representation of a validated api_tokens row. Mirrors Go Token. */
export interface ApiToken {
  id: string;
  organization_id: string;
  user_id?: string;
  name: string;
  kind: ApiTokenKind;
  scopes: string[];
  rate_limit_per_minute: number; // 0 = use default (60)
  expires_at?: string; // ISO string
  created_at: string;
}

/** Safe-to-display token summary (no hash). Mirrors Go TokenMeta. */
export interface TokenMeta {
  id: string;
  organization_id: string;
  created_by?: string;
  name: string;
  kind: ApiTokenKind;
  prefix: string; // first 12 chars e.g. "sk_live_aBcD"
  scopes: string[];
  rate_limit_per_minute: number;
  last_used_at?: string;
  expires_at?: string;
  created_at: string;
}

/** Request body for POST /orgs/:orgID/api-tokens. Mirrors Go issueRequest. */
export interface IssueRequest {
  name: string;
  kind: string; // "live" | "test" | "restricted"
  scopes: string[];
  allowed_ip_cidrs?: string[];
  rate_limit_per_minute?: number;
  expires_in_days?: number; // 0 = no expiry
}

/** Response for POST /orgs/:orgID/api-tokens. Mirrors Go issueResponse. */
export interface IssueResponse {
  id: string;
  name: string;
  kind: string;
  scopes: string[];
  prefix: string;
  token: string; // plaintext — shown exactly once
  created_at: string;
}

/** HTTP response shape for GET /orgs/:orgID/api-tokens list items. */
export interface TokenMetaResponse {
  id: string;
  name: string;
  kind: string;
  scopes: string[];
  prefix: string;
  rate_limit_per_minute?: number;
  last_used_at?: string;
  expires_at?: string;
  created_at: string;
}

/** Scopes used by the public v1 API. Mirrors Go ScopeDocumentsWrite etc. */
export const ScopeDocumentsWrite = "documents:write";
export const ScopeTransactionsRead = "transactions:read";

/** Valid token kinds. Mirrors Go Kind enum. */
export const VALID_KINDS = new Set(["live", "test", "restricted"]);
