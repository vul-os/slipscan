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

/** Mirrors src-tauri's `LocationUpdateRequest`: omit a key to leave it alone,
 * plain JSON expresses "explicitly clear this field" for a nested-optional
 * column, the same convention `MemberUpdateRequest` uses. */
export interface LocationUpdateRequest {
  id: string;
  name?: string;
  kind?: LocationKind;
  code?: string | null;
  address?: string | null;
  is_archived?: boolean;
}

// ---------------------------------------------------------------------------
// stock — the append-only movement ledger (Phase 6.3b, the flowstock fold).
//
// **On-hand is always `SUM(qty_delta)` over immutable movements**, computed on
// every read, never a stored counter. There is deliberately no "set stock
// level" call and there never will be: a correction is a new `adjustment`
// movement, which is what lets two locations that traded while disconnected
// converge by union instead of one overwriting the other.
// ---------------------------------------------------------------------------

export type StockMovementKind =
  | "receipt"
  | "sale"
  | "adjustment"
  | "transfer"
  | "count";

export interface StockMovement {
  id: string;
  book_id: string;
  variant_id: string;
  location_id: string;
  /** Signed. Negative takes stock out. Never zero. */
  qty_delta: number;
  kind: StockMovementKind;
  /** What caused it, e.g. "po_receipt" or "sales_order". */
  ref_kind: string | null;
  ref_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface NewStockMovement {
  variant_id: string;
  location_id: string;
  qty_delta: number;
  kind: StockMovementKind;
  ref_kind?: string;
  ref_id?: string;
  note?: string;
  created_by?: string;
}

/** A transfer is two movements summing to zero, written in one transaction —
 * stock never leaks in transit because it is never in transit. */
export interface TransferResult {
  out: StockMovement;
  in_: StockMovement;
}

/** A variant whose total on-hand is at or below its reorder point. */
export interface LowStockVariant {
  variant: ProductVariant;
  on_hand: number;
}

// ---------------------------------------------------------------------------
// catalogue — product categories, products, and their variants (Phase 6.3a,
// the flowstock fold).
//
// **The variant is the unit that matters.** Stock movements and every order
// line reference a `variant_id`, never a `product_id` — a product is the
// grouping ("T-shirt"), a variant is the thing you actually sell and count
// ("T-shirt / blue / L", its own SKU, price and reorder point). Wired to this
// client late, for the same reason contacts were: until then an order line
// could name a variant nothing could create.
//
// `product_categories` is deliberately its own table, distinct from the
// transaction `categories` used for classification — a join between them
// would type-check while being silently wrong.
// ---------------------------------------------------------------------------

export interface ProductCategory {
  id: string;
  book_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface NewProductCategory {
  book_id: string;
  name: string;
}

export interface Product {
  id: string;
  book_id: string;
  product_category_id: string | null;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewProduct {
  book_id: string;
  product_category_id?: string;
  name: string;
  description?: string;
}

/** Omit a key to leave it alone, send `null` to clear it. */
export interface ProductUpdateRequest {
  id: string;
  name?: string;
  description?: string | null;
  product_category_id?: string | null;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  book_id: string;
  /** Unique within the book. */
  sku: string;
  name: string;
  price_minor: number;
  cost_price_minor: number;
  currency: string;
  /** On-hand at or below this is "low" — see `stock_low_variants`. */
  reorder_point: number;
  /** Free-form JSON blob, stored verbatim. */
  attributes: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewProductVariant {
  product_id: string;
  sku: string;
  name: string;
  /** Defaults to 0 when omitted. */
  price_minor?: number;
  cost_price_minor?: number;
  currency: string;
  reorder_point?: number;
  attributes?: string;
}

export interface ProductVariantUpdateRequest {
  id: string;
  sku?: string;
  name?: string;
  price_minor?: number;
  cost_price_minor?: number;
  reorder_point?: number;
  attributes?: string | null;
}

// ---------------------------------------------------------------------------
// contacts — customers and suppliers in ONE table (Phase 6.2, the flowstock
// fold), deliberately not split into two, because a real trading party is
// often both. Referenced by sales orders, invoices and purchase orders with
// ON DELETE RESTRICT, so a contact with trade history cannot be deleted.
//
// Wired to this client late: the model shipped with 6.2 but only a read-only
// list was on any surface, so an order could name a contact_id that nothing
// could create. `npm run reachable:check` is what keeps that from recurring.
// ---------------------------------------------------------------------------

export type ContactRole = "customer" | "supplier" | "both";

export interface Contact {
  id: string;
  book_id: string;
  role: ContactRole;
  name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  billing_address: string | null;
  shipping_address: string | null;
  tax_number: string | null;
  payment_terms_days: number | null;
  credit_limit_minor: number | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface NewContact {
  book_id: string;
  role: ContactRole;
  name: string;
  company_name?: string;
  email?: string;
  phone?: string;
  billing_address?: string;
  shipping_address?: string;
  tax_number?: string;
  payment_terms_days?: number;
  credit_limit_minor?: number;
  notes?: string;
}

/** Selective update: omit a key to leave it alone, send `null` to clear it. */
export interface ContactUpdateRequest {
  id: string;
  role?: ContactRole;
  name?: string;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
  billing_address?: string | null;
  shipping_address?: string | null;
  tax_number?: string | null;
  payment_terms_days?: number | null;
  credit_limit_minor?: number | null;
  notes?: string | null;
  is_active?: boolean;
}

// ---------------------------------------------------------------------------
// purchasing — purchase orders, their line items, and goods receipts
// (Phase 6.4, the flowstock fold). No screen calls these yet (ROADMAP.md
// 6.9, "Desktop screens") — the IPC layer is wired ahead of the UI, the same
// order `book_profile`/the location CRUD landed in before their screens
// existed. `po_receive` writes a stock movement in the same transaction as
// the receipt, so on-hand and purchasing can never disagree about how much
// arrived; receiving progress (none/partial/complete) is always derived,
// never stored.
// ---------------------------------------------------------------------------

export type PurchaseOrderStatus = "draft" | "ordered" | "cancelled";
export type PoReceiptStatus = "none" | "partial" | "complete";

export interface PurchaseOrder {
  id: string;
  book_id: string;
  supplier_id: string;
  location_id: string;
  po_number: string;
  order_date: string;
  expected_delivery: string | null;
  status: PurchaseOrderStatus;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  currency: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewPurchaseOrder {
  book_id: string;
  supplier_id: string;
  location_id: string;
  po_number: string;
  order_date: string;
  expected_delivery?: string;
  currency: string;
  /** Defaults to 0 when omitted. */
  tax_minor?: number;
  notes?: string;
}

/** Mirrors src-tauri's `PoUpdateRequest`. Deliberately carries no `status` —
 * status moves only through `poSetStatus`'s guarded transitions. */
export interface PoUpdateRequest {
  id: string;
  supplier_id?: string;
  location_id?: string;
  po_number?: string;
  order_date?: string;
  expected_delivery?: string | null;
  tax_minor?: number;
  notes?: string | null;
}

export interface PurchaseOrderItem {
  id: string;
  purchase_order_id: string;
  book_id: string;
  variant_id: string;
  qty_ordered: number;
  unit_price_minor: number;
  total_minor: number;
  created_at: string;
  updated_at: string;
}

export interface NewPurchaseOrderItem {
  purchase_order_id: string;
  variant_id: string;
  qty_ordered: number;
  /** Defaults to 0 when omitted. */
  unit_price_minor?: number;
}

export interface PoItemUpdateRequest {
  id: string;
  qty_ordered?: number;
  unit_price_minor?: number;
}

/** One immutable fact: this many units of a line arrived at this location.
 * Insert-only — there is no update/delete request shape, the same as
 * `StockMovement`. */
export interface PoReceipt {
  id: string;
  book_id: string;
  purchase_order_item_id: string;
  location_id: string;
  /** Signed: negative corrects an earlier over-receipt. Never zero. */
  qty: number;
  note: string | null;
  received_by: string | null;
  created_at: string;
}

export interface NewPoReceipt {
  purchase_order_item_id: string;
  location_id: string;
  qty: number;
  note?: string;
  received_by?: string;
}

/** A line paired with its derived receiving progress — what a purchasing
 * screen would actually render. */
export interface PurchaseOrderItemReceiving {
  item: PurchaseOrderItem;
  received_qty: number;
  status: PoReceiptStatus;
}

// ---------------------------------------------------------------------------
// Sales orders & invoicing (Phase 6.5, migration 0014_sales). No screen calls
// these yet (ROADMAP.md 6.9) — wired ahead of the UI, the same order the
// purchasing block above and the location CRUD before it landed in.
//
// Two shapes on purpose, mirroring core exactly: a sales order is an editable
// draft, while an invoice is a fact. `Invoice`, `InvoiceItem` and
// `InvoicePayment` have no update or delete call anywhere in this file because
// the database refuses one — issued invoices are immutable, and a correction is
// a credit note (not built yet). There is no `status` on `Invoice` either:
// paid/unpaid is `InvoiceTotals.status`, derived from the payments each time
// rather than stored.
//
// Nullable fields follow the one convention this whole surface uses: omit a
// key to leave it alone, send `null` to clear it, send a value to set it.
// ---------------------------------------------------------------------------

export type SalesOrderStatus = "draft" | "confirmed" | "paid" | "cancelled";
export type InvoicePaymentStatus = "unpaid" | "partly_paid" | "paid";

export interface SalesOrder {
  id: string;
  book_id: string;
  contact_id: string;
  /** Required once the order has a stock-tracked line; `null` is valid for a
   * purely free-text/service order that never touches stock. */
  location_id: string | null;
  /** Assigned once at creation, per book, and never reassigned. */
  number: number;
  order_date: string;
  status: SalesOrderStatus;
  currency: string;
  notes: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewSalesOrder {
  book_id: string;
  contact_id: string;
  location_id?: string | null;
  /** Defaults to today. */
  order_date?: string;
  /** Defaults to the book's currency. */
  currency?: string;
  notes?: string;
}

/** Selective update; omitted keys are left untouched, `null` clears. Carries no
 * `status` — status moves only through confirm/cancel/mark-paid. */
export interface SalesOrderUpdateRequest {
  id: string;
  location_id?: string | null;
  order_date?: string;
  notes?: string | null;
}

export interface SalesOrderItem {
  id: string;
  sales_order_id: string;
  book_id: string;
  /** `null` = a free-text/service line, never touched by stock. */
  variant_id: string | null;
  description: string;
  quantity: number;
  unit_price_minor: number;
  /** Basis points, snapshotted when the line was added. */
  tax_rate_bps: number;
  line_order: number;
  created_at: string;
  updated_at: string;
}

export interface NewSalesOrderItem {
  sales_order_id: string;
  variant_id?: string | null;
  /** Required for a free-text line; defaults to the variant's name otherwise. */
  description?: string;
  quantity: number;
  /** Required for a free-text line; defaults to the variant's price otherwise. */
  unit_price_minor?: number;
  tax_rate_bps?: number;
}

/** Only reachable while the order is still a draft. */
export interface SalesOrderItemUpdateRequest {
  id: string;
  description?: string;
  quantity?: number;
  unit_price_minor?: number;
  tax_rate_bps?: number;
}

/** Derived from the order's own items every time — deliberately not stored on
 * the order, the same call core makes for on-hand stock. */
export interface SalesOrderTotals {
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
}

export interface Invoice {
  id: string;
  book_id: string;
  contact_id: string;
  /** Set when the invoice was issued from an order; `null` for a standalone
   * one (a retainer, a one-off service bill). */
  sales_order_id: string | null;
  /** A numbering book. `"invoice"` is the only series issued today. */
  series: string;
  /** Gapless per (book, series), assigned at issue and permanent. */
  number: number;
  issue_date: string;
  due_date: string;
  currency: string;
  notes: string | null;
  created_at: string;
}

/** Either copy the lines from a confirmed order (`sales_order_id`) or supply
 * `items` directly. `contact_id` is required unless an order supplies it. */
export interface NewInvoice {
  book_id: string;
  contact_id?: string;
  sales_order_id?: string;
  series?: string;
  /** Defaults to today. */
  issue_date?: string;
  due_date: string;
  currency?: string;
  notes?: string;
  items?: NewInvoiceItemInput[];
}

export interface NewInvoiceItemInput {
  variant_id?: string | null;
  description: string;
  quantity: number;
  unit_price_minor: number;
  tax_rate_bps?: number;
}

export interface InvoiceItem {
  id: string;
  invoice_id: string;
  book_id: string;
  variant_id: string | null;
  description: string;
  quantity: number;
  unit_price_minor: number;
  tax_rate_bps: number;
  line_order: number;
  created_at: string;
}

/** Paid/unpaid lives here, not on `Invoice` — it is `SUM(payments)` against the
 * line total, computed per call so two devices recording payments offline
 * converge by union instead of overwriting a stored flag. */
export interface InvoiceTotals {
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  paid_minor: number;
  due_minor: number;
  status: InvoicePaymentStatus;
}

export interface InvoicePayment {
  id: string;
  invoice_id: string;
  book_id: string;
  amount_minor: number;
  paid_at: string;
  /** Free text ("cash", "eft", a reference) — there is no payment-method
   * taxonomy yet. */
  method: string | null;
  note: string | null;
  created_at: string;
}

export interface NewInvoicePayment {
  invoice_id: string;
  amount_minor: number;
  /** Defaults to now. */
  paid_at?: string;
  method?: string;
  note?: string;
}

export interface AgedBucket {
  current_minor: number;
  overdue_1_30_minor: number;
  overdue_31_60_minor: number;
  overdue_61_90_minor: number;
  overdue_90_plus_minor: number;
  total_minor: number;
}

export interface AgedReceivablesRow {
  contact_id: string;
  contact_name: string;
  buckets: AgedBucket;
}

export interface AgedReceivables {
  as_of: string;
  rows: AgedReceivablesRow[];
  totals: AgedBucket;
}

// ---------------------------------------------------------------------------
// period close — the ritual that turns a ledger into a book someone will
// sign. `closePeriodCheck` previews (no mutation); `closePeriod` runs the
// identical checks and, only if nothing hard-refuses, advances the book's
// lock date; `reopenPeriod` is the deliberate, audited undo.
// ---------------------------------------------------------------------------

export interface ClosePeriodCurrencyBalance {
  currency: string;
  debit_minor: number;
  credit_minor: number;
}

/** Mirrors core's `ClosePeriodReport` — identical shape from `closePeriodCheck`
 * and `closePeriod`, differing only in `closed`. */
export interface ClosePeriodReport {
  book_id: string;
  /** The date being sealed through (inclusive). */
  to_date: string;
  /** The book's lock date before this call, or `null` if never closed. */
  previous_lock_date: string | null;
  /** Per-currency debit/credit totals as of `to_date`. */
  balance: ClosePeriodCurrencyBalance[];
  balanced: boolean;
  uncategorised_transaction_count: number;
  unreconciled_statement_line_count: number;
  draft_sales_order_count: number;
  unpaid_invoice_due_count: number;
  /** Non-empty means the close is refused; every reason named. */
  blocking_reasons: string[];
  /** Advisory — never blocks, always worth reading, present even on a
   * successful close's own returned report. */
  warnings: string[];
  closeable: boolean;
  /** `false` from `closePeriodCheck` (never mutates); `true` from
   * `closePeriod` only once the lock date actually moved. */
  closed: boolean;
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

// ---------------------------------------------------------------------------
// watch folder — local drop-folder watching while the app is open
// (ROADMAP.md "Phase 2 ... Slip/receipt capture"). Mirrors
// `WatchFolderStatusDto` exactly.
// ---------------------------------------------------------------------------

export interface WatchFolderStatus {
  /** The persisted choice — survives a restart, drives autostart. */
  enabled: boolean;
  folder: string | null;
  /**
   * Whether a watcher thread is actually alive right now. Can be `false`
   * while `enabled` is `true`: the thread stopped on an error (see
   * `last_error`) without anything having turned the setting back off.
   */
  running: boolean;
  book_id: string | null;
  book_name: string | null;
  imported_count: number;
  last_error: string | null;
  started_at: string | null;
}

export interface WatchFolderSetRequest {
  enabled: boolean;
  /** Required when `enabled` is true; ignored when false. */
  folder?: string | null;
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
// net worth — periodic per-account balance snapshots (PARITY.md "Net worth
// over time"). Money stays integer minor units + a currency code throughout,
// same as everywhere else in this file.
// ---------------------------------------------------------------------------

export type NetWorthSnapshotSource = "captured" | "backfilled";

/** One `(account, date)` balance fact, in the account's own currency. */
export interface NetWorthSnapshot {
  id: string;
  book_id: string;
  account_id: string;
  /** `YYYY-MM-DD`. The balance is as of the end of this day. */
  as_of_date: string;
  balance_minor: number;
  currency: string;
  source: NetWorthSnapshotSource;
  created_at: string;
}

/** One account's balance inside a {@link NetWorthPoint} — its own currency,
 * never converted. */
export interface NetWorthAccountBalance {
  account_id: string;
  currency: string;
  balance_minor: number;
}

/** One point in a net-worth series: every account's most recent known
 * balance at or before this date, plus the total converted to the book's
 * currency. `unconverted` names any currency present in `by_account` that
 * had no resolvable exchange rate and so is excluded from `total_minor` —
 * a caller shows that plainly rather than treating the total as complete. */
export interface NetWorthPoint {
  as_of_date: string;
  by_account: NetWorthAccountBalance[];
  /** The book's currency — what `total_minor` is denominated in. */
  currency: string;
  total_minor: number;
  unconverted: string[];
}

/** A net-worth series for one book: every point in range, plus the exchange
 * rate provenance behind every conversion any point performed. The FX cache
 * is latest-only (no historical rates), so every point's conversion uses
 * TODAY's cached rate for a currency, never the rate that applied on that
 * point's own date — `conversions` names exactly which rate, so this is
 * never hidden. */
export interface NetWorthSeries {
  book_id: string;
  currency: string;
  points: NetWorthPoint[];
  conversions: FxCachedRate[];
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
  /** Tombstone, never reversed: `member_revoke` is the only writer. A revoked
   * member keeps their row because attributions and capability history point
   * at it. See docs/ROLES.md. */
  status: "active" | "revoked";
  revoked_at: string | null;
  /** Appears in "whose spend is this" (attribution / splits). */
  attributable: boolean;
  /** May hold capabilities and devices. Monotonic — once true, stays true,
   * which is why `member_remove` refuses a principal outright. */
  principal: boolean;
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
 * Selective update. Omit a key to leave it untouched, send `null` to clear it,
 * send a value to set it — plain JSON, the same convention every nullable
 * field on this surface uses.
 */
export interface MemberPatch {
  id: string;
  label?: string;
  initial?: string;
  colour?: string;
  default_account_id?: string | null;
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
// statement import — parse a bank CSV into transactions through a named
// column-mapping preset. Same core pipeline the CLI's
// `slipscan import --preset` drives: dedupe, the categorisation cascade and
// the Payments detection hook all apply, because desktop and CLI call the
// identical `slipscan_ingest::bank::import_statement_lines` function. OFX
// statements and a fully custom column mapping are still CLI-only — this
// surface is the built-in preset catalog only.
// ---------------------------------------------------------------------------

/** One catalog entry: a named, region-tagged CSV column mapping. `mapping`
 * is the preset's raw CSV column spec — opaque here, since the UI only ever
 * shows `bank_name` in a picker and never inspects it. */
export interface StatementPreset {
  id: string;
  region: string;
  region_name: string;
  bank_name: string;
  mapping: unknown;
}

/** Presets of one region, in catalog order — the shape `statementPresetList`
 * returns (SA banks first, `generic` layouts last). */
export interface StatementPresetGroup {
  region: string;
  region_name: string;
  presets: StatementPreset[];
}

export interface StatementImportRequest {
  book_id: string;
  account_id: string;
  /** Id from `StatementPreset.id` (e.g. `za-fnb`, `generic-mdy`). */
  preset_id: string;
  file_name: string;
  mime_type: string;
  /** Base64 file contents (desktop passes a path in Tauri mode instead). */
  bytes_base64?: string;
  path?: string;
}

export interface StatementImportResult {
  document: Document;
  /** The file's content hash already existed as a document in this book —
   * the parse still ran (overlapping statement pulls are the normal case
   * for a bank export), so this is informational, never a refusal. */
  document_duplicate: boolean;
  preset_id: string;
  account_id: string;
  /** Newly created transactions only — a duplicate line is counted below,
   * never included here. */
  imported: Transaction[];
  /** Lines that matched an existing transaction and were not re-imported. */
  duplicates: number;
  /** Subset of `duplicates` matched by content hash alone (no bank
   * reference id) — see the CLI's `import_statement_lines` docs. */
  content_duplicates: number;
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

/** Chart-of-accounts entry as the desktop renders it — `LedgerAccount` is
 * this app's display name for core's `CoaAccount`, which is why the IPC
 * command `ledger_account_list` maps to the HTTP route `coa_list`. */
export interface NewLedgerAccount {
  book_id: string;
  code: string;
  name: string;
  kind: LedgerAccountType;
  description?: string;
  /** Defaults to the book's currency. */
  currency?: string;
}

/** Which side of the personal-finance model maps onto a chart entry. */
export type CoaMapEntity = "account" | "category";

/** One mapping from an account or category to a chart-of-accounts entry —
 * what makes automatic journal generation possible. */
export interface CoaMapEntry {
  id: string;
  book_id: string;
  entity_type: CoaMapEntity;
  entity_id: string;
  coa_id: string;
  created_at: string;
  updated_at: string;
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

/** One income/expense account's net movement over a period. */
export interface IncomeStatementRow {
  coa_id: string;
  code: string;
  name: string;
  kind: LedgerAccountType;
  /** Income: credits − debits. Expenses: debits − credits. */
  amount_minor: number;
}

/**
 * Income statement (profit & loss) over an inclusive posted-date range —
 * core's `report_income_statement`, passed straight through with no
 * reshaping. Replaces the old ALL-TIME `report_income_expense` chart as the
 * account-level P&L; that command is still used for the trend chart, which
 * is intentionally NOT scoped by the report period (see Reports.svelte).
 */
export interface IncomeStatement {
  book_id: string;
  from_date: string;
  to_date: string;
  currency: string;
  income: IncomeStatementRow[];
  expenses: IncomeStatementRow[];
  income_total_minor: number;
  expense_total_minor: number;
  net_profit_minor: number;
}

/** One balance-sheet account's natural-side balance as of a date. */
export interface BalanceSheetRow {
  coa_id: string;
  code: string;
  name: string;
  kind: LedgerAccountType;
  amount_minor: number;
}

/**
 * Balance sheet as of a date — core's `report_balance_sheet`. Income/expense
 * movement up to `as_of_date` is folded into `retained_earnings_minor`
 * (part of `equity_total_minor`) so the statement always balances:
 * `assets_total_minor === liabilities_total_minor + equity_total_minor`.
 */
export interface BalanceSheet {
  book_id: string;
  as_of_date: string;
  currency: string;
  assets: BalanceSheetRow[];
  liabilities: BalanceSheetRow[];
  equity: BalanceSheetRow[];
  retained_earnings_minor: number;
  assets_total_minor: number;
  liabilities_total_minor: number;
  equity_total_minor: number;
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
  /** Inclusive posted-date range this summary covers. */
  from: string;
  to: string;
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
