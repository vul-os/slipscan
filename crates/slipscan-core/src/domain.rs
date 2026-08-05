//! Domain model: serde-friendly structs mirroring the SQLite schema.
//!
//! Conventions: ids are UUID v7 strings, money is `i64` minor units with an
//! ISO-4217 currency code, timestamps are RFC 3339 UTC strings, dates are
//! `YYYY-MM-DD` strings.

use serde::{Deserialize, Serialize};

/// Generate a string-backed enum with serde + Display + FromStr, matching the
/// TEXT CHECK constraints in the schema.
macro_rules! str_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $s:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $s)] $variant),+
        }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $s),+ }
            }
        }

        impl std::str::FromStr for $name {
            type Err = crate::error::CoreError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($s => Ok(Self::$variant),)+
                    other => Err(crate::error::CoreError::InvalidEnum {
                        ty: stringify!($name),
                        value: other.to_string(),
                    }),
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

str_enum!(BookKind { Personal => "personal", Business => "business" });

str_enum!(AccountKind {
    Bank => "bank",
    Cash => "cash",
    Card => "card",
    Asset => "asset",
    Liability => "liability",
});

str_enum!(TransactionSource {
    Scraper => "scraper",
    Email => "email",
    Import => "import",
    Manual => "manual",
});

str_enum!(TransactionStatus {
    Pending => "pending",
    Verified => "verified",
    Rejected => "rejected",
});

str_enum!(CategoryKind {
    Income => "income",
    Expense => "expense",
    Transfer => "transfer",
});

str_enum!(MappingSource {
    User => "user",
    Rule => "rule",
    Llm => "llm",
    Pack => "pack",
    System => "system",
});

str_enum!(DocumentSource {
    Upload => "upload",
    Email => "email",
    Import => "import",
});

str_enum!(DocumentKind {
    Slip => "slip",
    Invoice => "invoice",
    BankStatement => "bank_statement",
    Unknown => "unknown",
});

str_enum!(DocumentStatus {
    Pending => "pending",
    Processing => "processing",
    Extracted => "extracted",
    Reviewed => "reviewed",
    Failed => "failed",
});

str_enum!(CoaKind {
    Asset => "asset",
    Liability => "liability",
    Equity => "equity",
    Income => "income",
    Expense => "expense",
});

str_enum!(JournalSourceType {
    Manual => "manual",
    Transaction => "transaction",
    Document => "document",
    OpeningBalance => "opening_balance",
    // A `po_receipts` row (migration `0013_purchasing`) posted straight to
    // the ledger — ROADMAP.md 6.6. `source_id` is the receipt's own id, so
    // each receiving event gets at most one net-live journal, the same
    // dedup guarantee `post_journal_in_tx` already gives transactions and
    // documents.
    PoReceipt => "po_receipt",
    // The cost/inventory half of a confirmed sales order's posting —
    // ROADMAP.md 6.6. Deliberately a *separate* journal from `SalesRevenue`
    // (two paired postings, not one four-line entry) so either can be
    // reversed and independently re-derived without touching the other.
    // `source_id` is the `sales_orders` id.
    SalesCogs => "sales_cogs",
    // The revenue/AR/VAT half of a confirmed sales order's posting — see
    // `SalesCogs`. `source_id` is the `sales_orders` id.
    SalesRevenue => "sales_revenue",
    // An `invoice_payments` row posted straight to the ledger —
    // ROADMAP.md 6.6. `source_id` is the payment's own id.
    InvoicePayment => "invoice_payment",
    // An `asset_depreciation_runs` row posted straight to the ledger —
    // migration `0016_assets`, PARITY.md "Fixed assets". `source_id` is the
    // run's own id, the same idiom `PoReceipt`/`InvoicePayment` use.
    Depreciation => "depreciation",
});

str_enum!(ReconState {
    Auto => "auto",
    Suggested => "suggested",
    Confirmed => "confirmed",
    Rejected => "rejected",
});

str_enum!(
    /// A journal line's role in the VAT return (VAT201).
    VatRole {
        OutputVat => "output_vat",
        InputVat => "input_vat",
        OutputBase => "output_base",
        InputBase => "input_base",
    }
);

str_enum!(
    /// What a [`CoaMapEntry`] maps onto the chart of accounts.
    CoaMapEntity {
        Account => "account",
        Category => "category",
    }
);

str_enum!(
    /// The sense in which FlowStock used the word "location": a storefront or
    /// office, bulk storage, or anything else. Data a person sets, not a
    /// behavioural switch — nothing in core branches on it yet.
    LocationKind {
        Branch => "branch",
        Warehouse => "warehouse",
        Site => "site",
    }
);

str_enum!(
    /// Which side(s) of trade a [`Contact`] is on. `Both` is not a "not sure
    /// yet" placeholder — it is the ordinary case of a party a business both
    /// buys from and sells to, which is exactly why contacts are one table
    /// with a role rather than two tables.
    ContactRole {
        Customer => "customer",
        Supplier => "supplier",
        Both => "both",
    }
);

str_enum!(
    /// FlowStock's five stock-movement kinds, unchanged (migration
    /// `0012_stock`). Not a sign predictor — `Adjustment` and `Count` move
    /// either direction, and nothing here or in the schema tries to guess
    /// which sign a kind "should" carry.
    StockMovementKind {
        Receipt => "receipt",
        Sale => "sale",
        Adjustment => "adjustment",
        Transfer => "transfer",
        Count => "count",
    }
);

str_enum!(
    /// A purchase order's hand-maintained workflow state (migration
    /// `0013_purchasing`). Not the none/partial/complete receiving progress
    /// — see [`PoReceiptStatus`] — this answers "has a human sent it to the
    /// supplier, or cancelled it", which nothing in `po_receipts` can derive.
    /// `CoreService::po_set_status` is the only writer.
    PurchaseOrderStatus {
        Draft => "draft",
        Ordered => "ordered",
        Cancelled => "cancelled",
    }
);

str_enum!(
    /// A purchase-order line's (or a whole PO's) receiving progress, always
    /// derived from `SUM(qty)` over `po_receipts` compared with
    /// `qty_ordered` — never stored (ROADMAP.md Phase 6 decision #4,
    /// extended from stock to purchasing by migration `0013_purchasing`).
    /// `Unreceived` serializes as `"none"` to match the none/partial/complete
    /// wording ROADMAP.md uses; the Rust identifier avoids shadowing
    /// `Option::None` at every call site.
    PoReceiptStatus {
        Unreceived => "none",
        Partial => "partial",
        Complete => "complete",
    }
);

// ---------------------------------------------------------------------------
// Book
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Book {
    pub id: String,
    pub kind: BookKind,
    pub name: String,
    pub currency: String,
    pub country: Option<String>,
    /// Region profile id ("za", "generic", …) driving chart-of-accounts
    /// seeds, tax rate table, and tax-report labels — see [`crate::region`].
    pub region: String,
    pub locale: String,
    pub timezone: String,
    pub financial_lock_date: Option<String>,
    /// The stored multi-location override (Phase 6 decision #3): `None`
    /// means "derive it from the `locations` row count", `Some(true)` /
    /// `Some(false)` pin the flag either way regardless of how many
    /// locations exist. Read this through [`crate::profile::resolve`] (or
    /// `CoreService::book_profile`) rather than directly — the resolved
    /// flag, not this raw field, is what a UI should branch on.
    pub multi_location_override: Option<bool>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewBook {
    pub name: String,
    pub kind: BookKind,
    /// Defaults to the region profile's default currency when omitted.
    pub currency: Option<String>,
    /// ISO 3166-1 alpha-2. Also used to infer the region profile when
    /// [`crate::CoreService::book_create`] is called without an explicit
    /// region (e.g. "ZA" → the "za" profile).
    pub country: Option<String>,
    /// Region profile id ("za", "generic", …) — see [`crate::region`]. Wins
    /// over `country` inference when set; unknown ids are rejected. When
    /// both this and `country` are omitted the book gets the generic
    /// profile.
    #[serde(default)]
    pub region: Option<String>,
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub book_id: String,
    pub name: String,
    pub kind: AccountKind,
    pub currency: String,
    pub institution: Option<String>,
    pub account_number_masked: Option<String>,
    pub opening_balance_minor: i64,
    pub is_archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewAccount {
    pub book_id: String,
    pub name: String,
    pub kind: AccountKind,
    pub currency: String,
    pub institution: Option<String>,
    pub account_number_masked: Option<String>,
    pub opening_balance_minor: Option<i64>,
}

/// Selective update; `None` fields are left untouched.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AccountPatch {
    pub name: Option<String>,
    pub institution: Option<String>,
    pub account_number_masked: Option<String>,
    pub is_archived: Option<bool>,
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transaction {
    pub id: String,
    pub book_id: String,
    pub account_id: String,
    pub category_id: Option<String>,
    pub document_id: Option<String>,
    pub source: TransactionSource,
    pub provider_txn_id: Option<String>,
    pub dedupe_hash: String,
    pub posted_date: String,
    pub amount_minor: i64,
    pub currency: String,
    pub merchant: Option<String>,
    pub merchant_normalized: Option<String>,
    pub description: Option<String>,
    pub notes: Option<String>,
    pub status: TransactionStatus,
    /// Who actually incurred this transaction — metadata, orthogonal to the
    /// ledger; never influences debits/credits. `None` = unattributed.
    /// Defaults from the account's owning member at creation
    /// (`transaction_create`), overridable via `transaction_attribute`. When
    /// the transaction is split across members (`transaction_splits`),
    /// reports distribute by share instead of using this single field.
    pub attributed_member_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewTransaction {
    pub book_id: String,
    pub account_id: String,
    pub source: TransactionSource,
    pub provider_txn_id: Option<String>,
    pub posted_date: String,
    pub amount_minor: i64,
    pub currency: String,
    pub merchant: Option<String>,
    pub description: Option<String>,
    pub notes: Option<String>,
    pub category_id: Option<String>,
    pub document_id: Option<String>,
    /// Disambiguates legitimate identical lines within one import batch
    /// (same account/date/amount/merchant/description). Importers number
    /// repeats 0, 1, 2, … so the content-hash dedupe rejects re-imports of
    /// the same statement without swallowing genuine duplicates. Only used
    /// when `provider_txn_id` is absent. Defaults to 0.
    #[serde(default)]
    pub dedupe_occurrence: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TransactionFilter {
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub status: Option<TransactionStatus>,
    /// Inclusive `YYYY-MM-DD` bounds.
    pub from_date: Option<String>,
    pub to_date: Option<String>,
    pub limit: Option<u32>,
}

// ---------------------------------------------------------------------------
// Category / classification
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub book_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: CategoryKind,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub is_system: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewCategory {
    pub book_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: CategoryKind,
    pub icon: Option<String>,
    pub color: Option<String>,
}

/// A category with its children, for `category_tree`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategoryNode {
    #[serde(flatten)]
    pub category: Category,
    pub children: Vec<CategoryNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MerchantMapping {
    pub id: String,
    pub book_id: String,
    pub merchant_normalized: String,
    pub category_id: String,
    pub source: MappingSource,
    pub confidence: f64,
    pub applied_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClassificationCorrection {
    pub id: String,
    pub book_id: String,
    pub transaction_id: String,
    pub merchant_normalized: Option<String>,
    pub old_category_id: Option<String>,
    pub new_category_id: Option<String>,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Budget {
    pub id: String,
    pub book_id: String,
    pub category_id: String,
    /// `YYYY-MM`.
    pub month: String,
    pub amount_minor: i64,
    pub currency: String,
    pub rollover: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetUpsert {
    pub book_id: String,
    pub category_id: String,
    pub month: String,
    pub amount_minor: i64,
    pub currency: String,
    pub rollover: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetStatus {
    pub category_id: String,
    pub month: String,
    pub budget_minor: i64,
    pub spent_minor: i64,
    pub remaining_minor: i64,
    pub currency: String,
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub book_id: String,
    pub source: DocumentSource,
    pub kind: DocumentKind,
    pub file_path: String,
    pub mime_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub original_name: Option<String>,
    pub sha256: Option<String>,
    pub status: DocumentStatus,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewDocument {
    pub book_id: String,
    pub source: DocumentSource,
    pub kind: DocumentKind,
    pub file_path: String,
    pub mime_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub original_name: Option<String>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentExtraction {
    pub id: String,
    pub document_id: String,
    pub book_id: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub status: DocumentStatus,
    /// slip-v2 JSON payload (types live in slipscan-extract).
    pub payload: Option<String>,
    pub error: Option<String>,
    pub is_current: bool,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoaAccount {
    pub id: String,
    pub book_id: String,
    pub code: String,
    pub name: String,
    pub kind: CoaKind,
    pub description: Option<String>,
    /// Fixed ISO-4217 currency for this account; `None` = any currency.
    /// Multi-currency groundwork — no FX revaluation yet.
    pub currency: Option<String>,
    pub is_archived: bool,
    pub is_system: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewCoaAccount {
    pub book_id: String,
    pub code: String,
    pub name: String,
    pub kind: CoaKind,
    pub description: Option<String>,
    /// Fixed ISO-4217 currency; omit for a currency-agnostic account.
    #[serde(default)]
    pub currency: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journal {
    pub id: String,
    pub book_id: String,
    pub posted_date: String,
    pub narrative: Option<String>,
    pub reference: Option<String>,
    pub source_type: JournalSourceType,
    pub source_id: Option<String>,
    /// When this journal reverses another, the reversed journal's id.
    /// Posted journals are never edited — corrections are reversals.
    pub reversal_of: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalLine {
    pub id: String,
    pub journal_id: String,
    pub book_id: String,
    pub coa_id: String,
    pub debit_minor: i64,
    pub credit_minor: i64,
    pub currency: String,
    pub description: Option<String>,
    pub line_order: i64,
    /// VAT rate this line was computed with, when VAT-relevant.
    pub vat_rate_id: Option<String>,
    /// Role of this line in the VAT return, when VAT-relevant.
    pub vat_role: Option<VatRole>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewJournal {
    pub book_id: String,
    pub posted_date: String,
    pub narrative: Option<String>,
    pub reference: Option<String>,
    pub source_type: JournalSourceType,
    pub source_id: Option<String>,
    pub lines: Vec<NewJournalLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewJournalLine {
    pub coa_id: String,
    pub debit_minor: i64,
    pub credit_minor: i64,
    pub currency: String,
    pub description: Option<String>,
    #[serde(default)]
    pub vat_rate_id: Option<String>,
    #[serde(default)]
    pub vat_role: Option<VatRole>,
}

/// A posted journal together with its lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostedJournal {
    #[serde(flatten)]
    pub journal: Journal,
    pub lines: Vec<JournalLine>,
}

/// Maps a personal-finance entity (account / category) to a chart-of-accounts
/// entry, used by automatic journal generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoaMapEntry {
    pub id: String,
    pub book_id: String,
    pub entity_type: CoaMapEntity,
    pub entity_id: String,
    pub coa_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VatRate {
    pub id: String,
    pub book_id: String,
    pub code: String,
    pub name: String,
    pub rate_bps: i64,
    pub country: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Recon
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReconMatch {
    pub id: String,
    pub book_id: String,
    pub transaction_id: String,
    pub document_id: Option<String>,
    pub journal_id: Option<String>,
    pub state: ReconState,
    pub confidence: f64,
    pub amount_delta_minor: i64,
    pub date_delta_days: i64,
    /// 0..1 similarity of the normalized merchant names.
    pub merchant_score: f64,
    pub created_at: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/// Spending is grouped per (category, currency): amounts in different
/// currencies are never summed into one figure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpendingRow {
    pub category_id: Option<String>,
    pub category_name: String,
    pub currency: String,
    pub total_minor: i64,
}

/// Spending grouped by calendar month (`YYYY-MM`), category, and currency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonthlySpendingRow {
    pub month: String,
    pub category_id: Option<String>,
    pub category_name: String,
    pub currency: String,
    pub total_minor: i64,
}

/// One trial-balance row: totals per (account, currency). A multi-currency
/// book yields one row per currency for accounts posted in several.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrialBalanceRow {
    pub coa_id: String,
    pub code: String,
    pub name: String,
    pub kind: CoaKind,
    pub currency: String,
    pub debit_minor: i64,
    pub credit_minor: i64,
}

/// One income/expense account's net movement over a period.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IncomeStatementRow {
    pub coa_id: String,
    pub code: String,
    pub name: String,
    pub kind: CoaKind,
    /// Income: credits − debits. Expenses: debits − credits.
    pub amount_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IncomeStatement {
    pub book_id: String,
    pub from_date: String,
    pub to_date: String,
    /// The single currency this statement is computed in (the book's base
    /// currency). Journal lines in other currencies are excluded — they show
    /// up per currency on the trial balance instead of being mixed in here.
    pub currency: String,
    pub income: Vec<IncomeStatementRow>,
    pub expenses: Vec<IncomeStatementRow>,
    pub income_total_minor: i64,
    pub expense_total_minor: i64,
    pub net_profit_minor: i64,
}

/// Per-tax-rate totals feeding the tax-period summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaxSummaryRow {
    pub vat_rate_id: Option<String>,
    pub code: String,
    pub name: String,
    pub rate_bps: i64,
    pub output_base_minor: i64,
    pub output_vat_minor: i64,
    pub input_base_minor: i64,
    pub input_vat_minor: i64,
}

/// Deprecated alias — the row type was renamed to [`TaxSummaryRow`];
/// "VAT201" is the SA region profile's label, not a core concept.
#[deprecated(note = "renamed to TaxSummaryRow")]
pub type Vat201Row = TaxSummaryRow;

/// One balance-sheet line: an asset / liability / equity account's balance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BalanceSheetRow {
    pub coa_id: String,
    pub code: String,
    pub name: String,
    pub kind: CoaKind,
    /// Natural-side balance: assets debit − credit; liabilities and equity
    /// credit − debit.
    pub amount_minor: i64,
}

/// Balance sheet as of a date. Income/expense movements up to the date are
/// folded into `retained_earnings_minor` so the statement always balances.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BalanceSheet {
    pub book_id: String,
    pub as_of_date: String,
    /// The single currency this statement is computed in (the book's base
    /// currency). Lines in other currencies are excluded, not mixed in.
    pub currency: String,
    pub assets: Vec<BalanceSheetRow>,
    pub liabilities: Vec<BalanceSheetRow>,
    pub equity: Vec<BalanceSheetRow>,
    /// Accumulated income − expenses up to `as_of_date` (part of equity).
    pub retained_earnings_minor: i64,
    pub assets_total_minor: i64,
    pub liabilities_total_minor: i64,
    /// Equity rows + retained earnings.
    pub equity_total_minor: i64,
}

/// Display labels for the tax-period summary boxes, taken from the book's
/// region profile — core never hardcodes report wording.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaxBoxLabels {
    pub standard_rated_supplies: String,
    pub zero_rated_supplies: String,
    pub exempt_supplies: String,
    pub output_tax: String,
    pub input_tax: String,
    pub net_tax: String,
}

/// Tax-period summary: output tax on supplies, input tax on purchases, and
/// the net amount payable to (positive) or refundable by (negative) the
/// revenue service. The report name and box labels come from the book's
/// region profile — South Africa's profile labels this report "VAT201".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaxPeriodSummary {
    pub book_id: String,
    pub from_date: String,
    pub to_date: String,
    /// The single currency this return is computed in (the book's base
    /// currency); tax-tagged lines in other currencies are excluded.
    pub currency: String,
    /// Region-profile display name for this report (e.g. "VAT201").
    pub report_name: String,
    pub labels: TaxBoxLabels,
    pub rows: Vec<TaxSummaryRow>,
    pub standard_rated_supplies_minor: i64,
    pub zero_rated_supplies_minor: i64,
    pub exempt_supplies_minor: i64,
    pub output_vat_minor: i64,
    pub input_vat_minor: i64,
    pub net_vat_minor: i64,
}

/// Deprecated alias — renamed to [`TaxPeriodSummary`]; "VAT201" is the SA
/// region profile's label for the generic tax-period summary.
#[deprecated(note = "renamed to TaxPeriodSummary — VAT201 is the SA profile's report label")]
pub type Vat201Summary = TaxPeriodSummary;

// ---------------------------------------------------------------------------
// Period close
//
// The ritual that turns a ledger into a book someone will sign:
// `CoreService::close_period_check` previews it (read-only, mutates
// nothing); `CoreService::close_period` runs the identical checks and, only
// if nothing hard-refuses, advances `books.financial_lock_date` to
// `to_date` in the same transaction. `CoreService::reopen_period` is the
// deliberate, reasoned, audited undo.
// ---------------------------------------------------------------------------

/// One currency's debit/credit totals over every journal line posted on or
/// before the close date — the close's own balance check. Every journal is
/// individually balanced at post time (`post_journal_in_tx`), so `debit_minor
/// != credit_minor` here can only mean something reached `journal_lines`
/// outside the service layer: this is a data-integrity guard, not a business
/// rule a real close is ever expected to trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClosePeriodCurrencyBalance {
    pub currency: String,
    pub debit_minor: i64,
    pub credit_minor: i64,
}

/// The result of checking (or performing) a period close.
///
/// `close_period_check` and `close_period` return the exact same shape,
/// computed by the exact same checks, so a dry run and a real close can
/// never disagree about what they found — only about whether `closed`
/// ends up `true` and whether `books.financial_lock_date` actually moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClosePeriodReport {
    pub book_id: String,
    /// The date being sealed through (inclusive). Becomes the book's new
    /// `financial_lock_date` when the close succeeds.
    pub to_date: String,
    /// The book's `financial_lock_date` before this call — `None` if the
    /// book had never been closed. The advisory checks below are scoped to
    /// the period this close newly covers: the day after this date (or the
    /// beginning of the book, if `None`) through `to_date`.
    pub previous_lock_date: Option<String>,
    /// Per-currency debit/credit totals as of `to_date`. Empty for a book
    /// with no postings yet — vacuously balanced.
    pub balance: Vec<ClosePeriodCurrencyBalance>,
    /// Whether every currency in `balance` has `debit_minor == credit_minor`.
    pub balanced: bool,
    /// Uncategorised (verified/pending) transactions dated in the newly
    /// covered period.
    pub uncategorised_transaction_count: i64,
    /// Transactions in the period with no `auto`- or human-confirmed
    /// reconciliation match — a `suggested` match still wants a human look,
    /// same as no match at all.
    pub unreconciled_statement_line_count: i64,
    /// Draft sales orders dated in the period — still being edited, not
    /// wrong, but worth a look before the period they belong to is sealed.
    pub draft_sales_order_count: i64,
    /// Invoices due in the period with zero payments recorded against them.
    pub unpaid_invoice_due_count: i64,
    /// Hard-refusal reasons. Non-empty means `close_period` will refuse
    /// (`CoreError::CloseBlocked`) rather than move the lock date.
    pub blocking_reasons: Vec<String>,
    /// Advisory notes — never block a close, always worth reading. Present
    /// on a successful close's own returned report too, not just the dry
    /// run: closing does not make the messiness disappear, only seals the
    /// period it was found in.
    pub warnings: Vec<String>,
    /// Whether this period *can* be closed (`blocking_reasons` is empty).
    pub closeable: bool,
    /// Whether the lock date was actually moved by this call. Always
    /// `false` from `close_period_check`, which never mutates; `true` from
    /// `close_period` only once it has committed the change — so the two
    /// calls' output is never confused for one another after the fact.
    pub closed: bool,
}

// ---------------------------------------------------------------------------
// Payments — watch codes, webhook endpoints, matches, deliveries
// ---------------------------------------------------------------------------

str_enum!(
    /// Delivery queue state. `pending` retries with backoff; `delivered` and
    /// `failed` are terminal.
    PayDeliveryState {
        Pending => "pending",
        Delivered => "delivered",
        Failed => "failed",
    }
);

/// A reference code being watched on inbound transactions. Deliberately a
/// flat list: no expiry, no recurrence, no lifecycle — `enabled` is the only
/// state, and an optional exact amount is the only filter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayWatch {
    pub id: String,
    pub book_id: String,
    /// Stored verbatim; matched case-insensitively as a whole token within
    /// the transaction description/merchant (INV1 never matches INV11).
    pub code: String,
    pub label: Option<String>,
    /// When set, only a transaction of exactly this amount (in
    /// `expected_currency`) matches.
    pub expected_amount_minor: Option<i64>,
    pub expected_currency: Option<String>,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewPayWatch {
    pub book_id: String,
    pub code: String,
    #[serde(default)]
    pub label: Option<String>,
    /// Optional exact-amount filter; requires `expected_currency`.
    #[serde(default)]
    pub expected_amount_minor: Option<i64>,
    #[serde(default)]
    pub expected_currency: Option<String>,
}

/// A webhook receiver. The signing secret is vault-held (write-only) under a
/// name derived from `id` — never a field here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayEndpoint {
    pub id: String,
    pub book_id: String,
    pub label: String,
    pub url: String,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewPayEndpoint {
    pub book_id: String,
    pub label: String,
    pub url: String,
}

/// Return type of `pay_endpoint_add` / `pay_endpoint_rotate_secret` — the
/// **only** sanctioned display of a signing secret, exactly once.
///
/// Why once: the receiver operator has to copy the secret into their own
/// system to verify signatures, so a single handover at creation/rotation is
/// unavoidable. After that the vault's write-only contract applies — there is
/// no `get`-for-display, and losing the secret means rotating it.
#[derive(Debug, Clone, Serialize)]
pub struct PayEndpointWithSecret {
    pub endpoint: PayEndpoint,
    /// 32 random bytes, hex-encoded (64 chars). Shown here once, then
    /// reachable only via the vault's `use_with` at signing time.
    pub secret: String,
}

/// One detection: watch `watch_id` matched transaction `transaction_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayMatch {
    pub id: String,
    pub book_id: String,
    pub watch_id: String,
    pub transaction_id: String,
    pub matched_at: String,
}

/// One queued webhook delivery. `payload` is the exact JSON body POSTed and
/// signed — metadata only (watch label + reference, amount/currency/date,
/// matched_at), never account numbers or the raw bank description.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayDelivery {
    pub id: String,
    pub book_id: String,
    pub endpoint_id: String,
    pub match_id: String,
    pub payload: String,
    pub state: PayDeliveryState,
    pub attempts: i64,
    pub next_attempt_at: String,
    pub last_status: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Household members & per-person attribution
// ---------------------------------------------------------------------------

str_enum!(MemberStatus { Active => "active", Revoked => "revoked" });

/// A person in the household sharing this book — local data, never a login.
/// See ARCHITECTURE.md "Household members & per-person attribution" and
/// docs/ROLES.md "members become principals" for `status`/`attributable`/
/// `principal`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub id: String,
    pub book_id: String,
    pub label: String,
    /// Short display initial (e.g. "A"), for tight UI spots (avatars, table
    /// cells) where the full label would crowd.
    pub initial: String,
    /// Cosmetic hex colour swatch; core stores it verbatim and never
    /// interprets it.
    pub colour: String,
    /// The account this member owns by default. New transactions on it
    /// attribute to this member unless overridden (`transaction_attribute`).
    /// `None` = no default owner.
    pub default_account_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// `Revoked` is a tombstone, not a delete — set once by `member_revoke`
    /// and never reversed. See migration `0006_members`'s header.
    pub status: MemberStatus,
    pub revoked_at: Option<String>,
    /// Appears in "whose spend is this" (attribution / splits).
    pub attributable: bool,
    /// May hold capabilities and devices. **Monotonic**: once true, stays
    /// true — `member_remove` refuses a member who *ever* held authority,
    /// not just one who holds it now.
    pub principal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewMember {
    pub book_id: String,
    pub label: String,
    /// Defaults to the label's first alphanumeric character, uppercased.
    #[serde(default)]
    pub initial: Option<String>,
    /// Defaults to one of a small built-in rotation when omitted.
    #[serde(default)]
    pub colour: Option<String>,
    #[serde(default)]
    pub default_account_id: Option<String>,
}

/// Selective update; `None` fields are left untouched.
/// `default_account_id: Some(None)` explicitly clears the default account
/// (as opposed to `None`, which leaves it as-is).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemberPatch {
    pub label: Option<String>,
    pub initial: Option<String>,
    pub colour: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_account_id: Option<Option<String>>,
}

/// One named operation granted to a `principal` (docs/ROLES.md "Authority is
/// a set of operations, not table permissions"). A capability is present or
/// absent — there is no field on it that changes value under a live id, so
/// grant/revoke are an insert and a delete, never an update.
///
/// `operation` is a free-form name today (the 177 IPC commands / 188 HTTP
/// routes ROLES.md names as the eventual registry); nothing in core
/// validates it against that registry yet, and nothing reads this table to
/// refuse an operation — see the module docs on `CoreService::member_
/// capability_grant` for why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberCapability {
    pub id: String,
    pub book_id: String,
    pub member_id: String,
    pub operation: String,
    pub granted_at: String,
}

/// One `(member, share)` row of a split transaction, as stored. `share_minor`
/// is always a positive portion of the transaction's absolute amount.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransactionSplit {
    pub id: String,
    pub transaction_id: String,
    pub member_id: String,
    pub share_minor: i64,
    pub created_at: String,
}

/// Input to `transaction_split_set`: the `(member, share)` pairs must sum to
/// the transaction's absolute amount. An empty list clears the split (the
/// transaction reverts to single-member attribution / unattributed).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SplitShare {
    pub member_id: String,
    pub share_minor: i64,
}

/// One member's outflow (expense) or inflow (contribution) total over a
/// period, in the book's base currency. `member_id = None` is the
/// "Unattributed" bucket: transactions with no split and no
/// `attributed_member_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberAmountRow {
    pub member_id: Option<String>,
    pub member_label: String,
    pub currency: String,
    pub total_minor: i64,
}

/// One member's share of one category's spend over a period (outflows
/// only), in the book's base currency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberCategoryRow {
    pub member_id: Option<String>,
    pub member_label: String,
    pub category_id: Option<String>,
    pub category_name: String,
    pub currency: String,
    pub total_minor: i64,
}

/// One member's net position over a period: contributions (inflow) minus
/// attributed expenses (outflow), in the book's base currency. Positive =
/// net contributor (is owed by the household); negative = net consumer
/// (owes the household). Every current member appears, plus an
/// "Unattributed" row for activity with no member at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberSettleRow {
    pub member_id: Option<String>,
    pub member_label: String,
    pub currency: String,
    pub contributions_minor: i64,
    pub expenses_minor: i64,
    pub net_minor: i64,
}

// ---------------------------------------------------------------------------
// Locations (Phase 6.1 — the FlowStock fold, foundation)
// ---------------------------------------------------------------------------

/// A physical place a book's activity happens at — a branch, a warehouse, a
/// site. Additive and optional, the same way [`Member`] is: a book with zero
/// locations behaves exactly as it did before this axis existed. Nothing
/// references a location yet (see migration `0009_locations`) — later
/// inventory (Phase 6.2+) will.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Location {
    pub id: String,
    pub book_id: String,
    pub name: String,
    pub kind: LocationKind,
    /// Optional short code for reports and labels (e.g. "JHB-01"). Unique
    /// within the book when set; `None` is never compared against another
    /// `None`.
    pub code: Option<String>,
    pub address: Option<String>,
    pub is_archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewLocation {
    pub book_id: String,
    pub name: String,
    /// Defaults to [`LocationKind::Branch`] when omitted.
    #[serde(default)]
    pub kind: Option<LocationKind>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
}

/// Selective update; `None` fields are left untouched. `code: Some(None)` and
/// `address: Some(None)` explicitly clear those fields (as opposed to `None`,
/// which leaves them as-is) — the same double-option convention
/// [`MemberPatch::default_account_id`] uses.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LocationPatch {
    pub name: Option<String>,
    pub kind: Option<LocationKind>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub code: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub address: Option<Option<String>>,
    pub is_archived: Option<bool>,
}

// ---------------------------------------------------------------------------
// Contacts (Xero axis — PARITY.md "Contacts (customers & suppliers)")
// ---------------------------------------------------------------------------

/// A party a book trades with, on either side or both — see migration
/// `0010_contacts` for why this is one table with a `role` rather than
/// separate customer/supplier tables. `credit_limit_minor` is in the book's
/// own `currency`; SlipScan has no per-contact currency concept yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contact {
    pub id: String,
    pub book_id: String,
    pub role: ContactRole,
    pub name: String,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub billing_address: Option<String>,
    pub shipping_address: Option<String>,
    pub tax_number: Option<String>,
    /// Net payment terms in days (e.g. 30 for "Net 30"). `None` = no term on
    /// record.
    pub payment_terms_days: Option<i64>,
    pub credit_limit_minor: Option<i64>,
    pub notes: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewContact {
    pub book_id: String,
    pub role: ContactRole,
    pub name: String,
    #[serde(default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub billing_address: Option<String>,
    #[serde(default)]
    pub shipping_address: Option<String>,
    #[serde(default)]
    pub tax_number: Option<String>,
    #[serde(default)]
    pub payment_terms_days: Option<i64>,
    #[serde(default)]
    pub credit_limit_minor: Option<i64>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Selective update; `None` fields are left untouched. The nullable fields
/// use `Option<Option<T>>` (as `MemberPatch::default_account_id` does):
/// `Some(None)` explicitly clears the field, plain `None` leaves it as-is.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContactPatch {
    pub role: Option<ContactRole>,
    pub name: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub company_name: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub email: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub phone: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub billing_address: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub shipping_address: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub tax_number: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub payment_terms_days: Option<Option<i64>>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub credit_limit_minor: Option<Option<i64>>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub notes: Option<Option<String>>,
    pub is_active: Option<bool>,
}

// ---------------------------------------------------------------------------
// Product catalogue (migration 0011, ROADMAP.md Phase 6.3a).
//
// Named `ProductCategory` rather than reusing `Category`: this groups
// catalogue items, not transactions, and shares no columns, no hierarchy and
// no reporting path with the transaction-categorisation `Category` above.
// See the migration header for the full reasoning.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductCategory {
    pub id: String,
    pub book_id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewProductCategory {
    pub book_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Product {
    pub id: String,
    pub book_id: String,
    pub product_category_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewProduct {
    pub book_id: String,
    pub product_category_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
}

/// Selective update; `None` fields are left untouched.
/// `product_category_id: Some(None)` explicitly clears the category (as
/// opposed to `None`, which leaves it as-is).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProductPatch {
    pub name: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub product_category_id: Option<Option<String>>,
}

/// The catalogue's sellable/stockable unit. Carries no on-hand quantity —
/// see the migration header: that is `SUM(qty_delta)` over a stock-movement
/// ledger a later stage adds, never a stored counter here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductVariant {
    pub id: String,
    pub product_id: String,
    pub book_id: String,
    pub sku: String,
    pub name: String,
    pub price_minor: i64,
    pub cost_price_minor: i64,
    pub currency: String,
    pub reorder_point: i64,
    /// Free-form JSON object (e.g. `{"size": "M", "colour": "Red"}`), stored
    /// and returned verbatim — never parsed or validated beyond "is this
    /// valid JSON" in the service layer. `None` = no attributes recorded.
    pub attributes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewProductVariant {
    pub product_id: String,
    pub sku: String,
    pub name: String,
    #[serde(default)]
    pub price_minor: Option<i64>,
    #[serde(default)]
    pub cost_price_minor: Option<i64>,
    pub currency: String,
    #[serde(default)]
    pub reorder_point: Option<i64>,
    #[serde(default)]
    pub attributes: Option<String>,
}

/// Selective update; `None` fields are left untouched.
/// `attributes: Some(None)` explicitly clears attributes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProductVariantPatch {
    pub sku: Option<String>,
    pub name: Option<String>,
    pub price_minor: Option<i64>,
    pub cost_price_minor: Option<i64>,
    pub reorder_point: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub attributes: Option<Option<String>>,
}

// ---------------------------------------------------------------------------
// Stock movements (migration 0012, ROADMAP.md Phase 6.3b — the append-only
// stock-movement ledger).
//
// There is no `StockMovementPatch` and no update/delete function anywhere
// behind this type: see migration `0012_stock`'s header for why a correction
// is always a second, compensating row rather than an edit to this one.
// ---------------------------------------------------------------------------

/// One immutable fact: this many units of `variant_id` moved at
/// `location_id`, in `kind`'s sense of the word. On-hand is never read off
/// this struct directly — it is always `SUM(qty_delta)` over a set of these,
/// computed in `repo::stock` at query time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StockMovement {
    pub id: String,
    pub book_id: String,
    pub variant_id: String,
    pub location_id: String,
    /// Signed. Positive = arrived at this location, negative = left it.
    /// Never zero — see the migration's `CHECK (qty_delta != 0)`.
    pub qty_delta: i64,
    pub kind: StockMovementKind,
    /// What caused this movement, in whatever vocabulary the causing stage
    /// uses. `Some("transfer")` is the only value this crate itself writes
    /// today (see [`Service::stock_transfer`](crate::service::Service)) —
    /// purchasing (6.4) and sales (6.5) will add their own once they exist.
    pub ref_kind: Option<String>,
    /// The id of whatever `ref_kind` names. For a transfer this is the pair's
    /// shared correlation id, not either movement's own `id` — see
    /// [`TransferResult`].
    pub ref_id: Option<String>,
    pub note: Option<String>,
    /// Free text, no FK — SlipScan has no user/staff identity yet (see the
    /// migration header). `None` = not recorded.
    pub created_by: Option<String>,
    pub created_at: String,
}

/// What it takes to record one movement. `book_id` is deliberately absent —
/// it is derived from the variant, the same way [`NewProductVariant`] derives
/// its book from the product it belongs to, so it can never disagree with the
/// variant's own book.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewStockMovement {
    pub variant_id: String,
    pub location_id: String,
    pub qty_delta: i64,
    pub kind: StockMovementKind,
    #[serde(default)]
    pub ref_kind: Option<String>,
    #[serde(default)]
    pub ref_id: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub created_by: Option<String>,
}

/// The two movements a [`Service::stock_transfer`](crate::service::Service)
/// call produces: one leaving `from_location_id` (negative), one arriving at
/// `to_location_id` (positive), sharing one `ref_id` so they can be found as
/// a pair later. Their `qty_delta`s always sum to zero — that is the whole
/// point of recording a transfer as two ledger facts instead of moving a
/// number from one place to another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferResult {
    pub out: StockMovement,
    pub in_: StockMovement,
}

/// A variant whose total on-hand, summed across every location, has fallen to
/// or below its own `reorder_point`. Carries the on-hand figure alongside the
/// variant rather than making the caller re-derive it, since deriving it is
/// the expensive half of the query this type exists to answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LowStockVariant {
    pub variant: ProductVariant,
    pub on_hand: i64,
}

// ---------------------------------------------------------------------------
// Purchasing (migration 0013, ROADMAP.md Phase 6.4 — purchase orders and
// goods receipts, re-derived from the retired FlowStock product).
// ---------------------------------------------------------------------------

/// A purchase order header: who it is going to, where it is expected, and
/// the running money totals. Editable — last-writer-wins, the same as
/// [`Contact`] or [`Location`]. `subtotal_minor`/`total_minor` are kept in
/// step by the service layer whenever a line changes (see
/// `CoreService::po_item_add`); there is nowhere else they could come from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PurchaseOrder {
    pub id: String,
    pub book_id: String,
    /// A `contacts` row — see migration `0013_purchasing`'s header for why
    /// this is `RESTRICT` rather than `SET NULL`.
    pub supplier_id: String,
    /// Where this order is expected. Not necessarily where every receipt
    /// against it actually lands — see [`PoReceipt::location_id`].
    pub location_id: String,
    pub po_number: String,
    pub order_date: String,
    pub expected_delivery: Option<String>,
    pub status: PurchaseOrderStatus,
    pub subtotal_minor: i64,
    pub tax_minor: i64,
    pub total_minor: i64,
    pub currency: String,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// What it takes to open a PO. Starts at `subtotal_minor = total_minor = 0`
/// with zero lines — `po_item_add` is what grows both.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewPurchaseOrder {
    pub book_id: String,
    pub supplier_id: String,
    pub location_id: String,
    pub po_number: String,
    pub order_date: String,
    #[serde(default)]
    pub expected_delivery: Option<String>,
    pub currency: String,
    #[serde(default)]
    pub tax_minor: Option<i64>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Selective update; `None` fields are left untouched. Deliberately carries
/// no `status` field — status moves only through `CoreService::
/// po_set_status`'s guarded transitions, never through a general patch.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PurchaseOrderPatch {
    pub supplier_id: Option<String>,
    pub location_id: Option<String>,
    pub po_number: Option<String>,
    pub order_date: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub expected_delivery: Option<Option<String>>,
    pub tax_minor: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub notes: Option<Option<String>>,
}

/// One line on a purchase order: this many of this variant, at this unit
/// price. `total_minor = qty_ordered * unit_price_minor`, kept in step by the
/// service layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PurchaseOrderItem {
    pub id: String,
    pub purchase_order_id: String,
    pub book_id: String,
    pub variant_id: String,
    pub qty_ordered: i64,
    pub unit_price_minor: i64,
    pub total_minor: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewPurchaseOrderItem {
    pub purchase_order_id: String,
    pub variant_id: String,
    pub qty_ordered: i64,
    #[serde(default)]
    pub unit_price_minor: Option<i64>,
}

/// Selective update; `None` fields are left untouched.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PurchaseOrderItemPatch {
    pub qty_ordered: Option<i64>,
    pub unit_price_minor: Option<i64>,
}

/// One immutable fact: this many units of a PO line arrived at this
/// location. On-hand-style figures are never read off this struct directly —
/// a line's received quantity is always `SUM(qty)` over a set of these,
/// computed in `repo::purchasing` at query time. There is no
/// `PoReceiptPatch` and no update/delete function anywhere behind this type:
/// see migration `0013_purchasing`'s header for why a correction is always a
/// second, compensating row rather than an edit to this one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PoReceipt {
    pub id: String,
    pub book_id: String,
    pub purchase_order_item_id: String,
    /// Where this particular receipt happened — independent of the parent
    /// PO's own `location_id`, so two sites can both receive against one
    /// line and converge by union rather than needing to agree first.
    pub location_id: String,
    /// Signed, like [`StockMovement::qty_delta`]. Positive = arrived,
    /// negative = a correction to an earlier over-receipt. Never zero.
    pub qty: i64,
    pub note: Option<String>,
    /// Free text, no FK — SlipScan has no user/staff identity yet (see
    /// [`StockMovement::created_by`]).
    pub received_by: Option<String>,
    pub created_at: String,
}

/// What it takes to record one receipt. `book_id` is deliberately absent —
/// derived from the line item, the same way [`NewStockMovement`] derives its
/// book from the variant, so it can never disagree with the item's own book.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewPoReceipt {
    pub purchase_order_item_id: String,
    pub location_id: String,
    pub qty: i64,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub received_by: Option<String>,
}

/// A PO line together with its derived receiving progress — the pairing a
/// purchasing screen actually wants to render, so it does not have to call
/// back for the sum itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PurchaseOrderItemReceiving {
    pub item: PurchaseOrderItem,
    pub received_qty: i64,
    pub status: PoReceiptStatus,
}

// ---------------------------------------------------------------------------
// Sales orders (migration 0014, ROADMAP.md Phase 6.5 — PARITY.md's single
// largest Xero-axis gap). See the migration header for why this table is an
// editable §4.4 LWW register while `Invoice` below is not.
// ---------------------------------------------------------------------------

str_enum!(SalesOrderStatus {
    Draft => "draft",
    Confirmed => "confirmed",
    Paid => "paid",
    Cancelled => "cancelled",
});

/// A customer order. Draft while a person is still shaping it; `confirm`
/// deducts stock for every stock-tracked line (migration `0012_stock`'s
/// ledger, `kind = sale`); `cancel` writes a compensating movement for each
/// one it had deducted rather than erasing anything, because that ledger is
/// immutable. There is no `subtotal`/`tax`/`total` column here, on purpose —
/// see [`SalesOrderTotals`]: a stored total is exactly the cached figure
/// Decision 4 in ROADMAP.md's Phase 6 header already refuses for on-hand
/// stock, for the same reason (it is trivial to forget to update after an
/// item edit, and a derived sum cannot forget).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SalesOrder {
    pub id: String,
    pub book_id: String,
    pub contact_id: String,
    /// Set the moment the order has a stock-tracked line; `None` is valid for
    /// a purely free-text/service order that never touches stock.
    pub location_id: Option<String>,
    /// Assigned once at creation by `repo::sales::allocate_number`, scoped to
    /// series `"sales_order"`. Never reassigned.
    pub number: i64,
    pub order_date: String,
    pub status: SalesOrderStatus,
    pub currency: String,
    pub notes: Option<String>,
    pub confirmed_at: Option<String>,
    pub cancelled_at: Option<String>,
    pub paid_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSalesOrder {
    pub book_id: String,
    pub contact_id: String,
    #[serde(default)]
    pub location_id: Option<String>,
    /// `YYYY-MM-DD`; defaults to today when omitted.
    #[serde(default)]
    pub order_date: Option<String>,
    /// Defaults to the book's own currency when omitted.
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Selective update to a sales order's own header fields. Only reachable
/// while the order is `draft` — see `CoreService::sales_order_update`.
/// `status` is deliberately absent: transitions go through their own
/// dedicated functions (`sales_order_confirm`/`_cancel`/`_mark_paid`), which
/// carry effects (stock deduction, timestamps) a blind field patch must not
/// be able to skip.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SalesOrderPatch {
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub location_id: Option<Option<String>>,
    pub order_date: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub notes: Option<Option<String>>,
}

/// A line on a sales order. `variant_id: None` is a free-text/service line —
/// never touched by stock. `description`/`unit_price_minor` are captured at
/// add-time rather than read live off the variant every time, so a later
/// rename or repricing of the catalogue item does not reword or reprice an
/// order a customer has already seen — the same treatment
/// `journal_lines.description` gets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SalesOrderItem {
    pub id: String,
    pub sales_order_id: String,
    pub book_id: String,
    pub variant_id: Option<String>,
    pub description: String,
    pub quantity: i64,
    pub unit_price_minor: i64,
    /// Basis points, same convention as `vat_rates.rate_bps` — a snapshot,
    /// not a live reference.
    pub tax_rate_bps: i64,
    pub line_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSalesOrderItem {
    pub sales_order_id: String,
    #[serde(default)]
    pub variant_id: Option<String>,
    /// Required for a free-text line (`variant_id: None`); defaults to the
    /// variant's own name for a catalogue line.
    #[serde(default)]
    pub description: Option<String>,
    pub quantity: i64,
    /// Required for a free-text line; defaults to the variant's own
    /// `price_minor` for a catalogue line.
    #[serde(default)]
    pub unit_price_minor: Option<i64>,
    #[serde(default)]
    pub tax_rate_bps: Option<i64>,
}

/// Selective update; `None` fields are left untouched. Only reachable while
/// the order is still a draft — see `CoreService::sales_order_item_update`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SalesOrderItemPatch {
    pub description: Option<String>,
    pub quantity: Option<i64>,
    pub unit_price_minor: Option<i64>,
    pub tax_rate_bps: Option<i64>,
}

/// `subtotal + tax == total`, always. Computed at query time from a sales
/// order's own items — see the header note on [`SalesOrder`] for why this is
/// never a stored column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SalesOrderTotals {
    pub subtotal_minor: i64,
    pub tax_minor: i64,
    pub total_minor: i64,
}

// ---------------------------------------------------------------------------
// Quotes (migration 0014, ROADMAP.md Phase 6.5 addendum — PARITY.md's "next
// Xero row" once invoicing shipped). A quote is a priced offer that has not
// happened yet: it never touches stock, never touches the ledger, and shares
// no numbering series with `sales_orders`. `draft -> sent -> accepted |
// declined | expired`; accepting one copies its lines into a brand new
// `sales_orders` row (`CoreService::quote_accept`) rather than inventing a
// second "confirm"-shaped path — the exact reuse `invoice_issue` already
// makes of a confirmed order's lines, just one hop earlier in the lifecycle.
// Same §4.4 LWW-register treatment as `sales_orders`/`sales_order_items` for
// the identical reason: a person keeps editing a quote — add a line, fix a
// price — right up until it is sent.
// ---------------------------------------------------------------------------

str_enum!(QuoteStatus {
    Draft => "draft",
    Sent => "sent",
    Accepted => "accepted",
    Declined => "declined",
    Expired => "expired",
});

/// A priced offer, not yet a sale. No `location_id` here at all — unlike
/// `SalesOrder`, a quote never deducts stock, so it has nothing to deduct
/// stock *from*. The `sales_orders` row `quote_accept` creates starts with
/// `location_id: None`, exactly like any other freshly created order; a
/// stock-tracked line still requires one before that order can confirm, the
/// same gate every other order line clears.
///
/// No `subtotal`/`tax`/`total` column, on purpose — same reasoning as
/// [`SalesOrder`]: see [`SalesOrderTotals`], reused here as `quote_totals`'s
/// return type since the shape is identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quote {
    pub id: String,
    pub book_id: String,
    pub contact_id: String,
    /// Assigned once at creation by `repo::sales::allocate_number`, scoped to
    /// series `"quote"` — a numbering book entirely separate from
    /// `sales_orders`' own `"sales_order"` series. Never reassigned.
    pub number: i64,
    pub quote_date: String,
    /// Advisory only: nothing here auto-expires a quote past this date —
    /// `quote_expire` is a deliberate call, not a timer. See migration
    /// `0014_sales`'s header for why no background job does this instead.
    pub expiry_date: Option<String>,
    pub status: QuoteStatus,
    pub currency: String,
    pub notes: Option<String>,
    pub sent_at: Option<String>,
    pub accepted_at: Option<String>,
    pub declined_at: Option<String>,
    pub expired_at: Option<String>,
    /// Set only by `quote_accept`, the moment this quote's lines are copied
    /// into a brand-new draft `sales_orders` row. `None` until then, and
    /// forever after for a quote that is declined, expires, or is still
    /// draft/sent.
    pub converted_sales_order_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewQuote {
    pub book_id: String,
    pub contact_id: String,
    /// `YYYY-MM-DD`; defaults to today when omitted.
    #[serde(default)]
    pub quote_date: Option<String>,
    #[serde(default)]
    pub expiry_date: Option<String>,
    /// Defaults to the book's own currency when omitted.
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Selective update to a quote's own header fields. Only reachable while the
/// quote is `draft` — see `CoreService::quote_update`. `status` is
/// deliberately absent, the same reasoning `SalesOrderPatch` gives: a
/// transition carries effects (timestamps, and for `accept`, a whole new
/// sales order) a blind field patch must not be able to skip.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QuotePatch {
    pub quote_date: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub expiry_date: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub notes: Option<Option<String>>,
}

/// A line on a quote. Same shape and the same add-time-capture reasoning as
/// [`SalesOrderItem`] — `description`/`unit_price_minor` are snapshotted so a
/// later catalogue rename or repricing does not reword or reprice an offer a
/// customer has already seen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuoteItem {
    pub id: String,
    pub quote_id: String,
    pub book_id: String,
    pub variant_id: Option<String>,
    pub description: String,
    pub quantity: i64,
    pub unit_price_minor: i64,
    pub tax_rate_bps: i64,
    pub line_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewQuoteItem {
    pub quote_id: String,
    #[serde(default)]
    pub variant_id: Option<String>,
    /// Required for a free-text line (`variant_id: None`); defaults to the
    /// variant's own name for a catalogue line.
    #[serde(default)]
    pub description: Option<String>,
    pub quantity: i64,
    /// Required for a free-text line; defaults to the variant's own
    /// `price_minor` for a catalogue line.
    #[serde(default)]
    pub unit_price_minor: Option<i64>,
    #[serde(default)]
    pub tax_rate_bps: Option<i64>,
}

/// Selective update; `None` fields are left untouched. Only reachable while
/// the quote is still a draft — see `CoreService::quote_item_update`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QuoteItemPatch {
    pub description: Option<String>,
    pub quantity: Option<i64>,
    pub unit_price_minor: Option<i64>,
    pub tax_rate_bps: Option<i64>,
}

// ---------------------------------------------------------------------------
// Invoices (migration 0014, ROADMAP.md Phase 6.5). See the migration header
// for why `Invoice`/`InvoiceItem`/`InvoicePayment` are immutable §4.3 OR-Sets
// rather than editable rows: an invoice is only ever created already issued
// and numbered by `CoreService::invoice_issue` — there is no draft phase, no
// update function, and no delete function anywhere behind these three types,
// the same absence `StockMovement` documents for itself.
// ---------------------------------------------------------------------------

str_enum!(InvoicePaymentStatus {
    Unpaid => "unpaid",
    PartlyPaid => "partly_paid",
    Paid => "paid",
});

/// A real invoice: numbered, dated, and permanent from the moment it exists.
/// There is deliberately no `status` field — paid/unpaid/partly-paid is
/// always derived from [`InvoicePayment`] rows against [`InvoiceTotals`],
/// never stored, for the identical reason on-hand stock is never stored (see
/// migration `0012_stock`'s Decision 4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invoice {
    pub id: String,
    pub book_id: String,
    pub contact_id: String,
    /// The confirmed/paid order this invoice was raised from, or `None` for
    /// a standalone invoice (a retainer, a one-off service bill) with no
    /// order behind it at all.
    pub sales_order_id: Option<String>,
    /// A numbering book. `"invoice"` is the only value this crate's own
    /// service functions ever write; free text (like
    /// `stock_movements.ref_kind`) so a future numbering book — a credit
    /// note series, a per-location series — has somewhere to live without a
    /// schema change.
    pub series: String,
    /// Assigned once, atomically, by `repo::sales::allocate_number` at issue
    /// time. See the migration header for the concurrency guarantee this
    /// carries and the one it deliberately does not (yet).
    pub number: i64,
    pub issue_date: String,
    pub due_date: String,
    pub currency: String,
    pub notes: Option<String>,
    pub created_at: String,
}

/// Everything `invoice_issue` needs. Exactly one of two shapes:
///
/// - `sales_order_id: Some(id)` — line items are copied from that order
///   (which must belong to `book_id`, must be `confirmed` or `paid`, and
///   whose own `contact_id`/`currency` are used, overriding whatever this
///   struct's `contact_id`/`currency`/`items` carry).
/// - `sales_order_id: None` — a standalone invoice; `contact_id`, `currency`
///   and a non-empty `items` are all required.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewInvoice {
    pub book_id: String,
    #[serde(default)]
    pub contact_id: Option<String>,
    #[serde(default)]
    pub sales_order_id: Option<String>,
    /// Defaults to `"invoice"` when omitted.
    #[serde(default)]
    pub series: Option<String>,
    /// `YYYY-MM-DD`; defaults to today when omitted.
    #[serde(default)]
    pub issue_date: Option<String>,
    pub due_date: String,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub items: Vec<NewInvoiceItemInput>,
}

/// One line of a standalone invoice (ignored — the order's own items are
/// copied instead — when `NewInvoice::sales_order_id` is set).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewInvoiceItemInput {
    #[serde(default)]
    pub variant_id: Option<String>,
    pub description: String,
    pub quantity: i64,
    pub unit_price_minor: i64,
    #[serde(default)]
    pub tax_rate_bps: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvoiceItem {
    pub id: String,
    pub invoice_id: String,
    pub book_id: String,
    pub variant_id: Option<String>,
    pub description: String,
    pub quantity: i64,
    pub unit_price_minor: i64,
    pub tax_rate_bps: i64,
    pub line_order: i64,
    pub created_at: String,
}

/// One immutable fact: this much was paid against this invoice, on this
/// date. There is no `InvoicePaymentPatch` and no update/delete function —
/// a refund or a correction is a new fact, never an edit to this one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvoicePayment {
    pub id: String,
    pub invoice_id: String,
    pub book_id: String,
    pub amount_minor: i64,
    pub paid_at: String,
    pub method: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewInvoicePayment {
    pub invoice_id: String,
    pub amount_minor: i64,
    /// `YYYY-MM-DD`; defaults to today when omitted.
    #[serde(default)]
    pub paid_at: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// `subtotal + tax == total`, `paid + due == total`, and `status` is exactly
/// what those two facts say — always computed, per the type's own header
/// note, never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvoiceTotals {
    pub subtotal_minor: i64,
    pub tax_minor: i64,
    pub total_minor: i64,
    pub paid_minor: i64,
    pub due_minor: i64,
    pub status: InvoicePaymentStatus,
}

/// One contact's outstanding balance, bucketed by how overdue each unpaid
/// invoice is as of a given date. `current` = not yet past its due date.
/// Money is summed in raw minor units with no currency conversion — see the
/// migration header's note on multi-currency being out of scope here, the
/// same limitation `report::report_spending` already carries for
/// multi-currency books.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgedBucket {
    pub current_minor: i64,
    pub overdue_1_30_minor: i64,
    pub overdue_31_60_minor: i64,
    pub overdue_61_90_minor: i64,
    pub overdue_90_plus_minor: i64,
    pub total_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgedReceivablesRow {
    pub contact_id: String,
    pub contact_name: String,
    pub buckets: AgedBucket,
}

/// PARITY.md's #2-ranked gap ("Contacts, then bills, then aged AR/AP — a
/// chain"), the receivables half of it. Cheap once invoices exist: every
/// outstanding invoice, grouped by contact, bucketed by age as of `as_of`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgedReceivables {
    pub as_of: String,
    pub rows: Vec<AgedReceivablesRow>,
    pub totals: AgedBucket,
}

// ---------------------------------------------------------------------------
// Fixed assets — a capitalised-cost register + depreciation (migration 0016,
// PARITY.md "Fixed assets"). See that migration's header for the full
// reasoning; the short version is repeated on each type below.
// ---------------------------------------------------------------------------

str_enum!(
    /// The only two depreciation methods this register implements — no
    /// revaluation, no tax-vs-book split, no third method without a matching
    /// schema CHECK and a matching arm in `CoreService::depreciation_run`'s
    /// schedule function.
    DepreciationMethod {
        StraightLine => "straight_line",
        ReducingBalance => "reducing_balance",
    }
);

str_enum!(
    /// `Active` until `CoreService::asset_dispose` flips it, once, to
    /// `Disposed`. There is no path back — disposing an asset is not
    /// reversible the way a purchase order's `Cancelled` isn't either.
    AssetStatus {
        Active => "active",
        Disposed => "disposed",
    }
);

/// A capitalised asset: cost, acquisition date, useful life and depreciation
/// method. Editable via `CoreService::asset_update` up until the moment any
/// depreciation has actually posted against it (enforced in the service
/// layer, not the schema — the same boundary purchase orders draw around
/// their own header fields once a receipt exists).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    pub book_id: String,
    pub name: String,
    pub description: Option<String>,
    /// `YYYY-MM-DD`. Month 1 of the depreciation schedule is the calendar
    /// month this date falls in — see `CoreService::depreciation_run`'s doc
    /// comment for the exact period-index convention.
    pub acquired_date: String,
    pub cost_minor: i64,
    pub residual_minor: i64,
    pub currency: String,
    pub useful_life_months: i64,
    pub method: DepreciationMethod,
    /// Required exactly when `method == ReducingBalance` (schema CHECK);
    /// `None` for `StraightLine`. A **per-period** (monthly) rate in basis
    /// points applied to opening net book value — not an annual rate, so
    /// there is no compounding conversion anywhere in the arithmetic.
    pub reducing_balance_rate_bps: Option<i64>,
    pub status: AssetStatus,
    pub disposed_date: Option<String>,
    pub disposal_proceeds_minor: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewAsset {
    pub book_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub acquired_date: String,
    pub cost_minor: i64,
    #[serde(default)]
    pub residual_minor: Option<i64>,
    pub currency: String,
    pub useful_life_months: i64,
    pub method: DepreciationMethod,
    #[serde(default)]
    pub reducing_balance_rate_bps: Option<i64>,
}

/// Selective update over the header fields. Deliberately carries no
/// `status`/`disposed_date`/`disposal_proceeds_minor` — those move only
/// through `CoreService::asset_dispose`, never through a general patch, the
/// same split `PurchaseOrderPatch` draws around `status`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AssetPatch {
    pub name: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<Option<String>>,
    pub acquired_date: Option<String>,
    pub cost_minor: Option<i64>,
    pub residual_minor: Option<i64>,
    pub useful_life_months: Option<i64>,
    pub method: Option<DepreciationMethod>,
    #[serde(
        default,
        deserialize_with = "crate::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub reducing_balance_rate_bps: Option<Option<i64>>,
}

/// What it takes to dispose an asset: when, and for how much (if anything).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetDisposal {
    pub disposed_date: String,
    #[serde(default)]
    pub proceeds_minor: Option<i64>,
}

/// One immutable fact: this much depreciation was recognised for this asset
/// in this period, backed by exactly this journal. Never edited or deleted —
/// see migration `0016_assets`'s header for why, and
/// `slipscan_sync::LEDGER_TABLES` for the sync mapping this earns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetDepreciationRun {
    pub id: String,
    pub book_id: String,
    pub asset_id: String,
    /// `YYYY-MM`.
    pub period: String,
    /// 1-based count of periods since acquisition (month of acquisition = 1).
    pub period_index: i64,
    pub depreciation_minor: i64,
    pub journal_id: String,
    pub created_at: String,
}

/// An asset together with its derived depreciation-to-date — the pairing a
/// register screen actually wants to render, so it does not have to call
/// back for the sum itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetWithDepreciation {
    pub asset: Asset,
    /// `SUM(depreciation_minor)` over this asset's net-live runs (a run
    /// whose journal was later reversed — see `asset_dispose` — does not
    /// count).
    pub accumulated_depreciation_minor: i64,
    /// `cost_minor - accumulated_depreciation_minor`. Never below
    /// `residual_minor` — see `CoreService::depreciation_run`'s doc comment
    /// for the arithmetic that guarantees it.
    pub net_book_value_minor: i64,
    /// How many periods have actually posted, net-live.
    pub periods_run: i64,
}

// ---------------------------------------------------------------------------
// Net worth — periodic per-account balance snapshots (migration 0015,
// PARITY.md gap #4 "Net worth over time"). See that migration's header for
// the full reasoning; the short version is repeated on each type below.
// ---------------------------------------------------------------------------

str_enum!(
    /// How a [`NetWorthSnapshot`] came to exist: `Captured` — recorded at
    /// (approximately) the moment it describes, via
    /// `CoreService::networth_capture`. `Backfilled` — reconstructed after
    /// the fact from the transaction ledger, via
    /// `CoreService::networth_backfill`. Both are equally valid facts; the
    /// tag exists so a reader can tell a live recording from a
    /// reconstruction, never so one is preferred over the other at query
    /// time.
    NetWorthSnapshotSource {
        Captured => "captured",
        Backfilled => "backfilled",
    }
);

/// One `(account, date)` balance fact, in the account's own currency —
/// migration 0015's append-only ledger. Insert-only: see that migration's
/// header for why this is a fact rather than an editable row, and
/// `slipscan_sync::LEDGER_TABLES` for the sync mapping this earns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetWorthSnapshot {
    pub id: String,
    pub book_id: String,
    pub account_id: String,
    /// `YYYY-MM-DD`. The balance is "as of the end of this day" — it
    /// includes every transaction posted on this date.
    pub as_of_date: String,
    /// Signed; a liability account legitimately reads negative, same as
    /// `Account::opening_balance_minor`.
    pub balance_minor: i64,
    /// The account's own currency — a snapshot never converts anything.
    pub currency: String,
    pub source: NetWorthSnapshotSource,
    pub created_at: String,
}

/// One account's balance inside a [`NetWorthPoint`] — its own currency,
/// never converted. `NetWorthPoint::total_minor` is where conversion (when
/// possible) happens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetWorthAccountBalance {
    pub account_id: String,
    pub currency: String,
    pub balance_minor: i64,
}

/// One point in a net-worth series (`CoreService::networth_series`): every
/// account's most recent known balance at or before this date — a sparse
/// per-account history read back as a step function — plus the total
/// converted to the book's currency.
///
/// `total_minor` only ever folds in a balance already in `currency` or with
/// a resolvable exchange rate; see `CoreService::networth_series`'s doc
/// comment for exactly which rate that is and its honest limits.
/// `unconverted` names every currency this point could not fold in, so a
/// caller — or the desktop chart — states that plainly instead of silently
/// understating (or, worse, silently mis-summing) net worth.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NetWorthPoint {
    pub as_of_date: String,
    pub by_account: Vec<NetWorthAccountBalance>,
    /// The book's currency — what `total_minor` is denominated in.
    pub currency: String,
    pub total_minor: i64,
    /// Currencies present in `by_account` that had no resolvable rate to
    /// `currency` and so are excluded from `total_minor`. Empty when every
    /// account is already in `currency`, or every foreign balance converted.
    pub unconverted: Vec<String>,
}

/// A net-worth series for one book: every point in range, plus the exchange
/// rate provenance behind every conversion any point performed — the same
/// shape `fx_convert` already reports (`crate::fx::FxCachedRate`), one entry
/// per foreign currency that appears anywhere in `points`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NetWorthSeries {
    pub book_id: String,
    /// The book's currency — what every point's `total_minor` is denominated
    /// in.
    pub currency: String,
    pub points: Vec<NetWorthPoint>,
    pub conversions: Vec<crate::fx::FxCachedRate>,
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    pub book_id: Option<String>,
    pub entity_type: String,
    pub entity_id: Option<String>,
    pub action: String,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **A nullable patch field must have three distinguishable states over
    /// JSON**, because the desktop IPC layer and the HTTP API only ever speak
    /// JSON — absent, null and set. Before `util::double_option`, `Option<T>`'s
    /// own `Deserialize` collapsed the first two: `{"notes": null}` and `{}`
    /// both produced `None`, so **nothing could be cleared from either surface**
    /// and no error was raised anywhere. Only the CLI could clear a field,
    /// because it builds `Some(None)` in Rust rather than going through serde.
    ///
    /// One case per patch type that has such a field, so this cannot pass by
    /// covering only the easy one.
    #[test]
    fn a_nullable_patch_field_distinguishes_absent_from_null_from_set() {
        macro_rules! three_states {
            ($ty:ty, $field:ident, $json_value:expr, $expected:expr) => {{
                let absent: $ty = serde_json::from_str("{}").unwrap();
                assert_eq!(
                    absent.$field, None,
                    concat!(
                        stringify!($ty),
                        "::",
                        stringify!($field),
                        " absent must mean LEAVE UNTOUCHED"
                    )
                );
                let cleared: $ty =
                    serde_json::from_str(concat!("{\"", stringify!($field), "\": null}")).unwrap();
                assert_eq!(
                    cleared.$field,
                    Some(None),
                    concat!(
                        stringify!($ty),
                        "::",
                        stringify!($field),
                        " explicit null must mean CLEAR, not leave untouched"
                    )
                );
                let set: $ty = serde_json::from_str(&format!(
                    "{{\"{}\": {}}}",
                    stringify!($field),
                    $json_value
                ))
                .unwrap();
                assert_eq!(
                    set.$field,
                    Some(Some($expected)),
                    concat!(
                        stringify!($ty),
                        "::",
                        stringify!($field),
                        " must round-trip a value"
                    )
                );
            }};
        }

        three_states!(
            MemberPatch,
            default_account_id,
            "\"acct-1\"",
            "acct-1".to_string()
        );
        three_states!(LocationPatch, code, "\"JHB\"", "JHB".to_string());
        three_states!(ContactPatch, email, "\"a@b.c\"", "a@b.c".to_string());
        three_states!(ContactPatch, payment_terms_days, "30", 30i64);
        three_states!(ProductPatch, description, "\"desc\"", "desc".to_string());
        three_states!(ProductVariantPatch, attributes, "\"{}\"", "{}".to_string());
        three_states!(PurchaseOrderPatch, notes, "\"n\"", "n".to_string());
        three_states!(
            PurchaseOrderPatch,
            expected_delivery,
            "\"2026-01-01\"",
            "2026-01-01".to_string()
        );
        three_states!(SalesOrderPatch, notes, "\"n\"", "n".to_string());
        three_states!(
            SalesOrderPatch,
            location_id,
            "\"loc-1\"",
            "loc-1".to_string()
        );
        three_states!(QuotePatch, notes, "\"n\"", "n".to_string());
        three_states!(
            QuotePatch,
            expiry_date,
            "\"2026-02-01\"",
            "2026-02-01".to_string()
        );
    }

    /// Serializing must be the exact inverse of deserializing, or a patch that
    /// round-trips through JSON turns "leave untouched" into "clear". `None`
    /// has to be *omitted*, not written as `null` — which is what the
    /// `skip_serializing_if` half of the attribute is for.
    #[test]
    fn an_untouched_patch_field_is_omitted_rather_than_serialized_as_null() {
        let untouched = ContactPatch::default();
        let json = serde_json::to_string(&untouched).unwrap();
        assert!(
            !json.contains("\"email\""),
            "an untouched field must not appear at all, or reading it back clears the value; got {json}"
        );
        let back: ContactPatch = serde_json::from_str(&json).unwrap();
        assert_eq!(back.email, None, "round-trip must preserve LEAVE UNTOUCHED");

        let cleared = ContactPatch {
            email: Some(None),
            ..Default::default()
        };
        let json = serde_json::to_string(&cleared).unwrap();
        let back: ContactPatch = serde_json::from_str(&json).unwrap();
        assert_eq!(
            back.email,
            Some(None),
            "round-trip must preserve CLEAR; got {json}"
        );
    }

    /// **Coverage assertion, not a spot check.** The behavioural test above can
    /// only cover fields someone remembered to list; this one reads this file's
    /// own source and fails if *any* `Option<Option<…>>` field is missing the
    /// deserializer — which is exactly how all nineteen of them were wrong to
    /// begin with. A new nullable patch field added without the attribute is a
    /// silently-unclearable field, so it fails here instead.
    #[test]
    fn every_nullable_patch_field_uses_the_double_option_deserializer() {
        let src = include_str!("domain.rs");
        let mut checked = 0;
        // Forward scan, accumulating each field's own attribute block. Walking
        // *backwards* over a fixed window is wrong and quietly so — it reaches
        // into the previous field's attributes, so stripping the deserializer
        // off one field still finds the neighbour's copy and passes — and a
        // smarter backward walk trips over the commas inside the multi-line
        // `#[serde(...)]` block itself. Scanning forward, "everything since the
        // last field or brace" is unambiguous.
        let mut pending: Vec<&str> = Vec::new();
        for line in src.lines() {
            let t = line.trim();
            let is_field = t.starts_with("pub ") && t.contains(':') && t.ends_with(',');
            if !is_field {
                if t.is_empty() || t.ends_with('{') || t == "}" {
                    pending.clear();
                } else {
                    pending.push(t);
                }
                continue;
            }
            // A field. Its attribute block is exactly what accumulated.
            if !t.contains("Option<Option<") {
                pending.clear();
                continue;
            }
            checked += 1;
            let preceding = pending.join("\n");
            pending.clear();
            assert!(
                preceding.contains("crate::util::double_option"),
                "{t}\n  ^ nullable patch field without \
                 `deserialize_with = \"crate::util::double_option\"`: it cannot be \
                 cleared over JSON, and nothing else will tell you"
            );
            assert!(
                preceding.contains("skip_serializing_if"),
                "{t}\n  ^ has the deserializer but not `skip_serializing_if`, so \
                 serializing an untouched field emits null and reads back as a clear"
            );
        }
        assert_eq!(
            checked, 23,
            "expected 23 nullable patch fields; if this moved, the count and the \
             fields above both need looking at rather than the number bumping"
        );
    }

    #[test]
    fn enums_round_trip_via_str() {
        assert_eq!(BookKind::Personal.as_str(), "personal");
        assert_eq!("business".parse::<BookKind>().unwrap(), BookKind::Business);
        assert!("bogus".parse::<BookKind>().is_err());
        assert_eq!(
            "bank_statement".parse::<DocumentKind>().unwrap(),
            DocumentKind::BankStatement
        );
        assert_eq!(LocationKind::Warehouse.as_str(), "warehouse");
        assert_eq!("site".parse::<LocationKind>().unwrap(), LocationKind::Site);
        assert!("bogus".parse::<LocationKind>().is_err());
        assert_eq!(
            DepreciationMethod::ReducingBalance.as_str(),
            "reducing_balance"
        );
        assert_eq!(
            "straight_line".parse::<DepreciationMethod>().unwrap(),
            DepreciationMethod::StraightLine
        );
        assert!("bogus".parse::<DepreciationMethod>().is_err());
        assert_eq!(AssetStatus::Disposed.as_str(), "disposed");
        assert_eq!(
            "active".parse::<AssetStatus>().unwrap(),
            AssetStatus::Active
        );
        assert!("bogus".parse::<AssetStatus>().is_err());
        assert_eq!(
            "depreciation".parse::<JournalSourceType>().unwrap(),
            JournalSourceType::Depreciation
        );
    }

    #[test]
    fn enums_serialize_snake_case() {
        assert_eq!(
            serde_json::to_string(&DocumentStatus::Extracted).unwrap(),
            "\"extracted\""
        );
        let parsed: TransactionSource = serde_json::from_str("\"scraper\"").unwrap();
        assert_eq!(parsed, TransactionSource::Scraper);
    }
}
