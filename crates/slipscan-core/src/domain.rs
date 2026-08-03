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

/// A person in the household sharing this book — local data, never a login.
/// See ARCHITECTURE.md "Household members & per-person attribution".
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
    #[serde(default)]
    pub default_account_id: Option<Option<String>>,
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
    #[serde(default)]
    pub code: Option<Option<String>>,
    #[serde(default)]
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
    #[serde(default)]
    pub company_name: Option<Option<String>>,
    #[serde(default)]
    pub email: Option<Option<String>>,
    #[serde(default)]
    pub phone: Option<Option<String>>,
    #[serde(default)]
    pub billing_address: Option<Option<String>>,
    #[serde(default)]
    pub shipping_address: Option<Option<String>>,
    #[serde(default)]
    pub tax_number: Option<Option<String>>,
    #[serde(default)]
    pub payment_terms_days: Option<Option<i64>>,
    #[serde(default)]
    pub credit_limit_minor: Option<Option<i64>>,
    #[serde(default)]
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
    #[serde(default)]
    pub description: Option<Option<String>>,
    #[serde(default)]
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
    #[serde(default)]
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
        assert_eq!(
            "site".parse::<LocationKind>().unwrap(),
            LocationKind::Site
        );
        assert!("bogus".parse::<LocationKind>().is_err());
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
