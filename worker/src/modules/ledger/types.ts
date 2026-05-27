/**
 * Domain types for the ledger module — port of Go backend/internal/ledger/store.go
 * type definitions. Amounts from Postgres NUMERIC columns are kept as strings
 * (the Neon driver returns them that way); all arithmetic uses lib/money.
 */

// ─── Accounts ─────────────────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  organization_id: string;
  parent_id: string | null;
  code: string | null;
  name: string;
  type: string; // account_type: asset|liability|equity|income|expense
  subtype: string | null;
  currency: string;
  tax_rate_id: string | null;
  description: string | null;
  is_archived: boolean;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface AccountResponse {
  id: string;
  organization_id: string;
  parent_id?: string;
  code?: string;
  name: string;
  type: string;
  subtype?: string;
  currency: string;
  tax_rate_id?: string;
  description?: string;
  is_archived: boolean;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateAccountRequest {
  parent_id?: string;
  code?: string;
  name: string;
  type: string;
  subtype?: string;
  currency: string;
  tax_rate_id?: string;
  description?: string;
}

export interface UpdateAccountRequest {
  code?: string;
  name?: string;
  subtype?: string;
  description?: string;
  is_archived?: boolean;
}

// ─── Ledger entries ───────────────────────────────────────────────────────────

export interface LedgerEntryRow {
  id: string;
  source_type: string;
  source_id: string;
  posted_date: string;
  /** Postgres NUMERIC — arrives as string from Neon driver */
  debit: string;
  /** Postgres NUMERIC — arrives as string from Neon driver */
  credit: string;
  description: string;
}

export interface LedgerEntryResponse {
  id: string;
  source_type: string;
  source_id: string;
  posted_date: string;
  /** Serialised as number to match Go float64 JSON output */
  debit: number;
  /** Serialised as number to match Go float64 JSON output */
  credit: number;
  description?: string;
}

// ─── Manual journals ──────────────────────────────────────────────────────────

export interface JournalLineRequest {
  account_id: string;
  /** Client sends numeric; validated before use */
  debit: number;
  credit: number;
  description?: string;
}

export interface CreateJournalRequest {
  posted_date: string; // YYYY-MM-DD
  narrative?: string;
  reference?: string;
  lines: JournalLineRequest[];
}

export interface JournalLineResponse {
  account_id: string;
  debit: number;
  credit: number;
  description?: string;
}

export interface JournalRow {
  id: string;
  organization_id: string;
  posted_date: string;
  narrative: string | null;
  reference: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface JournalLineRow {
  account_id: string;
  /** NUMERIC — string from Neon */
  debit: string;
  /** NUMERIC — string from Neon */
  credit: string;
  description: string;
}

export interface JournalResponse {
  id: string;
  organization_id: string;
  posted_date: string;
  narrative?: string;
  reference?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  lines?: JournalLineResponse[];
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

export interface ContactRow {
  id: string;
  organization_id: string;
  kind: string; // contact_kind: customer|supplier|both
  name: string;
  legal_name: string | null;
  email: string | null;
  phone: string | null;
  tax_number: string | null;
  payment_terms_days: number;
  default_account_id: string | null;
  default_tax_rate_id: string | null;
  currency: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  notes: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface ContactResponse {
  id: string;
  organization_id: string;
  kind: string;
  name: string;
  legal_name?: string;
  email?: string;
  phone?: string;
  tax_number?: string;
  payment_terms_days: number;
  default_account_id?: string;
  default_tax_rate_id?: string;
  currency?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;
  notes?: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateContactRequest {
  kind?: string;
  name: string;
  legal_name?: string;
  email?: string;
  phone?: string;
  tax_number?: string;
  payment_terms_days?: number;
  default_account_id?: string;
  default_tax_rate_id?: string;
  currency?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;
  notes?: string;
}

export interface UpdateContactRequest {
  kind?: string;
  name?: string;
  legal_name?: string;
  email?: string;
  phone?: string;
  tax_number?: string;
  payment_terms_days?: number;
  is_archived?: boolean;
  notes?: string;
}

// ─── Trial balance ────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  account_id: string;
  account_code: string; // COALESCE → empty string if null
  account_name: string;
  account_type: string;
  /** NUMERIC — string from Neon */
  total_debit: string;
  /** NUMERIC — string from Neon */
  total_credit: string;
}

export interface TrialBalanceLineResponse {
  account_id: string;
  account_code?: string;
  account_name: string;
  account_type: string;
  /** Number to match Go float64 JSON output */
  total_debit: number;
  /** Number to match Go float64 JSON output */
  total_credit: number;
}
