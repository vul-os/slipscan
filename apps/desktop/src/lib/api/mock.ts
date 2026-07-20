/**
 * In-memory mock dataset used when the frontend is not running under Tauri
 * (plain `vite dev` in a browser) or when a core command is not wired yet.
 * Realistic ZAR data; all money in minor units (cents).
 */
import type {
  Account,
  Book,
  Budget,
  BudgetUpsert,
  BudgetWithSpend,
  Category,
  DataMoveRequest,
  DataStatus,
  Document,
  DocumentImportRequest,
  DocumentReviewRequest,
  FxCachedRate,
  FxConversion,
  FxQuote,
  FxStatus,
  Health,
  IncomeExpenseReport,
  JournalEntry,
  JournalPostRequest,
  LedgerAccount,
  Member,
  MemberAmountRow,
  MemberCategoryRow,
  MemberPatch,
  MemberSettleRow,
  NewMember,
  NewPayEndpoint,
  NewPayWatch,
  PayDelivery,
  PayEndpoint,
  PayEndpointWithSecret,
  PayMatch,
  PayWatch,
  ReconConfirmRequest,
  ReconSuggestion,
  RegionInfo,
  Settings,
  SpendingReport,
  SplitShare,
  Transaction,
  TransactionListQuery,
  TransactionSplit,
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
  cat("Interest", "income", "🏦"),
  cat("Transfers", "transfer", "🔁"),
];

const catId = (name: string): string =>
  categories.find((c) => c.name === name)!.id;

const acctId = (name: string): string =>
  accounts.find((a) => a.name === name)!.id;

// ---------------------------------------------------------------------------
// household members — a small two-person demo household (ARCHITECTURE.md
// "Household members & per-person attribution"). Alex owns the cheque
// account, Sam owns the credit card; TymeBank and Cash stay joint (no
// default owner), exactly the shape core supports.
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

const txSeeds: TxSeed[] = [
  { d: "2026-07-16", desc: "WOOLWORTHS 178 CLAREMONT", merchant: "Woolworths", amount: -84_235, cat: "Groceries", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-07-16", desc: "UBER *TRIP HELP.UBER.COM", merchant: "Uber", amount: -11_650, cat: "Transport & fuel", acct: "Discovery Credit Card", source: "scraper", member: "Alex" },
  { d: "2026-07-15", desc: "CHECKERS SIXTY60 RONDEBOSCH", merchant: "Checkers Sixty60", amount: -63_780, cat: "Groceries", acct: "Discovery Credit Card", source: "scraper" },
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
  { d: "2026-06-30", desc: "CITY OF CT MUNICIPAL", merchant: "City of Cape Town", amount: -164_420, cat: "Utilities", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-06-28", desc: "WOOLWORTHS 178 CLAREMONT", merchant: "Woolworths", amount: -112_060, cat: "Groceries", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-06-27", desc: "SHELL ULTRA CITY N2", merchant: "Shell", amount: -85_500, cat: "Transport & fuel", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-06-25", desc: "SALARY - MOLEFE CONSULTING", merchant: null, amount: 5_450_000, cat: "Salary", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-06-24", desc: "PNP FAMILY KENILWORTH", merchant: "Pick n Pay", amount: -58_420, cat: "Groceries", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-06-23", desc: "KAUAI KLOOF NEK", merchant: "Kauai", amount: -14_900, cat: "Eating out", acct: "Discovery Credit Card", source: "scraper" },
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

// One split example: the big Woolworths shop, 60/40 between Alex and Sam —
// the shares must sum to exactly the transaction's absolute amount, just
// like core's `transaction_split_set` invariant.
let transactionSplits: TransactionSplit[] = [
  {
    id: id("ts00"),
    transaction_id: transactions[0]!.id,
    member_id: memberId("Alex"),
    share_minor: 50_541,
    created_at: "2026-07-16T09:00:00Z",
  },
  {
    id: id("ts00"),
    transaction_id: transactions[0]!.id,
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
  entry("2026-06-25", "June salary", [
    ["1000", 5_450_000, 0],
    ["4000", 0, 5_450_000],
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
// ShapePay mock — watch codes, endpoints, matches, deliveries. Mirrors the
// core contract: flat watch list, vault-only endpoint secrets (generated
// here, returned once, never stored), backoff-retried deliveries.
// ---------------------------------------------------------------------------

const payWatches: PayWatch[] = [
  {
    id: id("pw00"),
    book_id: BOOK_ID,
    code: "RENT-12B",
    label: "Garden flat rent",
    expected_amount_minor: null,
    expected_currency: null,
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

// The RENT-12B watch matched the inbound interest-day credit in the seed set.
const payMatches: PayMatch[] = [
  {
    id: id("pm00"),
    book_id: BOOK_ID,
    watch_id: payWatches[0]!.id,
    transaction_id: transactions[17]!.id,
    matched_at: "2026-07-02T04:10:00Z",
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
      amount_minor: 12_384,
      currency: "ZAR",
      posted_date: "2026-07-02",
      matched_at: "2026-07-02T04:10:00Z",
    }),
    state: "delivered",
    attempts: 1,
    next_attempt_at: "2026-07-02T04:10:00Z",
    last_status: 200,
    last_error: null,
    created_at: "2026-07-02T04:10:00Z",
    updated_at: "2026-07-02T04:11:00Z",
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
      amount_minor: 12_384,
      currency: "ZAR",
      posted_date: "2026-07-02",
      matched_at: "2026-07-02T04:10:00Z",
    }),
    state: "pending",
    attempts: 3,
    next_attempt_at: "2026-07-02T06:41:00Z", // past — due for "Deliver now"
    last_status: 503,
    last_error: "HTTP 503",
    created_at: "2026-07-02T04:10:00Z",
    updated_at: "2026-07-02T04:41:00Z",
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

// ---------------------------------------------------------------------------
// mock service surface — same names/shapes as the core services
// ---------------------------------------------------------------------------

const clone = <T>(v: T): T => structuredClone(v);

export const mockApi = {
  health: async (): Promise<Health> => ({
    status: "ok",
    version: "0.2.0-mock",
    tauri: "browser",
  }),

  book_list: async (): Promise<Book[]> => clone([book]),

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
    if (q.clear_default_account) {
      m.default_account_id = null;
    } else if (q.default_account_id !== undefined) {
      if (!accounts.some((a) => a.id === q.default_account_id))
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

  report_income_expense: async (_q: {
    book_id: string;
  }): Promise<IncomeExpenseReport> => ({
    book_id: BOOK_ID,
    currency: "ZAR",
    months: [
      { month: "2026-02", income_minor: 5_450_000, expense_minor: 3_310_400 },
      { month: "2026-03", income_minor: 5_450_000, expense_minor: 3_642_210 },
      { month: "2026-04", income_minor: 5_462_384, expense_minor: 2_980_770 },
      { month: "2026-05", income_minor: 5_450_000, expense_minor: 3_871_120 },
      { month: "2026-06", income_minor: 5_462_384, expense_minor: 3_120_450 },
      { month: "2026-07", income_minor: 12_384, expense_minor: 1_932_353 },
    ],
  }),

  report_vat_summary: async (_q: {
    book_id: string;
    period: string;
  }): Promise<VatSummary> => ({
    book_id: BOOK_ID,
    period: "2026-07",
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

  // -- ShapePay: same semantics as core — flat watch list, secrets returned
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
};

export type MockApi = typeof mockApi;
