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
  ReconConfirmRequest,
  ReconSuggestion,
  RegionInfo,
  Settings,
  SpendingReport,
  Transaction,
  TransactionListQuery,
  TrialBalance,
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

interface TxSeed {
  d: string;
  desc: string;
  merchant: string | null;
  amount: number; // rand cents, signed
  cat: string | null;
  acct: string;
  source: Transaction["source"];
}

const txSeeds: TxSeed[] = [
  { d: "2026-07-16", desc: "WOOLWORTHS 178 CLAREMONT", merchant: "Woolworths", amount: -84_235, cat: "Groceries", acct: "FNB Cheque", source: "scraper" },
  { d: "2026-07-16", desc: "UBER *TRIP HELP.UBER.COM", merchant: "Uber", amount: -11_650, cat: "Transport & fuel", acct: "Discovery Credit Card", source: "scraper" },
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
  created_at: `${s.d}T04:00:00Z`,
}));

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
// mock service surface — same names/shapes as the core services
// ---------------------------------------------------------------------------

const clone = <T>(v: T): T => structuredClone(v);

export const mockApi = {
  health: async (): Promise<Health> => ({
    status: "ok",
    version: "0.1.0-mock",
    tauri: "browser",
  }),

  book_list: async (): Promise<Book[]> => clone([book]),

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
  }): Promise<FxConversion> => {
    const from = q.from.toUpperCase();
    const to = q.to.toUpperCase();
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
