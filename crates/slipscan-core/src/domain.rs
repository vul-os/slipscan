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
pub type Vat201Summary = TaxPeriodSummary;

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
