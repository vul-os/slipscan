/**
 * Hand-maintained TypeScript mirror of the slipscan-core service surface.
 *
 * Contract (docs/ARCHITECTURE.md): Tauri commands and axum routes expose the
 * same core services with the same names. All payloads are serde JSON.
 * Update this file and the Rust side in the same change.
 *
 * Conventions mirrored from core:
 *   - ids are UUID v7 strings
 *   - money is i64 minor units (`*_minor`) + ISO-4217 currency code — never floats
 *   - timestamps are ISO-8601 UTC strings, rendered local in the UI
 */

// ---------------------------------------------------------------------------
// book
// ---------------------------------------------------------------------------

export type BookKind = "personal" | "business";

export interface Book {
  id: string;
  name: string;
  slug: string;
  kind: BookKind;
  currency: string;
  /** Region profile id ("za", "generic", …) — regions are data, not code. */
  region: string;
  /** Region profile display name, e.g. "South Africa". */
  region_name: string;
  /** The region profile's name for the tax-period report, e.g. "VAT201". */
  tax_report_name: string;
  /** User-visible path of the SQLite file backing this book. */
  file_path: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// data folder (movable) — contract: "Data location & backup". One folder
// holds everything durable; backup is the user's own cloud syncing it.
// ---------------------------------------------------------------------------

/**
 * Mirrors core's `datadir::DataStatus` — the exact payload the server's
 * `GET /api/v1/data_status` serves — plus the desktop-only cloud-sync hint.
 */
export interface DataStatus {
  /** The one folder holding everything durable (database + documents). */
  data_dir: string;
  db_path: string;
  documents_dir: string;
  /** The pointer file in the fixed per-OS config dir naming `data_dir`. */
  pointer_path: string;
  /** True when a pointer file names the folder; false on the default. */
  pointer_set: boolean;
  is_default_location: boolean;
  db_exists: boolean;
  db_size_bytes: number;
  document_count: number;
  documents_size_bytes: number;
  /**
   * Cloud-sync provider name when the folder is trivially inside a known
   * synced tree ("iCloud Drive", "Dropbox", …). Absent when not detectable —
   * absence never means "not synced".
   */
  cloud_sync_hint?: string;
}

export interface DataMoveRequest {
  /** Target folder (absolute; a leading `~` expands to the home dir). */
  target: string;
  /**
   * Adopt a folder that already contains a SlipScan database instead of
   * copying into it ("open instead" — the current folder is left as-is).
   */
  use_existing?: boolean;
}

/** A selectable region profile (chart of accounts, tax config, labels). */
export interface RegionInfo {
  id: string;
  display_name: string;
  /** ISO 3166-1 alpha-2; null for the generic profile. */
  country: string | null;
  default_currency: string | null;
  tax_report_name: string;
}

/** One configured tax rate in a book (mirrors core's VatRate). */
export interface VatRate {
  id: string;
  book_id: string;
  /** Stable code within the book, e.g. "STD", "ZER". */
  code: string;
  name: string;
  /** Basis points: 1500 = 15.00%. The generic profile's standard rate seeds
   * at 0 until configured via vat_rate_set_bps. */
  rate_bps: number;
  country: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// account (personal-finance view)
// ---------------------------------------------------------------------------

export type AccountKind = "bank" | "cash" | "card" | "asset" | "liability";

export interface Account {
  id: string;
  book_id: string;
  name: string;
  kind: AccountKind;
  institution: string | null;
  currency: string;
  balance_minor: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// transaction
// ---------------------------------------------------------------------------

export type TransactionSource = "scraper" | "email" | "import" | "manual";

export interface Transaction {
  id: string;
  book_id: string;
  account_id: string;
  /** Date the bank posted the transaction (ISO-8601 UTC). */
  posted_at: string;
  description: string;
  merchant: string | null;
  /** Signed minor units: negative = outflow. */
  amount_minor: number;
  currency: string;
  category_id: string | null;
  source: TransactionSource;
  /** Dedupe key from provider, when available. */
  provider_txn_id: string | null;
  /** Fallback dedupe hash of (account, date, amount, description). */
  hash: string;
  created_at: string;
}

export interface TransactionListQuery {
  book_id: string;
  account_id?: string;
  category_id?: string;
  /** Substring match on description/merchant. */
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// category
// ---------------------------------------------------------------------------

export type CategoryKind = "income" | "expense" | "transfer";

export interface Category {
  id: string;
  book_id: string;
  parent_id: string | null;
  name: string;
  kind: CategoryKind;
  /** Emoji or short glyph used in lists; optional. */
  icon: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

export interface Budget {
  id: string;
  book_id: string;
  category_id: string;
  /** Calendar month, `YYYY-MM`. */
  month: string;
  amount_minor: number;
  currency: string;
  rollover: boolean;
  created_at: string;
}

/** Budget joined with actual spend, as returned by `budget_list`. */
export interface BudgetWithSpend extends Budget {
  category_name: string;
  spent_minor: number;
}

export interface BudgetUpsert {
  book_id: string;
  category_id: string;
  month: string;
  amount_minor: number;
  currency: string;
  rollover: boolean;
}

// ---------------------------------------------------------------------------
// document (receipts / slips / statements) — slip-v2 extraction
// ---------------------------------------------------------------------------

export type DocumentKind = "receipt" | "slip" | "invoice" | "statement";

/** Extraction status machine: pending → extracted → reviewed. */
export type DocumentStatus = "pending" | "extracted" | "reviewed" | "failed";

export interface SlipLineItem {
  description: string;
  quantity: number;
  unit_minor: number;
  total_minor: number;
  category_id: string | null;
  discount_minor: number;
}

/** slip-v2 extraction result (types owned by slipscan-extract, stored by core). */
export interface SlipExtraction {
  schema: "slip-v2";
  merchant: string;
  issued_at: string;
  currency: string;
  total_minor: number;
  vat_minor: number;
  discount_minor: number;
  line_items: SlipLineItem[];
  /** 0..1 extraction confidence. */
  confidence: number;
}

export interface Document {
  id: string;
  book_id: string;
  kind: DocumentKind;
  status: DocumentStatus;
  file_name: string;
  mime_type: string;
  /** Populated once status ≥ extracted. */
  extraction: SlipExtraction | null;
  /** Convenience denormalisation for lists. */
  merchant: string | null;
  issued_at: string | null;
  total_minor: number | null;
  currency: string;
  created_at: string;
}

export interface DocumentImportRequest {
  book_id: string;
  file_name: string;
  mime_type: string;
  /** Base64 file contents (desktop passes a path in Tauri mode instead). */
  bytes_base64?: string;
  path?: string;
}

/**
 * Human-reviewed correction of an extraction. Core stores the corrected
 * slip-v2 result and advances the status machine to `reviewed`.
 */
export interface DocumentReviewRequest {
  document_id: string;
  extraction: SlipExtraction;
}

// ---------------------------------------------------------------------------
// ledger (double-entry)
// ---------------------------------------------------------------------------

export type LedgerAccountType =
  | "asset"
  | "liability"
  | "equity"
  | "income"
  | "expense";

export interface LedgerAccount {
  id: string;
  book_id: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  vat_rate_bp: number | null;
  archived: boolean;
}

export interface JournalLine {
  id: string;
  entry_id: string;
  ledger_account_id: string;
  /** Denormalised for display. */
  ledger_account_name: string;
  debit_minor: number;
  credit_minor: number;
}

export interface JournalEntry {
  id: string;
  book_id: string;
  entry_date: string;
  memo: string;
  /** Lines always balance: Σ debit == Σ credit (enforced by core). */
  lines: JournalLine[];
  source_document_id: string | null;
  created_at: string;
}

export interface JournalPostRequest {
  book_id: string;
  entry_date: string;
  memo: string;
  lines: Array<{
    ledger_account_id: string;
    debit_minor: number;
    credit_minor: number;
  }>;
  source_document_id?: string;
}

// ---------------------------------------------------------------------------
// recon
// ---------------------------------------------------------------------------

export type ReconStatus = "suggested" | "confirmed" | "rejected";

export interface ReconSuggestion {
  id: string;
  book_id: string;
  transaction_id: string;
  document_id: string;
  /** 0..1 match score. */
  score: number;
  status: ReconStatus;
  /** Denormalised summaries for display. */
  transaction_description: string;
  transaction_amount_minor: number;
  document_merchant: string;
  document_total_minor: number;
  currency: string;
  created_at: string;
}

export interface ReconConfirmRequest {
  suggestion_id: string;
  accept: boolean;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

export interface SpendingByCategory {
  category_id: string;
  category_name: string;
  amount_minor: number;
  /** 0..1 share of total spend in period. */
  share: number;
}

export interface SpendingReport {
  book_id: string;
  from: string;
  to: string;
  currency: string;
  total_spent_minor: number;
  by_category: SpendingByCategory[];
}

export interface IncomeExpensePoint {
  month: string;
  income_minor: number;
  expense_minor: number;
}

export interface IncomeExpenseReport {
  book_id: string;
  currency: string;
  months: IncomeExpensePoint[];
}

/** Tax-report box labels, straight from the book's region profile. */
export interface TaxBoxLabels {
  standard_rated_supplies: string;
  zero_rated_supplies: string;
  exempt_supplies: string;
  output_tax: string;
  input_tax: string;
  net_tax: string;
}

export interface VatSummary {
  book_id: string;
  period: string;
  currency: string;
  /** Region-profile report name ("VAT201" for za, "Tax summary" generic). */
  report_name: string;
  labels: TaxBoxLabels;
  output_vat_minor: number;
  input_vat_minor: number;
  net_vat_minor: number;
}

export interface TrialBalanceRow {
  ledger_account_id: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  debit_minor: number;
  credit_minor: number;
}

export interface TrialBalance {
  book_id: string;
  as_of: string;
  currency: string;
  rows: TrialBalanceRow[];
  total_debit_minor: number;
  total_credit_minor: number;
}

// ---------------------------------------------------------------------------
// settings — secrets are keychain entry NAMES only, never secret material
// ---------------------------------------------------------------------------

export interface LlmProviderSettings {
  provider: "none" | "openai-compatible" | "anthropic" | "local";
  endpoint: string | null;
  model: string | null;
  /** OS keychain entry name holding the API key. */
  keychain_entry: string | null;
}

export interface MailboxSettings {
  enabled: boolean;
  host: string | null;
  port: number;
  username: string | null;
  /** OS keychain entry name holding the IMAP password. */
  keychain_entry: string | null;
  folder: string;
}

/**
 * Bank-scraper adapter registration. Credentials live in the vault
 * (write-only); this carries metadata only.
 */
export interface ScraperAdapter {
  id: string;
  /** Adapter id from the framework, e.g. `za-fnb`. */
  adapter: string;
  institution: string;
  status: "connected" | "needs_attention" | "disabled";
  last_sync: string | null;
  /** OS keychain entry name holding the scraper credentials. */
  keychain_entry: string | null;
}

export interface InstalledPack {
  id: string;
  name: string;
  version: string;
  publisher: string;
  /** ed25519 public key fingerprint the pack was verified against. */
  signer_fingerprint: string;
  installed_at: string;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  llm: LlmProviderSettings;
  mailbox: MailboxSettings;
  scrapers: ScraperAdapter[];
  packs: InstalledPack[];
}

// ---------------------------------------------------------------------------
// credential vault — write-only. IPC exposes METADATA ONLY: there is no
// command that returns secret material, and no type here may ever carry it.
// ---------------------------------------------------------------------------

export interface VaultCredentialMeta {
  /** Entry name, e.g. `imap.password.fastmail`. */
  name: string;
  /** Optional human label shown in the UI. */
  label: string | null;
  /** Rotation counter; starts at 1, bumped on replace. */
  version: number;
  /** Short non-reversible fingerprint — "did it change", never the value. */
  fingerprint: string;
  created_at: string;
  rotated_at: string | null;
  last_used_at: string | null;
}

/** Write-only input: the secret goes in and never comes back out. */
export interface VaultSetRequest {
  name: string;
  label?: string;
  secret: string;
}

export interface VaultReplaceRequest {
  name: string;
  secret: string;
}

// ---------------------------------------------------------------------------
// FX (OpenRate) — opt-in exchange rates. Rates are decimal STRINGS, never
// floats; money stays integer minor units end-to-end.
// ---------------------------------------------------------------------------

/** A locally cached rate with provenance and computed staleness. */
export interface FxCachedRate {
  from_currency: string;
  to_currency: string;
  /** Exact decimal rate as a string — never parse into a float for money math. */
  rate: string;
  /** RFC 3339 instant the rate is dated at (from OpenRate). */
  as_of: string;
  /** OpenRate quality grade at fetch time (e.g. "A", "B"). */
  grade: string;
  /** When this SlipScan fetched the rate. */
  fetched_at: string;
  /** Seconds since `as_of`, computed at read time; null if unparsable. */
  age_secs: number | null;
}

/** FX configuration + cache overview. Reading this never touches the network. */
export interface FxStatus {
  configured: boolean;
  base_url: string | null;
  cached_rates: FxCachedRate[];
}

/** One fetched quote (the only FX call that touches the network — explicitly). */
export interface FxQuote {
  from_currency: string;
  to_currency: string;
  rate: string;
  as_of: string;
  /** Server-reported staleness at fetch time, seconds. Null when the server
   * omitted it — unknown staleness, never shown as "fresh". */
  age_sec: number | null;
  grade: string;
  sources: string[];
}

/** One performed conversion, carrying the exact rate it used. */
export interface FxConversion {
  from_currency: string;
  to_currency: string;
  amount_minor: number;
  converted_minor: number;
  rate: string;
  as_of: string;
  grade: string;
  fetched_at: string;
  age_secs: number | null;
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

export interface Health {
  status: "ok";
  version: string;
  tauri: string;
}
