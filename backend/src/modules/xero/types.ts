/**
 * Xero domain types — port of backend/internal/accounting_export/provider.go
 * and the type definitions from store.go.
 */

// ── Domain objects (pushed to Xero) ──────────────────────────────────────────

export interface Contact {
  id:           string;
  name:         string;
  legalName:    string;
  email:        string;
  phone:        string;
  taxNumber:    string;
  addressLine1: string;
  addressLine2: string;
  city:         string;
  region:       string;
  postalCode:   string;
  country:      string;
  kind:         "customer" | "supplier" | "both" | string;
}

export interface Transaction {
  id:          string;
  postedDate:  Date;
  direction:   "debit" | "credit" | string;
  merchant:    string;
  description: string;
  amount:      number;
  currency:    string;
  tax:         number;
  accountCode: string; // chart-of-accounts code in external system
  taxRateCode: string; // e.g. "OUTPUT", "INPUT", "NONE"
  contactId:   string; // nil UUID if absent: "00000000-0000-0000-0000-000000000000"
}

export interface PushResult {
  localId:    string;
  externalId: string;
  updated:    boolean; // true = updated existing record
}

// ── Store types (DB rows) ─────────────────────────────────────────────────────

export interface Mapping {
  id:             string;
  organizationId: string;
  provider:       string;
  localType:      string;
  localId:        string;
  externalId:     string;
  lastSyncedAt:   Date | null;
  syncError:      string | null;
  createdAt:      Date;
  updatedAt:      Date;
}

export interface Grant {
  id:                   string;
  organizationId:       string;
  accountEmail:         string | null; // stores Xero tenant ID
  accessTokenEncrypted: string;        // stored as hex string
  refreshTokenEncrypted: string;
  tokenType:            string | null;
  expiresAt:            Date | null;
}

// ── Xero API response shapes ──────────────────────────────────────────────────

export interface XeroTokenResponse {
  access_token:  string;
  refresh_token: string;
  token_type:    string;
  expires_in:    number; // seconds
  id_token?:     string;
}

export interface XeroConnection {
  tenantId:   string;
  tenantType: string; // "ORGANISATION" | "PRACTICE"
  tenantName: string;
}

// ── Config ────────────────────────────────────────────────────────────────────

export const DEFAULT_XERO_SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.contacts",
  "accounting.transactions",
  "offline_access",
];

// Sentinel for missing mapping.
export const ERR_MAPPING_NOT_FOUND = "accounting export mapping not found";
export const ERR_GRANT_NOT_FOUND   = "oauth grant not found for provider";
