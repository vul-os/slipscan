/**
 * Typed API client for the slipscan-core service surface.
 *
 * Under Tauri, every call goes through `invoke()` using the contract command
 * names (book_list, transaction_list, …). Outside Tauri (plain `vite dev` in
 * a browser) — or while a command is not wired into src-tauri yet — calls
 * transparently fall back to the in-memory mock dataset so the UI always runs.
 */
import { invoke } from "@tauri-apps/api/core";
import { mockApi } from "./mock";
import { apiStatus } from "./status.svelte";
import type {
  Account,
  AgedReceivables,
  BenchmarkReport,
  Book,
  BookKind,
  BookProfile,
  Budget,
  BudgetUpsert,
  BudgetWithSpend,
  Category,
  ClosePeriodReport,
  CoaMapEntity,
  CoaMapEntry,
  Contact,
  ContactUpdateRequest,
  DataMoveRequest,
  DataStatus,
  DeviceIdentity,
  DevicePeer,
  DeviceRotateResult,
  DeviceRotation,
  Document,
  DocumentImportRequest,
  FxConversion,
  FxQuote,
  FxStatus,
  Health,
  BalanceSheet,
  IncomeExpenseReport,
  IncomeStatement,
  InstalledPackInfo,
  Invoice,
  InvoiceItem,
  InvoicePayment,
  InvoiceTotals,
  JournalEntry,
  JournalPostRequest,
  LedgerAccount,
  Location,
  LocationUpdateRequest,
  LowStockVariant,
  Member,
  MemberAmountRow,
  MemberCategoryRow,
  MemberPatch,
  MemberSettleRow,
  NetWorthSeries,
  NetWorthSnapshot,
  NewBook,
  NewContact,
  NewInvoice,
  NewInvoicePayment,
  NewLedgerAccount,
  NewLocation,
  NewMember,
  NewPayEndpoint,
  NewPayWatch,
  NewPoReceipt,
  NewProduct,
  NewProductCategory,
  NewProductVariant,
  NewPurchaseOrder,
  NewPurchaseOrderItem,
  NewSalesOrder,
  NewSalesOrderItem,
  NewStockMovement,
  PackDocumentRequest,
  PackInstallOutcome,
  PackOffer,
  PackSourceInfo,
  PackVerification,
  PairRedeemRequest,
  PairingAcceptance,
  PairingInvite,
  PairingInviteMeta,
  PayDelivery,
  PayEndpoint,
  PayEndpointWithSecret,
  PayMatch,
  PayWatch,
  PoItemUpdateRequest,
  PoReceipt,
  PoReceiptStatus,
  PoUpdateRequest,
  Product,
  ProductCategory,
  ProductUpdateRequest,
  ProductVariant,
  ProductVariantUpdateRequest,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderItemReceiving,
  ReconConfirmRequest,
  ReconSuggestion,
  RegionInfo,
  SalesOrder,
  SalesOrderItem,
  SalesOrderItemUpdateRequest,
  SalesOrderTotals,
  SalesOrderUpdateRequest,
  Settings,
  SpendingReport,
  SplitShare,
  StockMovement,
  Transaction,
  TransactionListQuery,
  TransactionSplit,
  TransferResult,
  TrialBalance,
  VatRate,
  VatSummary,
  VaultCredentialMeta,
  VaultReplaceRequest,
  VaultSetRequest,
} from "./types";

export const isTauri: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** True only for "this command is not registered at all" errors — real
 * domain errors (validation, not-found, unbalanced journal) must surface. */
function isCommandMissing(command: string, err: unknown): boolean {
  return String(err).includes(`Command ${command} not found`);
}

async function call<T>(
  command: string,
  args: Record<string, unknown>,
  mock: () => Promise<T>,
): Promise<T> {
  if (!isTauri) return mock();
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    if (!isCommandMissing(command, err)) throw err;
    // Command not wired into src-tauri yet: keep the shell usable, but flag
    // it — the sidebar shows a "mock" badge so fake data is never silent.
    apiStatus.usedMockFallback = true;
    console.warn(`[api] ${command} unavailable, using mock data:`, err);
    return mock();
  }
}

export const api = {
  health: (): Promise<Health> => call("health", {}, mockApi.health),

  bookList: (): Promise<Book[]> => call("book_list", {}, mockApi.book_list),

  /** Create a book and seed it (chart of accounts + starter categories) from
   * the region profile it was created with — the command is what first-run
   * setup calls to turn the region and currency the user picked into an
   * actual book. Nothing jurisdictional is chosen here: `region` is an id the
   * caller took from `regionList`, and core rejects one it does not know. */
  bookCreate: (q: NewBook): Promise<Book> =>
    call("book_create", { query: q }, () => mockApi.book_create(q)),

  // -- book profiles (Phase 6.0 — ROADMAP.md "Phase 6", Book profiles):
  // which capability groups a book should show right now. Settings and
  // first-run setup both call these instead of re-deriving `kind ===
  // "business"` or a locations count themselves. --

  bookProfile: (q: { book_id: string }): Promise<BookProfile> =>
    call("book_profile", { query: q }, () => mockApi.book_profile(q)),

  /** Change a book's kind later, in either direction. Downgrading only
   * hides screens — it deletes nothing in locations/contacts/catalogue. */
  bookSetKind: (q: { book_id: string; kind: BookKind }): Promise<BookProfile> =>
    call("book_set_kind", { query: q }, () => mockApi.book_set_kind(q)),

  /** Pin (`true`/`false`) or clear (`null`/omitted) the multi-location
   * override (decision #3: derived by default, overridable either way). */
  bookSetMultiLocationOverride: (q: {
    book_id: string;
    multi_location_override?: boolean | null;
  }): Promise<BookProfile> =>
    call("book_set_multi_location_override", { query: q }, () =>
      mockApi.book_set_multi_location_override(q),
    ),

  // -- locations: branches, sites and warehouses within a book (Phase 6.1,
  // the flowstock fold foundation). A book with none behaves exactly as it
  // always has; a second one is what the multi-location flag derives from. --

  locationList: (q: { book_id: string }): Promise<Location[]> =>
    call("location_list", { query: q }, () => mockApi.location_list(q)),

  locationCreate: (q: NewLocation): Promise<Location> =>
    call("location_create", { query: q }, () => mockApi.location_create(q)),

  locationUpdate: (q: LocationUpdateRequest): Promise<Location> =>
    call("location_update", { query: q }, () => mockApi.location_update(q)),

  locationDelete: (q: { location_id: string }): Promise<null> =>
    call("location_delete", { query: q }, () => mockApi.location_delete(q)),

  // -- chart of accounts, journal generation, and the book lock date. The
  // chart could be listed and seeded but not added to; a journal could be
  // posted but not generated from a transaction or document, nor reversed. --

  ledgerAccountCreate: (q: NewLedgerAccount): Promise<LedgerAccount> =>
    call("coa_create", { query: q }, () => mockApi.coa_create(q)),

  /** Archive, never delete — history is preserved. */
  ledgerAccountArchive: (q: { id: string }): Promise<LedgerAccount> =>
    call("coa_archive", { query: q }, () => mockApi.coa_archive(q)),

  /** Map an account or category onto a chart entry. */
  coaMapSet: (q: {
    book_id: string;
    entity_type: CoaMapEntity;
    entity_id: string;
    coa_id: string;
  }): Promise<CoaMapEntry> =>
    call("coa_map_set", { query: q }, () => mockApi.coa_map_set(q)),

  journalGenerateForTransaction: (q: {
    transaction_id: string;
    vat_rate_id?: string;
  }): Promise<JournalEntry> =>
    call("journal_generate_for_transaction", { query: q }, () =>
      mockApi.journal_generate_for_transaction(q),
    ),

  journalGenerateForDocument: (q: {
    document_id: string;
  }): Promise<JournalEntry> =>
    call("journal_generate_for_document", { query: q }, () =>
      mockApi.journal_generate_for_document(q),
    ),

  /** A posted journal is immutable; a correction is a reversal. */
  journalReverse: (q: {
    journal_id: string;
    posted_date?: string;
    narrative?: string;
  }): Promise<JournalEntry> =>
    call("journal_reverse", { query: q }, () => mockApi.journal_reverse(q)),

  /** Set or clear the book's financial lock date — journals may not be
   * posted on or before it. `null` clears. */
  bookSetLockDate: (q: {
    book_id: string;
    lock_date?: string | null;
  }): Promise<Book> =>
    call("book_set_lock_date", { query: q }, () =>
      mockApi.book_set_lock_date(q),
    ),

  // -- period close: the ritual that turns a ledger into a book someone
  // will sign. `closePeriodCheck` previews with no mutation; `closePeriod`
  // runs the identical checks and locks on success; `reopenPeriod` is the
  // deliberate, audited undo. --

  /** Preview closing the period through `to_date` — no mutation. */
  closePeriodCheck: (q: {
    book_id: string;
    to_date: string;
  }): Promise<ClosePeriodReport> =>
    call("close_period_check", { query: q }, () =>
      mockApi.close_period_check(q),
    ),

  /** Close the period through `to_date`. Rejects (with every blocking
   * reason in the error) rather than locking over a problem. */
  closePeriod: (q: { book_id: string; to_date: string }): Promise<ClosePeriodReport> =>
    call("close_period", { query: q }, () => mockApi.close_period(q)),

  /** Reopen a closed period — a deliberate, audited act. `reason` is
   * required; `to_date` reopens back to an earlier seal instead of
   * clearing the lock entirely. */
  reopenPeriod: (q: {
    book_id: string;
    reason: string;
    to_date?: string | null;
  }): Promise<Book> =>
    call("reopen_period", { query: q }, () => mockApi.reopen_period(q)),

  // -- stock: the append-only movement ledger (Phase 6.3b). On-hand is
  // derived on every read; there is no "set level" call, on purpose. --

  stockMovementRecord: (q: NewStockMovement): Promise<StockMovement> =>
    call("stock_movement_record", { query: q }, () =>
      mockApi.stock_movement_record(q),
    ),

  /** `SUM(qty_delta)` for one variant at one location. */
  stockOnHand: (q: {
    variant_id: string;
    location_id: string;
  }): Promise<number> =>
    call("stock_on_hand", { query: q }, () => mockApi.stock_on_hand(q)),

  /** On-hand per location, as `[location_id, qty]` pairs. */
  stockOnHandByLocation: (q: {
    variant_id: string;
  }): Promise<[string, number][]> =>
    call("stock_on_hand_by_location", { query: q }, () =>
      mockApi.stock_on_hand_by_location(q),
    ),

  stockOnHandTotal: (q: { variant_id: string }): Promise<number> =>
    call("stock_on_hand_total", { query: q }, () =>
      mockApi.stock_on_hand_total(q),
    ),

  stockMovementsForVariant: (q: {
    variant_id: string;
  }): Promise<StockMovement[]> =>
    call("stock_movements_for_variant", { query: q }, () =>
      mockApi.stock_movements_for_variant(q),
    ),

  stockMovementsForLocation: (q: {
    location_id: string;
  }): Promise<StockMovement[]> =>
    call("stock_movements_for_location", { query: q }, () =>
      mockApi.stock_movements_for_location(q),
    ),

  /** Every movement written by one source document. */
  stockMovementsForRef: (q: {
    ref_kind: string;
    ref_id: string;
  }): Promise<StockMovement[]> =>
    call("stock_movements_for_ref", { query: q }, () =>
      mockApi.stock_movements_for_ref(q),
    ),

  stockTransfer: (q: {
    variant_id: string;
    from_location_id: string;
    to_location_id: string;
    qty: number;
    note?: string;
    created_by?: string;
  }): Promise<TransferResult> =>
    call("stock_transfer", { query: q }, () => mockApi.stock_transfer(q)),

  stockLowVariants: (q: { book_id: string }): Promise<LowStockVariant[]> =>
    call("stock_low_variants", { query: q }, () =>
      mockApi.stock_low_variants(q),
    ),

  // -- catalogue: product categories, products, and their variants (Phase
  // 6.3a). The variant is the unit stock movements and order lines reference;
  // wired late, so until now a line could name one nothing could create. --

  productCategoryCreate: (q: NewProductCategory): Promise<ProductCategory> =>
    call("product_category_create", { query: q }, () =>
      mockApi.product_category_create(q),
    ),

  productCategoryGet: (q: { id: string }): Promise<ProductCategory> =>
    call("product_category_get", { query: q }, () =>
      mockApi.product_category_get(q),
    ),

  productCategoryList: (q: { book_id: string }): Promise<ProductCategory[]> =>
    call("product_category_list", { query: q }, () =>
      mockApi.product_category_list(q),
    ),

  productCategoryRename: (q: {
    id: string;
    name: string;
  }): Promise<ProductCategory> =>
    call("product_category_rename", { query: q }, () =>
      mockApi.product_category_rename(q),
    ),

  productCategoryDelete: (q: { id: string }): Promise<null> =>
    call("product_category_delete", { query: q }, () =>
      mockApi.product_category_delete(q),
    ),

  productCreate: (q: NewProduct): Promise<Product> =>
    call("product_create", { query: q }, () => mockApi.product_create(q)),

  productGet: (q: { id: string }): Promise<Product> =>
    call("product_get", { query: q }, () => mockApi.product_get(q)),

  productList: (q: { book_id: string }): Promise<Product[]> =>
    call("product_list", { query: q }, () => mockApi.product_list(q)),

  productUpdate: (q: ProductUpdateRequest): Promise<Product> =>
    call("product_update", { query: q }, () => mockApi.product_update(q)),

  productDelete: (q: { id: string }): Promise<null> =>
    call("product_delete", { query: q }, () => mockApi.product_delete(q)),

  /** The sellable/stockable unit — what an order line actually references. */
  productVariantAdd: (q: NewProductVariant): Promise<ProductVariant> =>
    call("product_variant_add", { query: q }, () =>
      mockApi.product_variant_add(q),
    ),

  productVariantGet: (q: { id: string }): Promise<ProductVariant> =>
    call("product_variant_get", { query: q }, () =>
      mockApi.product_variant_get(q),
    ),

  productVariantList: (q: { product_id: string }): Promise<ProductVariant[]> =>
    call("product_variant_list", { query: q }, () =>
      mockApi.product_variant_list(q),
    ),

  /** Every variant in the book — what a picker needs. */
  productVariantListForBook: (q: {
    book_id: string;
  }): Promise<ProductVariant[]> =>
    call("product_variant_list_for_book", { query: q }, () =>
      mockApi.product_variant_list_for_book(q),
    ),

  productVariantUpdate: (
    q: ProductVariantUpdateRequest,
  ): Promise<ProductVariant> =>
    call("product_variant_update", { query: q }, () =>
      mockApi.product_variant_update(q),
    ),

  productVariantDelete: (q: { id: string }): Promise<null> =>
    call("product_variant_delete", { query: q }, () =>
      mockApi.product_variant_delete(q),
    ),

  // -- contacts: customers and suppliers in one table (Phase 6.2). Wired
  // late — the model shipped with 6.2 but nothing could create a contact, so
  // purchasing and sales could name an id that did not exist. --

  contactAdd: (q: NewContact): Promise<Contact> =>
    call("contact_add", { query: q }, () => mockApi.contact_add(q)),

  contactGet: (q: { id: string }): Promise<Contact> =>
    call("contact_get", { query: q }, () => mockApi.contact_get(q)),

  contactList: (q: { book_id: string }): Promise<Contact[]> =>
    call("contact_list", { query: q }, () => mockApi.contact_list(q)),

  /** Role `customer` or `both`. */
  contactListCustomers: (q: { book_id: string }): Promise<Contact[]> =>
    call("contact_list_customers", { query: q }, () =>
      mockApi.contact_list_customers(q),
    ),

  /** Role `supplier` or `both`. */
  contactListSuppliers: (q: { book_id: string }): Promise<Contact[]> =>
    call("contact_list_suppliers", { query: q }, () =>
      mockApi.contact_list_suppliers(q),
    ),

  contactUpdate: (q: ContactUpdateRequest): Promise<Contact> =>
    call("contact_update", { query: q }, () => mockApi.contact_update(q)),

  /** Refused by the database when the contact has any trade history. */
  contactRemove: (q: { id: string }): Promise<null> =>
    call("contact_remove", { query: q }, () => mockApi.contact_remove(q)),

  // -- purchasing: purchase orders, their line items, and goods receipts
  // (Phase 6.4, the flowstock fold). No screen calls these yet (ROADMAP.md
  // 6.9) — wired ahead of the UI the same way `bookProfile`/the location
  // CRUD above were. `poReceive` writes a stock movement in the same
  // transaction as the receipt, so on-hand and purchasing can never
  // disagree about how much arrived. --

  poCreate: (q: NewPurchaseOrder): Promise<PurchaseOrder> =>
    call("po_create", { query: q }, () => mockApi.po_create(q)),

  poGet: (q: { po_id: string }): Promise<PurchaseOrder> =>
    call("po_get", { query: q }, () => mockApi.po_get(q)),

  poList: (q: { book_id: string }): Promise<PurchaseOrder[]> =>
    call("po_list", { query: q }, () => mockApi.po_list(q)),

  poUpdate: (q: PoUpdateRequest): Promise<PurchaseOrder> =>
    call("po_update", { query: q }, () => mockApi.po_update(q)),

  /** `draft -> ordered -> cancelled`, never reversible. */
  poSetStatus: (q: {
    po_id: string;
    status: PurchaseOrder["status"];
  }): Promise<PurchaseOrder> =>
    call("po_set_status", { query: q }, () => mockApi.po_set_status(q)),

  poDelete: (q: { po_id: string }): Promise<null> =>
    call("po_delete", { query: q }, () => mockApi.po_delete(q)),

  poItemAdd: (q: NewPurchaseOrderItem): Promise<PurchaseOrderItem> =>
    call("po_item_add", { query: q }, () => mockApi.po_item_add(q)),

  poItemGet: (q: { item_id: string }): Promise<PurchaseOrderItem> =>
    call("po_item_get", { query: q }, () => mockApi.po_item_get(q)),

  poItemList: (q: { purchase_order_id: string }): Promise<PurchaseOrderItem[]> =>
    call("po_item_list", { query: q }, () => mockApi.po_item_list(q)),

  poItemUpdate: (q: PoItemUpdateRequest): Promise<PurchaseOrderItem> =>
    call("po_item_update", { query: q }, () => mockApi.po_item_update(q)),

  poItemDelete: (q: { item_id: string }): Promise<null> =>
    call("po_item_delete", { query: q }, () => mockApi.po_item_delete(q)),

  /** Record one goods receipt against a line. Writes a stock movement in
   * the same transaction — the keystone this phase exists to prove. */
  poReceive: (q: NewPoReceipt): Promise<PoReceipt> =>
    call("po_receive", { query: q }, () => mockApi.po_receive(q)),

  poReceiptsForItem: (q: { item_id: string }): Promise<PoReceipt[]> =>
    call("po_receipts_for_item", { query: q }, () =>
      mockApi.po_receipts_for_item(q),
    ),

  poReceiptsForPo: (q: { purchase_order_id: string }): Promise<PoReceipt[]> =>
    call("po_receipts_for_po", { query: q }, () =>
      mockApi.po_receipts_for_po(q),
    ),

  /** `SUM(qty)` over a line's own receipts — never a stored counter. */
  poItemReceivedQty: (q: { item_id: string }): Promise<number> =>
    call("po_item_received_qty", { query: q }, () =>
      mockApi.po_item_received_qty(q),
    ),

  poItemReceivingStatus: (q: { item_id: string }): Promise<PoReceiptStatus> =>
    call("po_item_receiving_status", { query: q }, () =>
      mockApi.po_item_receiving_status(q),
    ),

  /** A PO's lines paired with each one's derived received quantity and
   * status — what a purchasing screen would actually render. */
  poItemsWithReceiving: (q: {
    purchase_order_id: string;
  }): Promise<PurchaseOrderItemReceiving[]> =>
    call("po_items_with_receiving", { query: q }, () =>
      mockApi.po_items_with_receiving(q),
    ),

  poReceivingStatus: (q: {
    purchase_order_id: string;
  }): Promise<PoReceiptStatus> =>
    call("po_receiving_status", { query: q }, () =>
      mockApi.po_receiving_status(q),
    ),

  // -- sales orders & invoicing (Phase 6.5, migration 0014_sales). No screen
  // calls these yet (ROADMAP.md 6.9) — wired ahead of the UI, the same as the
  // purchasing block above. An order is the editable draft; an invoice is a
  // fact, which is why there is no invoiceUpdate/invoiceDelete here: the
  // database refuses one, and a correction is a credit note (not built).
  // Nullable fields clear by sending `null` rather than a `clear_*` flag —
  // see the note in types.ts for why this differs from purchasing. --

  salesOrderCreate: (q: NewSalesOrder): Promise<SalesOrder> =>
    call("sales_order_create", { query: q }, () => mockApi.sales_order_create(q)),

  salesOrderGet: (q: { id: string }): Promise<SalesOrder> =>
    call("sales_order_get", { query: q }, () => mockApi.sales_order_get(q)),

  salesOrderList: (q: { book_id: string }): Promise<SalesOrder[]> =>
    call("sales_order_list", { query: q }, () => mockApi.sales_order_list(q)),

  salesOrderUpdate: (q: SalesOrderUpdateRequest): Promise<SalesOrder> =>
    call("sales_order_update", { query: q }, () => mockApi.sales_order_update(q)),

  /** Only reachable while the order is still a draft — a confirmed order has
   * moved stock, so it is cancelled rather than deleted. */
  salesOrderDelete: (q: { id: string }): Promise<null> =>
    call("sales_order_delete", { query: q }, () => mockApi.sales_order_delete(q)),

  salesOrderItemAdd: (q: NewSalesOrderItem): Promise<SalesOrderItem> =>
    call("sales_order_item_add", { query: q }, () =>
      mockApi.sales_order_item_add(q),
    ),

  salesOrderItemsList: (q: {
    sales_order_id: string;
  }): Promise<SalesOrderItem[]> =>
    call("sales_order_items_list", { query: q }, () =>
      mockApi.sales_order_items_list(q),
    ),

  salesOrderItemUpdate: (
    q: SalesOrderItemUpdateRequest,
  ): Promise<SalesOrderItem> =>
    call("sales_order_item_update", { query: q }, () =>
      mockApi.sales_order_item_update(q),
    ),

  salesOrderItemRemove: (q: { id: string }): Promise<null> =>
    call("sales_order_item_remove", { query: q }, () =>
      mockApi.sales_order_item_remove(q),
    ),

  /** draft -> confirmed. Deducts stock for every stock-tracked line in the
   * same transaction, so on-hand can never disagree with what was sold. */
  salesOrderConfirm: (q: { id: string }): Promise<SalesOrder> =>
    call("sales_order_confirm", { query: q }, () =>
      mockApi.sales_order_confirm(q),
    ),

  /** Writes a compensating stock movement for each line it had deducted,
   * rather than erasing anything — that ledger is immutable. */
  salesOrderCancel: (q: { id: string }): Promise<SalesOrder> =>
    call("sales_order_cancel", { query: q }, () => mockApi.sales_order_cancel(q)),

  salesOrderMarkPaid: (q: { id: string }): Promise<SalesOrder> =>
    call("sales_order_mark_paid", { query: q }, () =>
      mockApi.sales_order_mark_paid(q),
    ),

  /** Derived from the order's items every time, never stored on the order. */
  salesOrderTotals: (q: { id: string }): Promise<SalesOrderTotals> =>
    call("sales_order_totals", { query: q }, () => mockApi.sales_order_totals(q)),

  /** The only way an invoice comes into being — it is created already
   * numbered, and never edited afterwards. */
  invoiceIssue: (q: NewInvoice): Promise<Invoice> =>
    call("invoice_issue", { query: q }, () => mockApi.invoice_issue(q)),

  invoiceGet: (q: { id: string }): Promise<Invoice> =>
    call("invoice_get", { query: q }, () => mockApi.invoice_get(q)),

  invoiceList: (q: { book_id: string }): Promise<Invoice[]> =>
    call("invoice_list", { query: q }, () => mockApi.invoice_list(q)),

  invoiceItemsList: (q: { invoice_id: string }): Promise<InvoiceItem[]> =>
    call("invoice_items_list", { query: q }, () =>
      mockApi.invoice_items_list(q),
    ),

  /** Includes paid/unpaid state, which is computed here rather than stored. */
  invoiceTotals: (q: { id: string }): Promise<InvoiceTotals> =>
    call("invoice_totals", { query: q }, () => mockApi.invoice_totals(q)),

  invoicePaymentRecord: (q: NewInvoicePayment): Promise<InvoicePayment> =>
    call("invoice_payment_record", { query: q }, () =>
      mockApi.invoice_payment_record(q),
    ),

  invoicePaymentsList: (q: {
    invoice_id: string;
  }): Promise<InvoicePayment[]> =>
    call("invoice_payments_list", { query: q }, () =>
      mockApi.invoice_payments_list(q),
    ),

  /** Every outstanding invoice bucketed by age, grouped by contact. */
  reportAgedReceivables: (q: {
    book_id: string;
    as_of?: string;
  }): Promise<AgedReceivables> =>
    call("report_aged_receivables", { query: q }, () =>
      mockApi.report_aged_receivables(q),
    ),

  // -- data folder: one movable folder holds everything durable. Backup is
  // the user's own cloud syncing that folder; SlipScan ships no backup
  // service. --

  dataStatus: (): Promise<DataStatus> =>
    call("data_status", {}, mockApi.data_status),

  /** Single await for the whole copy→verify→switch→cleanup sequence; while
   * it is pending the app is read-only (other commands block on the move). */
  dataMove: (q: DataMoveRequest): Promise<DataStatus> =>
    call("data_move", { query: q }, () => mockApi.data_move(q)),

  accountList: (q: { book_id: string }): Promise<Account[]> =>
    call("account_list", { query: q }, () => mockApi.account_list(q)),

  /** Records today's (or `as_of_date`'s) balance for every account, one
   * snapshot each. Safe to call on every Dashboard load — an account that
   * already has a snapshot for that date keeps it rather than duplicating. */
  networthCapture: (q: {
    book_id: string;
    as_of_date?: string;
  }): Promise<NetWorthSnapshot[]> =>
    call("networth_capture", { query: q }, () => mockApi.networth_capture(q)),

  /** Reconstructs historical snapshots from the transaction ledger. Safe to
   * call repeatedly: only dates still missing a snapshot ever gain one. */
  networthBackfill: (q: { book_id: string }): Promise<NetWorthSnapshot[]> =>
    call("networth_backfill", { query: q }, () => mockApi.networth_backfill(q)),

  networthSeries: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<NetWorthSeries> =>
    call("networth_series", { query: q }, () => mockApi.networth_series(q)),

  transactionList: (q: TransactionListQuery): Promise<Transaction[]> =>
    call("transaction_list", { query: q }, () => mockApi.transaction_list(q)),

  transactionCategorize: (q: {
    transaction_id: string;
    category_id: string | null;
  }): Promise<Transaction> =>
    call("transaction_categorize", { query: q }, () =>
      mockApi.transaction_categorize(q),
    ),

  categoryList: (q: { book_id: string }): Promise<Category[]> =>
    call("category_list", { query: q }, () => mockApi.category_list(q)),

  // -- household members & per-person attribution: local data, never a
  // login. A book with zero members works unchanged. --

  memberList: (q: { book_id: string }): Promise<Member[]> =>
    call("member_list", { query: q }, () => mockApi.member_list(q)),

  memberAdd: (q: NewMember): Promise<Member> =>
    call("member_add", { query: q }, () => mockApi.member_add(q)),

  memberUpdate: (q: MemberPatch): Promise<Member> =>
    call("member_update", { query: q }, () => mockApi.member_update(q)),

  memberRemove: (q: { id: string; reassign_to?: string }): Promise<null> =>
    call("member_remove", { query: q }, () => mockApi.member_remove(q)),

  /** Override (or clear, with `member_id: null`) a transaction's
   * attribution — metadata only, never touches amount/currency/category. */
  transactionAttribute: (q: {
    transaction_id: string;
    member_id: string | null;
  }): Promise<Transaction> =>
    call("transaction_attribute", { query: q }, () =>
      mockApi.transaction_attribute(q),
    ),

  transactionSplitsList: (q: {
    transaction_id: string;
  }): Promise<TransactionSplit[]> =>
    call("transaction_splits_list", { query: q }, () =>
      mockApi.transaction_splits_list(q),
    ),

  /** Replace a transaction's split set; an empty `shares` array clears it. */
  transactionSplitSet: (q: {
    transaction_id: string;
    shares: SplitShare[];
  }): Promise<TransactionSplit[]> =>
    call("transaction_split_set", { query: q }, () =>
      mockApi.transaction_split_set(q),
    ),

  reportMemberExpense: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<MemberAmountRow[]> =>
    call("report_member_expense", { query: q }, () =>
      mockApi.report_member_expense(q),
    ),

  reportMemberContribution: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<MemberAmountRow[]> =>
    call("report_member_contribution", { query: q }, () =>
      mockApi.report_member_contribution(q),
    ),

  reportMemberCategory: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<MemberCategoryRow[]> =>
    call("report_member_category", { query: q }, () =>
      mockApi.report_member_category(q),
    ),

  reportSettleUp: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<MemberSettleRow[]> =>
    call("report_settle_up", { query: q }, () => mockApi.report_settle_up(q)),

  budgetList: (q: {
    book_id: string;
    month: string;
  }): Promise<BudgetWithSpend[]> =>
    call("budget_list", { query: q }, () => mockApi.budget_list(q)),

  budgetUpsert: (q: BudgetUpsert): Promise<Budget> =>
    call("budget_upsert", { query: q }, () => mockApi.budget_upsert(q)),

  documentList: (q: { book_id: string }): Promise<Document[]> =>
    call("document_list", { query: q }, () => mockApi.document_list(q)),

  documentGet: (q: { document_id: string }): Promise<Document> =>
    call("document_get", { query: q }, () => mockApi.document_get(q)),

  documentImport: (q: DocumentImportRequest): Promise<Document> =>
    call("document_import", { query: q }, () => mockApi.document_import(q)),

  ledgerAccountList: (q: { book_id: string }): Promise<LedgerAccount[]> =>
    call("ledger_account_list", { query: q }, () =>
      mockApi.ledger_account_list(q),
    ),

  journalList: (q: { book_id: string }): Promise<JournalEntry[]> =>
    call("journal_list", { query: q }, () => mockApi.journal_list(q)),

  journalPost: (q: JournalPostRequest): Promise<JournalEntry> =>
    call("journal_post", { query: q }, () => mockApi.journal_post(q)),

  reconSuggest: (q: { book_id: string }): Promise<ReconSuggestion[]> =>
    call("recon_suggest", { query: q }, () => mockApi.recon_suggest(q)),

  reconConfirm: (q: ReconConfirmRequest): Promise<ReconSuggestion> =>
    call("recon_confirm", { query: q }, () => mockApi.recon_confirm(q)),

  reportSpending: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<SpendingReport> =>
    call("report_spending", { query: q }, () => mockApi.report_spending(q)),

  reportIncomeExpense: (q: { book_id: string }): Promise<IncomeExpenseReport> =>
    call("report_income_expense", { query: q }, () =>
      mockApi.report_income_expense(q),
    ),

  reportIncomeStatement: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<IncomeStatement> =>
    call("report_income_statement", { query: q }, () =>
      mockApi.report_income_statement(q),
    ),

  reportBalanceSheet: (q: {
    book_id: string;
    as_of?: string;
  }): Promise<BalanceSheet> =>
    call("report_balance_sheet", { query: q }, () =>
      mockApi.report_balance_sheet(q),
    ),

  reportVatSummary: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<VatSummary> =>
    call("report_vat_summary", { query: q }, () =>
      mockApi.report_vat_summary(q),
    ),

  reportTrialBalance: (q: { book_id: string }): Promise<TrialBalance> =>
    call("report_trial_balance", { query: q }, () =>
      mockApi.report_trial_balance(q),
    ),

  regionList: (): Promise<RegionInfo[]> =>
    call("region_list", {}, mockApi.region_list),

  // -- tax rates: listed and configurable per book (the generic profile's
  // standard rate is a placeholder until the user sets it) --

  vatRateList: (q: { book_id: string }): Promise<VatRate[]> =>
    call("vat_rate_list", { query: q }, () => mockApi.vat_rate_list(q)),

  vatRateSetBps: (q: {
    book_id: string;
    code: string;
    rate_bps: number;
  }): Promise<VatRate> =>
    call("vat_rate_set_bps", { query: q }, () => mockApi.vat_rate_set_bps(q)),

  // -- FX (OpenRate): opt-in. Only fxFetchRate touches the network, and only
  // on an explicit user action against the configured endpoint. --

  fxStatus: (): Promise<FxStatus> => call("fx_status", {}, mockApi.fx_status),

  fxConfigure: (q: { base_url: string }): Promise<FxStatus> =>
    call("fx_configure", { query: q }, () => mockApi.fx_configure(q)),

  fxFetchRate: (q: { from: string; to: string }): Promise<FxQuote> =>
    call("fx_fetch_rate", { query: q }, () => mockApi.fx_fetch_rate(q)),

  fxConvert: (q: {
    from: string;
    to: string;
    amount_minor: number;
    /** Optional pinned decimal rate: replays a booked conversion exactly
     * instead of using the current cached rate. */
    rate?: string;
  }): Promise<FxConversion> =>
    call("fx_convert", { query: q }, () => mockApi.fx_convert(q)),

  // -- Payments: watch reference codes on inbound transactions, fire signed
  // webhooks. Only payDeliverDue touches the network — on explicit user
  // action, and only to endpoints the user registered. --

  payWatchList: (q: { book_id: string }): Promise<PayWatch[]> =>
    call("pay_watch_list", { query: q }, () => mockApi.pay_watch_list(q)),

  payWatchAdd: (q: NewPayWatch): Promise<PayWatch> =>
    call("pay_watch_add", { query: q }, () => mockApi.pay_watch_add(q)),

  payWatchRemove: (q: { watch_id: string }): Promise<null> =>
    call("pay_watch_remove", { query: q }, () => mockApi.pay_watch_remove(q)),

  payWatchSetEnabled: (q: {
    watch_id: string;
    enabled: boolean;
  }): Promise<PayWatch> =>
    call("pay_watch_set_enabled", { query: q }, () =>
      mockApi.pay_watch_set_enabled(q),
    ),

  payEndpointList: (q: { book_id: string }): Promise<PayEndpoint[]> =>
    call("pay_endpoint_list", { query: q }, () => mockApi.pay_endpoint_list(q)),

  /** The response carries the signing secret EXACTLY ONCE — show it, let the
   * user copy it, then drop it from state. It can never be read back. */
  payEndpointAdd: (q: NewPayEndpoint): Promise<PayEndpointWithSecret> =>
    call("pay_endpoint_add", { query: q }, () => mockApi.pay_endpoint_add(q)),

  /** Same single-display contract as payEndpointAdd; the old secret is
   * destroyed. */
  payEndpointRotateSecret: (q: {
    endpoint_id: string;
  }): Promise<PayEndpointWithSecret> =>
    call("pay_endpoint_rotate_secret", { query: q }, () =>
      mockApi.pay_endpoint_rotate_secret(q),
    ),

  /** Removes the endpoint (queued deliveries cascade) and revokes its
   * vault-held signing secret. */
  payEndpointRemove: (q: { endpoint_id: string }): Promise<null> =>
    call("pay_endpoint_remove", { query: q }, () =>
      mockApi.pay_endpoint_remove(q),
    ),

  payEndpointSetEnabled: (q: {
    endpoint_id: string;
    enabled: boolean;
  }): Promise<PayEndpoint> =>
    call("pay_endpoint_set_enabled", { query: q }, () =>
      mockApi.pay_endpoint_set_enabled(q),
    ),

  payMatchList: (q: { book_id: string }): Promise<PayMatch[]> =>
    call("pay_match_list", { query: q }, () => mockApi.pay_match_list(q)),

  payDeliveryList: (q: { book_id: string }): Promise<PayDelivery[]> =>
    call("pay_delivery_list", { query: q }, () => mockApi.pay_delivery_list(q)),

  /** POST every due pending delivery now (signed in core's vault); returns
   * the deliveries acted on, updated. */
  payDeliverDue: (): Promise<PayDelivery[]> =>
    call("pay_deliver_due", {}, mockApi.pay_deliver_due),

  // -- classification packs: rules, never data. Every install goes through
  // verify → TOFU trust → Installer, so a signer change is a refusal and
  // versions only move forward. Nothing here touches the network: a pack is
  // a file the user already holds. --

  packList: (q: { book_id: string }): Promise<InstalledPackInfo[]> =>
    call("pack_list", { query: q }, () => mockApi.pack_list(q)),

  /** Preflight: verifies the signature and reports the signer's fingerprint
   * and what installing would do. Writes nothing — call it before
   * `packInstall` so the trust-on-first-use decision is an informed one. */
  packVerify: (q: PackDocumentRequest): Promise<PackVerification> =>
    call("pack_verify", { query: q }, () => mockApi.pack_verify(q)),

  /** Verify and install (or upgrade). Passing the publisher's key *is* the
   * trust decision; the pack id is pinned to it from then on. */
  packInstall: (q: PackDocumentRequest): Promise<PackInstallOutcome> =>
    call("pack_install", { query: q }, () => mockApi.pack_install(q)),

  /** Removes the pack's rules and registration. Categories it created stay
   * (local now) so history never breaks, and the signer pin is kept. */
  packUninstall: (q: { book_id: string; pack_id: string }): Promise<boolean> =>
    call("pack_uninstall", { query: q }, () => mockApi.pack_uninstall(q)),

  // -- pack sources: the fetch half. The same signed bytes over any
  // transport — a file, a synced folder or USB stick, a git remote, plain
  // HTTPS — because the signature is what is trusted, not the channel.
  //
  // There is no registry and no default source: the list starts empty, only
  // `packSourceAdd` ever writes to it, and until it has an entry nothing here
  // makes an outbound request. --

  /** Configured sources. Empty on a fresh install, and empty is the whole
   * privacy story: no source, no request. */
  packSourceList: (): Promise<PackSourceInfo[]> =>
    call("pack_source_list", {}, mockApi.pack_source_list),

  /** Add a source. Nothing is contacted by adding one — it is read when the
   * user asks. `uri` is `file:<path>`, `folder:<path>`, `git:<url>[#ref]` or
   * `https://<url>`; plain `http://` is refused. */
  packSourceAdd: (q: { name: string; uri: string }): Promise<PackSourceInfo> =>
    call("pack_source_add", { query: q }, () => mockApi.pack_source_add(q)),

  /** Forget a source. Installed packs are untouched — where a pack came from
   * is history, not a dependency. */
  packSourceRemove: (q: { name: string }): Promise<boolean> =>
    call("pack_source_remove", { query: q }, () => mockApi.pack_source_remove(q)),

  /** Read a source's catalogue and preflight every pack against the book.
   * **Installs nothing.** Each offer carries the catalogue's claim and, when
   * the bytes verify, the real facts — show the second, act on the second. */
  packSourceFetch: (q: { book_id: string; source: string }): Promise<PackOffer[]> =>
    call("pack_source_fetch", { query: q }, () => mockApi.pack_source_fetch(q)),

  /** Fetch one pack from a source and install it. Verification happens on the
   * bytes first. A signer this machine has never seen refuses unless
   * `accept_signer` carries the fingerprint the user was shown and checked —
   * and a pack id whose publisher key changed refuses regardless, because the
   * pin is not overridable from anywhere. */
  packSourceInstall: (q: {
    book_id: string;
    source: string;
    pack_id: string;
    document?: string;
    accept_signer?: string;
  }): Promise<PackInstallOutcome> =>
    call("pack_source_install", { query: q }, () => mockApi.pack_source_install(q)),

  /** Install the built-in seed packs into a book. **Opt-in, never automatic**
   * — which taxonomy a book starts from is the user's decision, and putting a
   * South African chart in front of someone in Portugal would be wrong.
   * Idempotent: a seed already at the same version is skipped, and categories
   * the user already has are adopted by (parent, name), never duplicated, so
   * re-running clobbers nothing. Returns only the seeds it actually wrote. */
  packInstallSeeds: (q: { book_id: string }): Promise<PackInstallOutcome[]> =>
    call("pack_install_seeds", { query: q }, () => mockApi.pack_install_seeds(q)),

  /** Compare this book's spend for one calendar month against every
   * installed benchmark pack — the read side of peer comparison, computed
   * here, transmitting nothing. `skipped` and `unmapped_keys` must be shown:
   * a pack in another currency is *not compared* (no FX is applied) and a
   * key nothing maps to is missing, and rendering either as a zero would be
   * a lie. Contribution, and the differential privacy it needs, are not
   * built (BENCHMARKS.md). */
  packBenchmark: (q: { book_id: string; period: string }): Promise<BenchmarkReport[]> =>
    call("pack_benchmark", { query: q }, () => mockApi.pack_benchmark(q)),

  settingsGet: (): Promise<Settings> =>
    call("settings_get", {}, mockApi.settings_get),

  settingsSet: (q: { settings: Settings }): Promise<Settings> =>
    call("settings_set", { query: q }, () => mockApi.settings_set(q)),

  // -- credential vault: write-only, metadata comes back, secrets never do --

  vaultList: (): Promise<VaultCredentialMeta[]> =>
    call("vault_list", {}, mockApi.vault_list),

  vaultSet: (q: VaultSetRequest): Promise<VaultCredentialMeta> =>
    call("vault_set", { query: q }, () => mockApi.vault_set(q)),

  vaultReplace: (q: VaultReplaceRequest): Promise<VaultCredentialMeta> =>
    call("vault_replace", { query: q }, () => mockApi.vault_replace(q)),

  vaultRevoke: (q: { name: string }): Promise<null> =>
    call("vault_revoke", { query: q }, () => mockApi.vault_revoke(q)),

  // -- device identity and pairing (docs/NODES.md).
  //
  // **NOTHING SYNCS YET.** Identity and pairing are real; there is no oplog
  // and no transport. Pairing two devices proves who they are and then does
  // nothing else, and every screen here must say so.
  //
  // The ceremony (invite/accept/confirm) plus init, rotate, reset and forget
  // are **local-only and exist only as IPC** — the HTTP routes of those names
  // refuse and say why: they create or destroy the private key, or they carry
  // a single-use claim token and need a human in front of the screen. Same
  // treatment vaultSet/vaultReplace already get. --

  /** This device's identity, or `null` if it has none yet. */
  deviceStatus: (): Promise<DeviceIdentity | null> =>
    call("device_status", {}, mockApi.device_status),

  /** Pinned peers, revoked tombstones included — hiding a tombstone would
   * hide the reason a re-pair is being refused. */
  deviceList: (): Promise<DevicePeer[]> =>
    call("device_list", {}, mockApi.device_list),

  deviceGet: (q: { device_id: string }): Promise<DevicePeer> =>
    call("device_get", { query: q }, () => mockApi.device_get(q)),

  /** Invites this device minted. Never carries a claim token. */
  deviceInviteList: (): Promise<PairingInviteMeta[]> =>
    call("device_invite_list", {}, mockApi.device_invite_list),

  deviceRotations: (): Promise<DeviceRotation[]> =>
    call("device_rotations", {}, mockApi.device_rotations),

  /** Revoke a peer: the pin becomes a tombstone so that key cannot silently
   * pair again. `deviceForget` is the deliberate way back. */
  deviceRevoke: (q: { device_id: string }): Promise<DevicePeer> =>
    call("device_revoke", { query: q }, () => mockApi.device_revoke(q)),

  /** Generate this device's keypair — the private half goes straight into the
   * write-only vault, the public half becomes the device id. Refused if an
   * identity already exists. */
  deviceInit: (q: { label?: string }): Promise<DeviceIdentity> =>
    call("device_init", { query: q }, () => mockApi.device_init(q)),

  /** Rotate this device's key, signed by the key it replaces. The device id
   * changes, so peers' pins of this device go stale — and nothing re-pairs
   * them, because there is no transport to do it over. */
  deviceRotate: (): Promise<DeviceRotateResult> =>
    call("device_rotate", {}, mockApi.device_rotate),

  /** Destroy this device's private key and identity. Peer pins are kept.
   * `confirm` is required — it cannot be undone and the key cannot be
   * recovered from a backup of the data folder. */
  deviceReset: (q: { confirm: boolean }): Promise<null> =>
    call("device_reset", { query: q }, () => mockApi.device_reset(q)),

  /** Drop a peer's pin entirely, tombstone included — the deliberate local
   * reset that lets a revoked key pair again. */
  deviceForget: (q: { device_id: string }): Promise<boolean> =>
    call("device_forget", { query: q }, () => mockApi.device_forget(q)),

  /** Mint a single-use pairing invite. The returned `blob` **is a credential**
   * until redeemed or expired: show it, let it be copied, then drop it. */
  devicePairInvite: (q: {
    label?: string;
    ttl_seconds?: number;
  }): Promise<PairingInvite> =>
    call("device_pair_invite", { query: q }, () => mockApi.device_pair_invite(q)),

  /** Withdraw an unredeemed invite — the answer to "that blob went to the
   * wrong window". */
  deviceInviteCancel: (q: { id: string }): Promise<boolean> =>
    call("device_invite_cancel", { query: q }, () =>
      mockApi.device_invite_cancel(q),
    ),

  /** Redeem an invite: pins the inviter and returns the acceptance blob to
   * carry back. The key-name check is **mandatory** — pass the key-name the
   * user typed, or `confirmed_by_human` only if this screen displayed it and
   * got an affirmative. Supplying neither is refused by the backend. */
  devicePairAccept: (q: PairRedeemRequest): Promise<PairingAcceptance> =>
    call("device_pair_accept", { query: q }, () => mockApi.device_pair_accept(q)),

  /** Redeem the acceptance blob: burns the single-use claim token and pins the
   * accepter. Same mandatory key-name check. */
  devicePairConfirm: (q: PairRedeemRequest): Promise<DevicePeer> =>
    call("device_pair_confirm", { query: q }, () =>
      mockApi.device_pair_confirm(q),
    ),
};

export type Api = typeof api;
