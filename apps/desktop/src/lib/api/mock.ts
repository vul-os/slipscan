/**
 * In-memory mock dataset used when the frontend is not running under Tauri
 * (plain `vite dev` in a browser) or when a core command is not wired yet.
 * Realistic ZAR data; all money in minor units (cents).
 */
import type {
  Account,
  AgedBucket,
  AgedReceivables,
  AgedReceivablesRow,
  BenchmarkCohort,
  BenchmarkReport,
  Book,
  BookKind,
  BookProfile,
  Budget,
  BudgetUpsert,
  BudgetWithSpend,
  Category,
  ClosePeriodCurrencyBalance,
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
  DocumentReviewRequest,
  FxCachedRate,
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
  InvoicePaymentStatus,
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
  NetWorthAccountBalance,
  NetWorthPoint,
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
  PackKind,
  PackOffer,
  PackSourceInfo,
  PackSourceKind,
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

const BOOK_ID = "0197a1b0-0000-7000-8000-000000000001";

// UUID-v7-ish deterministic ids for stable mock data.
let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `0197a1b0-${prefix}-7000-8000-${String(seq).padStart(12, "0")}`;
}

const book: Book = {
  id: BOOK_ID,
  name: "Personal",
  slug: "personal",
  kind: "personal",
  currency: "ZAR",
  // The demo book uses the South African region profile — that is demo
  // *data*, never a code default (regions are data, not code).
  region: "za",
  region_name: "South Africa",
  tax_report_name: "VAT201",
  file_path: "~/SlipScan/personal.slipscan.db",
  created_at: "2026-01-04T08:12:00Z",
};

/** A database file can hold several books; `book_create` appends here. */
const books: Book[] = [book];

/**
 * Phase 6.0 (Book profiles): the multi-location override, per book. `books`
 * carries `kind` itself (mutated directly by `book_set_kind`), but the
 * override has no home on the `Book` DTO, so it lives here — the same
 * separation `crate::profile::resolve` draws in core between the book row
 * and the resolved flag.
 */
const multiLocationOverrides = new Map<string, boolean | null>();

/**
 * Locations: branches, sites and warehouses (Phase 6.1). Empty by default —
 * a book with none behaves exactly as it always has, the same as core.
 */
const locations: Location[] = [];

/**
 * Purchasing (Phase 6.4): purchase orders, their line items, and goods
 * receipts. Empty by default, the same as `locations` — nothing pre-seeds
 * these since no screen calls them yet (ROADMAP.md 6.9). `poReceipts` is
 * append-only, mirroring core's own insert-only `po_receipts` table: nothing
 * here ever mutates or removes a row out of it.
 */
/** Chart-of-accounts mapping and per-book lock dates (mock-only state). */
const coaMap: CoaMapEntry[] = [];
const lockDates = new Map<string, string | null>();

/** Stock (Phase 6.3b). Append-only, exactly like core's table: nothing in
 * this file ever mutates or removes a movement, because the database would
 * refuse to. On-hand is summed on every read, never stored. */
const stockMovements: StockMovement[] = [];

/** Catalogue (Phase 6.3a). Empty by default, like contacts and purchasing. */
const productCategories: ProductCategory[] = [];
const products: Product[] = [];
const productVariants: ProductVariant[] = [];

/** Contacts (Phase 6.2). Empty by default, like locations and purchasing —
 * no screen calls these yet (ROADMAP.md 6.9). */
const contacts: Contact[] = [];

const purchaseOrders: PurchaseOrder[] = [];
const purchaseOrderItems: PurchaseOrderItem[] = [];
const poReceipts: PoReceipt[] = [];

/**
 * Sales orders & invoicing (Phase 6.5). Empty by default, like purchasing —
 * no screen calls these yet (ROADMAP.md 6.9). `invoices`, `invoiceItems` and
 * `invoicePayments` are append-only here on purpose, mirroring core's
 * insert-only tables: nothing in this file ever mutates or removes a row out
 * of them, because the database would refuse to.
 */
const salesOrders: SalesOrder[] = [];
const salesOrderItems: SalesOrderItem[] = [];
const invoices: Invoice[] = [];
const invoiceItems: InvoiceItem[] = [];
const invoicePayments: InvoicePayment[] = [];

/** Per `(book, series)` counter, mirroring core's `number_sequences`: gapless
 * and never reused. */
const numberSequences = new Map<string, number>();
function nextNumber(bookId: string, series: string): number {
  const key = `${bookId}/${series}`;
  const next = numberSequences.get(key) ?? 1;
  numberSequences.set(key, next + 1);
  return next;
}

/** Everything core marks ON DELETE RESTRICT against `product_variants`. */
function variantIsReferenced(variantId: string): boolean {
  return (
    stockMovements.some((m) => m.variant_id === variantId) ||
    salesOrderItems.some((i) => i.variant_id === variantId) ||
    invoiceItems.some((i) => i.variant_id === variantId) ||
    purchaseOrderItems.some((i) => i.variant_id === variantId)
  );
}

function requireProductCategory(id: string): ProductCategory {
  const c = productCategories.find((x) => x.id === id);
  if (!c) throw new Error(`no product category with id ${id}`);
  return c;
}

function requireProduct(id: string): Product {
  const p = products.find((x) => x.id === id);
  if (!p) throw new Error(`no product with id ${id}`);
  return p;
}

function requireVariant(id: string): ProductVariant {
  const v = productVariants.find((x) => x.id === id);
  if (!v) throw new Error(`no product variant with id ${id}`);
  return v;
}

/** One contacts table holds both sides of trade, so ordering from a
 * customer-only contact is a slip no foreign key can catch — core checks the
 * role explicitly and so does this. Unknown ids are left to the caller's own
 * lookup, exactly as the mock's other cross-entity checks are. */
function requireSupplierRole(contactId: string): void {
  const c = contacts.find((x) => x.id === contactId);
  if (c && c.role === "customer")
    throw new Error(
      "contact is not marked as a supplier (role customer) — set its role to supplier or both",
    );
}

function requireContact(contactId: string): Contact {
  const c = contacts.find((x) => x.id === contactId);
  if (!c) throw new Error(`no contact with id ${contactId}`);
  return c;
}

function requireOrder(orderId: string): SalesOrder {
  const order = salesOrders.find((o) => o.id === orderId);
  if (!order) throw new Error(`no sales order with id ${orderId}`);
  return order;
}

function requireInvoice(invoiceId: string): Invoice {
  const invoice = invoices.find((v) => v.id === invoiceId);
  if (!invoice) throw new Error(`no invoice with id ${invoiceId}`);
  return invoice;
}

/** Everything except adding lines to a draft is refused once an order has
 * moved on — the same guard core applies. */
function requireDraft(order: SalesOrder, verb: string): void {
  if (order.status !== "draft")
    throw new Error(`a ${order.status} order cannot be ${verb}`);
}

/** Derived from the lines every time, never stored — the same rule core keeps
 * for on-hand stock and for invoice paid/unpaid. */
function totalsOf(
  lines: { quantity: number; unit_price_minor: number; tax_rate_bps: number }[],
): SalesOrderTotals {
  let subtotal_minor = 0;
  let tax_minor = 0;
  for (const line of lines) {
    const net = line.quantity * line.unit_price_minor;
    subtotal_minor += net;
    tax_minor += Math.round((net * line.tax_rate_bps) / 10_000);
  }
  return { subtotal_minor, tax_minor, total_minor: subtotal_minor + tax_minor };
}

function invoiceTotalsFor(invoiceId: string): InvoiceTotals {
  const { subtotal_minor, tax_minor, total_minor } = totalsOf(
    invoiceItems.filter((i) => i.invoice_id === invoiceId),
  );
  const paid_minor = invoicePayments
    .filter((p) => p.invoice_id === invoiceId)
    .reduce((sum, p) => sum + p.amount_minor, 0);
  const due_minor = total_minor - paid_minor;
  const status: InvoicePaymentStatus =
    paid_minor <= 0 ? "unpaid" : due_minor > 0 ? "partly_paid" : "paid";
  return {
    subtotal_minor,
    tax_minor,
    total_minor,
    paid_minor,
    due_minor,
    status,
  };
}

const emptyBucket = (): AgedBucket => ({
  current_minor: 0,
  overdue_1_30_minor: 0,
  overdue_31_60_minor: 0,
  overdue_61_90_minor: 0,
  overdue_90_plus_minor: 0,
  total_minor: 0,
});

/** Whole days from `due` to `asOf`; negative means not yet due. */
function daysBetween(due: string, asOf: string): number {
  const ms = Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}

function bucketFor(bucket: AgedBucket, daysOverdue: number, amount: number) {
  if (daysOverdue <= 0) bucket.current_minor += amount;
  else if (daysOverdue <= 30) bucket.overdue_1_30_minor += amount;
  else if (daysOverdue <= 60) bucket.overdue_31_60_minor += amount;
  else if (daysOverdue <= 90) bucket.overdue_61_90_minor += amount;
  else bucket.overdue_90_plus_minor += amount;
  bucket.total_minor += amount;
}

function addBucket(into: AgedBucket, from: AgedBucket) {
  into.current_minor += from.current_minor;
  into.overdue_1_30_minor += from.overdue_1_30_minor;
  into.overdue_31_60_minor += from.overdue_31_60_minor;
  into.overdue_61_90_minor += from.overdue_61_90_minor;
  into.overdue_90_plus_minor += from.overdue_90_plus_minor;
  into.total_minor += from.total_minor;
}

/** `SUM(qty)` over a line's own receipts — mirrors
 * `repo::purchasing::received_qty_for_item`, never a stored counter. */
function receivedQtyForItem(itemId: string): number {
  return poReceipts
    .filter((r) => r.purchase_order_item_id === itemId)
    .reduce((sum, r) => sum + r.qty, 0);
}

/** Mirrors `CoreService::receipt_status_from`: `"none"` at zero or less,
 * `"complete"` at or beyond `qty_ordered`, `"partial"` in between. */
function receiptStatusFrom(received: number, ordered: number): PoReceiptStatus {
  if (received <= 0) return "none";
  if (received >= ordered) return "complete";
  return "partial";
}

function requirePo(poId: string): PurchaseOrder {
  const po = purchaseOrders.find((p) => p.id === poId);
  if (!po) throw new Error(`purchase order not found: ${poId}`);
  return po;
}

function requirePoItem(itemId: string): PurchaseOrderItem {
  const item = purchaseOrderItems.find((i) => i.id === itemId);
  if (!item) throw new Error(`purchase order line not found: ${itemId}`);
  return item;
}

/** Recompute and persist a PO's `subtotal_minor`/`total_minor` from its
 * current lines — mirrors `CoreService::recalc_po_totals_in_tx`. */
function recalcPoTotals(poId: string): void {
  const po = requirePo(poId);
  const subtotal = purchaseOrderItems
    .filter((i) => i.purchase_order_id === poId)
    .reduce((sum, i) => sum + i.total_minor, 0);
  po.subtotal_minor = subtotal;
  po.total_minor = subtotal + po.tax_minor;
  po.updated_at = new Date().toISOString();
}

function resolveProfile(b: Book): BookProfile {
  const locationCount = locations.filter((l) => l.book_id === b.id).length;
  const override = multiLocationOverrides.get(b.id) ?? null;
  const multiLocation = override ?? locationCount > 1;
  const isBusiness = b.kind === "business";
  return {
    kind: b.kind,
    location_count: locationCount,
    multi_location_override: override,
    multi_location: multiLocation,
    show_accounts: true,
    show_transactions: true,
    show_budgets: true,
    show_members: true,
    show_contacts: isBusiness,
    show_catalogue: isBusiness,
    show_purchasing: isBusiness,
    show_sales: isBusiness,
    show_locations: isBusiness && multiLocation,
  };
}

const regions: RegionInfo[] = [
  {
    id: "generic",
    display_name: "Generic (international)",
    country: null,
    default_currency: "USD",
    tax_report_name: "Tax summary",
  },
  {
    id: "za",
    display_name: "South Africa",
    country: "ZA",
    default_currency: "ZAR",
    tax_report_name: "VAT201",
  },
];

/** The dev book is a za book, so it carries the ZA VAT rate table. */
const vatRates: VatRate[] = [
  {
    id: id("vr01"),
    book_id: BOOK_ID,
    code: "STD",
    name: "Standard rate (15%)",
    rate_bps: 1_500,
    country: "ZA",
    is_active: true,
    created_at: "2026-01-04T08:12:00Z",
    updated_at: "2026-01-04T08:12:00Z",
  },
  {
    id: id("vr02"),
    book_id: BOOK_ID,
    code: "ZER",
    name: "Zero-rated (0%)",
    rate_bps: 0,
    country: "ZA",
    is_active: true,
    created_at: "2026-01-04T08:12:00Z",
    updated_at: "2026-01-04T08:12:00Z",
  },
  {
    id: id("vr03"),
    book_id: BOOK_ID,
    code: "EXE",
    name: "Exempt",
    rate_bps: 0,
    country: "ZA",
    is_active: true,
    created_at: "2026-01-04T08:12:00Z",
    updated_at: "2026-01-04T08:12:00Z",
  },
];

const accounts: Account[] = [
  {
    id: id("ac01"),
    book_id: BOOK_ID,
    name: "FNB Cheque",
    kind: "bank",
    institution: "FNB",
    currency: "ZAR",
    balance_minor: 1_824_540,
    created_at: "2026-01-04T08:14:00Z",
  },
  {
    id: id("ac02"),
    book_id: BOOK_ID,
    name: "TymeBank GoalSave",
    kind: "bank",
    institution: "TymeBank",
    currency: "ZAR",
    balance_minor: 4_550_000,
    created_at: "2026-01-04T08:15:00Z",
  },
  {
    id: id("ac03"),
    book_id: BOOK_ID,
    name: "Discovery Credit Card",
    kind: "card",
    institution: "Discovery Bank",
    currency: "ZAR",
    balance_minor: -732_118,
    created_at: "2026-01-04T08:16:00Z",
  },
  {
    id: id("ac04"),
    book_id: BOOK_ID,
    name: "Cash",
    kind: "cash",
    institution: null,
    currency: "ZAR",
    balance_minor: 42_000,
    created_at: "2026-01-04T08:16:30Z",
  },
];

// ---------------------------------------------------------------------------
// net worth — a few months of plausible history, in the same order as
// `accounts`, so the Dashboard chart has something to draw in mock mode.
// Real history comes from `networth_backfill` reconstructing the actual
// transaction ledger; this is fabricated for the mock fallback only, and
// its last row matches `accounts`' own current balances so the chart's most
// recent point agrees with the stat tiles above it.
// ---------------------------------------------------------------------------

const networthHistory: { date: string; totals: number[] }[] = [
  { date: "2026-02-28", totals: [1_180_000, 4_120_000, -410_000, 35_000] },
  { date: "2026-03-31", totals: [1_340_000, 4_220_000, -520_000, 38_000] },
  { date: "2026-04-30", totals: [1_510_000, 4_310_000, -610_000, 39_500] },
  { date: "2026-05-31", totals: [1_620_000, 4_400_000, -655_000, 40_000] },
  { date: "2026-06-30", totals: [1_705_000, 4_470_000, -700_000, 41_000] },
  { date: "2026-07-31", totals: [1_780_000, 4_510_000, -725_000, 41_500] },
  { date: "2026-08-03", totals: [1_824_540, 4_550_000, -732_118, 42_000] },
];

function networthPoints(): NetWorthPoint[] {
  return networthHistory.map(({ date, totals }) => {
    const by_account: NetWorthAccountBalance[] = accounts.map((a, i) => ({
      account_id: a.id,
      currency: a.currency,
      balance_minor: totals[i],
    }));
    return {
      as_of_date: date,
      by_account,
      currency: book.currency,
      total_minor: totals.reduce((sum, v) => sum + v, 0),
      unconverted: [],
    };
  });
}

const cat = (name: string, kind: Category["kind"], icon: string): Category => ({
  id: id("cat0"),
  book_id: BOOK_ID,
  parent_id: null,
  name,
  kind,
  icon,
  created_at: "2026-01-04T08:20:00Z",
});

const categories: Category[] = [
  cat("Groceries", "expense", "🛒"),
  cat("Eating out", "expense", "☕"),
  cat("Transport & fuel", "expense", "⛽"),
  cat("Utilities", "expense", "💡"),
  cat("Subscriptions", "expense", "📺"),
  cat("Health", "expense", "🩺"),
  cat("Household", "expense", "🏠"),
  cat("Salary", "income", "💼"),
  cat("Rental income", "income", "🏘️"),
  cat("Interest", "income", "🏦"),
  cat("Transfers", "transfer", "🔁"),
];

const catId = (name: string): string =>
  categories.find((c) => c.name === name)!.id;

const acctId = (name: string): string =>
  accounts.find((a) => a.name === name)!.id;

// ---------------------------------------------------------------------------
// household members — a small two-person demo household (ARCHITECTURE.md
// "Household members & per-person attribution"). The FNB cheque account is
// the everyday account both salaries land in, with Alex as its default
// attribution; Sam's default is the credit card they carry. TymeBank and
// Cash stay joint (no default owner), exactly the shape core supports.
//
// A member has ONE default account, so the income that does not follow it —
// Sam's salary into the shared cheque account — carries an explicit
// `member` override on its seed, which is the same override path the Uber
// trip below uses in the other direction.
// ---------------------------------------------------------------------------

interface MemberSeed {
  label: string;
  initial: string;
  colour: string;
  account: string | null;
}

const memberSeeds: MemberSeed[] = [
  { label: "Alex", initial: "A", colour: "#6f9200", account: "FNB Cheque" },
  { label: "Sam", initial: "S", colour: "#6a6fbf", account: "Discovery Credit Card" },
];

let members: Member[] = memberSeeds.map((m) => ({
  id: id("mb00"),
  book_id: BOOK_ID,
  label: m.label,
  initial: m.initial,
  colour: m.colour,
  default_account_id: m.account ? acctId(m.account) : null,
  created_at: "2026-01-05T08:00:00Z",
  updated_at: "2026-01-05T08:00:00Z",
}));

const memberId = (label: string): string =>
  members.find((m) => m.label === label)!.id;

/** account id → the member who defaults transactions on it to themselves. */
function accountOwnerId(accountId: string): string | null {
  return members.find((m) => m.default_account_id === accountId)?.id ?? null;
}

interface TxSeed {
  d: string;
  desc: string;
  merchant: string | null;
  amount: number; // rand cents, signed
  cat: string | null;
  acct: string;
  source: Transaction["source"];
  /** Attribution override: a member label, `null` to force unattributed, or
   * omitted to default to the account's owning member (core's own rule). */
  member?: string | null;
}

// Dates run backwards from the demo "today" (2026-07-16, the capture clock
// in scripts/screenshot.mjs). Nothing may be dated after it: a seed in the
// future simply never appears on a month-scoped screen.
//
// The household is paid on the 15th, so July's income has already landed by
// the demo's today — which is what makes the per-member contribution and
// settle-up reports show real figures for the month on screen rather than a
// month that has not been paid yet.
const txSeeds: TxSeed[] = [
  { d: "2026-07-16", desc: "WOOLWORTHS 178 CLAREMONT", merchant: "Woolworths", amount: -84_235, cat: "Groceries", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-07-16", desc: "UBER *TRIP HELP.UBER.COM", merchant: "Uber", amount: -11_650, cat: "Transport & fuel", acct: "Discovery Credit Card", source: "scraper", member: "Alex" },
  { d: "2026-07-15", desc: "CHECKERS SIXTY60 RONDEBOSCH", merchant: "Checkers Sixty60", amount: -63_780, cat: "Groceries", acct: "Discovery Credit Card", source: "scraper" },
  { d: "2026-07-15", desc: "SALARY - MOLEFE CONSULTING", merchant: null, amount: 5_450_000, cat: "Salary", acct: "FNB Cheque", source: "scraper" },
  // Sam is paid into the same everyday account, so this one carries the
  // explicit attribution rather than inheriting the account's default.
  { d: "2026-07-15", desc: "SALARY - THELA DESIGN STUDIO", merchant: null, amount: 2_860_000, cat: "Salary", acct: "FNB Cheque", source: "scraper", member: "Sam" },
  { d: "2026-07-15", desc: "VIDA E CAFFE KLOOF ST", merchant: "Vida e Caffè", amount: -6_850, cat: "Eating out", acct: "Discovery Credit Card", source: "scraper" },
  { d: "2026-07-14", desc: "ESKOM PREPAID ELEC", merchant: "Eskom", amount: -95_000, cat: "Utilities", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-07-14", desc: "PNP FAMILY KENILWORTH", merchant: "Pick n Pay", amount: -41_290, cat: "Groceries", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-07-13", desc: "NETFLIX.COM AMSTERDAM", merchant: "Netflix", amount: -19_900, cat: "Subscriptions", acct: "Discovery Credit Card", source: "scraper" },
  { d: "2026-07-12", desc: "ENGEN WINELANDS N1", merchant: "Engen", amount: -92_040, cat: "Transport & fuel", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-07-11", desc: "TAKEALOT.COM CPT", merchant: "Takealot", amount: -124_999, cat: null, acct: "Discovery Credit Card", source: "scraper" },
  { d: "2026-07-10", desc: "MTN AIRTIME PURCHASE", merchant: "MTN", amount: -29_900, cat: "Utilities", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-07-10", desc: "OBS SUPERETTE CASH", merchant: null, amount: -18_500, cat: null, acct: "Cash", source: "manual" },
  { d: "2026-07-08", desc: "DISCOVERY HEALTH CONTRIB", merchant: "Discovery Health", amount: -285_600, cat: "Health", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-07-07", desc: "CLICKS PHARMACY GARDENS", merchant: "Clicks", amount: -34_265, cat: "Health", acct: "Discovery Credit Card", source: "scraper" },
  { d: "2026-07-06", desc: "SPOTIFY P24BB1D6C3", merchant: "Spotify", amount: -8_499, cat: "Subscriptions", acct: "Discovery Credit Card", source: "scraper" },
  { d: "2026-07-05", desc: "TRANSFER TO GOALSAVE", merchant: null, amount: -500_000, cat: "Transfers", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-07-04", desc: "YOCO *HONEST CHOCOLATE", merchant: "Honest Chocolate", amount: -9_800, cat: "Eating out", acct: "Discovery Credit Card", source: "scraper" },
  { d: "2026-07-03", desc: "BUILDERS WAREHOUSE TOKAI", merchant: "Builders", amount: -78_635, cat: "Household", acct: "Discovery Credit Card", source: "scraper" },
  { d: "2026-07-02", desc: "INTEREST CAPITALISED", merchant: null, amount: 12_384, cat: "Interest", acct: "TymeBank GoalSave", source: "scraper" },
  { d: "2026-07-01", desc: "UBER EATS CAPE TOWN", merchant: "Uber Eats", amount: -28_450, cat: "Eating out", acct: "Discovery Credit Card", source: "scraper" },
  // The garden-flat tenant's monthly EFT. The reference is the whole token
  // `RENT-12B`, which is the watch code the Payments screen matches on.
  { d: "2026-07-01", desc: "EFT CREDIT RENT-12B COETZEE", merchant: null, amount: 750_000, cat: "Rental income", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-06-30", desc: "CITY OF CT MUNICIPAL", merchant: "City of Cape Town", amount: -164_420, cat: "Utilities", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-06-28", desc: "WOOLWORTHS 178 CLAREMONT", merchant: "Woolworths", amount: -112_060, cat: "Groceries", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-06-27", desc: "SHELL ULTRA CITY N2", merchant: "Shell", amount: -85_500, cat: "Transport & fuel", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-06-24", desc: "PNP FAMILY KENILWORTH", merchant: "Pick n Pay", amount: -58_420, cat: "Groceries", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-06-23", desc: "KAUAI KLOOF NEK", merchant: "Kauai", amount: -14_900, cat: "Eating out", acct: "Discovery Credit Card", source: "scraper" },
  { d: "2026-06-15", desc: "SALARY - MOLEFE CONSULTING", merchant: null, amount: 5_450_000, cat: "Salary", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-06-15", desc: "SALARY - THELA DESIGN STUDIO", merchant: null, amount: 2_860_000, cat: "Salary", acct: "FNB Cheque", source: "scraper", member: "Sam" },
  // June's rent predates the RENT-12B watch (created 2026-06-28), so it is
  // correctly unmatched — a watch only sees what arrives after it exists.
  { d: "2026-06-01", desc: "EFT CREDIT RENT-12B COETZEE", merchant: null, amount: 750_000, cat: "Rental income", acct: "FNB Cheque", source: "scraper" },
];

const transactions: Transaction[] = txSeeds.map((s, i) => ({
  id: id("tx00"),
  book_id: BOOK_ID,
  account_id: acctId(s.acct),
  posted_at: `${s.d}T00:00:00Z`,
  description: s.desc,
  merchant: s.merchant,
  amount_minor: s.amount,
  currency: "ZAR",
  category_id: s.cat ? catId(s.cat) : null,
  source: s.source,
  provider_txn_id: s.source === "scraper" ? `prov-${1000 + i}` : null,
  hash: `h${(2000 + i).toString(16)}`,
  // Default attribution follows the account's owning member (core's own
  // rule); a seed may explicitly override it or force unattributed.
  attributed_member_id:
    s.member !== undefined
      ? s.member === null
        ? null
        : memberId(s.member)
      : accountOwnerId(acctId(s.acct)),
  created_at: `${s.d}T04:00:00Z`,
}));

/** A seeded transaction by (date, description). Positional references break
 * silently the moment a seed is inserted above them, and one already had:
 * the payments watch below used to point at whichever row happened to sit
 * at index 17. */
const txOn = (date: string, description: string): Transaction => {
  const found = transactions.find(
    (t) => t.posted_at.startsWith(date) && t.description === description,
  );
  if (!found) throw new Error(`no seeded transaction "${description}" on ${date}`);
  return found;
};

// One split example: the big Woolworths shop, 60/40 between Alex and Sam —
// the shares must sum to exactly the transaction's absolute amount, just
// like core's `transaction_split_set` invariant.
const woolworthsShop = txOn("2026-07-16", "WOOLWORTHS 178 CLAREMONT");
let transactionSplits: TransactionSplit[] = [
  {
    id: id("ts00"),
    transaction_id: woolworthsShop.id,
    member_id: memberId("Alex"),
    share_minor: 50_541,
    created_at: "2026-07-16T09:00:00Z",
  },
  {
    id: id("ts00"),
    transaction_id: woolworthsShop.id,
    member_id: memberId("Sam"),
    share_minor: 33_694,
    created_at: "2026-07-16T09:00:00Z",
  },
];

interface DocSeed {
  merchant: string;
  d: string;
  total: number;
  status: Document["status"];
  confidence: number;
  file: string;
  /** [description, quantity, unit_minor, category name | null][] */
  items?: Array<[string, number, number, string | null]>;
  /** Slip-level discount (line totals − discount = total). */
  discount?: number;
}

const docSeeds: DocSeed[] = [
  { merchant: "Woolworths", d: "2026-07-16", total: 84_235, status: "pending", confidence: 0, file: "IMG_2841.heic" },
  {
    merchant: "Checkers Sixty60", d: "2026-07-15", total: 63_780, status: "extracted", confidence: 0.97, file: "sixty60-slip.pdf",
    discount: 911,
    items: [
      ["Full Cream Milk 2L", 2, 3_499, "Groceries"],
      ["Free Range Eggs 18s", 1, 8_999, "Groceries"],
      ["Chicken Breast Fillets 1kg", 2, 11_999, "Groceries"],
      ["Basmati Rice 2kg", 1, 7_499, "Groceries"],
      ["Blueberries 250g", 2, 4_599, "Groceries"],
      ["Sourdough Loaf", 1, 4_499, "Groceries"],
      ["Sixty60 Delivery", 1, 3_500, null],
    ],
  },
  {
    merchant: "Engen", d: "2026-07-12", total: 92_040, status: "extracted", confidence: 0.93, file: "IMG_2833.heic",
    items: [
      ["Unleaded 95 · 41.6L", 1, 89_540, "Transport & fuel"],
      ["Engine Oil Top-up 500ml", 1, 2_500, "Transport & fuel"],
    ],
  },
  {
    merchant: "Takealot", d: "2026-07-11", total: 124_999, status: "reviewed", confidence: 0.99, file: "takealot-invoice-8841.pdf",
    items: [
      ["Logitech MX Keys Mini", 1, 99_999, "Household"],
      ["Desk Mat XL Charcoal", 1, 25_000, "Household"],
    ],
  },
  {
    merchant: "Eskom", d: "2026-07-14", total: 95_000, status: "reviewed", confidence: 0.99, file: "eskom-prepaid.pdf",
    items: [["Prepaid Electricity Token", 1, 95_000, "Utilities"]],
  },
  {
    merchant: "Clicks", d: "2026-07-07", total: 34_265, status: "reviewed", confidence: 0.96, file: "IMG_2819.heic",
    items: [
      ["Panado 24s", 1, 5_499, "Health"],
      ["Vitamin D3 60s", 1, 8_999, "Health"],
      ["SPF50 Sunscreen 200ml", 1, 12_999, "Health"],
      ["Lip Balm", 2, 3_384, "Health"],
    ],
  },
  {
    merchant: "Builders", d: "2026-07-03", total: 78_635, status: "extracted", confidence: 0.88, file: "IMG_2807.heic",
    items: [
      ["Wall Plugs 100pk", 1, 3_995, "Household"],
      ["Cordless Drill Bit Set", 1, 34_900, "Household"],
      ["Interior PVA 5L White", 1, 28_990, "Household"],
      ["Sandpaper Assorted", 2, 5_375, "Household"],
    ],
  },
  {
    merchant: "Pick n Pay", d: "2026-06-24", total: 58_420, status: "reviewed", confidence: 0.98, file: "IMG_2769.heic",
    discount: 1_372,
    items: [
      ["Chicken Braai Pack", 1, 15_999, "Groceries"],
      ["Charcoal 4kg", 1, 8_999, "Groceries"],
      ["Rolls 12s", 2, 2_599, "Groceries"],
      ["Salad Mix 300g", 1, 4_599, "Groceries"],
      ["Craft Lemonade 6pk", 1, 7_999, "Groceries"],
      ["Boerewors 1kg", 1, 13_999, "Groceries"],
      ["Firelighters", 1, 2_999, "Groceries"],
    ],
  },
  { merchant: "", d: "2026-07-09", total: 0, status: "failed", confidence: 0, file: "IMG_2825.heic" },
];

const documents: Document[] = docSeeds.map((s) => {
  const hasExtraction = s.status === "extracted" || s.status === "reviewed";
  return {
    id: id("dc00"),
    book_id: BOOK_ID,
    kind: s.file.includes("invoice") ? "invoice" : "receipt",
    status: s.status,
    file_name: s.file,
    mime_type: s.file.endsWith(".pdf") ? "application/pdf" : "image/heic",
    extraction: hasExtraction
      ? {
          schema: "slip-v2",
          merchant: s.merchant,
          issued_at: `${s.d}T00:00:00Z`,
          currency: "ZAR",
          total_minor: s.total,
          vat_minor: Math.round((s.total * 15) / 115),
          discount_minor: s.discount ?? 0,
          line_items: (s.items ?? []).map(([description, quantity, unit, catName]) => ({
            description,
            quantity,
            unit_minor: unit,
            total_minor: quantity * unit,
            category_id: catName ? catId(catName) : null,
            discount_minor: 0,
          })),
          confidence: s.confidence,
        }
      : null,
    merchant: hasExtraction ? s.merchant : null,
    issued_at: hasExtraction ? `${s.d}T00:00:00Z` : null,
    total_minor: hasExtraction ? s.total : null,
    currency: "ZAR",
    created_at: `${s.d}T09:00:00Z`,
  };
});

const budgets: Budget[] = (
  [
    ["Groceries", 400_000],
    ["Eating out", 120_000],
    ["Transport & fuel", 250_000],
    ["Utilities", 300_000],
    ["Subscriptions", 40_000],
    ["Health", 320_000],
    ["Household", 100_000],
  ] as Array<[string, number]>
).map(([name, amount]) => ({
  id: id("bg00"),
  book_id: BOOK_ID,
  category_id: catId(name),
  month: "2026-07",
  amount_minor: amount,
  currency: "ZAR",
  rollover: name === "Household",
  created_at: "2026-06-30T18:00:00Z",
}));

const ledgerAccounts: LedgerAccount[] = (
  [
    ["1000", "Bank — FNB Cheque", "asset"],
    ["1010", "Bank — TymeBank GoalSave", "asset"],
    ["1100", "Cash on hand", "asset"],
    ["2000", "Credit card — Discovery", "liability"],
    ["2200", "VAT control", "liability"],
    ["3000", "Opening balance equity", "equity"],
    ["4000", "Salary income", "income"],
    ["4100", "Interest income", "income"],
    ["4200", "Rental income", "income"],
    ["5000", "Groceries", "expense"],
    ["5100", "Transport & fuel", "expense"],
    ["5200", "Utilities", "expense"],
    ["5300", "Health", "expense"],
    ["5900", "General expenses", "expense"],
  ] as Array<[string, string, LedgerAccount["type"]]>
).map(([code, name, type]) => ({
  id: id("la00"),
  book_id: BOOK_ID,
  code,
  name,
  type,
  vat_rate_bp: type === "expense" ? 1500 : null,
  archived: false,
}));

const la = (code: string): LedgerAccount =>
  ledgerAccounts.find((a) => a.code === code)!;

function entry(
  date: string,
  memo: string,
  lines: Array<[string, number, number]>,
): JournalEntry {
  const eid = id("je00");
  return {
    id: eid,
    book_id: BOOK_ID,
    entry_date: date,
    memo,
    lines: lines.map(([code, debit, credit]) => ({
      id: id("jl00"),
      entry_id: eid,
      ledger_account_id: la(code).id,
      ledger_account_name: la(code).name,
      debit_minor: debit,
      credit_minor: credit,
    })),
    source_document_id: null,
    created_at: `${date}T10:00:00Z`,
  };
}

const journalEntries: JournalEntry[] = [
  entry("2026-07-14", "Eskom prepaid electricity", [
    ["5200", 82_609, 0],
    ["2200", 12_391, 0],
    ["1000", 0, 95_000],
  ]),
  entry("2026-07-12", "Fuel — Engen Winelands", [
    ["5100", 80_035, 0],
    ["2200", 12_005, 0],
    ["1000", 0, 92_040],
  ]),
  // Both salaries land in the same cheque account, so one entry carries the
  // pair; the member dimension is attribution metadata on the transactions
  // and never reaches a debit or a credit.
  entry("2026-07-15", "July salaries", [
    ["1000", 8_310_000, 0],
    ["4000", 0, 8_310_000],
  ]),
  entry("2026-07-01", "Garden flat rent — July", [
    ["1000", 750_000, 0],
    ["4200", 0, 750_000],
  ]),
  entry("2026-06-15", "June salaries", [
    ["1000", 8_310_000, 0],
    ["4000", 0, 8_310_000],
  ]),
];

let reconSuggestions: ReconSuggestion[] = documents
  .filter((d) => d.extraction !== null)
  .slice(0, 5)
  .map((d, i) => {
    const tx = transactions.find(
      (t) => t.merchant && d.merchant && t.merchant === d.merchant,
    );
    return {
      id: id("rc00"),
      book_id: BOOK_ID,
      transaction_id: tx?.id ?? transactions[i]!.id,
      document_id: d.id,
      score: [0.99, 0.97, 0.93, 0.86, 0.81][i]!,
      status: (i < 2 ? "confirmed" : "suggested") as ReconSuggestion["status"],
      transaction_description: tx?.description ?? transactions[i]!.description,
      transaction_amount_minor: tx?.amount_minor ?? transactions[i]!.amount_minor,
      document_merchant: d.merchant ?? d.file_name,
      document_total_minor: d.total_minor ?? 0,
      currency: "ZAR",
      created_at: "2026-07-16T06:00:00Z",
    };
  });

// ---------------------------------------------------------------------------
// Payments mock — watch codes, endpoints, matches, deliveries. Mirrors the
// core contract: flat watch list, vault-only endpoint secrets (generated
// here, returned once, never stored), backoff-retried deliveries.
// ---------------------------------------------------------------------------

const payWatches: PayWatch[] = [
  {
    id: id("pw00"),
    book_id: BOOK_ID,
    code: "RENT-12B",
    label: "Garden flat rent",
    expected_amount_minor: 750_000,
    expected_currency: "ZAR",
    enabled: true,
    created_at: "2026-06-28T07:00:00Z",
  },
  {
    id: id("pw00"),
    book_id: BOOK_ID,
    code: "INV-2041",
    label: "Deck repair invoice",
    expected_amount_minor: 450_000,
    expected_currency: "ZAR",
    enabled: true,
    created_at: "2026-07-10T15:30:00Z",
  },
];

const payEndpoints: PayEndpoint[] = [
  {
    id: id("pe00"),
    book_id: BOOK_ID,
    label: "Shop backend",
    url: "https://shop.example.co.za/hooks/slipscan",
    enabled: true,
    created_at: "2026-06-28T07:05:00Z",
  },
  {
    id: id("pe00"),
    book_id: BOOK_ID,
    label: "Staging receiver",
    url: "http://192.168.1.40:8787/webhook",
    enabled: true,
    created_at: "2026-07-01T18:00:00Z",
  },
];

// The RENT-12B watch matched July's rent EFT — the one inbound credit whose
// description actually carries that reference, at exactly the amount the
// watch expects.
const julyRent = txOn("2026-07-01", "EFT CREDIT RENT-12B COETZEE");
const payMatches: PayMatch[] = [
  {
    id: id("pm00"),
    book_id: BOOK_ID,
    watch_id: payWatches[0]!.id,
    transaction_id: julyRent.id,
    matched_at: "2026-07-01T04:10:00Z",
  },
];

const payDeliveries: PayDelivery[] = [
  {
    id: id("pd00"),
    book_id: BOOK_ID,
    endpoint_id: payEndpoints[0]!.id,
    match_id: payMatches[0]!.id,
    payload: JSON.stringify({
      event: "payment.matched",
      reference: "RENT-12B",
      watch_label: "Garden flat rent",
      amount_minor: 750_000,
      currency: "ZAR",
      posted_date: "2026-07-01",
      matched_at: "2026-07-01T04:10:00Z",
    }),
    state: "delivered",
    attempts: 1,
    next_attempt_at: "2026-07-01T04:10:00Z",
    last_status: 200,
    last_error: null,
    created_at: "2026-07-01T04:10:00Z",
    updated_at: "2026-07-01T04:11:00Z",
  },
  {
    id: id("pd00"),
    book_id: BOOK_ID,
    endpoint_id: payEndpoints[1]!.id,
    match_id: payMatches[0]!.id,
    payload: JSON.stringify({
      event: "payment.matched",
      reference: "RENT-12B",
      watch_label: "Garden flat rent",
      amount_minor: 750_000,
      currency: "ZAR",
      posted_date: "2026-07-01",
      matched_at: "2026-07-01T04:10:00Z",
    }),
    state: "pending",
    attempts: 3,
    next_attempt_at: "2026-07-01T06:41:00Z", // past — due for "Deliver now"
    last_status: 503,
    last_error: "HTTP 503",
    created_at: "2026-07-01T04:10:00Z",
    updated_at: "2026-07-01T04:41:00Z",
  },
];

/** Mock stand-in for core's 32-random-bytes-hex signing secret. */
function mockPaySecret(): string {
  let s = "";
  for (let i = 0; i < 64; i += 1) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

/** Mirrors core's webhook URL validation posture (never echoes credentials). */
function mockValidateWebhookUrl(raw: string): string {
  const url = raw.trim();
  // Like core's normalize_webhook_url: input carrying '@' may embed
  // credentials (user:pass@host) and is NEVER echoed into an error message,
  // whichever check fires; the credential check runs before the generic one.
  const shown = url.includes("@")
    ? "<url withheld: it contains '@' and may embed credentials>"
    : `"${url}"`;
  const invalid = () =>
    new Error(
      `invalid webhook URL ${shown} (expected http(s)://host[:port][/path])`,
    );
  const sep = url.indexOf("://");
  const rest = sep >= 0 ? url.slice(sep + 3) : "";
  if ((rest.split(/[/?#]/)[0] ?? "").includes("@"))
    throw new Error(
      "webhook URL must not embed credentials — deliveries are authenticated by the HMAC signature",
    );
  if (!/^https?:\/\/\S+$/i.test(url)) throw invalid();
  return url;
}

/** Mock data folder — the platform default until "moved". */
const DEFAULT_DATA_DIR = "~/Library/Application Support/org.vulos.slipscan";
const dataState: DataStatus = {
  data_dir: DEFAULT_DATA_DIR,
  db_path: `${DEFAULT_DATA_DIR}/slipscan.db`,
  documents_dir: `${DEFAULT_DATA_DIR}/documents`,
  pointer_path: `${DEFAULT_DATA_DIR}/data_dir.json`,
  pointer_set: false,
  is_default_location: true,
  db_exists: true,
  db_size_bytes: 2_184_192,
  document_count: documents.length,
  documents_size_bytes: 14_386_002,
};

/** Mirrors the desktop shell's trivial path-component cloud detection. */
function mockCloudHint(folder: string): string | undefined {
  if (folder.includes("Mobile Documents") || folder.includes("com~apple~CloudDocs"))
    return "iCloud Drive";
  for (const vendor of [
    "Dropbox",
    "Google Drive",
    "OneDrive",
    "Nextcloud",
    "Syncthing",
    "Proton Drive",
    "pCloud",
  ]) {
    if (folder.includes(vendor)) return vendor;
  }
  return undefined;
}

/** FX starts unconfigured — opt-in, exactly like the real core service. */
const fxState: FxStatus = {
  configured: false,
  base_url: null,
  cached_rates: [],
};

let settings: Settings = {
  theme: "system",
  llm: {
    provider: "none",
    endpoint: null,
    model: null,
    keychain_entry: null,
  },
  mailbox: {
    enabled: false,
    host: null,
    port: 993,
    username: null,
    keychain_entry: null,
    folder: "INBOX",
  },
  scrapers: [
    {
      id: id("sc00"),
      adapter: "za-fnb",
      institution: "FNB",
      status: "connected",
      last_sync: "2026-07-17T05:30:00Z",
      keychain_entry: "slipscan/scraper/za-fnb",
    },
    {
      id: id("sc00"),
      adapter: "za-discovery",
      institution: "Discovery Bank",
      status: "needs_attention",
      last_sync: "2026-07-14T05:31:00Z",
      keychain_entry: "slipscan/scraper/za-discovery",
    },
  ],
  packs: [
    {
      id: id("pk00"),
      name: "za-retail-base",
      version: "1.4.0",
      publisher: "slipscan-community",
      signer_fingerprint: "ed25519:7f3a…c91d",
      installed_at: "2026-05-11T14:03:00Z",
    },
  ],
};

// Vault mock: metadata only — the secret is hashed into a fingerprint and
// discarded, mirroring the write-only contract of the real vault.
const vaultEntries: VaultCredentialMeta[] = [
  {
    name: "imap.password.fastmail",
    label: "Fastmail app password",
    version: 2,
    fingerprint: "9f31c2ab",
    created_at: "2026-05-02T09:12:00Z",
    rotated_at: "2026-06-20T07:45:00Z",
    last_used_at: "2026-07-17T05:30:00Z",
  },
  {
    name: "scraper.za-fnb",
    label: "FNB scraper login",
    version: 1,
    fingerprint: "4be80d17",
    created_at: "2026-04-11T16:03:00Z",
    rotated_at: null,
    last_used_at: "2026-07-17T05:31:00Z",
  },
];

/** Non-cryptographic stand-in for the real fingerprint (mock only). */
function mockFingerprint(name: string, secret: string): string {
  let h = 0x811c9dc5;
  for (const c of `${name}${secret}`) {
    h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// device identity and pairing.
//
// **No signature is generated or verified here, and nothing syncs** — the
// second half of that sentence is true of the real thing too (docs/NODES.md:
// identity and pairing only, no oplog, no transport). What the mock models
// faithfully is the state machine the screen has to render and every refusal
// it has to be able to show:
//
// * pairing with yourself is refused, which is why the browser harness cannot
//   run the ceremony end to end on its own (see `mockForeignInvite`);
// * a claim token is single-use and burnt on redemption, so a replayed
//   acceptance is refused;
// * an expired invite is refused;
// * the key-name comparison is MANDATORY: a redeem with neither a typed
//   key-name nor an explicit human confirmation is refused outright rather
//   than quietly downgraded, exactly as the Tauri command does;
// * a mistyped key-name and the wrong device are different answers;
// * a revoked peer is a tombstone that refuses re-pairing until it is
//   deliberately forgotten.
// ---------------------------------------------------------------------------

/** Deterministic 64-char lowercase hex, standing in for a public key. */
function mockPublicKey(seed: string): string {
  let h = 0x2545f491;
  let out = "";
  for (let i = 0; i < 8; i++) {
    for (const c of seed + ":" + i) {
      h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

/** Word list for the mock's key-names. The real ones come from kotva-core:
 * eight data words carrying 80 bits of a BLAKE3 digest plus a checksum word.
 * These are the right *shape* — nine short words joined by `-` — and nothing
 * more; the mock cannot and must not claim to check a checksum. */
const MOCK_KEYNAME_WORDS = [
  "amber", "anchor", "basalt", "brisk", "cedar", "cinder", "dune", "ember",
  "flint", "grove", "harbor", "indigo", "jasper", "kelp", "lumen", "marble",
  "nimbus", "onyx", "pewter", "quartz", "rowan", "slate", "tundra", "umber",
  "vellum", "willow", "xenon", "yarrow", "zephyr", "orchid", "pebble", "reef",
];

/** Nine words, derived from the key. Same input, same name — the only
 * property the UI depends on. */
function mockKeyname(publicKey: string): string {
  const words: string[] = [];
  for (let i = 0; i < 9; i++) {
    const chunk = parseInt(publicKey.slice(i * 4, i * 4 + 4) || "0", 16);
    words.push(MOCK_KEYNAME_WORDS[chunk % MOCK_KEYNAME_WORDS.length]!);
  }
  return words.join("-");
}

/** Normalize a typed key-name the way core does: lowercase, trimmed, and
 * tolerant of spaces where a user typed words instead of hyphens. */
function normalizeKeyname(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
    .join("-");
}

/** Does this look like a key-name at all? The real gate is the checksum word;
 * the mock can only check the shape, and says so rather than pretending. */
function looksLikeKeyname(name: string): boolean {
  return name.split("-").length === 9;
}

interface MockBlobPayload {
  typ: "slipscan.pair.invite" | "slipscan.pair.accept";
  device_id: string;
  label: string;
  claim: string;
  expires_at?: string;
  for_device_id?: string;
}

const MOCK_BLOB_PREFIX = "ss-pair1.";

const encodeMockBlob = (payload: MockBlobPayload): string =>
  MOCK_BLOB_PREFIX + btoa(JSON.stringify(payload));

function decodeMockBlob(blob: string): MockBlobPayload {
  const trimmed = blob.trim();
  if (!trimmed.startsWith(MOCK_BLOB_PREFIX))
    throw new Error("not a SlipScan pairing blob");
  try {
    return JSON.parse(atob(trimmed.slice(MOCK_BLOB_PREFIX.length)));
  } catch {
    throw new Error("this pairing blob is not readable — copy it again in full");
  }
}

const THIS_DEVICE_KEY = mockPublicKey("this-laptop");
const PAIRED_DEVICE_KEY = mockPublicKey("home-server");
const REVOKED_DEVICE_KEY = mockPublicKey("old-phone");

let deviceIdentity: DeviceIdentity | null = {
  public_key: THIS_DEVICE_KEY,
  keyname: mockKeyname(THIS_DEVICE_KEY),
  label: "Alex's laptop",
  created_at: "2026-06-02T08:14:00Z",
  rotated_at: null,
};

const devicePeers: DevicePeer[] = [
  {
    public_key: PAIRED_DEVICE_KEY,
    keyname: mockKeyname(PAIRED_DEVICE_KEY),
    label: "home server",
    paired_at: "2026-06-02T08:31:00Z",
    revoked_at: null,
    // Always null: nothing connects to anything.
    last_seen_at: null,
  },
  {
    public_key: REVOKED_DEVICE_KEY,
    keyname: mockKeyname(REVOKED_DEVICE_KEY),
    label: "old phone",
    paired_at: "2026-06-02T08:44:00Z",
    revoked_at: "2026-07-04T19:02:00Z",
    last_seen_at: null,
  },
];

let deviceInvites: PairingInviteMeta[] = [];
let deviceRotations: DeviceRotation[] = [];
/** claim token -> the invite it belongs to. The real store keeps only a
 * SHA-256 of the token, so a copy of the database can redeem nothing; the mock
 * keeps it in the clear, and this comment is why that is acceptable here. */
const mockClaims = new Map<string, string>();

const mockClaimToken = (): string => mockPublicKey("claim-" + ++seq);

function requireDeviceIdentity(): DeviceIdentity {
  if (!deviceIdentity)
    throw new Error(
      "this device has no identity yet — create one before pairing",
    );
  return deviceIdentity;
}

/**
 * The key-name comparison, resolved the way the Tauri command resolves it —
 * **fail closed**.
 *
 * A request carrying neither a typed key-name nor an explicit human
 * confirmation is refused. It is not treated as "someone confirmed it": the
 * blobs are self-signed, so a substituted invite verifies perfectly, and this
 * comparison is the only thing that authenticates a pairing. Modelling the
 * refusal is what lets the screen be tested for asking.
 */
function mockKeynameCheck(query: PairRedeemRequest, actual: string): void {
  const typed = query.expect_keyname?.trim();
  if (typed) {
    const expected = normalizeKeyname(typed);
    if (!looksLikeKeyname(expected))
      throw new Error(
        `"${expected}" is not a key-name (nine words) — check what you typed`,
      );
    if (expected !== actual)
      throw new Error(
        `key-name mismatch: you expected ${expected}, this blob carries ` +
          `${actual} — refusing rather than pairing the wrong device`,
      );
    return;
  }
  if (query.confirmed_by_human) return;
  throw new Error(
    "pairing needs the key-name check: pass the key-name shown on the other " +
      "device (expect_keyname), or confirm that this screen displayed it and " +
      "the person agreed it matched (confirmed_by_human)",
  );
}

/**
 * An invite as though **another** device had minted it.
 *
 * The browser harness is one device, and pairing with yourself is refused (by
 * core, and by this mock) — so without this the accept side of the ceremony is
 * unreachable outside Tauri. Exported for the test suites; it is not a real
 * signed blob, because nothing here signs anything.
 */
export function mockForeignInvite(
  label = "a device",
  ttlSeconds = 600,
): { blob: string; keyname: string } {
  const key = mockPublicKey("foreign-" + ++seq);
  return {
    blob: encodeMockBlob({
      typ: "slipscan.pair.invite",
      device_id: key,
      label,
      claim: mockClaimToken(),
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    }),
    keyname: mockKeyname(key),
  };
}

/**
 * The acceptance the other device would carry back, given an invite this one
 * minted. A human walking a blob across the room, simulated — same reason as
 * `mockForeignInvite`.
 */
export function mockForeignAcceptance(inviteBlob: string): {
  blob: string;
  keyname: string;
} {
  const invite = decodeMockBlob(inviteBlob);
  const key = mockPublicKey("accepter-" + ++seq);
  return {
    blob: encodeMockBlob({
      typ: "slipscan.pair.accept",
      device_id: key,
      label: "the other device",
      claim: invite.claim,
      for_device_id: invite.device_id,
    }),
    keyname: mockKeyname(key),
  };
}

/** Pin a peer, trust-on-first-use: an unknown key is pinned, a known one may
 * refresh its cosmetic label, and a **revoked** one is refused. */
function mockPinPeer(publicKey: string, label: string): DevicePeer {
  const existing = devicePeers.find((p) => p.public_key === publicKey);
  if (existing) {
    if (existing.revoked_at)
      throw new Error(
        `${existing.keyname} was revoked on this device — forget it first if ` +
          "you really mean to pair it again",
      );
    existing.label = label;
    return existing;
  }
  const peer: DevicePeer = {
    public_key: publicKey,
    keyname: mockKeyname(publicKey),
    label,
    paired_at: new Date().toISOString(),
    revoked_at: null,
    last_seen_at: null,
  };
  devicePeers.push(peer);
  return peer;
}

// ---------------------------------------------------------------------------
// classification packs.
//
// **No signature is verified here.** This harness has no ed25519, and
// pretending otherwise would be the one dishonest thing a mock must not do:
// verification is the Tauri command's job, over the real crate. What the
// mock does model faithfully is the state machine the UI has to render —
// per-pack-id signer pinning (a changed key is a refusal), strict semver
// (same version is an error, downgrades are rejected, upgrades re-map) and
// trust-on-first-use labelling — so every branch of the Packs screen can be
// exercised in a browser.
// ---------------------------------------------------------------------------

/** Fingerprint of a signer key, mock-side: stable per key and grouped like
 * the real one, but a hash of nothing meaningful. */
const mockSignerFingerprint = (publicKey: string): string => {
  const raw = mockFingerprint("signer", publicKey.trim().toLowerCase());
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
};

const COMMUNITY_KEY =
  "3ac1f0e9b7d2564a8e1c0f5b96d3a7248fe0b1c6d495a8237e6f0b1c2d3e4f50";
const COMMUNITY_FP = mockSignerFingerprint(COMMUNITY_KEY);

let installedPacks: InstalledPackInfo[] = [
  {
    pack_id: "za-retail-base",
    book_id: BOOK_ID,
    name: "South African retail merchants",
    version: "1.4.0",
    kind: "taxonomy",
    region: "ZA",
    signer_fingerprint: COMMUNITY_FP,
    signer_label: "SlipScan Community",
    installed_at: "2026-05-11T14:03:00Z",
    updated_at: "2026-06-28T09:20:00Z",
  },
  {
    pack_id: "za-benchmarks-2026",
    book_id: BOOK_ID,
    name: "ZA household benchmarks · 2026",
    version: "0.3.1",
    kind: "benchmark",
    region: "ZA",
    signer_fingerprint: COMMUNITY_FP,
    signer_label: "SlipScan Community",
    installed_at: "2026-07-02T11:41:00Z",
    updated_at: "2026-07-02T11:41:00Z",
  },
  {
    // A second benchmark pack in a currency this book does not use. It is
    // here on purpose: "no FX conversion is applied" is a load-bearing
    // property, and the only way the UI's *not compared* branch gets
    // exercised in the browser, the smoke suite and the screenshots is if a
    // mismatched pack exists to produce it. A fabricated zero would read as
    // "you spend nothing on groceries", which is not what is known.
    pack_id: "eu-benchmarks-2026",
    book_id: BOOK_ID,
    name: "EU household benchmarks · 2026",
    version: "0.2.0",
    kind: "benchmark",
    region: "PT",
    signer_fingerprint: COMMUNITY_FP,
    signer_label: "SlipScan Community",
    installed_at: "2026-07-06T08:15:00Z",
    updated_at: "2026-07-06T08:15:00Z",
  },
];

/** pack id → the signer fingerprint it is pinned to. The real store keeps
 * pins across an uninstall so an id can never be taken over; so does this. */
const packPins = new Map<string, string>(
  installedPacks.map((p) => [p.pack_id, p.signer_fingerprint]),
);
/**
 * Configured pack sources. **Starts empty, and that is the point**: there is
 * no registry and no default endpoint, so a fresh install has nowhere to
 * fetch from until the user adds one. Seeding a demo source here would make
 * the harness lie about the one property this design exists to keep.
 */
let packSources: PackSourceInfo[] = [];

const MOCK_SOURCE_SCHEMES = new Set(["file", "folder", "git", "https", "http"]);

function mockSourceKind(uri: string): PackSourceKind {
  if (uri.startsWith("file:")) return "file";
  if (uri.startsWith("folder:")) return "folder";
  if (uri.startsWith("git:")) return "git";
  if (uri.startsWith("https://")) return "https";
  if (uri.startsWith("http://"))
    throw new Error(
      `refusing the plaintext source "${uri}": use https://. The signature is what is trusted, but a plaintext fetch still tells the network which packs you run`,
    );
  throw new Error(
    `unsupported pack source "${uri}"; use file:<path>, folder:<path>, git:<url>, or https://<url>`,
  );
}

/**
 * What any configured source offers in this harness — one pack from a signer
 * already trusted here, one from a signer that is NOT (so the accept-the-
 * fingerprint step is exercised), one that would be a downgrade, and one file
 * that does not verify at all (so "one bad file must not hide the catalogue"
 * is visible in the UI, not just asserted in Rust).
 */
const NEWCOMER_FP = "5c1a-9e02-7b44-d310";

const mockCatalogue: {
  pack_id: string;
  version: string;
  name: string;
  document: string;
  kind: PackKind;
  region: string | null;
  author: string | null;
  signer_fingerprint: string;
  categories: number;
  merchant_rules: number;
  keyword_rules: number;
  broken?: string;
}[] = [
  {
    pack_id: "za-retail-base",
    version: "1.6.0",
    name: "South African retail merchants",
    document: `${COMMUNITY_FP}/za-retail-base-1.6.0.pack.json`,
    kind: "taxonomy",
    region: "ZA",
    author: "SlipScan Community",
    signer_fingerprint: COMMUNITY_FP,
    categories: 28,
    merchant_rules: 164,
    keyword_rules: 12,
  },
  {
    pack_id: "intl-groceries",
    version: "2.0.0",
    name: "Worldwide grocery chains",
    document: `${NEWCOMER_FP}/intl-groceries-2.0.0.pack.json`,
    kind: "taxonomy",
    region: null,
    author: "hazel",
    signer_fingerprint: NEWCOMER_FP,
    categories: 9,
    merchant_rules: 74,
    keyword_rules: 0,
  },
  {
    pack_id: "za-benchmarks-2026",
    version: "0.2.0",
    name: "ZA household benchmarks · 2026",
    document: `${COMMUNITY_FP}/za-benchmarks-2026-0.2.0.pack.json`,
    kind: "benchmark",
    region: "ZA",
    author: "SlipScan Community",
    signer_fingerprint: COMMUNITY_FP,
    categories: 0,
    merchant_rules: 0,
    keyword_rules: 0,
  },
  {
    pack_id: "za-fuel",
    version: "1.0.0",
    name: "SA fuel stations",
    document: `${COMMUNITY_FP}/za-fuel-1.0.0.pack.json`,
    kind: "taxonomy",
    region: "ZA",
    author: "SlipScan Community",
    signer_fingerprint: COMMUNITY_FP,
    categories: 0,
    merchant_rules: 0,
    keyword_rules: 0,
    broken: "signature verification failed",
  },
];

/** signer fingerprint → trust label (trust-on-first-use). */
const trustedSigners = new Map<string, string>([[COMMUNITY_FP, "SlipScan Community"]]);

interface MockSemver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(raw: string): MockSemver {
  const parts = raw.trim().split(".");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p)))
    throw new Error(`invalid semantic version "${raw}" (expected MAJOR.MINOR.PATCH)`);
  const [major, minor, patch] = parts.map(Number) as [number, number, number];
  return { major, minor, patch };
}

/** Negative / zero / positive, same ordering strict semver uses. */
const cmpSemver = (a: MockSemver, b: MockSemver): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/** Canonical form the installer stores a version in. */
const canonicalVersion = (raw: string): string => {
  const v = parseSemver(raw);
  return `${v.major}.${v.minor}.${v.patch}`;
};

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface MockPackDocument {
  id: string;
  name: string;
  version: string;
  region: string | null;
  author: string | null;
  kind: PackKind;
  categories: number;
  merchant_rules: number;
  keyword_rules: number;
}

/** Decode and shape-check the pack document. The real path verifies the
 * signature over these exact bytes first; here they are only parsed. */
function readPackDocument(q: PackDocumentRequest): MockPackDocument {
  if (!q.signature.trim()) throw new Error("signature is required");
  if (!q.public_key.trim()) throw new Error("public key is required");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64(q.document_base64)));
  } catch (err) {
    throw new Error(`invalid payload JSON: ${err}`);
  }
  const meta = parsed.meta as
    | { id?: string; name?: string; version?: string; region?: string; author?: string }
    | undefined;
  if (!meta?.id || !meta.name || !meta.version)
    throw new Error(
      "pack validation failed: meta.id, meta.name and meta.version are required",
    );
  const count = (key: string): number =>
    Array.isArray(parsed[key]) ? (parsed[key] as unknown[]).length : 0;
  return {
    id: meta.id,
    name: meta.name,
    version: canonicalVersion(meta.version),
    region: meta.region ?? null,
    author: meta.author ?? null,
    kind: parsed.benchmarks ? "benchmark" : "taxonomy",
    categories: count("categories"),
    merchant_rules: count("merchant_rules"),
    keyword_rules: count("keyword_rules"),
  };
}

/** The refusal the installer would return, if any — same order and same
 * wording as the real `PackError` variants. */
function packRefusal(
  doc: MockPackDocument,
  fingerprint: string,
  installed: InstalledPackInfo | undefined,
): string | null {
  const pinned = packPins.get(doc.id);
  if (pinned && pinned !== fingerprint)
    return `pack ${doc.id} was previously signed by a different key (pinned signer ${pinned}); refusing to install`;
  if (!installed) return null;
  const cmp = cmpSemver(parseSemver(doc.version), parseSemver(installed.version));
  if (cmp === 0) return `pack ${doc.id} version ${installed.version} is already installed`;
  if (cmp < 0)
    return `pack ${doc.id}: offered version ${doc.version} is older than installed version ${installed.version}; downgrades are rejected`;
  return null;
}

/**
 * The built-in seed packs, mirroring the embedded fixtures in
 * `crates/slipscan-packs/src/fixtures/` — ids, names, versions, regions and
 * counts are read off those files, and the crate's
 * `seed_packs_parse_validate_and_verify` test pins the id/region list, so
 * this cannot drift silently.
 *
 * Two are region-specific (`ZA`) and one is global. That asymmetry is the
 * whole reason seeding is opt-in rather than something book creation does.
 */
const seedPacks: {
  pack_id: string;
  name: string;
  version: string;
  region: string | null;
  categories: number;
  rules: number;
}[] = [
  {
    pack_id: "za-personal",
    name: "South Africa — Personal Finance",
    version: "1.0.0",
    region: "ZA",
    categories: 33,
    rules: 91,
  },
  {
    pack_id: "za-business-vat",
    name: "South Africa — Small Business & VAT",
    version: "1.0.0",
    region: "ZA",
    categories: 29,
    rules: 56,
  },
  {
    pack_id: "intl-starter",
    name: "International Starter",
    version: "1.0.0",
    region: null,
    categories: 32,
    rules: 86,
  },
];

/** Seeds are embedded in the binary, so there is no key to trust on first
 * use and the TOFU store is not touched — the real installer records them
 * under a reserved builtin signer, which is not a trust-store row. */
const BUILTIN_SIGNER_FP = "builtin";

// ---------------------------------------------------------------------------
// benchmark packs — the READ side of peer comparison, the only half built.
//
// What this harness models faithfully is the shape the UI has to render:
// a comparison resolved through the taxonomy map, keys the pack cites that
// nothing maps to (`unmapped_keys`), and a pack in another currency coming
// back *not compared* rather than as zeroes. The statistics themselves are
// invented fixtures — there is no published benchmark pack to ship, which is
// exactly what BENCHMARKS.md says. Nothing here contributes anything
// anywhere: there is no contribution path in SlipScan at all.
// ---------------------------------------------------------------------------

/** Taxonomy key → local category, as an installed taxonomy pack's category
 * map would resolve it. Keys are real `za-personal`/`intl-starter` keys. */
const benchmarkKeyMap: Record<string, string> = {
  groceries: "Groceries",
  "eating-out": "Eating out",
  transport: "Transport & fuel",
  "housing.utilities": "Utilities",
  "entertainment.streaming": "Subscriptions",
  medical: "Health",
};

interface MockBenchmarkStat {
  category_key: string;
  p25_minor: number;
  median_minor: number;
  p75_minor: number;
  sample_size: number;
}

interface MockBenchmarkSet {
  pack_id: string;
  /** The calendar year these stats cover. A real pack carries a period per
   * statistic; the fixture collapses that to "every month of one year" so a
   * month outside it exercises the *pack publishes nothing for this month*
   * branch, which is a different answer from "you spent nothing". */
  year: string;
  currency: string;
  cohort: BenchmarkCohort;
  k_floor: number;
  stats: MockBenchmarkStat[];
}

/** `insurance` and `education` are real taxonomy keys that this demo book has
 * no category for, so they land in `unmapped_keys` — the branch that answers
 * "why is there no row for insurance?". */
const benchmarkSets: MockBenchmarkSet[] = [
  {
    pack_id: "za-benchmarks-2026",
    year: "2026",
    currency: "ZAR",
    cohort: { region: "ZA", household_size: 2, income_band: "C" },
    k_floor: 25,
    stats: [
      {
        category_key: "groceries",
        p25_minor: 310_000,
        median_minor: 485_000,
        p75_minor: 702_500,
        sample_size: 412,
      },
      {
        category_key: "eating-out",
        p25_minor: 62_000,
        median_minor: 118_000,
        p75_minor: 214_000,
        sample_size: 388,
      },
      {
        category_key: "transport",
        p25_minor: 90_000,
        median_minor: 160_000,
        p75_minor: 260_000,
        sample_size: 380,
      },
      {
        category_key: "housing.utilities",
        p25_minor: 145_000,
        median_minor: 198_000,
        p75_minor: 265_000,
        sample_size: 401,
      },
      {
        category_key: "entertainment.streaming",
        p25_minor: 18_000,
        median_minor: 34_900,
        p75_minor: 62_000,
        sample_size: 297,
      },
      // A cohort median of zero: most households in the band spend nothing
      // here in a given month. `ratio_to_median` is absent rather than
      // Infinity — dividing by it would invent a number.
      {
        category_key: "medical",
        p25_minor: 0,
        median_minor: 0,
        p75_minor: 96_000,
        sample_size: 254,
      },
      {
        category_key: "insurance",
        p25_minor: 120_000,
        median_minor: 214_500,
        p75_minor: 361_000,
        sample_size: 344,
      },
      {
        category_key: "education",
        p25_minor: 0,
        median_minor: 180_000,
        p75_minor: 640_000,
        sample_size: 129,
      },
    ],
  },
  {
    pack_id: "eu-benchmarks-2026",
    year: "2026",
    currency: "EUR",
    cohort: { region: "PT", household_size: 2, income_band: "B" },
    k_floor: 30,
    stats: [
      {
        category_key: "groceries",
        p25_minor: 28_000,
        median_minor: 41_500,
        p75_minor: 58_000,
        sample_size: 216,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// household member reports — mirrors core's repo/report.rs member_amount /
// member_category / settle_up: split shares are distributed, singly-
// attributed transactions count in full, and everything else rolls into the
// "Unattributed" (member_id: null) bucket. All scoped to the book's base
// currency (ZAR here), exactly like every other report.
// ---------------------------------------------------------------------------

const memberLabel = (memberId2: string | null): string =>
  (memberId2 && members.find((m) => m.id === memberId2)?.label) || "Unattributed";

/** `(member, share)` rows for one transaction: its splits if any, otherwise
 * a single row for its `attributed_member_id` (possibly unattributed). */
function attributionRows(
  t: Transaction,
  signedShare: (minor: number) => number,
): Array<[string | null, number]> {
  const splits = transactionSplits.filter((s) => s.transaction_id === t.id);
  if (splits.length > 0)
    return splits.map((s) => [s.member_id, signedShare(s.share_minor)]);
  return [[t.attributed_member_id, signedShare(Math.abs(t.amount_minor))]];
}

function memberAmount(from: string, to: string, expense: boolean): MemberAmountRow[] {
  const currency = "ZAR";
  const totals = new Map<string | null, number>();
  const inRange = transactions.filter(
    (t) =>
      t.currency === currency &&
      t.posted_at.slice(0, 10) >= from &&
      t.posted_at.slice(0, 10) <= to &&
      (expense ? t.amount_minor < 0 : t.amount_minor > 0),
  );
  for (const t of inRange) {
    for (const [memberId2, share] of attributionRows(t, (m) => m)) {
      totals.set(memberId2, (totals.get(memberId2) ?? 0) + share);
    }
  }
  return [...totals.entries()]
    .map(([member_id, total_minor]) => ({
      member_id,
      member_label: memberLabel(member_id),
      currency,
      total_minor,
    }))
    .sort((a, b) => b.total_minor - a.total_minor);
}

function memberCategoryReport(from: string, to: string): MemberCategoryRow[] {
  const currency = "ZAR";
  const rows = new Map<string, MemberCategoryRow>();
  const inRange = transactions.filter(
    (t) =>
      t.currency === currency &&
      t.amount_minor < 0 &&
      t.posted_at.slice(0, 10) >= from &&
      t.posted_at.slice(0, 10) <= to,
  );
  for (const t of inRange) {
    for (const [memberId2, share] of attributionRows(t, (m) => m)) {
      const key = `${memberId2 ?? "none"}::${t.category_id ?? "none"}`;
      const row = rows.get(key) ?? {
        member_id: memberId2,
        member_label: memberLabel(memberId2),
        category_id: t.category_id,
        category_name: categories.find((c) => c.id === t.category_id)?.name ?? "Uncategorized",
        currency,
        total_minor: 0,
      };
      row.total_minor += share;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) => a.member_label.localeCompare(b.member_label) || b.total_minor - a.total_minor,
  );
}

function settleUp(from: string, to: string): MemberSettleRow[] {
  const currency = "ZAR";
  const rows = new Map<string | null, MemberSettleRow>();
  // Every current member appears, even at zero.
  for (const m of members) {
    rows.set(m.id, {
      member_id: m.id,
      member_label: m.label,
      currency,
      contributions_minor: 0,
      expenses_minor: 0,
      net_minor: 0,
    });
  }
  for (const row of memberAmount(from, to, false)) {
    const r = rows.get(row.member_id) ?? {
      member_id: row.member_id,
      member_label: row.member_label,
      currency,
      contributions_minor: 0,
      expenses_minor: 0,
      net_minor: 0,
    };
    r.contributions_minor += row.total_minor;
    rows.set(row.member_id, r);
  }
  for (const row of memberAmount(from, to, true)) {
    const r = rows.get(row.member_id) ?? {
      member_id: row.member_id,
      member_label: row.member_label,
      currency,
      contributions_minor: 0,
      expenses_minor: 0,
      net_minor: 0,
    };
    r.expenses_minor += row.total_minor;
    rows.set(row.member_id, r);
  }
  const out = [...rows.values()];
  for (const r of out) r.net_minor = r.contributions_minor - r.expenses_minor;
  // Members first (creation order), the trailing "Unattributed" row last —
  // mirrors core's settle_up ordering.
  out.sort((a, b) => (a.member_id === null ? 1 : b.member_id === null ? -1 : 0));
  return out;
}

/**
 * Money in and money out for one `YYYY-MM`, straight off the seeded rows.
 * Transfers between the household's own accounts are excluded from the
 * expense side, exactly like `report_spending` — moving R5 000 into savings
 * is not spending it.
 */
function seededMonthTotals(month: string): {
  income_minor: number;
  expense_minor: number;
} {
  const rows = transactions.filter((t) => t.posted_at.startsWith(month));
  const isTransfer = (t: Transaction): boolean =>
    categories.find((c) => c.id === t.category_id)?.kind === "transfer";
  return {
    income_minor: rows
      .filter((t) => t.amount_minor > 0)
      .reduce((s, t) => s + t.amount_minor, 0),
    expense_minor: rows
      .filter((t) => t.amount_minor < 0 && !isTransfer(t))
      .reduce((s, t) => s + -t.amount_minor, 0),
  };
}

// ---------------------------------------------------------------------------
// mock service surface — same names/shapes as the core services
// ---------------------------------------------------------------------------

const clone = <T>(v: T): T => structuredClone(v);

// ---------------------------------------------------------------------------
// period close — mirrors core's `ClosePeriodReport` checks closely enough
// for mock purposes: a single-currency (ZAR) balance-as-of-`to_date` check,
// plus the four advisory counts, scoped to the period between whatever this
// book was already locked through (`lockDates`) and `to_date`.
// ---------------------------------------------------------------------------

const dayAfter = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

function buildCloseReport(book_id: string, to_date: string): ClosePeriodReport {
  const b = books.find((x) => x.id === book_id);
  if (!b) throw new Error(`book not found: ${book_id}`);
  const previous_lock_date = lockDates.get(book_id) ?? null;

  const blocking_reasons: string[] = [];
  if (previous_lock_date && to_date <= previous_lock_date) {
    blocking_reasons.push(
      `book is already closed through ${previous_lock_date}; reopen the period first to ` +
        "move the close date backward, or close through a later date",
    );
  }
  const from_date =
    previous_lock_date === null
      ? "0001-01-01"
      : to_date > previous_lock_date
        ? dayAfter(previous_lock_date)
        : to_date;

  let debit_minor = 0;
  let credit_minor = 0;
  for (const je of journalEntries) {
    if (je.book_id !== book_id || je.entry_date > to_date) continue;
    for (const line of je.lines) {
      debit_minor += line.debit_minor;
      credit_minor += line.credit_minor;
    }
  }
  const balanced = debit_minor === credit_minor;
  const balance: ClosePeriodCurrencyBalance[] =
    debit_minor === 0 && credit_minor === 0
      ? []
      : [{ currency: "ZAR", debit_minor, credit_minor }];
  if (!balanced) {
    blocking_reasons.push(
      `trial balance does not balance as of ${to_date}: ZAR debit ${debit_minor} != ` +
        `credit ${credit_minor}`,
    );
  }

  const inRange = (date: string) => date >= from_date && date <= to_date;

  const uncategorised_transaction_count = transactions.filter(
    (t) =>
      t.book_id === book_id &&
      t.category_id === null &&
      inRange(t.posted_at.slice(0, 10)),
  ).length;

  const reconciledTxnIds = new Set(
    reconSuggestions.filter((r) => r.status === "confirmed").map((r) => r.transaction_id),
  );
  const unreconciled_statement_line_count = transactions.filter(
    (t) =>
      t.book_id === book_id &&
      inRange(t.posted_at.slice(0, 10)) &&
      !reconciledTxnIds.has(t.id),
  ).length;

  const draft_sales_order_count = salesOrders.filter(
    (o) => o.book_id === book_id && o.status === "draft" && inRange(o.order_date),
  ).length;

  const unpaid_invoice_due_count = invoices.filter(
    (inv) =>
      inv.book_id === book_id &&
      inRange(inv.due_date) &&
      !invoicePayments.some((p) => p.invoice_id === inv.id),
  ).length;

  const warnings: string[] = [];
  if (uncategorised_transaction_count > 0) {
    warnings.push(
      `${uncategorised_transaction_count} uncategorised transaction(s) in this period`,
    );
  }
  if (unreconciled_statement_line_count > 0) {
    warnings.push(
      `${unreconciled_statement_line_count} unreconciled statement line(s) in this period`,
    );
  }
  if (draft_sales_order_count > 0) {
    warnings.push(`${draft_sales_order_count} draft sales order(s) dated in this period`);
  }
  if (unpaid_invoice_due_count > 0) {
    warnings.push(
      `${unpaid_invoice_due_count} invoice(s) due in this period with no payment ` +
        "recorded against them",
    );
  }

  return {
    book_id,
    to_date,
    previous_lock_date,
    balance,
    balanced,
    uncategorised_transaction_count,
    unreconciled_statement_line_count,
    draft_sales_order_count,
    unpaid_invoice_due_count,
    blocking_reasons,
    warnings,
    closeable: blocking_reasons.length === 0,
    closed: false,
  };
}

export const mockApi = {
  health: async (): Promise<Health> => ({
    status: "ok",
    version: "0.2.0-mock",
    tauri: "browser",
  }),

  book_list: async (): Promise<Book[]> => clone(books),

  /**
   * Mirrors core's `book_create`, including the parts that are easy to get
   * wrong: the region profile is resolved from the `region_list` data (an
   * explicit id wins, else the country infers one, else **generic** — never
   * a jurisdiction picked here), an unknown region id is rejected rather
   * than downgraded, and the currency falls back to the chosen profile's
   * own default only when the profile names one.
   */
  book_create: async (q: NewBook): Promise<Book> => {
    const name = q.name.trim();
    if (!name) throw new Error("book name must not be empty");
    let profile: RegionInfo | undefined;
    if (q.region) {
      profile = regions.find((r) => r.id === q.region);
      if (!profile)
        throw new Error(
          `unknown region profile "${q.region}" (known: ${regions
            .map((r) => r.id)
            .join(", ")})`,
        );
    } else if (q.country) {
      profile = regions.find(
        (r) => r.country?.toUpperCase() === q.country!.toUpperCase(),
      );
    }
    profile ??= regions.find((r) => r.id === "generic")!;
    const currency = (q.currency ?? profile.default_currency ?? "").trim().toUpperCase();
    if (!currency)
      throw new Error(
        "currency is required (the selected region profile has no default)",
      );
    if (!/^[A-Z]{3}$/.test(currency))
      throw new Error(`invalid currency code "${currency}"`);
    const created: Book = {
      id: id("bk00"),
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      kind: q.kind,
      currency,
      region: profile.id,
      region_name: profile.display_name,
      tax_report_name: profile.tax_report_name,
      file_path: dataState.db_path,
      created_at: new Date().toISOString(),
    };
    books.push(created);
    return clone(created);
  },

  // -- book profiles (Phase 6.0): personal / business / business-multi-
  // location, derived from `kind` and the `locations` count with an
  // explicit override — see `resolveProfile` above. --

  book_profile: async (q: { book_id: string }): Promise<BookProfile> => {
    const b = books.find((x) => x.id === q.book_id);
    if (!b) throw new Error(`book not found: ${q.book_id}`);
    return clone(resolveProfile(b));
  },

  book_set_kind: async (q: {
    book_id: string;
    kind: BookKind;
  }): Promise<BookProfile> => {
    const b = books.find((x) => x.id === q.book_id);
    if (!b) throw new Error(`book not found: ${q.book_id}`);
    b.kind = q.kind;
    return clone(resolveProfile(b));
  },

  book_set_multi_location_override: async (q: {
    book_id: string;
    multi_location_override?: boolean | null;
  }): Promise<BookProfile> => {
    const b = books.find((x) => x.id === q.book_id);
    if (!b) throw new Error(`book not found: ${q.book_id}`);
    multiLocationOverrides.set(q.book_id, q.multi_location_override ?? null);
    return clone(resolveProfile(b));
  },

  // -- locations: branches, sites and warehouses (Phase 6.1). --

  location_list: async (q: { book_id: string }): Promise<Location[]> =>
    clone(locations.filter((l) => l.book_id === q.book_id)),

  location_create: async (q: NewLocation): Promise<Location> => {
    const name = q.name.trim();
    if (!name) throw new Error("location name must not be empty");
    if (locations.some((l) => l.book_id === q.book_id && l.name === name))
      throw new Error(`a location named "${name}" already exists in this book`);
    const code = q.code?.trim() || null;
    if (
      code &&
      locations.some((l) => l.book_id === q.book_id && l.code === code)
    )
      throw new Error(`location code "${code}" is already used in this book`);
    const now = new Date().toISOString();
    const created: Location = {
      id: id("lc00"),
      book_id: q.book_id,
      name,
      kind: q.kind ?? "branch",
      code,
      address: q.address?.trim() || null,
      is_archived: false,
      created_at: now,
      updated_at: now,
    };
    locations.push(created);
    return clone(created);
  },

  location_update: async (q: LocationUpdateRequest): Promise<Location> => {
    const l = locations.find((x) => x.id === q.id);
    if (!l) throw new Error(`location not found: ${q.id}`);
    if (q.name !== undefined) {
      const name = q.name.trim();
      if (!name) throw new Error("location name must not be empty");
      l.name = name;
    }
    if (q.kind !== undefined) l.kind = q.kind;
    // `null` clears, an absent key leaves alone.
    if (q.code !== undefined) l.code = q.code?.trim() || null;
    if (q.address !== undefined) l.address = q.address?.trim() || null;
    if (q.is_archived !== undefined) l.is_archived = q.is_archived;
    l.updated_at = new Date().toISOString();
    return clone(l);
  },

  location_delete: async (q: { location_id: string }): Promise<null> => {
    const i = locations.findIndex((x) => x.id === q.location_id);
    if (i === -1) throw new Error(`location not found: ${q.location_id}`);
    locations.splice(i, 1);
    return null;
  },

  // -- chart of accounts, journal generation, lock date. --

  coa_create: async (q: NewLedgerAccount): Promise<LedgerAccount> => {
    const code = q.code.trim();
    if (!code) throw new Error("account code must not be empty");
    if (ledgerAccounts.some((a) => a.book_id === q.book_id && a.code === code))
      throw new Error(`account code "${code}" already exists in this book`);
    const created: LedgerAccount = {
      id: id("coa0"),
      book_id: q.book_id,
      code,
      name: q.name.trim(),
      type: q.kind,
      vat_rate_bp: null,
      archived: false,
    };
    ledgerAccounts.push(created);
    return clone(created);
  },

  /** Archive, never delete — the row stays and stops accepting new lines. */
  coa_archive: async (q: { id: string }): Promise<LedgerAccount> => {
    const a = ledgerAccounts.find((x) => x.id === q.id);
    if (!a) throw new Error(`no ledger account with id ${q.id}`);
    a.archived = true;
    return clone(a);
  },

  coa_map_set: async (q: {
    book_id: string;
    entity_type: CoaMapEntity;
    entity_id: string;
    coa_id: string;
  }): Promise<CoaMapEntry> => {
    // Core refuses three cross-book pairings; the mock models the chart of
    // accounts, so it can check that one at least.
    const entry = ledgerAccounts.find((a) => a.id === q.coa_id);
    if (entry && entry.book_id !== q.book_id)
      throw new Error("chart-of-accounts entry belongs to a different book");
    const now = new Date().toISOString();
    const existing = coaMap.find(
      (m) =>
        m.book_id === q.book_id &&
        m.entity_type === q.entity_type &&
        m.entity_id === q.entity_id,
    );
    if (existing) {
      existing.coa_id = q.coa_id;
      existing.updated_at = now;
      return clone(existing);
    }
    const created: CoaMapEntry = {
      id: id("cmap"),
      book_id: q.book_id,
      entity_type: q.entity_type,
      entity_id: q.entity_id,
      coa_id: q.coa_id,
      created_at: now,
      updated_at: now,
    };
    coaMap.push(created);
    return clone(created);
  },

  // Journal generation depends on the CoA mapping and VAT rules that only
  // core implements; the mock refuses rather than inventing a journal that
  // would not match what the real service posts.
  journal_generate_for_transaction: async (_q: {
    transaction_id: string;
    vat_rate_id?: string;
  }): Promise<JournalEntry> => {
    throw new Error(
      "journal generation is not simulated in the browser mock — run the desktop app",
    );
  },

  journal_generate_for_document: async (_q: {
    document_id: string;
  }): Promise<JournalEntry> => {
    throw new Error(
      "journal generation is not simulated in the browser mock — run the desktop app",
    );
  },

  journal_reverse: async (_q: {
    journal_id: string;
    posted_date?: string;
    narrative?: string;
  }): Promise<JournalEntry> => {
    throw new Error(
      "journal reversal is not simulated in the browser mock — run the desktop app",
    );
  },

  book_set_lock_date: async (q: {
    book_id: string;
    lock_date?: string | null;
  }): Promise<Book> => {
    const b = books.find((x) => x.id === q.book_id);
    if (!b) throw new Error(`book not found: ${q.book_id}`);
    lockDates.set(q.book_id, q.lock_date ?? null);
    return clone(b);
  },

  // -- period close: check (dry run, no mutation), run (locks on success),
  // reopen (deliberate, reasoned undo). --

  close_period_check: async (q: {
    book_id: string;
    to_date: string;
  }): Promise<ClosePeriodReport> => clone(buildCloseReport(q.book_id, q.to_date)),

  close_period: async (q: {
    book_id: string;
    to_date: string;
  }): Promise<ClosePeriodReport> => {
    const report = buildCloseReport(q.book_id, q.to_date);
    if (!report.closeable) {
      throw new Error(
        `book is not closeable for this period: ${report.blocking_reasons.join("; ")}`,
      );
    }
    lockDates.set(q.book_id, q.to_date);
    return clone({ ...report, closed: true });
  },

  reopen_period: async (q: {
    book_id: string;
    reason: string;
    to_date?: string | null;
  }): Promise<Book> => {
    const b = books.find((x) => x.id === q.book_id);
    if (!b) throw new Error(`book not found: ${q.book_id}`);
    const current = lockDates.get(q.book_id) ?? null;
    if (!current) throw new Error("book is not closed; there is no period to reopen");
    if (!q.reason.trim()) throw new Error("reopening a closed period needs a reason");
    if (q.to_date != null && q.to_date >= current) {
      throw new Error(
        `reopening to ${q.to_date} does not move the lock date backward from ${current}`,
      );
    }
    lockDates.set(q.book_id, q.to_date ?? null);
    return clone(b);
  },

  // -- stock: the append-only movement ledger (Phase 6.3b). --

  stock_movement_record: async (
    q: NewStockMovement,
  ): Promise<StockMovement> => {
    if (q.qty_delta === 0)
      throw new Error("stock movement qty_delta must not be zero");
    const variant = requireVariant(q.variant_id);
    // Both of these are core guards the mock was missing. A ref_id with no
    // ref_kind is a pointer with nothing saying what it points at, and a
    // location from another book would file the movement in the wrong ledger.
    if (q.ref_id !== undefined && q.ref_kind === undefined)
      throw new Error(
        "stock movement has a ref_id but no ref_kind to name what it refers to",
      );
    const location = locations.find((l) => l.id === q.location_id);
    if (location && location.book_id !== variant.book_id)
      throw new Error(
        "stock movement location and variant belong to different books",
      );
    const created: StockMovement = {
      id: id("stkm"),
      book_id: variant.book_id,
      variant_id: variant.id,
      location_id: q.location_id,
      qty_delta: q.qty_delta,
      kind: q.kind,
      ref_kind: q.ref_kind ?? null,
      ref_id: q.ref_id ?? null,
      note: q.note?.trim() || null,
      created_by: q.created_by ?? null,
      created_at: new Date().toISOString(),
    };
    stockMovements.push(created);
    return clone(created);
  },

  stock_on_hand: async (q: {
    variant_id: string;
    location_id: string;
  }): Promise<number> =>
    stockMovements
      .filter(
        (m) => m.variant_id === q.variant_id && m.location_id === q.location_id,
      )
      .reduce((sum, m) => sum + m.qty_delta, 0),

  stock_on_hand_by_location: async (q: {
    variant_id: string;
  }): Promise<[string, number][]> => {
    const per = new Map<string, number>();
    for (const m of stockMovements.filter((x) => x.variant_id === q.variant_id))
      per.set(m.location_id, (per.get(m.location_id) ?? 0) + m.qty_delta);
    return [...per.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  },

  stock_on_hand_total: async (q: { variant_id: string }): Promise<number> =>
    stockMovements
      .filter((m) => m.variant_id === q.variant_id)
      .reduce((sum, m) => sum + m.qty_delta, 0),

  stock_movements_for_variant: async (q: {
    variant_id: string;
  }): Promise<StockMovement[]> =>
    clone(stockMovements.filter((m) => m.variant_id === q.variant_id)),

  stock_movements_for_location: async (q: {
    location_id: string;
  }): Promise<StockMovement[]> =>
    clone(stockMovements.filter((m) => m.location_id === q.location_id)),

  stock_movements_for_ref: async (q: {
    ref_kind: string;
    ref_id: string;
  }): Promise<StockMovement[]> =>
    clone(
      stockMovements.filter(
        (m) => m.ref_kind === q.ref_kind && m.ref_id === q.ref_id,
      ),
    ),

  /** Two movements summing to zero — stock is never "in transit". */
  stock_transfer: async (q: {
    variant_id: string;
    from_location_id: string;
    to_location_id: string;
    qty: number;
    note?: string;
    created_by?: string;
  }): Promise<TransferResult> => {
    if (q.qty <= 0) throw new Error("a transfer quantity must be positive");
    if (q.from_location_id === q.to_location_id)
      throw new Error("a transfer needs two different locations");
    const variant = requireVariant(q.variant_id);
    const now = new Date().toISOString();
    const mk = (location_id: string, qty_delta: number): StockMovement => ({
      id: id("stkm"),
      book_id: variant.book_id,
      variant_id: variant.id,
      location_id,
      qty_delta,
      kind: "transfer",
      ref_kind: null,
      ref_id: null,
      note: q.note?.trim() || null,
      created_by: q.created_by ?? null,
      created_at: now,
    });
    const out = mk(q.from_location_id, -q.qty);
    const in_ = mk(q.to_location_id, q.qty);
    stockMovements.push(out, in_);
    return clone({ out, in_ });
  },

  stock_low_variants: async (q: {
    book_id: string;
  }): Promise<LowStockVariant[]> => {
    const rows: LowStockVariant[] = [];
    for (const variant of productVariants.filter((v) => v.book_id === q.book_id)) {
      const on_hand = stockMovements
        .filter((m) => m.variant_id === variant.id)
        .reduce((sum, m) => sum + m.qty_delta, 0);
      if (on_hand <= variant.reorder_point) rows.push({ variant: clone(variant), on_hand });
    }
    return rows;
  },

  // -- catalogue: categories, products, variants (Phase 6.3a). --

  product_category_create: async (
    q: NewProductCategory,
  ): Promise<ProductCategory> => {
    const name = q.name.trim();
    if (!name) throw new Error("category name must not be empty");
    const now = new Date().toISOString();
    const created: ProductCategory = {
      id: id("pcat"),
      book_id: q.book_id,
      name,
      created_at: now,
      updated_at: now,
    };
    productCategories.push(created);
    return clone(created);
  },

  product_category_get: async (q: { id: string }): Promise<ProductCategory> =>
    clone(requireProductCategory(q.id)),

  product_category_list: async (q: {
    book_id: string;
  }): Promise<ProductCategory[]> =>
    clone(productCategories.filter((c) => c.book_id === q.book_id)),

  product_category_rename: async (q: {
    id: string;
    name: string;
  }): Promise<ProductCategory> => {
    const c = requireProductCategory(q.id);
    const name = q.name.trim();
    if (!name) throw new Error("category name must not be empty");
    c.name = name;
    c.updated_at = new Date().toISOString();
    return clone(c);
  },

  product_category_delete: async (q: { id: string }): Promise<null> => {
    const c = requireProductCategory(q.id);
    productCategories.splice(productCategories.indexOf(c), 1);
    // Core sets the FK to NULL rather than orphaning the product.
    for (const p of products) {
      if (p.product_category_id === c.id) p.product_category_id = null;
    }
    return null;
  },

  product_create: async (q: NewProduct): Promise<Product> => {
    const name = q.name.trim();
    if (!name) throw new Error("product name must not be empty");
    const now = new Date().toISOString();
    const created: Product = {
      id: id("prod"),
      book_id: q.book_id,
      product_category_id: q.product_category_id ?? null,
      name,
      description: q.description?.trim() || null,
      created_at: now,
      updated_at: now,
    };
    products.push(created);
    return clone(created);
  },

  product_get: async (q: { id: string }): Promise<Product> =>
    clone(requireProduct(q.id)),

  product_list: async (q: { book_id: string }): Promise<Product[]> =>
    clone(products.filter((p) => p.book_id === q.book_id)),

  product_update: async (q: ProductUpdateRequest): Promise<Product> => {
    const p = requireProduct(q.id);
    if (q.name !== undefined) {
      const name = q.name.trim();
      if (!name) throw new Error("product name must not be empty");
      p.name = name;
    }
    if (q.description !== undefined) p.description = q.description?.trim() || null;
    if (q.product_category_id !== undefined)
      p.product_category_id = q.product_category_id ?? null;
    p.updated_at = new Date().toISOString();
    return clone(p);
  },

  /** Mirrors the schema, which is not what you might guess:
   * `product_variants.product_id` is ON DELETE **CASCADE**, so deleting a
   * product deletes its variants with it — but everything that references a
   * *variant* (stock movements, order and invoice lines) is ON DELETE
   * RESTRICT, so the cascade is refused the moment any of those variants has
   * been traded. This mock used to refuse whenever the product had any
   * variant at all, which is a guard core does not have. */
  product_delete: async (q: { id: string }): Promise<null> => {
    const p = requireProduct(q.id);
    const doomed = productVariants.filter((v) => v.product_id === p.id);
    if (doomed.some((v) => variantIsReferenced(v.id)))
      throw new Error(
        "a variant of this product has stock movements or order lines against it and cannot be deleted",
      );
    for (const v of doomed) productVariants.splice(productVariants.indexOf(v), 1);
    products.splice(products.indexOf(p), 1);
    return null;
  },

  product_variant_add: async (
    q: NewProductVariant,
  ): Promise<ProductVariant> => {
    const product = requireProduct(q.product_id);
    const sku = q.sku.trim();
    if (!sku) throw new Error("variant SKU must not be empty");
    if (!q.name.trim()) throw new Error("variant name must not be empty");
    if ((q.price_minor ?? 0) < 0)
      throw new Error("variant price must not be negative");
    if ((q.cost_price_minor ?? 0) < 0)
      throw new Error("variant cost price must not be negative");
    if ((q.reorder_point ?? 0) < 0)
      throw new Error("variant reorder point must not be negative");
    if (
      productVariants.some(
        (v) => v.book_id === product.book_id && v.sku === sku,
      )
    )
      throw new Error(`a variant with SKU "${sku}" already exists in this book`);
    const now = new Date().toISOString();
    const created: ProductVariant = {
      id: id("pvar"),
      product_id: product.id,
      book_id: product.book_id,
      sku,
      name: q.name.trim(),
      price_minor: q.price_minor ?? 0,
      cost_price_minor: q.cost_price_minor ?? 0,
      currency: q.currency,
      reorder_point: q.reorder_point ?? 0,
      attributes: q.attributes ?? null,
      created_at: now,
      updated_at: now,
    };
    productVariants.push(created);
    return clone(created);
  },

  product_variant_get: async (q: { id: string }): Promise<ProductVariant> =>
    clone(requireVariant(q.id)),

  product_variant_list: async (q: {
    product_id: string;
  }): Promise<ProductVariant[]> =>
    clone(productVariants.filter((v) => v.product_id === q.product_id)),

  product_variant_list_for_book: async (q: {
    book_id: string;
  }): Promise<ProductVariant[]> =>
    clone(productVariants.filter((v) => v.book_id === q.book_id)),

  product_variant_update: async (
    q: ProductVariantUpdateRequest,
  ): Promise<ProductVariant> => {
    const v = requireVariant(q.id);
    if (q.sku !== undefined) {
      const sku = q.sku.trim();
      if (!sku) throw new Error("variant SKU must not be empty");
      if (
        productVariants.some(
          (o) => o.id !== v.id && o.book_id === v.book_id && o.sku === sku,
        )
      )
        throw new Error(`a variant with SKU "${sku}" already exists in this book`);
      v.sku = sku;
    }
    if (q.name !== undefined) {
      const name = q.name.trim();
      if (!name) throw new Error("variant name must not be empty");
      v.name = name;
    }
    if (q.price_minor !== undefined) {
      if (q.price_minor < 0)
        throw new Error("variant price must not be negative");
      v.price_minor = q.price_minor;
    }
    if (q.cost_price_minor !== undefined) {
      if (q.cost_price_minor < 0)
        throw new Error("variant cost price must not be negative");
      v.cost_price_minor = q.cost_price_minor;
    }
    if (q.reorder_point !== undefined) {
      if (q.reorder_point < 0)
        throw new Error("variant reorder point must not be negative");
      v.reorder_point = q.reorder_point;
    }
    if (q.attributes !== undefined) v.attributes = q.attributes ?? null;
    v.updated_at = new Date().toISOString();
    return clone(v);
  },

  /** ON DELETE RESTRICT from stock movements and every kind of order line —
   * a variant that has been traded is history and stays. */
  product_variant_delete: async (q: { id: string }): Promise<null> => {
    const v = requireVariant(q.id);
    if (variantIsReferenced(v.id))
      throw new Error(
        "this variant has stock movements or order lines against it and cannot be deleted",
      );
    productVariants.splice(productVariants.indexOf(v), 1);
    return null;
  },

  // -- contacts: customers and suppliers in one table (Phase 6.2). --

  contact_add: async (q: NewContact): Promise<Contact> => {
    const name = q.name.trim();
    if (!name) throw new Error("contact name must not be empty");
    if (q.payment_terms_days !== undefined && q.payment_terms_days < 0)
      throw new Error("payment terms must be zero or more days");
    if (q.credit_limit_minor !== undefined && q.credit_limit_minor < 0)
      throw new Error("credit limit must not be negative");
    const now = new Date().toISOString();
    const created: Contact = {
      id: id("ct00"),
      book_id: q.book_id,
      role: q.role,
      name,
      company_name: q.company_name?.trim() || null,
      email: q.email?.trim() || null,
      phone: q.phone?.trim() || null,
      billing_address: q.billing_address?.trim() || null,
      shipping_address: q.shipping_address?.trim() || null,
      tax_number: q.tax_number?.trim() || null,
      payment_terms_days: q.payment_terms_days ?? null,
      credit_limit_minor: q.credit_limit_minor ?? null,
      notes: q.notes?.trim() || null,
      is_active: true,
      created_at: now,
      updated_at: now,
    };
    contacts.push(created);
    return clone(created);
  },

  contact_get: async (q: { id: string }): Promise<Contact> =>
    clone(requireContact(q.id)),

  contact_list: async (q: { book_id: string }): Promise<Contact[]> =>
    clone(contacts.filter((c) => c.book_id === q.book_id)),

  contact_list_customers: async (q: { book_id: string }): Promise<Contact[]> =>
    clone(
      contacts.filter(
        (c) => c.book_id === q.book_id && (c.role === "customer" || c.role === "both"),
      ),
    ),

  contact_list_suppliers: async (q: { book_id: string }): Promise<Contact[]> =>
    clone(
      contacts.filter(
        (c) => c.book_id === q.book_id && (c.role === "supplier" || c.role === "both"),
      ),
    ),

  contact_update: async (q: ContactUpdateRequest): Promise<Contact> => {
    const c = requireContact(q.id);
    // `null` clears, an absent key leaves alone.
    if (q.role !== undefined) c.role = q.role;
    if (q.name !== undefined) {
      const name = q.name.trim();
      if (!name) throw new Error("contact name must not be empty");
      c.name = name;
    }
    if (q.company_name !== undefined) c.company_name = q.company_name?.trim() || null;
    if (q.email !== undefined) c.email = q.email?.trim() || null;
    if (q.phone !== undefined) c.phone = q.phone?.trim() || null;
    if (q.billing_address !== undefined)
      c.billing_address = q.billing_address?.trim() || null;
    if (q.shipping_address !== undefined)
      c.shipping_address = q.shipping_address?.trim() || null;
    if (q.tax_number !== undefined) c.tax_number = q.tax_number?.trim() || null;
    if (q.payment_terms_days !== undefined) {
      if (q.payment_terms_days !== null && q.payment_terms_days < 0)
        throw new Error("payment terms must be zero or more days");
      c.payment_terms_days = q.payment_terms_days ?? null;
    }
    if (q.credit_limit_minor !== undefined) {
      if (q.credit_limit_minor !== null && q.credit_limit_minor < 0)
        throw new Error("credit limit must not be negative");
      c.credit_limit_minor = q.credit_limit_minor ?? null;
    }
    if (q.notes !== undefined) c.notes = q.notes?.trim() || null;
    if (q.is_active !== undefined) c.is_active = q.is_active;
    c.updated_at = new Date().toISOString();
    return clone(c);
  },

  /** Mirrors core's ON DELETE RESTRICT: a contact with trade history stays. */
  contact_remove: async (q: { id: string }): Promise<null> => {
    const c = requireContact(q.id);
    const used =
      salesOrders.some((o) => o.contact_id === c.id) ||
      invoices.some((v) => v.contact_id === c.id) ||
      purchaseOrders.some((p) => p.supplier_id === c.id);
    if (used)
      throw new Error(
        "this contact has orders or invoices against it and cannot be deleted",
      );
    contacts.splice(contacts.indexOf(c), 1);
    return null;
  },

  // -- purchasing: purchase orders, their line items, and goods receipts
  // (Phase 6.4). Suppliers and product variants have no mock dataset of
  // their own yet (Contacts/Catalogue are Phase 6.2/6.3a, not wired to the
  // desktop at all) — `supplier_id`/`variant_id` are accepted and stored
  // verbatim here, the same trust boundary core itself only closes with a
  // real `contact_get`/`product_variant_get` lookup. --

  po_create: async (q: NewPurchaseOrder): Promise<PurchaseOrder> => {
    const poNumber = q.po_number.trim();
    if (!poNumber) throw new Error("purchase order number must not be empty");
    if (
      purchaseOrders.some(
        (p) => p.book_id === q.book_id && p.po_number === poNumber,
      )
    )
      throw new Error(`a purchase order numbered "${poNumber}" already exists in this book`);
    // Core refuses both of these and the mock did not. The role check is the
    // one worth having: ordering from a contact marked customer-only is a
    // data-entry slip the schema cannot catch, because one contacts table
    // holds both sides of trade.
    requireSupplierRole(q.supplier_id);
    if ((q.tax_minor ?? 0) < 0)
      throw new Error("purchase order tax must not be negative");
    const now = new Date().toISOString();
    const taxMinor = q.tax_minor ?? 0;
    const created: PurchaseOrder = {
      id: id("po00"),
      book_id: q.book_id,
      supplier_id: q.supplier_id,
      location_id: q.location_id,
      po_number: poNumber,
      order_date: q.order_date,
      expected_delivery: q.expected_delivery ?? null,
      status: "draft",
      subtotal_minor: 0,
      tax_minor: taxMinor,
      total_minor: taxMinor,
      currency: q.currency,
      notes: q.notes?.trim() || null,
      created_at: now,
      updated_at: now,
    };
    purchaseOrders.push(created);
    return clone(created);
  },

  po_get: async (q: { po_id: string }): Promise<PurchaseOrder> =>
    clone(requirePo(q.po_id)),

  po_list: async (q: { book_id: string }): Promise<PurchaseOrder[]> =>
    clone(
      purchaseOrders
        .filter((p) => p.book_id === q.book_id)
        .sort((a, b) => b.order_date.localeCompare(a.order_date)),
    ),

  po_update: async (q: PoUpdateRequest): Promise<PurchaseOrder> => {
    const po = requirePo(q.id);
    // The same guards `po_create` applies — reassigning a PO to a
    // customer-only contact is the same mistake as opening one that way, and
    // it was possible here after being closed there.
    if (q.supplier_id !== undefined) {
      requireSupplierRole(q.supplier_id);
      po.supplier_id = q.supplier_id;
    }
    if (q.location_id !== undefined) po.location_id = q.location_id;
    if (q.po_number !== undefined) {
      const poNumber = q.po_number.trim();
      if (!poNumber) throw new Error("purchase order number must not be empty");
      po.po_number = poNumber;
    }
    if (q.order_date !== undefined) po.order_date = q.order_date;
    if (q.expected_delivery !== undefined)
      po.expected_delivery = q.expected_delivery ?? null;
    if (q.tax_minor !== undefined) {
      if (q.tax_minor < 0)
        throw new Error("purchase order tax must not be negative");
      po.tax_minor = q.tax_minor;
      po.total_minor = po.subtotal_minor + q.tax_minor;
    }
    if (q.notes !== undefined) po.notes = q.notes?.trim() || null;
    po.updated_at = new Date().toISOString();
    return clone(po);
  },

  /** `draft -> ordered -> cancelled`, never reversible — mirrors
   * `CoreService::po_status_transition_allowed`. */
  po_set_status: async (q: {
    po_id: string;
    status: PurchaseOrder["status"];
  }): Promise<PurchaseOrder> => {
    const po = requirePo(q.po_id);
    const allowed =
      (po.status === "draft" && (q.status === "ordered" || q.status === "cancelled")) ||
      (po.status === "ordered" && q.status === "cancelled");
    if (!allowed)
      throw new Error(`invalid status transition: ${po.status} -> ${q.status}`);
    po.status = q.status;
    po.updated_at = new Date().toISOString();
    return clone(po);
  },

  po_delete: async (q: { po_id: string }): Promise<null> => {
    const po = requirePo(q.po_id);
    const lineIds = purchaseOrderItems
      .filter((i) => i.purchase_order_id === po.id)
      .map((i) => i.id);
    if (poReceipts.some((r) => lineIds.includes(r.purchase_order_item_id)))
      throw new Error(
        "cannot delete a purchase order with a receipt against one of its lines",
      );
    for (const lineId of lineIds) {
      const i = purchaseOrderItems.findIndex((x) => x.id === lineId);
      if (i !== -1) purchaseOrderItems.splice(i, 1);
    }
    const i = purchaseOrders.findIndex((x) => x.id === po.id);
    purchaseOrders.splice(i, 1);
    return null;
  },

  po_item_add: async (q: NewPurchaseOrderItem): Promise<PurchaseOrderItem> => {
    const po = requirePo(q.purchase_order_id);
    if (po.status === "cancelled")
      throw new Error("cannot add a line to a cancelled purchase order");
    if (q.qty_ordered <= 0)
      throw new Error("purchase order line quantity must be positive");
    const unitPriceMinor = q.unit_price_minor ?? 0;
    if (unitPriceMinor < 0)
      throw new Error("purchase order line unit price must not be negative");
    const now = new Date().toISOString();
    const created: PurchaseOrderItem = {
      id: id("poi0"),
      purchase_order_id: po.id,
      book_id: po.book_id,
      variant_id: q.variant_id,
      qty_ordered: q.qty_ordered,
      unit_price_minor: unitPriceMinor,
      total_minor: q.qty_ordered * unitPriceMinor,
      created_at: now,
      updated_at: now,
    };
    purchaseOrderItems.push(created);
    recalcPoTotals(po.id);
    return clone(created);
  },

  po_item_get: async (q: { item_id: string }): Promise<PurchaseOrderItem> =>
    clone(requirePoItem(q.item_id)),

  po_item_list: async (q: {
    purchase_order_id: string;
  }): Promise<PurchaseOrderItem[]> =>
    clone(
      purchaseOrderItems.filter((i) => i.purchase_order_id === q.purchase_order_id),
    ),

  po_item_update: async (
    q: PoItemUpdateRequest,
  ): Promise<PurchaseOrderItem> => {
    const item = requirePoItem(q.id);
    // Core refuses this and the mock did not: a cancelled order is finished,
    // and editing its lines would rewrite what was ordered after the fact.
    const po = purchaseOrders.find((p) => p.id === item.purchase_order_id);
    if (po?.status === "cancelled")
      throw new Error("cannot edit a line on a cancelled purchase order");
    if (q.qty_ordered !== undefined) {
      if (q.qty_ordered <= 0)
        throw new Error("purchase order line quantity must be positive");
      const received = receivedQtyForItem(item.id);
      if (q.qty_ordered < received)
        throw new Error(
          `cannot reduce ordered quantity to ${q.qty_ordered}; ${received} has already been received against this line`,
        );
      item.qty_ordered = q.qty_ordered;
    }
    if (q.unit_price_minor !== undefined) {
      if (q.unit_price_minor < 0)
        throw new Error("purchase order line unit price must not be negative");
      item.unit_price_minor = q.unit_price_minor;
    }
    item.total_minor = item.qty_ordered * item.unit_price_minor;
    item.updated_at = new Date().toISOString();
    recalcPoTotals(item.purchase_order_id);
    return clone(item);
  },

  po_item_delete: async (q: { item_id: string }): Promise<null> => {
    const item = requirePoItem(q.item_id);
    if (poReceipts.some((r) => r.purchase_order_item_id === item.id))
      throw new Error("cannot delete a line with a receipt against it");
    const i = purchaseOrderItems.findIndex((x) => x.id === item.id);
    purchaseOrderItems.splice(i, 1);
    recalcPoTotals(item.purchase_order_id);
    return null;
  },

  /** Record one goods receipt against a line. There is no mock stock ledger
   * to write into (Phase 6.3b has no desktop surface of its own either) —
   * this records the receipt fact only, the half of the keystone invariant
   * this mock dataset can actually represent. */
  po_receive: async (q: NewPoReceipt): Promise<PoReceipt> => {
    const item = requirePoItem(q.purchase_order_item_id);
    const po = requirePo(item.purchase_order_id);
    if (po.status === "cancelled")
      throw new Error("cannot receive against a cancelled purchase order");
    if (q.qty === 0)
      throw new Error("goods receipt quantity must not be zero");
    const created: PoReceipt = {
      id: id("prc0"),
      book_id: item.book_id,
      purchase_order_item_id: item.id,
      location_id: q.location_id,
      qty: q.qty,
      note: q.note?.trim() || null,
      received_by: q.received_by?.trim() || null,
      created_at: new Date().toISOString(),
    };
    poReceipts.push(created);
    return clone(created);
  },

  po_receipts_for_item: async (q: { item_id: string }): Promise<PoReceipt[]> =>
    clone(poReceipts.filter((r) => r.purchase_order_item_id === q.item_id)),

  po_receipts_for_po: async (q: {
    purchase_order_id: string;
  }): Promise<PoReceipt[]> => {
    const lineIds = new Set(
      purchaseOrderItems
        .filter((i) => i.purchase_order_id === q.purchase_order_id)
        .map((i) => i.id),
    );
    return clone(poReceipts.filter((r) => lineIds.has(r.purchase_order_item_id)));
  },

  po_item_received_qty: async (q: { item_id: string }): Promise<number> =>
    receivedQtyForItem(q.item_id),

  po_item_receiving_status: async (q: {
    item_id: string;
  }): Promise<PoReceiptStatus> => {
    const item = requirePoItem(q.item_id);
    return receiptStatusFrom(receivedQtyForItem(item.id), item.qty_ordered);
  },

  po_items_with_receiving: async (q: {
    purchase_order_id: string;
  }): Promise<PurchaseOrderItemReceiving[]> =>
    clone(
      purchaseOrderItems
        .filter((i) => i.purchase_order_id === q.purchase_order_id)
        .map((item) => {
          const received_qty = receivedQtyForItem(item.id);
          return {
            item,
            received_qty,
            status: receiptStatusFrom(received_qty, item.qty_ordered),
          };
        }),
    ),

  po_receiving_status: async (q: {
    purchase_order_id: string;
  }): Promise<PoReceiptStatus> => {
    const rows = purchaseOrderItems.filter(
      (i) => i.purchase_order_id === q.purchase_order_id,
    );
    if (rows.length === 0) return "none";
    const statuses = rows.map((item) =>
      receiptStatusFrom(receivedQtyForItem(item.id), item.qty_ordered),
    );
    if (statuses.every((s) => s === "complete")) return "complete";
    if (statuses.every((s) => s === "none")) return "none";
    return "partial";
  },

  // -- sales orders & invoicing (Phase 6.5). Empty by default, like
  // purchasing above: no screen calls these yet (ROADMAP.md 6.9).
  //
  // What this mock does NOT simulate, deliberately, so nobody reads a green
  // screen as proof the real thing works: confirming an order does not move
  // stock and cancelling does not write a compensating movement (this mock has
  // no stock ledger at all, exactly as the purchasing mock has none), and
  // `report_aged_receivables` uses the contact id in place of a name because
  // there is no contacts store here either. Numbering, draft-only editing,
  // invoice immutability and the derived totals ARE modelled, because those
  // are the behaviours a screen has to be written against. --

  sales_order_create: async (q: NewSalesOrder): Promise<SalesOrder> => {
    const now = new Date().toISOString();
    const created: SalesOrder = {
      id: id("so00"),
      book_id: q.book_id,
      contact_id: q.contact_id,
      location_id: q.location_id ?? null,
      number: nextNumber(q.book_id, "sales_order"),
      order_date: q.order_date ?? now.slice(0, 10),
      status: "draft",
      currency: q.currency ?? book.currency,
      notes: q.notes?.trim() || null,
      confirmed_at: null,
      cancelled_at: null,
      paid_at: null,
      created_at: now,
      updated_at: now,
    };
    salesOrders.push(created);
    return clone(created);
  },

  sales_order_get: async (q: { id: string }): Promise<SalesOrder> =>
    clone(requireOrder(q.id)),

  sales_order_list: async (q: { book_id: string }): Promise<SalesOrder[]> =>
    clone(
      salesOrders
        .filter((o) => o.book_id === q.book_id)
        .sort((a, b) => b.number - a.number),
    ),

  sales_order_update: async (
    q: SalesOrderUpdateRequest,
  ): Promise<SalesOrder> => {
    const order = requireOrder(q.id);
    // Core refuses this and the mock did not: once an order is confirmed it
    // has moved stock, so its header is no longer a draft to edit.
    requireDraft(order, "edited");
    // `null` clears, an absent key leaves alone — the same three states the
    // core patch structs spell out. See types.ts.
    if (q.location_id !== undefined) order.location_id = q.location_id;
    if (q.order_date !== undefined) order.order_date = q.order_date;
    if (q.notes !== undefined) order.notes = q.notes?.trim() || null;
    order.updated_at = new Date().toISOString();
    return clone(order);
  },

  sales_order_delete: async (q: { id: string }): Promise<null> => {
    const order = requireOrder(q.id);
    requireDraft(order, "deleted");
    salesOrders.splice(salesOrders.indexOf(order), 1);
    for (let i = salesOrderItems.length - 1; i >= 0; i -= 1) {
      if (salesOrderItems[i].sales_order_id === order.id)
        salesOrderItems.splice(i, 1);
    }
    return null;
  },

  sales_order_item_add: async (
    q: NewSalesOrderItem,
  ): Promise<SalesOrderItem> => {
    const order = requireOrder(q.sales_order_id);
    requireDraft(order, "changed");
    if (q.quantity <= 0) throw new Error("quantity must be greater than zero");
    const description = q.description?.trim();
    if (!description)
      throw new Error("a line without a variant needs a description");
    if (q.unit_price_minor === undefined)
      throw new Error("a line without a variant needs a unit price");
    const now = new Date().toISOString();
    const created: SalesOrderItem = {
      id: id("soi0"),
      sales_order_id: order.id,
      book_id: order.book_id,
      variant_id: q.variant_id ?? null,
      description,
      quantity: q.quantity,
      unit_price_minor: q.unit_price_minor,
      tax_rate_bps: q.tax_rate_bps ?? 0,
      line_order: salesOrderItems.filter(
        (i) => i.sales_order_id === order.id,
      ).length,
      created_at: now,
      updated_at: now,
    };
    salesOrderItems.push(created);
    return clone(created);
  },

  sales_order_items_list: async (q: {
    sales_order_id: string;
  }): Promise<SalesOrderItem[]> =>
    clone(
      salesOrderItems
        .filter((i) => i.sales_order_id === q.sales_order_id)
        .sort((a, b) => a.line_order - b.line_order),
    ),

  sales_order_item_update: async (
    q: SalesOrderItemUpdateRequest,
  ): Promise<SalesOrderItem> => {
    const item = salesOrderItems.find((i) => i.id === q.id);
    if (!item) throw new Error(`no sales order line with id ${q.id}`);
    requireDraft(requireOrder(item.sales_order_id), "changed");
    if (q.description !== undefined) {
      const description = q.description.trim();
      if (!description)
        throw new Error("sales order line description must not be empty");
      item.description = description;
    }
    if (q.quantity !== undefined) {
      if (q.quantity <= 0)
        throw new Error("sales order line quantity must be positive");
      item.quantity = q.quantity;
    }
    if (q.unit_price_minor !== undefined) {
      if (q.unit_price_minor < 0)
        throw new Error("sales order line unit price must not be negative");
      item.unit_price_minor = q.unit_price_minor;
    }
    if (q.tax_rate_bps !== undefined) {
      if (q.tax_rate_bps < 0 || q.tax_rate_bps > 10_000)
        throw new Error(
          "sales order line tax rate must be between 0 and 10000 basis points",
        );
      item.tax_rate_bps = q.tax_rate_bps;
    }
    item.updated_at = new Date().toISOString();
    return clone(item);
  },

  sales_order_item_remove: async (q: { id: string }): Promise<null> => {
    const idx = salesOrderItems.findIndex((i) => i.id === q.id);
    if (idx < 0) throw new Error(`no sales order line with id ${q.id}`);
    requireDraft(requireOrder(salesOrderItems[idx].sales_order_id), "changed");
    salesOrderItems.splice(idx, 1);
    return null;
  },

  sales_order_confirm: async (q: { id: string }): Promise<SalesOrder> => {
    const order = requireOrder(q.id);
    requireDraft(order, "confirmed");
    const lines = salesOrderItems.filter((i) => i.sales_order_id === order.id);
    if (lines.length === 0)
      throw new Error("an order with no lines cannot be confirmed");
    // Core refuses this and the mock did not: a stock-tracked line has to
    // come out of somewhere, so confirming one without a location would be a
    // movement with no location to write it against.
    if (lines.some((i) => i.variant_id !== null) && order.location_id === null)
      throw new Error(
        "cannot confirm: this order has stock-tracked line items but no location set",
      );
    order.status = "confirmed";
    order.confirmed_at = new Date().toISOString();
    order.updated_at = order.confirmed_at;
    return clone(order);
  },

  sales_order_cancel: async (q: { id: string }): Promise<SalesOrder> => {
    const order = requireOrder(q.id);
    if (order.status === "cancelled" || order.status === "paid")
      throw new Error(`a ${order.status} order cannot be cancelled`);
    order.status = "cancelled";
    order.cancelled_at = new Date().toISOString();
    order.updated_at = order.cancelled_at;
    return clone(order);
  },

  sales_order_mark_paid: async (q: { id: string }): Promise<SalesOrder> => {
    const order = requireOrder(q.id);
    if (order.status !== "confirmed")
      throw new Error("only a confirmed order can be marked paid");
    order.status = "paid";
    order.paid_at = new Date().toISOString();
    order.updated_at = order.paid_at;
    return clone(order);
  },

  sales_order_totals: async (q: { id: string }): Promise<SalesOrderTotals> => {
    requireOrder(q.id);
    return totalsOf(
      salesOrderItems.filter((i) => i.sales_order_id === q.id),
    );
  },

  invoice_issue: async (q: NewInvoice): Promise<Invoice> => {
    const now = new Date().toISOString();
    const series = (q.series ?? "invoice").trim();
    if (!series) throw new Error("invoice numbering series must not be empty");
    const issueDate = q.issue_date ?? now.slice(0, 10);
    if (q.due_date < issueDate)
      throw new Error("invoice due date must not be before its issue date");
    let contactId = q.contact_id ?? null;
    let lines = q.items ?? [];
    if (q.sales_order_id) {
      const order = requireOrder(q.sales_order_id);
      // An invoice is a fact about a sale that happened. A draft order has
      // not happened yet, and a cancelled one did not.
      if (order.status !== "confirmed" && order.status !== "paid")
        throw new Error(
          "cannot issue an invoice from a sales order that is not confirmed or paid",
        );
      contactId = contactId ?? order.contact_id;
      if (lines.length === 0)
        lines = salesOrderItems
          .filter((i) => i.sales_order_id === order.id)
          .map((i) => ({
            variant_id: i.variant_id,
            description: i.description,
            quantity: i.quantity,
            unit_price_minor: i.unit_price_minor,
            tax_rate_bps: i.tax_rate_bps,
          }));
    }
    if (!contactId)
      throw new Error("an invoice needs a contact, or an order that has one");
    if (lines.length === 0) throw new Error("an invoice needs at least one line");
    for (const line of lines) {
      if (line.quantity <= 0)
        throw new Error("invoice line quantity must be positive");
      if (line.unit_price_minor < 0)
        throw new Error("invoice line unit price must not be negative");
      const bps = line.tax_rate_bps ?? 0;
      if (bps < 0 || bps > 10_000)
        throw new Error(
          "invoice line tax rate must be between 0 and 10000 basis points",
        );
    }
    const created: Invoice = {
      id: id("inv0"),
      book_id: q.book_id,
      contact_id: contactId,
      sales_order_id: q.sales_order_id ?? null,
      series,
      number: nextNumber(q.book_id, series),
      issue_date: issueDate,
      due_date: q.due_date,
      currency: q.currency ?? book.currency,
      notes: q.notes?.trim() || null,
      created_at: now,
    };
    invoices.push(created);
    lines.forEach((line, i) => {
      invoiceItems.push({
        id: id("ivi0"),
        invoice_id: created.id,
        book_id: created.book_id,
        variant_id: line.variant_id ?? null,
        description: line.description,
        quantity: line.quantity,
        unit_price_minor: line.unit_price_minor,
        tax_rate_bps: line.tax_rate_bps ?? 0,
        line_order: i,
        created_at: now,
      });
    });
    return clone(created);
  },

  invoice_get: async (q: { id: string }): Promise<Invoice> =>
    clone(requireInvoice(q.id)),

  invoice_list: async (q: { book_id: string }): Promise<Invoice[]> =>
    clone(
      invoices
        .filter((v) => v.book_id === q.book_id)
        .sort((a, b) => b.number - a.number),
    ),

  invoice_items_list: async (q: {
    invoice_id: string;
  }): Promise<InvoiceItem[]> =>
    clone(
      invoiceItems
        .filter((i) => i.invoice_id === q.invoice_id)
        .sort((a, b) => a.line_order - b.line_order),
    ),

  invoice_totals: async (q: { id: string }): Promise<InvoiceTotals> => {
    requireInvoice(q.id);
    return invoiceTotalsFor(q.id);
  },

  invoice_payment_record: async (
    q: NewInvoicePayment,
  ): Promise<InvoicePayment> => {
    const invoice = requireInvoice(q.invoice_id);
    if (q.amount_minor <= 0)
      throw new Error("a payment amount must be greater than zero");
    const now = new Date().toISOString();
    const created: InvoicePayment = {
      id: id("ivp0"),
      invoice_id: invoice.id,
      book_id: invoice.book_id,
      amount_minor: q.amount_minor,
      paid_at: q.paid_at ?? now,
      method: q.method?.trim() || null,
      note: q.note?.trim() || null,
      created_at: now,
    };
    invoicePayments.push(created);
    return clone(created);
  },

  invoice_payments_list: async (q: {
    invoice_id: string;
  }): Promise<InvoicePayment[]> =>
    clone(invoicePayments.filter((p) => p.invoice_id === q.invoice_id)),

  report_aged_receivables: async (q: {
    book_id: string;
    as_of?: string;
  }): Promise<AgedReceivables> => {
    const asOf = q.as_of ?? new Date().toISOString().slice(0, 10);
    const byContact = new Map<string, AgedBucket>();
    for (const invoice of invoices.filter((v) => v.book_id === q.book_id)) {
      const { due_minor } = invoiceTotalsFor(invoice.id);
      if (due_minor <= 0) continue;
      const bucket = byContact.get(invoice.contact_id) ?? emptyBucket();
      bucketFor(bucket, daysBetween(invoice.due_date, asOf), due_minor);
      byContact.set(invoice.contact_id, bucket);
    }
    const totals = emptyBucket();
    const rows: AgedReceivablesRow[] = [...byContact.entries()].map(
      ([contact_id, buckets]) => {
        addBucket(totals, buckets);
        // No contacts store in this mock — the id stands in for the name.
        return { contact_id, contact_name: contact_id, buckets };
      },
    );
    return { as_of: asOf, rows, totals };
  },

  data_status: async (): Promise<DataStatus> =>
    clone({ ...dataState, cloud_sync_hint: mockCloudHint(dataState.data_dir) }),

  data_move: async (q: DataMoveRequest): Promise<DataStatus> => {
    const target = q.target.trim();
    if (!target) throw new Error("enter a destination folder");
    if (!target.startsWith("/") && !target.startsWith("~"))
      throw new Error(`enter an absolute path (got "${target}")`);
    if (target === dataState.data_dir)
      throw new Error("the target is the current data folder");
    if (target.startsWith(`${dataState.data_dir}/`))
      throw new Error(
        `the target ${target} is inside the current data folder ${dataState.data_dir} — pick a folder outside it`,
      );
    // Deterministic stand-in for the offer-open case (real detection is a
    // slipscan.db in the target folder).
    if (!q.use_existing && target.includes("existing"))
      throw new Error(
        `the target folder already contains a SlipScan database (${target}/slipscan.db) — open that database instead, or pick an empty folder`,
      );
    // The real move is a single long await (copy + verify + switch).
    await new Promise((r) => setTimeout(r, 1200));
    dataState.data_dir = target;
    dataState.db_path = `${target}/slipscan.db`;
    dataState.documents_dir = `${target}/documents`;
    dataState.pointer_set = true;
    dataState.is_default_location = false;
    return clone({ ...dataState, cloud_sync_hint: mockCloudHint(target) });
  },

  account_list: async (_q: { book_id: string }): Promise<Account[]> =>
    clone(accounts),

  networth_capture: async (q: {
    book_id: string;
    as_of_date?: string;
  }): Promise<NetWorthSnapshot[]> => {
    const latest = networthHistory[networthHistory.length - 1];
    const asOf = q.as_of_date ?? latest.date;
    const now = new Date().toISOString();
    return clone(
      accounts.map((a, i) => ({
        id: id("nws"),
        book_id: q.book_id,
        account_id: a.id,
        as_of_date: asOf,
        balance_minor: latest.totals[i],
        currency: a.currency,
        source: "captured" as const,
        created_at: now,
      })),
    );
  },

  // Mock history is already "backfilled" — nothing new to create.
  networth_backfill: async (_q: { book_id: string }): Promise<NetWorthSnapshot[]> =>
    clone([]),

  networth_series: async (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<NetWorthSeries> => {
    const points = networthPoints().filter(
      (p) => p.as_of_date >= q.from && p.as_of_date <= q.to,
    );
    return clone({
      book_id: q.book_id,
      currency: book.currency,
      points,
      conversions: [],
    });
  },

  transaction_list: async (q: TransactionListQuery): Promise<Transaction[]> => {
    let rows = transactions.slice();
    if (q.account_id) rows = rows.filter((t) => t.account_id === q.account_id);
    if (q.category_id)
      rows = rows.filter((t) => t.category_id === q.category_id);
    if (q.search) {
      const s = q.search.toLowerCase();
      rows = rows.filter(
        (t) =>
          t.description.toLowerCase().includes(s) ||
          (t.merchant ?? "").toLowerCase().includes(s),
      );
    }
    rows.sort((a, b) => (a.posted_at < b.posted_at ? 1 : -1));
    if (q.offset) rows = rows.slice(q.offset);
    if (q.limit) rows = rows.slice(0, q.limit);
    return clone(rows);
  },

  transaction_categorize: async (q: {
    transaction_id: string;
    category_id: string | null;
  }): Promise<Transaction> => {
    const tx = transactions.find((t) => t.id === q.transaction_id);
    if (!tx) throw new Error(`transaction not found: ${q.transaction_id}`);
    tx.category_id = q.category_id;
    return clone(tx);
  },

  category_list: async (_q: { book_id: string }): Promise<Category[]> =>
    clone(categories),

  // -- household members & per-person attribution: local data, never a
  // login (ARCHITECTURE.md "Household members & per-person attribution") --

  member_list: async (_q: { book_id: string }): Promise<Member[]> =>
    clone(members),

  member_add: async (q: NewMember): Promise<Member> => {
    const label = q.label.trim();
    if (!label) throw new Error("member label must not be empty");
    if (members.some((m) => m.book_id === q.book_id && m.label === label))
      throw new Error(`a member named "${label}" already exists in this book`);
    if (q.default_account_id && !accounts.some((a) => a.id === q.default_account_id))
      throw new Error(`account not found: ${q.default_account_id}`);
    const palette = ["#6f9200", "#6a6fbf", "#007fa3", "#b0761f", "#b1524e"];
    const now = new Date().toISOString();
    const member: Member = {
      id: id("mb00"),
      book_id: q.book_id,
      label,
      initial: (q.initial?.trim() || label.charAt(0)).toUpperCase(),
      colour: q.colour?.trim() || palette[members.length % palette.length]!,
      default_account_id: q.default_account_id ?? null,
      created_at: now,
      updated_at: now,
    };
    members.push(member);
    return clone(member);
  },

  member_update: async (q: MemberPatch): Promise<Member> => {
    const m = members.find((x) => x.id === q.id);
    if (!m) throw new Error(`member not found: ${q.id}`);
    if (q.label !== undefined) {
      const label = q.label.trim();
      if (!label) throw new Error("member label must not be empty");
      m.label = label;
    }
    if (q.initial !== undefined) {
      const initial = q.initial.trim();
      if (!initial) throw new Error("member initial must not be empty");
      m.initial = initial;
    }
    if (q.colour !== undefined) {
      const colour = q.colour.trim();
      if (!colour) throw new Error("member colour must not be empty");
      m.colour = colour;
    }
    if (q.default_account_id !== undefined) {
      if (
        q.default_account_id !== null &&
        !accounts.some((a) => a.id === q.default_account_id)
      )
        throw new Error(`account not found: ${q.default_account_id}`);
      m.default_account_id = q.default_account_id;
    }
    m.updated_at = new Date().toISOString();
    return clone(m);
  },

  member_remove: async (q: { id: string; reassign_to?: string }): Promise<null> => {
    const idx = members.findIndex((m) => m.id === q.id);
    if (idx === -1) throw new Error(`member not found: ${q.id}`);
    const attributed =
      transactions.some((t) => t.attributed_member_id === q.id) ||
      transactionSplits.some((s) => s.member_id === q.id);
    if (attributed) {
      if (!q.reassign_to)
        throw new Error(
          `member ${q.id} still has attributed transactions or splits — pass a ` +
            "reassign-target member to move them first, or clear the attributions/splits before removing",
        );
      if (q.reassign_to === q.id)
        throw new Error("cannot reassign a member's attributions to themselves");
      const target = members.find((m) => m.id === q.reassign_to);
      if (!target) throw new Error(`member not found: ${q.reassign_to}`);
      for (const t of transactions) {
        if (t.attributed_member_id === q.id) t.attributed_member_id = target.id;
      }
      for (const s of transactionSplits) {
        if (s.member_id === q.id) s.member_id = target.id;
      }
      // Merge duplicate (transaction, member) split rows on conflict, same
      // as core's `repo::member::reassign_attributions`.
      const merged = new Map<string, TransactionSplit>();
      const next: TransactionSplit[] = [];
      for (const s of transactionSplits) {
        const key = `${s.transaction_id}:${s.member_id}`;
        const existing = merged.get(key);
        if (existing) {
          existing.share_minor += s.share_minor;
        } else {
          merged.set(key, s);
          next.push(s);
        }
      }
      transactionSplits = next;
    }
    members.splice(idx, 1);
    return null;
  },

  transaction_attribute: async (q: {
    transaction_id: string;
    member_id: string | null;
  }): Promise<Transaction> => {
    const tx = transactions.find((t) => t.id === q.transaction_id);
    if (!tx) throw new Error(`transaction not found: ${q.transaction_id}`);
    if (q.member_id && !members.some((m) => m.id === q.member_id))
      throw new Error(`member not found: ${q.member_id}`);
    tx.attributed_member_id = q.member_id;
    return clone(tx);
  },

  transaction_splits_list: async (q: {
    transaction_id: string;
  }): Promise<TransactionSplit[]> =>
    clone(transactionSplits.filter((s) => s.transaction_id === q.transaction_id)),

  transaction_split_set: async (q: {
    transaction_id: string;
    shares: SplitShare[];
  }): Promise<TransactionSplit[]> => {
    const tx = transactions.find((t) => t.id === q.transaction_id);
    if (!tx) throw new Error(`transaction not found: ${q.transaction_id}`);
    const target = Math.abs(tx.amount_minor);
    const seen = new Set<string>();
    let sum = 0;
    for (const share of q.shares) {
      if (seen.has(share.member_id))
        throw new Error(`member ${share.member_id} appears more than once in the split`);
      seen.add(share.member_id);
      if (share.share_minor <= 0) throw new Error("split shares must be positive");
      if (!members.some((m) => m.id === share.member_id))
        throw new Error(`member not found: ${share.member_id}`);
      sum += share.share_minor;
    }
    if (q.shares.length > 0 && sum !== target)
      throw new Error(
        `split shares must sum to the transaction's absolute amount (${target} minor units), got ${sum}`,
      );
    transactionSplits = transactionSplits.filter((s) => s.transaction_id !== q.transaction_id);
    const now = new Date().toISOString();
    for (const share of q.shares) {
      transactionSplits.push({
        id: id("ts00"),
        transaction_id: q.transaction_id,
        member_id: share.member_id,
        share_minor: share.share_minor,
        created_at: now,
      });
    }
    return clone(transactionSplits.filter((s) => s.transaction_id === q.transaction_id));
  },

  report_member_expense: async (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<MemberAmountRow[]> => clone(memberAmount(q.from, q.to, true)),

  report_member_contribution: async (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<MemberAmountRow[]> => clone(memberAmount(q.from, q.to, false)),

  report_member_category: async (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<MemberCategoryRow[]> => clone(memberCategoryReport(q.from, q.to)),

  report_settle_up: async (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<MemberSettleRow[]> => clone(settleUp(q.from, q.to)),

  budget_list: async (q: {
    book_id: string;
    month: string;
  }): Promise<BudgetWithSpend[]> =>
    clone(
      budgets
        .filter((b) => b.month === q.month)
        .map((b) => {
          const spent = transactions
            .filter(
              (t) =>
                t.category_id === b.category_id &&
                t.amount_minor < 0 &&
                t.posted_at.startsWith(q.month),
            )
            .reduce((sum, t) => sum + -t.amount_minor, 0);
          return {
            ...b,
            category_name:
              categories.find((c) => c.id === b.category_id)?.name ?? "—",
            spent_minor: spent,
          };
        }),
    ),

  budget_upsert: async (q: BudgetUpsert): Promise<Budget> => {
    const existing = budgets.find(
      (b) => b.category_id === q.category_id && b.month === q.month,
    );
    if (existing) {
      existing.amount_minor = q.amount_minor;
      existing.rollover = q.rollover;
      return clone(existing);
    }
    const created: Budget = {
      id: id("bg00"),
      created_at: new Date().toISOString(),
      ...q,
    };
    budgets.push(created);
    return clone(created);
  },

  document_list: async (_q: { book_id: string }): Promise<Document[]> =>
    clone(
      documents
        .slice()
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    ),

  document_get: async (q: { document_id: string }): Promise<Document> => {
    const doc = documents.find((d) => d.id === q.document_id);
    if (!doc) throw new Error(`document not found: ${q.document_id}`);
    return clone(doc);
  },

  document_import: async (q: DocumentImportRequest): Promise<Document> => {
    const doc: Document = {
      id: id("dc00"),
      book_id: q.book_id,
      kind: "receipt",
      status: "pending",
      file_name: q.file_name,
      mime_type: q.mime_type,
      extraction: null,
      merchant: null,
      issued_at: null,
      total_minor: null,
      currency: "ZAR",
      created_at: new Date().toISOString(),
    };
    documents.unshift(doc);
    return clone(doc);
  },

  document_review: async (q: DocumentReviewRequest): Promise<Document> => {
    const doc = documents.find((d) => d.id === q.document_id);
    if (!doc) throw new Error(`document not found: ${q.document_id}`);
    doc.extraction = structuredClone(q.extraction);
    doc.status = "reviewed";
    doc.merchant = q.extraction.merchant;
    doc.issued_at = q.extraction.issued_at;
    doc.total_minor = q.extraction.total_minor;
    doc.currency = q.extraction.currency;
    return clone(doc);
  },

  ledger_account_list: async (_q: {
    book_id: string;
  }): Promise<LedgerAccount[]> => clone(ledgerAccounts),

  journal_list: async (_q: { book_id: string }): Promise<JournalEntry[]> =>
    clone(journalEntries),

  journal_post: async (q: JournalPostRequest): Promise<JournalEntry> => {
    const debit = q.lines.reduce((s, l) => s + l.debit_minor, 0);
    const credit = q.lines.reduce((s, l) => s + l.credit_minor, 0);
    if (debit !== credit)
      throw new Error(`unbalanced entry: debit ${debit} != credit ${credit}`);
    const eid = id("je00");
    const posted: JournalEntry = {
      id: eid,
      book_id: q.book_id,
      entry_date: q.entry_date,
      memo: q.memo,
      lines: q.lines.map((l) => ({
        id: id("jl00"),
        entry_id: eid,
        ledger_account_id: l.ledger_account_id,
        ledger_account_name:
          ledgerAccounts.find((a) => a.id === l.ledger_account_id)?.name ?? "—",
        debit_minor: l.debit_minor,
        credit_minor: l.credit_minor,
      })),
      source_document_id: q.source_document_id ?? null,
      created_at: new Date().toISOString(),
    };
    journalEntries.unshift(posted);
    return clone(posted);
  },

  recon_suggest: async (_q: {
    book_id: string;
  }): Promise<ReconSuggestion[]> =>
    clone(reconSuggestions.filter((s) => s.status !== "rejected")),

  recon_confirm: async (q: ReconConfirmRequest): Promise<ReconSuggestion> => {
    const s = reconSuggestions.find((x) => x.id === q.suggestion_id);
    if (!s) throw new Error(`suggestion not found: ${q.suggestion_id}`);
    s.status = q.accept ? "confirmed" : "rejected";
    return clone(s);
  },

  report_spending: async (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<SpendingReport> => {
    const inRange = transactions.filter(
      (t) =>
        t.amount_minor < 0 &&
        // Compare on the date part: a `YYYY-MM-DD` range bound must include
        // the whole last day, and `...T00:00:00Z` > `YYYY-MM-DD` otherwise.
        t.posted_at.slice(0, 10) >= q.from &&
        t.posted_at.slice(0, 10) <= q.to &&
        categories.find((c) => c.id === t.category_id)?.kind !== "transfer",
    );
    const total = inRange.reduce((s, t) => s + -t.amount_minor, 0);
    const byCat = new Map<string, number>();
    for (const t of inRange) {
      const key = t.category_id ?? "uncategorized";
      byCat.set(key, (byCat.get(key) ?? 0) + -t.amount_minor);
    }
    return {
      book_id: q.book_id,
      from: q.from,
      to: q.to,
      currency: "ZAR",
      total_spent_minor: total,
      by_category: [...byCat.entries()]
        .map(([category_id, amount]) => ({
          category_id,
          category_name:
            categories.find((c) => c.id === category_id)?.name ??
            "Uncategorised",
          amount_minor: amount,
          share: total === 0 ? 0 : amount / total,
        }))
        .sort((a, b) => b.amount_minor - a.amount_minor),
    };
  },

  /**
   * Six months of history. The five closed months are invented — the seeds
   * only carry the recent slice a fresh import would hold — at the
   * household's steady state: two salaries (R54 500 + R28 600) plus the
   * garden flat's R7 500, with interest capitalising quarterly.
   *
   * The current month is NOT invented: it is computed from the same seeded
   * rows every other screen reads, so the last bar can never drift away from
   * the Household, Budgets and Reports figures beside it. It is a partial
   * month (the demo clock is the 16th), which is why its expense bar is
   * short while its income is already whole — the household is paid on the
   * 15th.
   */
  report_income_expense: async (_q: {
    book_id: string;
  }): Promise<IncomeExpenseReport> => ({
    book_id: BOOK_ID,
    currency: "ZAR",
    months: [
      { month: "2026-02", income_minor: 9_060_000, expense_minor: 3_310_400 },
      { month: "2026-03", income_minor: 9_060_000, expense_minor: 3_642_210 },
      { month: "2026-04", income_minor: 9_072_384, expense_minor: 2_980_770 },
      { month: "2026-05", income_minor: 9_060_000, expense_minor: 3_871_120 },
      { month: "2026-06", income_minor: 9_060_000, expense_minor: 3_120_450 },
      { month: "2026-07", ...seededMonthTotals("2026-07") },
    ],
  }),

  /**
   * Real per-account totals from the seeded journal entries, filtered to
   * the requested range — the same shape (and the same journal rows) the
   * trial balance below reads, so an income statement and the trial
   * balance can never quietly disagree about what was posted.
   */
  report_income_statement: async (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<IncomeStatement> => {
    const inRange = journalEntries.filter(
      (e) => e.entry_date >= q.from && e.entry_date <= q.to,
    );
    const byAccount = new Map<string, { debit: number; credit: number }>();
    for (const e of inRange) {
      for (const l of e.lines) {
        const totals = byAccount.get(l.ledger_account_id) ?? {
          debit: 0,
          credit: 0,
        };
        totals.debit += l.debit_minor;
        totals.credit += l.credit_minor;
        byAccount.set(l.ledger_account_id, totals);
      }
    }
    const rowsFor = (kind: "income" | "expense", creditNormal: boolean) =>
      ledgerAccounts
        .filter((a) => a.type === kind)
        .map((a) => {
          const t = byAccount.get(a.id) ?? { debit: 0, credit: 0 };
          return {
            coa_id: a.id,
            code: a.code,
            name: a.name,
            kind: a.type,
            amount_minor: creditNormal ? t.credit - t.debit : t.debit - t.credit,
          };
        })
        .filter((r) => r.amount_minor !== 0);
    const income = rowsFor("income", true);
    const expenses = rowsFor("expense", false);
    const income_total_minor = income.reduce((s, r) => s + r.amount_minor, 0);
    const expense_total_minor = expenses.reduce((s, r) => s + r.amount_minor, 0);
    return {
      book_id: q.book_id,
      from_date: q.from,
      to_date: q.to,
      currency: "ZAR",
      income,
      expenses,
      income_total_minor,
      expense_total_minor,
      net_profit_minor: income_total_minor - expense_total_minor,
    };
  },

  /**
   * As-of totals from the same seeded journal entries — an earlier
   * `as_of` genuinely sees fewer of them, so this behaves like the real
   * report rather than a fixed snapshot.
   */
  report_balance_sheet: async (q: {
    book_id: string;
    as_of?: string;
  }): Promise<BalanceSheet> => {
    const asOf = q.as_of ?? "2026-07-17";
    const upTo = journalEntries.filter((e) => e.entry_date <= asOf);
    const byAccount = new Map<string, { debit: number; credit: number }>();
    for (const e of upTo) {
      for (const l of e.lines) {
        const totals = byAccount.get(l.ledger_account_id) ?? {
          debit: 0,
          credit: 0,
        };
        totals.debit += l.debit_minor;
        totals.credit += l.credit_minor;
        byAccount.set(l.ledger_account_id, totals);
      }
    }
    const rowsFor = (
      kind: "asset" | "liability" | "equity" | "income" | "expense",
      creditNormal: boolean,
    ) =>
      ledgerAccounts
        .filter((a) => a.type === kind)
        .map((a) => {
          const t = byAccount.get(a.id) ?? { debit: 0, credit: 0 };
          return {
            coa_id: a.id,
            code: a.code,
            name: a.name,
            kind: a.type,
            amount_minor: creditNormal ? t.credit - t.debit : t.debit - t.credit,
          };
        })
        .filter((r) => r.amount_minor !== 0);
    const assets = rowsFor("asset", false);
    const liabilities = rowsFor("liability", true);
    const equity = rowsFor("equity", true);
    const income = rowsFor("income", true);
    const expenses = rowsFor("expense", false);
    const retained_earnings_minor =
      income.reduce((s, r) => s + r.amount_minor, 0) -
      expenses.reduce((s, r) => s + r.amount_minor, 0);
    return {
      book_id: q.book_id,
      as_of_date: asOf,
      currency: "ZAR",
      assets,
      liabilities,
      equity,
      retained_earnings_minor,
      assets_total_minor: assets.reduce((s, r) => s + r.amount_minor, 0),
      liabilities_total_minor: liabilities.reduce((s, r) => s + r.amount_minor, 0),
      equity_total_minor:
        equity.reduce((s, r) => s + r.amount_minor, 0) + retained_earnings_minor,
    };
  },

  report_vat_summary: async (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<VatSummary> => ({
    book_id: BOOK_ID,
    from: q.from,
    to: q.to,
    currency: "ZAR",
    // Labels come from the demo book's za profile — data, not code.
    report_name: "VAT201",
    labels: {
      standard_rated_supplies: "Standard-rated supplies",
      zero_rated_supplies: "Zero-rated supplies",
      exempt_supplies: "Exempt supplies",
      output_tax: "Output VAT",
      input_tax: "Input VAT",
      net_tax: "Net VAT payable (refundable if negative)",
    },
    output_vat_minor: 0,
    input_vat_minor: 24_396,
    net_vat_minor: -24_396,
  }),

  report_trial_balance: async (_q: {
    book_id: string;
  }): Promise<TrialBalance> => {
    const rows = ledgerAccounts.map((a) => {
      const debit = journalEntries
        .flatMap((e) => e.lines)
        .filter((l) => l.ledger_account_id === a.id)
        .reduce((s, l) => s + l.debit_minor, 0);
      const credit = journalEntries
        .flatMap((e) => e.lines)
        .filter((l) => l.ledger_account_id === a.id)
        .reduce((s, l) => s + l.credit_minor, 0);
      const net = debit - credit;
      return {
        ledger_account_id: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        debit_minor: net > 0 ? net : 0,
        credit_minor: net < 0 ? -net : 0,
      };
    });
    return {
      book_id: BOOK_ID,
      as_of: "2026-07-17",
      currency: "ZAR",
      rows,
      total_debit_minor: rows.reduce((s, r) => s + r.debit_minor, 0),
      total_credit_minor: rows.reduce((s, r) => s + r.credit_minor, 0),
    };
  },

  region_list: async (): Promise<RegionInfo[]> => clone(regions),

  // -- tax rates: per-book, configurable (the generic profile's standard
  // rate seeds at 0 bps until the user sets it) --

  vat_rate_list: async (q: { book_id: string }): Promise<VatRate[]> =>
    clone(vatRates.filter((r) => r.book_id === q.book_id)),

  vat_rate_set_bps: async (q: {
    book_id: string;
    code: string;
    rate_bps: number;
  }): Promise<VatRate> => {
    if (q.rate_bps < 0 || q.rate_bps > 10_000)
      throw new Error(
        `rate_bps must be between 0 and 10000 (0%..100%), got ${q.rate_bps}`,
      );
    const rate = vatRates.find(
      (r) => r.book_id === q.book_id && r.code === q.code,
    );
    if (!rate) throw new Error(`vat_rate ${q.book_id}/${q.code} not found`);
    rate.rate_bps = q.rate_bps;
    rate.updated_at = new Date().toISOString();
    return clone(rate);
  },

  // -- FX (OpenRate) mock: mirrors core semantics — opt-in, cache-only
  // conversion, "fetch" only on explicit request (here it fabricates a
  // deterministic quote instead of any network call). --

  fx_status: async (): Promise<FxStatus> => clone(fxState),

  fx_configure: async (q: { base_url: string }): Promise<FxStatus> => {
    const trimmed = q.base_url.trim().replace(/\/+$/, "");
    if (trimmed === "") {
      fxState.configured = false;
      fxState.base_url = null;
    } else {
      if (!/^https?:\/\/\S+$/.test(trimmed))
        throw new Error(`invalid OpenRate base URL "${q.base_url}"`);
      fxState.configured = true;
      fxState.base_url = trimmed;
    }
    return clone(fxState);
  },

  fx_fetch_rate: async (q: { from: string; to: string }): Promise<FxQuote> => {
    if (!fxState.configured)
      throw new Error(
        "exchange rates are not configured: set the OpenRate base URL first",
      );
    const from = q.from.toUpperCase();
    const to = q.to.toUpperCase();
    const now = new Date().toISOString();
    const quote: FxQuote = {
      from_currency: from,
      to_currency: to,
      rate: "18.074219053",
      as_of: now,
      age_sec: 0,
      grade: "B",
      sources: ["mock"],
    };
    const cached: FxCachedRate = {
      from_currency: from,
      to_currency: to,
      rate: quote.rate,
      as_of: quote.as_of,
      grade: quote.grade,
      fetched_at: now,
      age_secs: 0,
    };
    fxState.cached_rates = fxState.cached_rates
      .filter((r) => !(r.from_currency === from && r.to_currency === to))
      .concat(cached);
    return clone(quote);
  },

  fx_convert: async (q: {
    from: string;
    to: string;
    amount_minor: number;
    rate?: string;
  }): Promise<FxConversion> => {
    const from = q.from.toUpperCase();
    const to = q.to.toUpperCase();
    if (q.rate !== undefined) {
      // Pinned-rate replay: never re-rated by the cache. Mock-only float
      // math; the real path is exact decimal × i64 in core.
      const pinned = Number(q.rate);
      if (!Number.isFinite(pinned) || pinned <= 0)
        throw new Error(`pinned rate must be positive, got "${q.rate}"`);
      return {
        from_currency: from,
        to_currency: to,
        amount_minor: q.amount_minor,
        converted_minor: Math.round(q.amount_minor * pinned),
        rate: q.rate,
        as_of: "",
        grade: "pinned",
        fetched_at: "",
        age_secs: null,
      };
    }
    if (from === to)
      return {
        from_currency: from,
        to_currency: to,
        amount_minor: q.amount_minor,
        converted_minor: q.amount_minor,
        rate: "1",
        as_of: new Date().toISOString(),
        grade: "identity",
        fetched_at: new Date().toISOString(),
        age_secs: 0,
      };
    const cached = fxState.cached_rates.find(
      (r) => r.from_currency === from && r.to_currency === to,
    );
    if (!cached)
      throw new Error(`fx_rate ${from}/${to} not found: fetch the rate first`);
    // Mock-only arithmetic; the real path does exact decimal × i64 in core.
    const converted = Math.round(q.amount_minor * Number(cached.rate));
    return {
      from_currency: from,
      to_currency: to,
      amount_minor: q.amount_minor,
      converted_minor: converted,
      rate: cached.rate,
      as_of: cached.as_of,
      grade: cached.grade,
      fetched_at: cached.fetched_at,
      age_secs: cached.age_secs,
    };
  },

  // -- Payments: same semantics as core — flat watch list, secrets returned
  // exactly once and never stored, 4xx fails fast / others retry --

  pay_watch_list: async (q: { book_id: string }): Promise<PayWatch[]> =>
    clone(payWatches.filter((w) => w.book_id === q.book_id)),

  pay_watch_add: async (q: NewPayWatch): Promise<PayWatch> => {
    const code = q.code.trim();
    if (!code) throw new Error("watch code must not be empty");
    if (q.expected_amount_minor != null) {
      if (q.expected_amount_minor <= 0)
        throw new Error(
          `expected amount ${q.expected_amount_minor} out of range: must be positive (only inbound transactions match)`,
        );
      if (!q.expected_currency)
        throw new Error(
          'an exact expected amount needs a currency (e.g. "ZAR")',
        );
    }
    const watch: PayWatch = {
      id: id("pw00"),
      book_id: q.book_id,
      code,
      label: q.label?.trim() || null,
      expected_amount_minor: q.expected_amount_minor ?? null,
      expected_currency: q.expected_currency?.toUpperCase() ?? null,
      enabled: true,
      created_at: new Date().toISOString(),
    };
    payWatches.push(watch);
    return clone(watch);
  },

  pay_watch_remove: async (q: { watch_id: string }): Promise<null> => {
    const i = payWatches.findIndex((w) => w.id === q.watch_id);
    if (i === -1) throw new Error(`pay_watch ${q.watch_id} not found`);
    payWatches.splice(i, 1);
    return null;
  },

  pay_watch_set_enabled: async (q: {
    watch_id: string;
    enabled: boolean;
  }): Promise<PayWatch> => {
    const watch = payWatches.find((w) => w.id === q.watch_id);
    if (!watch) throw new Error(`pay_watch ${q.watch_id} not found`);
    watch.enabled = q.enabled;
    return clone(watch);
  },

  pay_endpoint_list: async (q: { book_id: string }): Promise<PayEndpoint[]> =>
    clone(payEndpoints.filter((e) => e.book_id === q.book_id)),

  pay_endpoint_add: async (
    q: NewPayEndpoint,
  ): Promise<PayEndpointWithSecret> => {
    const label = q.label.trim();
    if (!label) throw new Error("endpoint label must not be empty");
    const endpoint: PayEndpoint = {
      id: id("pe00"),
      book_id: q.book_id,
      label,
      url: mockValidateWebhookUrl(q.url),
      enabled: true,
      created_at: new Date().toISOString(),
    };
    payEndpoints.push(endpoint);
    // The secret is returned once and forgotten — write-only, like the vault.
    return { endpoint: clone(endpoint), secret: mockPaySecret() };
  },

  pay_endpoint_rotate_secret: async (q: {
    endpoint_id: string;
  }): Promise<PayEndpointWithSecret> => {
    const endpoint = payEndpoints.find((e) => e.id === q.endpoint_id);
    if (!endpoint) throw new Error(`pay_endpoint ${q.endpoint_id} not found`);
    return { endpoint: clone(endpoint), secret: mockPaySecret() };
  },

  pay_endpoint_remove: async (q: { endpoint_id: string }): Promise<null> => {
    const i = payEndpoints.findIndex((e) => e.id === q.endpoint_id);
    if (i === -1) throw new Error(`pay_endpoint ${q.endpoint_id} not found`);
    payEndpoints.splice(i, 1);
    // Queued deliveries cascade with the endpoint, exactly like core.
    for (let d = payDeliveries.length - 1; d >= 0; d -= 1) {
      if (payDeliveries[d]!.endpoint_id === q.endpoint_id)
        payDeliveries.splice(d, 1);
    }
    return null;
  },

  pay_endpoint_set_enabled: async (q: {
    endpoint_id: string;
    enabled: boolean;
  }): Promise<PayEndpoint> => {
    const endpoint = payEndpoints.find((e) => e.id === q.endpoint_id);
    if (!endpoint) throw new Error(`pay_endpoint ${q.endpoint_id} not found`);
    endpoint.enabled = q.enabled;
    return clone(endpoint);
  },

  pay_match_list: async (q: { book_id: string }): Promise<PayMatch[]> =>
    clone(payMatches.filter((m) => m.book_id === q.book_id)),

  pay_delivery_list: async (q: { book_id: string }): Promise<PayDelivery[]> =>
    clone(payDeliveries.filter((d) => d.book_id === q.book_id)),

  pay_deliver_due: async (): Promise<PayDelivery[]> => {
    const now = new Date().toISOString();
    const acted: PayDelivery[] = [];
    for (const d of payDeliveries) {
      const endpoint = payEndpoints.find((e) => e.id === d.endpoint_id);
      if (
        d.state !== "pending" ||
        d.next_attempt_at > now ||
        !endpoint?.enabled
      )
        continue;
      // The mock receiver always answers 200 — retry/backoff arithmetic
      // lives in core, exercised by its own tests.
      d.state = "delivered";
      d.attempts += 1;
      d.last_status = 200;
      d.last_error = null;
      d.updated_at = now;
      acted.push(d);
    }
    return clone(acted);
  },

  // -- classification packs: rules, never data (no signature is checked in
  // this harness — see the section comment above) --

  pack_list: async (q: { book_id: string }): Promise<InstalledPackInfo[]> =>
    clone(
      installedPacks
        .filter((p) => p.book_id === q.book_id)
        .sort((a, b) => a.pack_id.localeCompare(b.pack_id)),
    ),

  pack_verify: async (q: PackDocumentRequest): Promise<PackVerification> => {
    const doc = readPackDocument(q);
    const fingerprint = mockSignerFingerprint(q.public_key);
    const installed = installedPacks.find(
      (p) => p.book_id === q.book_id && p.pack_id === doc.id,
    );
    const refusal = packRefusal(doc, fingerprint, installed);
    const pinned = packPins.get(doc.id) ?? null;
    return {
      pack_id: doc.id,
      name: doc.name,
      version: doc.version,
      kind: doc.kind,
      region: doc.region,
      author: doc.author,
      signer_fingerprint: fingerprint,
      trusted_as: trustedSigners.get(fingerprint) ?? null,
      pinned_fingerprint: pinned,
      installed_version: installed?.version ?? null,
      categories: doc.categories,
      merchant_rules: doc.merchant_rules,
      keyword_rules: doc.keyword_rules,
      action: refusal ? "refuse" : installed ? "upgrade" : "install",
      refusal,
      // A file the user picked comes with the publisher's key in hand, so
      // passing it *is* the trust decision — nothing further to accept.
      needs_signer_acceptance: false,
      origin: null,
    };
  },

  pack_install: async (q: PackDocumentRequest): Promise<PackInstallOutcome> => {
    const doc = readPackDocument(q);
    const fingerprint = mockSignerFingerprint(q.public_key);
    const existing = installedPacks.find(
      (p) => p.book_id === q.book_id && p.pack_id === doc.id,
    );
    const refusal = packRefusal(doc, fingerprint, existing);
    if (refusal) throw new Error(refusal);

    // Passing the key is the trust decision; the id pins to it from here on.
    if (!trustedSigners.has(fingerprint))
      trustedSigners.set(fingerprint, doc.author?.trim() || `publisher ${fingerprint}`);
    packPins.set(doc.id, fingerprint);

    const now = new Date().toISOString();
    const upgradedFrom = existing?.version ?? null;
    if (existing) {
      existing.name = doc.name;
      existing.version = doc.version;
      existing.kind = doc.kind;
      existing.region = doc.region;
      existing.signer_fingerprint = fingerprint;
      existing.signer_label = trustedSigners.get(fingerprint) ?? null;
      existing.updated_at = now;
    } else {
      installedPacks.push({
        pack_id: doc.id,
        book_id: q.book_id,
        name: doc.name,
        version: doc.version,
        kind: doc.kind,
        region: doc.region,
        signer_fingerprint: fingerprint,
        signer_label: trustedSigners.get(fingerprint) ?? null,
        installed_at: now,
        updated_at: now,
      });
    }
    return {
      pack_id: doc.id,
      name: doc.name,
      version: doc.version,
      region: doc.region,
      outcome: upgradedFrom ? "upgraded" : "installed",
      upgraded_from: upgradedFrom,
      // An upgrade re-maps onto the categories it already created.
      categories_created: upgradedFrom ? 0 : doc.categories,
      categories_reused: upgradedFrom ? doc.categories : 0,
      rules_installed: doc.merchant_rules + doc.keyword_rules,
    };
  },

  // -- pack sources: the fetch half. Same shape as the real thing: a source
  // list that starts EMPTY (no registry, no default endpoint), a read that
  // installs nothing and shows fingerprints, and an install that refuses an
  // unseen signer until it is accepted by fingerprint. --

  pack_source_list: async (): Promise<PackSourceInfo[]> => clone(packSources),

  pack_source_add: async (q: { name: string; uri: string }): Promise<PackSourceInfo> => {
    const name = q.name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || MOCK_SOURCE_SCHEMES.has(name))
      throw new Error(`pack source name "${q.name}" is invalid`);
    if (packSources.some((s) => s.name === name))
      throw new Error(`a pack source named "${name}" already exists`);
    const uri = q.uri.trim();
    const kind = mockSourceKind(uri);
    packSources.push({
      name,
      uri,
      kind,
      network: kind === "git" || kind === "https",
      added_at: new Date().toISOString(),
      last_synced_at: null,
    });
    return clone(packSources[packSources.length - 1]);
  },

  pack_source_remove: async (q: { name: string }): Promise<boolean> => {
    const before = packSources.length;
    packSources = packSources.filter((s) => s.name !== q.name.trim().toLowerCase());
    return packSources.length < before;
  },

  pack_source_fetch: async (q: {
    book_id: string;
    source: string;
  }): Promise<PackOffer[]> => {
    const source = packSources.find((s) => s.name === q.source);
    if (!source) throw new Error(`no pack source named "${q.source}"`);
    source.last_synced_at = new Date().toISOString();
    return clone(
      mockCatalogue.map((entry) => {
        if (entry.broken)
          return {
            pack_id: entry.pack_id,
            version: entry.version,
            name: entry.name,
            document: entry.document,
            verified: null,
            error: entry.broken,
          };
        const installed = installedPacks.find(
          (p) => p.book_id === q.book_id && p.pack_id === entry.pack_id,
        );
        const pinned = packPins.get(entry.pack_id) ?? null;
        const refusal =
          pinned && pinned !== entry.signer_fingerprint
            ? `pack ${entry.pack_id} was previously signed by a different key (pinned signer ${pinned}); refusing to install`
            : installed
              ? packRefusal(
                  {
                    id: entry.pack_id,
                    name: entry.name,
                    version: entry.version,
                    region: entry.region,
                    author: entry.author,
                    kind: entry.kind,
                    categories: entry.categories,
                    merchant_rules: entry.merchant_rules,
                    keyword_rules: entry.keyword_rules,
                  },
                  entry.signer_fingerprint,
                  installed,
                )
              : null;
        const trusted = trustedSigners.get(entry.signer_fingerprint) ?? null;
        return {
          pack_id: entry.pack_id,
          version: entry.version,
          name: entry.name,
          document: entry.document,
          error: null,
          verified: {
            pack_id: entry.pack_id,
            name: entry.name,
            version: entry.version,
            kind: entry.kind,
            region: entry.region,
            author: entry.author,
            signer_fingerprint: entry.signer_fingerprint,
            trusted_as: trusted,
            pinned_fingerprint: pinned,
            installed_version: installed?.version ?? null,
            categories: entry.categories,
            merchant_rules: entry.merchant_rules,
            keyword_rules: entry.keyword_rules,
            action: refusal ? "refuse" : installed ? "upgrade" : "install",
            refusal,
            needs_signer_acceptance: !trusted && !pinned,
            origin: `${source.uri} (${entry.document})`,
          },
        };
      }),
    );
  },

  pack_source_install: async (q: {
    book_id: string;
    source: string;
    pack_id: string;
    document?: string;
    accept_signer?: string;
  }): Promise<PackInstallOutcome> => {
    const source = packSources.find((s) => s.name === q.source);
    if (!source) throw new Error(`no pack source named "${q.source}"`);
    const entry = mockCatalogue.find((e) =>
      q.document ? e.document === q.document : e.pack_id === q.pack_id,
    );
    if (!entry || entry.broken)
      throw new Error(`pack "${q.pack_id}" is not offered by source "${q.source}"`);

    // The pin comes before the trust decision, exactly as it does for real:
    // a changed publisher key must not leave a newly-trusted signer behind.
    const pinned = packPins.get(entry.pack_id) ?? null;
    if (pinned && pinned !== entry.signer_fingerprint)
      throw new Error(
        `pack ${entry.pack_id} was previously signed by a different key (pinned signer ${pinned}); refusing to install`,
      );
    if (!trustedSigners.has(entry.signer_fingerprint)) {
      if (q.accept_signer !== entry.signer_fingerprint)
        throw new Error(
          `signer ${entry.signer_fingerprint} for pack ${entry.pack_id} has never been seen here; check the fingerprint against the publisher's own channel and accept it explicitly`,
        );
      trustedSigners.set(
        entry.signer_fingerprint,
        entry.author?.trim() || `publisher ${entry.signer_fingerprint}`,
      );
    }
    packPins.set(entry.pack_id, entry.signer_fingerprint);

    const existing = installedPacks.find(
      (p) => p.book_id === q.book_id && p.pack_id === entry.pack_id,
    );
    const refusal = packRefusal(
      {
        id: entry.pack_id,
        name: entry.name,
        version: entry.version,
        region: entry.region,
        author: entry.author,
        kind: entry.kind,
        categories: entry.categories,
        merchant_rules: entry.merchant_rules,
        keyword_rules: entry.keyword_rules,
      },
      entry.signer_fingerprint,
      existing,
    );
    if (refusal) throw new Error(refusal);

    const now = new Date().toISOString();
    const upgradedFrom = existing?.version ?? null;
    if (existing) {
      existing.version = entry.version;
      existing.name = entry.name;
      existing.signer_fingerprint = entry.signer_fingerprint;
      existing.signer_label = trustedSigners.get(entry.signer_fingerprint) ?? null;
      existing.updated_at = now;
    } else {
      installedPacks.push({
        pack_id: entry.pack_id,
        book_id: q.book_id,
        name: entry.name,
        version: entry.version,
        kind: entry.kind,
        region: entry.region,
        signer_fingerprint: entry.signer_fingerprint,
        signer_label: trustedSigners.get(entry.signer_fingerprint) ?? null,
        installed_at: now,
        updated_at: now,
      });
    }
    source.last_synced_at = now;
    return {
      pack_id: entry.pack_id,
      name: entry.name,
      version: entry.version,
      region: entry.region,
      outcome: upgradedFrom ? "upgraded" : "installed",
      upgraded_from: upgradedFrom,
      categories_created: upgradedFrom ? 0 : entry.categories,
      categories_reused: upgradedFrom ? entry.categories : 0,
      rules_installed: entry.merchant_rules + entry.keyword_rules,
    };
  },

  pack_uninstall: async (q: {
    book_id: string;
    pack_id: string;
  }): Promise<boolean> => {
    const before = installedPacks.length;
    installedPacks = installedPacks.filter(
      (p) => !(p.book_id === q.book_id && p.pack_id === q.pack_id),
    );
    // The pin outlives the pack, exactly as it does in the real store.
    return installedPacks.length < before;
  },

  /** Idempotent and non-clobbering, like the real one: a seed already
   * installed at the same version is skipped and does not come back in the
   * result, so a second call returns an empty list rather than claiming to
   * have done work. Categories are "adopted" rather than duplicated, which
   * shows up as `categories_reused`. */
  pack_install_seeds: async (q: {
    book_id: string;
  }): Promise<PackInstallOutcome[]> => {
    const now = new Date().toISOString();
    const written: PackInstallOutcome[] = [];
    for (const seed of seedPacks) {
      const existing = installedPacks.find(
        (p) => p.book_id === q.book_id && p.pack_id === seed.pack_id,
      );
      if (existing && existing.version === seed.version) continue;
      const upgradedFrom = existing?.version ?? null;
      if (existing) {
        existing.version = seed.version;
        existing.updated_at = now;
      } else {
        installedPacks.push({
          pack_id: seed.pack_id,
          book_id: q.book_id,
          name: seed.name,
          version: seed.version,
          kind: "taxonomy",
          region: seed.region,
          // Builtin seeds carry a reserved signer, not a public key: their
          // payload is embedded in the binary, so there is no first-use
          // trust decision to make and no trust-store row to label.
          signer_fingerprint: BUILTIN_SIGNER_FP,
          signer_label: null,
          installed_at: now,
          updated_at: now,
        });
      }
      written.push({
        pack_id: seed.pack_id,
        name: seed.name,
        version: seed.version,
        region: seed.region,
        outcome: upgradedFrom ? "upgraded" : "installed",
        upgraded_from: upgradedFrom,
        categories_created: upgradedFrom ? 0 : seed.categories,
        categories_reused: upgradedFrom ? seed.categories : 0,
        rules_installed: seed.rules,
      });
    }
    return clone(written);
  },

  /** Local peer comparison for one month. Mirrors the op's semantics: your
   * side is the spending report for the month, no currency is ever
   * converted (a mismatched pack is `skipped`), and a key nothing maps to is
   * reported in `unmapped_keys` instead of vanishing. */
  pack_benchmark: async (q: {
    book_id: string;
    period: string;
  }): Promise<BenchmarkReport[]> => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(q.period))
      throw new Error(`period "${q.period}" must be a calendar month, YYYY-MM`);

    const installedHere = installedPacks.filter((p) => p.book_id === q.book_id);
    // Benchmark packs declare no categories of their own: the keys they cite
    // resolve through whatever taxonomy pack is installed. With none, every
    // key is unmapped — which is the honest answer, not an empty screen.
    const haveTaxonomy = installedHere.some((p) => p.kind === "taxonomy");

    const spending = await mockApi.report_spending({
      book_id: q.book_id,
      from: `${q.period}-01`,
      // `-31` spans any month: dates are compared as strings, so a 30-day
      // month simply has no `-31` row.
      to: `${q.period}-31`,
    });
    const spendByCategoryName = new Map(
      spending.by_category.map((r) => [r.category_name, r.amount_minor]),
    );

    const reports: BenchmarkReport[] = [];
    for (const pack of installedHere.filter((p) => p.kind === "benchmark")) {
      const set = benchmarkSets.find((s) => s.pack_id === pack.pack_id);
      if (!set) continue;
      const report: BenchmarkReport = {
        pack_id: set.pack_id,
        pack_name: pack.name,
        period: q.period,
        currency: set.currency,
        cohort: { ...set.cohort },
        k_floor: set.k_floor,
        skipped: null,
        comparisons: [],
        unmapped_keys: [],
      };
      if (set.currency !== spending.currency) {
        report.skipped = `pack is in ${set.currency} and this book is in ${spending.currency} — no conversion is applied`;
        reports.push(report);
        continue;
      }
      // Stats are filtered by period first, exactly as the op does — so a
      // month the pack does not cover yields no comparisons AND no unmapped
      // keys, rather than reporting every key as unmatched.
      const stats = q.period.startsWith(`${set.year}-`) ? set.stats : [];
      for (const stat of stats) {
        const category = haveTaxonomy ? benchmarkKeyMap[stat.category_key] : undefined;
        if (!category) {
          report.unmapped_keys.push(stat.category_key);
          continue;
        }
        const yours = spendByCategoryName.get(category) ?? 0;
        report.comparisons.push({
          category_key: stat.category_key,
          currency: set.currency,
          yours_minor: yours,
          median_minor: stat.median_minor,
          p25_minor: stat.p25_minor,
          p75_minor: stat.p75_minor,
          delta_minor: yours - stat.median_minor,
          // Absent, not Infinity, when the cohort median is zero.
          ratio_to_median:
            stat.median_minor === 0 ? null : yours / stat.median_minor,
          position:
            yours < stat.p25_minor
              ? "below_p25"
              : yours > stat.p75_minor
                ? "above_p75"
                : "typical",
          sample_size: stat.sample_size,
        });
      }
      report.unmapped_keys.sort();
      reports.push(report);
    }
    return clone(reports);
  },

  settings_get: async (): Promise<Settings> => clone(settings),

  settings_set: async (q: { settings: Settings }): Promise<Settings> => {
    settings = clone(q.settings);
    return clone(settings);
  },

  vault_list: async (): Promise<VaultCredentialMeta[]> => clone(vaultEntries),

  vault_set: async (q: VaultSetRequest): Promise<VaultCredentialMeta> => {
    if (!q.secret) throw new Error("secret must not be empty");
    if (vaultEntries.some((e) => e.name === q.name))
      throw new Error(
        `vault secret "${q.name}" already exists; use replace to rotate it`,
      );
    const meta: VaultCredentialMeta = {
      name: q.name,
      label: q.label?.trim() || null,
      version: 1,
      fingerprint: mockFingerprint(q.name, q.secret),
      created_at: new Date().toISOString(),
      rotated_at: null,
      last_used_at: null,
    };
    vaultEntries.push(meta);
    return clone(meta);
  },

  vault_replace: async (
    q: VaultReplaceRequest,
  ): Promise<VaultCredentialMeta> => {
    if (!q.secret) throw new Error("secret must not be empty");
    const entry = vaultEntries.find((e) => e.name === q.name);
    if (!entry) throw new Error(`no credential named "${q.name}"`);
    entry.version += 1;
    entry.fingerprint = mockFingerprint(q.name, q.secret);
    entry.rotated_at = new Date().toISOString();
    return clone(entry);
  },

  vault_revoke: async (q: { name: string }): Promise<null> => {
    const i = vaultEntries.findIndex((e) => e.name === q.name);
    if (i === -1) throw new Error(`no credential named "${q.name}"`);
    vaultEntries.splice(i, 1);
    return null;
  },

  // -- device identity and pairing. Nothing syncs; see the section comment
  // above for what the state machine does and does not model. --

  device_status: async (): Promise<DeviceIdentity | null> =>
    deviceIdentity ? clone(deviceIdentity) : null,

  device_list: async (): Promise<DevicePeer[]> => clone(devicePeers),

  device_get: async (q: { device_id: string }): Promise<DevicePeer> => {
    const peer = devicePeers.find(
      (p) => p.public_key === q.device_id.trim().toLowerCase(),
    );
    if (!peer) throw new Error(`no paired device ${q.device_id}`);
    return clone(peer);
  },

  device_invite_list: async (): Promise<PairingInviteMeta[]> =>
    clone(deviceInvites),

  device_rotations: async (): Promise<DeviceRotation[]> =>
    clone(deviceRotations),

  device_init: async (q: { label?: string }): Promise<DeviceIdentity> => {
    if (deviceIdentity)
      throw new Error(
        `this device already has an identity (${deviceIdentity.keyname}) — ` +
          "rotate it, or reset it first",
      );
    const key = mockPublicKey("init-" + ++seq);
    deviceIdentity = {
      public_key: key,
      keyname: mockKeyname(key),
      label: q.label?.trim() || "this device",
      created_at: new Date().toISOString(),
      rotated_at: null,
    };
    return clone(deviceIdentity);
  },

  device_rotate: async (): Promise<DeviceRotateResult> => {
    const current = requireDeviceIdentity();
    const key = mockPublicKey("rotate-" + ++seq);
    const now = new Date().toISOString();
    const rotation: DeviceRotation = {
      old_public_key: current.public_key,
      new_public_key: key,
      // Not a signature. The real one is made by the OUTGOING key and is what
      // makes a rotation provable rather than asserted; this harness has no
      // ed25519 and must not imply it does.
      signature: mockPublicKey("sig-" + seq) + mockPublicKey("sig2-" + seq),
      rotated_at: now,
    };
    deviceRotations.push(rotation);
    deviceIdentity = {
      public_key: key,
      keyname: mockKeyname(key),
      label: current.label,
      created_at: current.created_at,
      rotated_at: now,
    };
    return clone({ identity: deviceIdentity, rotation });
  },

  device_reset: async (q: { confirm: boolean }): Promise<null> => {
    if (!q.confirm)
      throw new Error(
        "resetting destroys this device's private key and cannot be undone — " +
          "pass confirm to proceed",
      );
    deviceIdentity = null;
    // Peer pins survive: they are this device's opinions about *other*
    // devices, and changing our own key does not invalidate them.
    deviceInvites = [];
    deviceRotations = [];
    mockClaims.clear();
    return null;
  },

  device_revoke: async (q: { device_id: string }): Promise<DevicePeer> => {
    const peer = devicePeers.find((p) => p.public_key === q.device_id);
    if (!peer) throw new Error(`no paired device ${q.device_id}`);
    peer.revoked_at ??= new Date().toISOString();
    return clone(peer);
  },

  device_forget: async (q: { device_id: string }): Promise<boolean> => {
    const i = devicePeers.findIndex((p) => p.public_key === q.device_id);
    if (i === -1) return false;
    devicePeers.splice(i, 1);
    return true;
  },

  device_pair_invite: async (q: {
    label?: string;
    ttl_seconds?: number;
  }): Promise<PairingInvite> => {
    const identity = requireDeviceIdentity();
    const ttl = q.ttl_seconds ?? 600;
    if (ttl < 1 || ttl > 86_400)
      throw new Error("invite lifetime must be between 1 and 86400 seconds");
    const claim = mockClaimToken();
    const inviteId = id("dv01");
    const now = new Date();
    const expires_at = new Date(now.getTime() + ttl * 1000).toISOString();
    deviceInvites = [
      {
        id: inviteId,
        label: q.label?.trim() || "a device",
        created_at: now.toISOString(),
        expires_at,
        redeemed_at: null,
        redeemed_by: null,
      },
      ...deviceInvites,
    ];
    mockClaims.set(claim, inviteId);
    return {
      id: inviteId,
      blob: encodeMockBlob({
        typ: "slipscan.pair.invite",
        device_id: identity.public_key,
        label: identity.label,
        claim,
        expires_at,
      }),
      keyname: identity.keyname,
      expires_at,
    };
  },

  device_invite_cancel: async (q: { id: string }): Promise<boolean> => {
    const invite = deviceInvites.find(
      (i) => i.id === q.id && i.redeemed_at === null,
    );
    if (!invite) return false;
    deviceInvites = deviceInvites.filter((i) => i.id !== q.id);
    for (const [claim, owner] of [...mockClaims]) {
      if (owner === q.id) mockClaims.delete(claim);
    }
    return true;
  },

  device_pair_accept: async (
    q: PairRedeemRequest,
  ): Promise<PairingAcceptance> => {
    const identity = requireDeviceIdentity();
    const payload = decodeMockBlob(q.blob);
    if (payload.typ !== "slipscan.pair.invite")
      throw new Error("that is not a pairing invite");
    if (payload.device_id === identity.public_key)
      throw new Error(
        "this invite came from this device — pair two different devices",
      );
    if (payload.expires_at && payload.expires_at < new Date().toISOString())
      throw new Error(
        `this invite expired at ${payload.expires_at} — ask for a fresh one`,
      );
    // The key-name is always recomputed from the key, never read out of the
    // blob: an attacker controls every field in there.
    mockKeynameCheck(q, mockKeyname(payload.device_id));

    const peer = mockPinPeer(payload.device_id, payload.label);
    return clone({
      peer,
      blob: encodeMockBlob({
        typ: "slipscan.pair.accept",
        device_id: identity.public_key,
        label: identity.label,
        claim: payload.claim,
        for_device_id: payload.device_id,
      }),
    });
  },

  device_pair_confirm: async (q: PairRedeemRequest): Promise<DevicePeer> => {
    const identity = requireDeviceIdentity();
    const payload = decodeMockBlob(q.blob);
    if (payload.typ !== "slipscan.pair.accept")
      throw new Error("that is not a pairing acceptance");
    if (payload.device_id === identity.public_key)
      throw new Error(
        "this acceptance came from this device — pair two different devices",
      );
    if (payload.for_device_id !== identity.public_key)
      throw new Error("this acceptance is addressed to a different device");
    mockKeynameCheck(q, mockKeyname(payload.device_id));

    const inviteId = mockClaims.get(payload.claim);
    const invite = deviceInvites.find((i) => i.id === inviteId);
    if (!invite)
      throw new Error(
        "this acceptance answers no invite from this device — it may have " +
          "been withdrawn, or minted somewhere else",
      );
    if (invite.redeemed_at)
      throw new Error(
        "this invite was already redeemed — invites are single-use; mint a fresh one",
      );
    if (invite.expires_at < new Date().toISOString())
      throw new Error(
        `this invite expired at ${invite.expires_at} — mint a fresh one`,
      );

    const peer = mockPinPeer(payload.device_id, payload.label);
    // Burn the token, exactly as the real confirm does in the same
    // transaction as the pin.
    invite.redeemed_at = new Date().toISOString();
    invite.redeemed_by = peer.public_key;
    mockClaims.delete(payload.claim);
    return clone(peer);
  },
};

export type MockApi = typeof mockApi;
