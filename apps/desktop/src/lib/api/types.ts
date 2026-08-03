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

/**
 * Mirrors core's `NewBook`. Region and currency are the caller's choice out
 * of `region_list` — there is no default jurisdiction here or in core: with
 * neither `region` nor `country` given the book lands on the **generic**
 * profile, and an unknown `region` id is rejected rather than silently
 * downgraded.
 */
export interface NewBook {
  name: string;
  kind: BookKind;
  /** Omit to take the chosen region profile's default currency, if it has
   * one; a profile without one makes this required. */
  currency?: string;
  /** ISO 3166-1 alpha-2; also infers the region profile when `region` is
   * omitted. */
  country?: string;
  /** Region profile id from `region_list`. */
  region?: string;
}

// ---------------------------------------------------------------------------
// book profiles (Phase 6.0 — ROADMAP.md "Phase 6", Book profiles). One data
// model, three presentations: personal / business / business-multi-location
// are progressive disclosure over one schema, never a schema fork. Mirrors
// core's `profile::BookProfile` — the single source every surface (CLI,
// HTTP, this app) resolves the capability groups from.
// ---------------------------------------------------------------------------

export interface BookProfile {
  kind: BookKind;
  /** Rows currently in `locations` for this book. */
  location_count: number;
  /** The stored override, verbatim: `null` means "derive it". */
  multi_location_override: boolean | null;
  /** The resolved flag — what the UI should branch on, not the override
   * field above. */
  multi_location: boolean;
  show_accounts: boolean;
  show_transactions: boolean;
  show_budgets: boolean;
  show_members: boolean;
  show_contacts: boolean;
  show_catalogue: boolean;
  show_purchasing: boolean;
  show_sales: boolean;
  show_locations: boolean;
}

// ---------------------------------------------------------------------------
// locations — branches, sites and warehouses within a book (Phase 6.1, the
// flowstock fold foundation). Additive and optional: a book with none
// behaves exactly as it always has.
// ---------------------------------------------------------------------------

export type LocationKind = "branch" | "warehouse" | "site";

export interface Location {
  id: string;
  book_id: string;
  name: string;
  kind: LocationKind;
  code: string | null;
  address: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface NewLocation {
  book_id: string;
  name: string;
  /** Defaults to "branch" when omitted. */
  kind?: LocationKind;
  code?: string;
  address?: string;
}

/** Mirrors src-tauri's `LocationUpdateRequest`: the `clear_*` flags are how
 * plain JSON expresses "explicitly clear this field" for a nested-optional
 * column, the same convention `MemberUpdateRequest` uses. */
export interface LocationUpdateRequest {
  id: string;
  name?: string;
  kind?: LocationKind;
  code?: string;
  clear_code?: boolean;
  address?: string;
  clear_address?: boolean;
  is_archived?: boolean;
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
  /**
   * Who actually incurred this transaction — metadata only, orthogonal to
   * the ledger; never changes amount/currency/category. `null` =
   * unattributed. When the transaction is split across members (see
   * `TransactionSplit`), reports distribute by the split shares instead of
   * this single field.
   */
  attributed_member_id: string | null;
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
// household members & per-person attribution (ARCHITECTURE.md "Household
// members & per-person attribution"). Members are local data, not logins —
// no auth anywhere; attribution is metadata that never changes debits/
// credits. A book with zero members works exactly as before (backward
// compatible): every attribution field is simply absent/null.
// ---------------------------------------------------------------------------

/** A person in the household sharing this book. */
export interface Member {
  id: string;
  book_id: string;
  label: string;
  /** Short display initial (e.g. "A") for tight UI spots like avatars. */
  initial: string;
  /** Cosmetic hex colour swatch; never interpreted beyond display. */
  colour: string;
  /** The account this member owns by default — new transactions on it
   * attribute here unless overridden. `null` = no default owner. */
  default_account_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewMember {
  book_id: string;
  label: string;
  /** Defaults to the label's first letter, uppercased, when omitted. */
  initial?: string;
  /** Defaults to a built-in colour rotation when omitted. */
  colour?: string;
  default_account_id?: string;
}

/**
 * Selective update. Omitted fields are left untouched.
 * `clear_default_account: true` explicitly clears the default account;
 * otherwise `default_account_id` (if present) sets a new one and omitting
 * it leaves the current value as-is.
 */
export interface MemberPatch {
  id: string;
  label?: string;
  initial?: string;
  colour?: string;
  clear_default_account?: boolean;
  default_account_id?: string;
}

/** One `(member, share)` row of a split transaction, as stored. `share_minor`
 * is always a positive portion of the transaction's absolute amount. */
export interface TransactionSplit {
  id: string;
  transaction_id: string;
  member_id: string;
  share_minor: number;
  created_at: string;
}

/** Input to `transactionSplitSet`: pairs must sum to the transaction's
 * absolute amount. An empty array clears the split. */
export interface SplitShare {
  member_id: string;
  share_minor: number;
}

/** One member's outflow (expense) or inflow (contribution) total over a
 * period, in the book's base currency. `member_id: null` is the
 * "Unattributed" bucket. */
export interface MemberAmountRow {
  member_id: string | null;
  member_label: string;
  currency: string;
  total_minor: number;
}

/** One member's share of one category's spend over a period (outflows only). */
export interface MemberCategoryRow {
  member_id: string | null;
  member_label: string;
  category_id: string | null;
  category_name: string;
  currency: string;
  total_minor: number;
}

/** One member's net position over a period: contributions minus attributed
 * expenses — "who owes whom". Positive = net contributor; negative = net
 * consumer. Every current member appears, plus a trailing "Unattributed" row. */
export interface MemberSettleRow {
  member_id: string | null;
  member_label: string;
  currency: string;
  contributions_minor: number;
  expenses_minor: number;
  net_minor: number;
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

/**
 * The pre-Installer pack index the desktop settings blob still carries. It
 * is written by nothing and read by nothing — the Packs screen reads the
 * `pack_*` tables through `packList`. Kept because the field is part of the
 * stored `desktop.settings` JSON on disk and dropping it from the type would
 * silently drop it on the next save.
 */
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
// classification packs — the one install pipeline (ARCHITECTURE.md
// "Classification packs — one install pipeline"). Packs carry rules, never
// data. Every install goes through signature verification, a TOFU signer
// store that pins a pack id to the key that first signed it, and strict
// semver; the pack tables are the only thing read here.
// ---------------------------------------------------------------------------

/** `taxonomy` packs carry categories + classification rules; `benchmark`
 * packs carry anonymous aggregate statistics and touch neither. */
/** What a pack carries. Known kinds are named for autocomplete; the `string`
 * arm is load-bearing, not laziness — a pack kind added by a later release
 * travels every transport unchanged, and this type must not be the thing that
 * refuses to render it. */
export type PackKind = "taxonomy" | "benchmark" | "mailrules" | (string & {});

/** One pack installed into a book. Metadata only — the signed payload never
 * crosses IPC, and a signer is a public key, never secret material. */
export interface InstalledPackInfo {
  pack_id: string;
  book_id: string;
  name: string;
  version: string;
  kind: PackKind;
  /** ISO 3166-1 alpha-2 the pack targets; `null` = global. */
  region: string | null;
  /** Short fingerprint of the signer's key, for the out-of-band check. */
  signer_fingerprint: string;
  /** The trust store's label for this signer, or `null` if it is not (or no
   * longer) trusted — revoking a signer leaves its packs installed. */
  signer_label: string | null;
  installed_at: string;
  updated_at: string;
}

/** A signed pack as the user holds it: the exact signed document, its
 * detached signature and the publisher's key — the three inputs `slipscan
 * pack install` takes. Base64 is transport encoding only; the bytes are
 * verified exactly as given. */
export interface PackDocumentRequest {
  book_id: string;
  document_base64: string;
  /** 128 hex characters, or base64 of the 64 signature bytes. */
  signature: string;
  /** 64 hex characters, or base64 of the 32 public-key bytes. */
  public_key: string;
}

/** What installing this file would do — `refuse` included. */
export type PackAction = "install" | "upgrade" | "refuse";

/** Preflight for an install: what the file is, who signed it, and what
 * installing would do. Verification happens here; nothing is written. */
export interface PackVerification {
  pack_id: string;
  name: string;
  version: string;
  kind: PackKind;
  region: string | null;
  author: string | null;
  /** Check this out-of-band before accepting the signer — it is the whole
   * point of trust-on-first-use. */
  signer_fingerprint: string;
  /** Trust label if this key is already trusted; `null` on first use. */
  trusted_as: string | null;
  /** Fingerprint the pack id is pinned to, when it has been installed
   * before. Differs from `signer_fingerprint` exactly when the publisher key
   * changed — which is a refusal, never a silent success. */
  pinned_fingerprint: string | null;
  /** Version of this pack id currently installed in the book, if any. */
  installed_version: string | null;
  categories: number;
  merchant_rules: number;
  keyword_rules: number;
  action: PackAction;
  /** Set only when `action === "refuse"`: the installer's own wording. */
  refusal: string | null;
  /** Whether installing needs this fingerprint accepted first. Always false
   * for a file the user picked with the publisher's key in hand — passing the
   * key *is* the decision there. True for a pack that arrived over a
   * transport, where nothing was hand-carried and arriving is not accepting. */
  needs_signer_acceptance: boolean;
  /** Where the bytes came from, when they came from a source rather than a
   * file the user picked. */
  origin: string | null;
}

// ---------------------------------------------------------------------------
// pack sources — the FETCH half (docs/PACKS.md "Getting a pack").
//
// The same signed bytes over any transport, because the signature is what is
// trusted, not the channel. A source grants no authority: what arrives is
// verified before anything is written, an unseen signer must be accepted
// explicitly, and a pack id stays pinned to the key that first signed it.
//
// There is no registry and no default source. The list starts empty, only the
// user writes to it, and until it has an entry SlipScan makes no outbound
// request about packs at all.
// ---------------------------------------------------------------------------

/** Which transport a source speaks. */
export type PackSourceKind = "file" | "folder" | "git" | "https";

/** One configured source. */
export interface PackSourceInfo {
  /** The short handle the user refers to it by. */
  name: string;
  /** Canonical URI — `file:`, `folder:`, `git:` or `https://`. */
  uri: string;
  kind: PackSourceKind;
  /** Whether reading it can put packets on a network. `file`/`folder` never
   * do; showing this is how the screen stays honest about what a read costs. */
  network: boolean;
  added_at: string;
  last_synced_at: string | null;
}

/** One pack a source offers.
 *
 * `pack_id`, `version` and `name` are the **catalogue's claims** — an
 * untrusted file. `verified` is the only part derived from a checked
 * signature, and it is the one a user may act on. Render the claim greyed and
 * the verified facts plainly; never the other way round. */
export interface PackOffer {
  /** Claimed id (catalogue). */
  pack_id: string;
  /** Claimed version (catalogue). */
  version: string;
  /** Claimed display name (catalogue). */
  name: string | null;
  /** Blob name within the source; the handle `packSourceInstall` takes. */
  document: string;
  /** The verified preflight, present iff the signature verified. */
  verified: PackVerification | null;
  /** Why this entry could not be verified. One unreadable file in a shared
   * folder must not hide the rest of the catalogue. */
  error: string | null;
}

export interface PackInstallOutcome {
  pack_id: string;
  name: string;
  version: string;
  /** ISO 3166-1 alpha-2 the pack targets; `null` = global. Present so a
   * screen can show *whose* chart of accounts it just took on. */
  region: string | null;
  outcome: "installed" | "upgraded";
  /** The version replaced, when `outcome === "upgraded"`. */
  upgraded_from: string | null;
  categories_created: number;
  categories_reused: number;
  rules_installed: number;
}

// ---------------------------------------------------------------------------
// benchmark packs — the READ side of anonymous peer comparison, and the only
// half that exists (BENCHMARKS.md). A benchmark pack is a public file of a
// cohort's published aggregate statistics; the comparison is arithmetic done
// on this machine against your own spend, and nothing is transmitted.
//
// The *contribution* half — and the local differential privacy that design
// requires — is NOT BUILT: no contribution code, no noise generation, no
// transport, no settings surface. Nothing typed here may be described in a
// way that implies otherwise.
// ---------------------------------------------------------------------------

/** Where your spend sits relative to the cohort's quartiles. */
export type QuartilePosition = "below_p25" | "typical" | "above_p75";

/** The cohort a benchmark set describes — deliberately coarse, and a
 * property of the pack, never of you. */
export interface BenchmarkCohort {
  /** ISO 3166-1 alpha-2, e.g. `ZA`. */
  region: string;
  household_size: number;
  /** Short community-defined band label, e.g. `C`. */
  income_band: string;
}

/** One taxonomy key placed against the cohort's quartiles. Amounts are
 * integer minor units in the set's currency — never converted. */
export interface BenchmarkComparison {
  category_key: string;
  currency: string;
  /** Your total for the key this period, descendants included. */
  yours_minor: number;
  median_minor: number;
  p25_minor: number;
  p75_minor: number;
  /** `yours - median`; positive means you spend more than the median. */
  delta_minor: number;
  /** `yours / median`, `null` when the cohort median is zero. */
  ratio_to_median: number | null;
  position: QuartilePosition;
  /** Contributions behind the stat — always >= the pack's `k_floor`. */
  sample_size: number;
}

/** One installed benchmark pack compared against this book's own spend for
 * one calendar month. */
export interface BenchmarkReport {
  pack_id: string;
  pack_name: string;
  /** The calendar month `YYYY-MM` compared. */
  period: string;
  /** The pack's own currency. **Never converted** — see `skipped`. */
  currency: string;
  cohort: BenchmarkCohort;
  /** The k-anonymity floor the pack's aggregator enforced. */
  k_floor: number;
  /** Why nothing was compared, when nothing was — a currency mismatch, or no
   * spend at all in the pack's currency. `null` on a real comparison, which
   * may still be empty if the pack has no stat for the period. Never render
   * this as zeroes: a silently-zero benchmark is a lie. */
  skipped: string | null;
  comparisons: BenchmarkComparison[];
  /** Taxonomy keys the pack has a stat for that nothing installed maps to a
   * local category. Shown rather than dropped, so "why is groceries
   * missing?" has an answer. */
  unmapped_keys: string[];
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
// device identity and pairing (docs/NODES.md).
//
// **NOTHING SYNCS.** This is phase 1 of the node model: identity and pairing
// only. There is no oplog, no transport, no coordinator, no directory and no
// default endpoint. Two paired devices know each other's keys and can prove
// possession of them — and that is the entire extent of it. Every screen built
// on these types has to say so; a "paired" badge that implies data is moving
// would be the single most misleading thing this app could show.
//
// There are also no accounts: no email, no password, no username, no login.
// A device generates its own keypair and the public key IS the id.
//
// Field names are the wire names — these mirror core's `device::DeviceIdentity`,
// `DevicePeer`, `DeviceRotation` and `pairing::PairingInviteMeta`, which cross
// IPC unwrapped.
// ---------------------------------------------------------------------------

/** This device's own identity. Public information only — the private half
 * lives in the write-only vault and never crosses IPC. */
export interface DeviceIdentity {
  /** The device id: lowercase hex ed25519 public key (64 chars). */
  public_key: string;
  /** Human-comparable rendering of `public_key`: nine checksummed words.
   * This is what a person reads off the other device's screen — and comparing
   * it is the entire authentication step of pairing. */
  keyname: string;
  /** Cosmetic. Not an identity and not resolvable: two devices may share a
   * label and nothing anywhere cares. */
  label: string;
  created_at: string;
  rotated_at: string | null;
}

/** A peer device this one has pinned. */
export interface DevicePeer {
  /** The peer's device id. Pinned at pairing and never updated — the key IS
   * the id, so there is no id under which a key could be swapped. */
  public_key: string;
  keyname: string;
  label: string;
  paired_at: string;
  /** Tombstone. Non-null means revoked, and the row is kept precisely so that
   * key cannot quietly re-pair: only a deliberate local forget clears it. */
  revoked_at: string | null;
  /** **Always null today** — nothing connects to anything. Do not render this
   * as "offline"; there is nothing to be online. */
  last_seen_at: string | null;
}

/** One rotation of this device's own key, provable against the key it
 * replaced. Nothing transmits these. */
export interface DeviceRotation {
  old_public_key: string;
  new_public_key: string;
  /** Detached ed25519 signature by `old_public_key`. */
  signature: string;
  rotated_at: string;
}

/** This device's key after a rotation, plus the proof it replaced the last. */
export interface DeviceRotateResult {
  identity: DeviceIdentity;
  rotation: DeviceRotation;
}

/** Outstanding-invite metadata. **Never carries a claim token** — the clear
 * token exists only inside the blob the user already holds. */
export interface PairingInviteMeta {
  id: string;
  label: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  /** Device id that redeemed this invite, once one has. */
  redeemed_by: string | null;
}

/** An invite this device minted, ready to carry to another device by hand. */
export interface PairingInvite {
  id: string;
  /**
   * The text to move out of band — QR, paste, a file on a stick. SlipScan
   * opens no socket to do this.
   *
   * **A CREDENTIAL until it is redeemed or expires**: it contains the invite's
   * single-use claim token. Never log it, never put it in an error message,
   * and drop it from component state as soon as it has been copied.
   */
  blob: string;
  /** This device's key-name — what the *other* person must see match. */
  keyname: string;
  expires_at: string;
}

/** The result of accepting an invite: the inviter is now pinned, and `blob`
 * goes back so the inviter can pin us. Same credential discipline as
 * `PairingInvite.blob` — it echoes the claim token. */
export interface PairingAcceptance {
  peer: DevicePeer;
  blob: string;
}

/**
 * Redeeming a pairing blob. Exactly one of the two checks must be supplied,
 * and the backend refuses the request outright if neither is — there is no
 * "skip the comparison" state on this surface at all.
 */
export interface PairRedeemRequest {
  blob: string;
  /** The key-name the user read off the other device and typed. Compared
   * against the key inside the blob; a mismatch refuses, and a name that
   * fails its own checksum reports itself as mistyped instead. */
  expect_keyname?: string;
  /** Pass true ONLY when the screen genuinely displayed the key-name and the
   * person affirmed it matched. Passing it otherwise turns a human
   * verification step into a rubber stamp. */
  confirmed_by_human?: boolean;
}

// ---------------------------------------------------------------------------
// Payments — watch reference codes on inbound transactions, fire signed
// webhooks. Deliberately simple: watch codes are a flat list (`enabled` is
// the only state, an optional exact amount the only filter), endpoint signing
// secrets are vault-held (shown exactly once at creation/rotation), and
// deliveries retry with backoff.
// ---------------------------------------------------------------------------

export interface PayWatch {
  id: string;
  book_id: string;
  /** Matched case-insensitively as a whole token within the transaction
   * description/merchant (INV1 never matches INV11). */
  code: string;
  label: string | null;
  /** When set, only a transaction of exactly this amount (in
   * `expected_currency`) matches. */
  expected_amount_minor: number | null;
  expected_currency: string | null;
  enabled: boolean;
  created_at: string;
}

export interface NewPayWatch {
  book_id: string;
  code: string;
  label?: string;
  /** Optional exact-amount filter; requires `expected_currency`. */
  expected_amount_minor?: number;
  expected_currency?: string;
}

/** A webhook receiver. The signing secret is vault-held (write-only) under a
 * name derived from `id` — never a field here. */
export interface PayEndpoint {
  id: string;
  book_id: string;
  label: string;
  url: string;
  enabled: boolean;
  created_at: string;
}

export interface NewPayEndpoint {
  book_id: string;
  label: string;
  url: string;
}

/**
 * Returned by endpoint add/rotate ONLY — the single sanctioned display of a
 * signing secret, exactly once, so the receiver operator can configure
 * verification. After this response the secret exists solely in the vault
 * (write-only): losing it means rotating it.
 */
export interface PayEndpointWithSecret {
  endpoint: PayEndpoint;
  /** 32 random bytes, hex-encoded (64 chars). Shown here once, then
   * reachable only by core's signer at delivery time. */
  secret: string;
}

/** One detection: watch `watch_id` matched transaction `transaction_id`. */
export interface PayMatch {
  id: string;
  book_id: string;
  watch_id: string;
  transaction_id: string;
  matched_at: string;
}

/** `pending` retries with backoff; `delivered` and `failed` are terminal. */
export type PayDeliveryState = "pending" | "delivered" | "failed";

/** One queued webhook delivery. `payload` is the exact JSON body POSTed and
 * signed — metadata only (reference, amount/currency/date, matched_at),
 * never account numbers or the raw bank description. */
export interface PayDelivery {
  id: string;
  book_id: string;
  endpoint_id: string;
  match_id: string;
  payload: string;
  state: PayDeliveryState;
  attempts: number;
  next_attempt_at: string;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
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
