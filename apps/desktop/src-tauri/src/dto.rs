//! Serde DTOs mirroring `apps/desktop/src/lib/api/types.ts` — the hand-kept
//! TypeScript contract. Update both sides in the same change.
//!
//! Core domain types are richer than the UI needs; the mapping here is pure
//! serialization (rename/derive/denormalize), never business logic.

use serde::{Deserialize, Serialize};

use slipscan_core::domain::{
    self as core, CategoryNode, CoaAccount, DocumentKind, DocumentStatus, ReconState,
};

// ---------------------------------------------------------------------------
// book / account
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct BookDto {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub kind: String,
    pub currency: String,
    pub file_path: String,
    pub created_at: String,
}

pub fn book_dto(book: &core::Book, db_path: &std::path::Path) -> BookDto {
    BookDto {
        id: book.id.clone(),
        name: book.name.clone(),
        slug: slugify(&book.name),
        kind: book.kind.as_str().to_string(),
        currency: book.currency.clone(),
        file_path: db_path.display().to_string(),
        created_at: book.created_at.clone(),
    }
}

fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountDto {
    pub id: String,
    pub book_id: String,
    pub name: String,
    pub kind: String,
    pub institution: Option<String>,
    pub currency: String,
    pub balance_minor: i64,
    pub created_at: String,
}

pub fn account_dto(account: &core::Account, txn_sum_minor: i64) -> AccountDto {
    AccountDto {
        id: account.id.clone(),
        book_id: account.book_id.clone(),
        name: account.name.clone(),
        kind: account.kind.as_str().to_string(),
        institution: account.institution.clone(),
        currency: account.currency.clone(),
        balance_minor: account.opening_balance_minor + txn_sum_minor,
        created_at: account.created_at.clone(),
    }
}

// ---------------------------------------------------------------------------
// transaction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct TransactionDto {
    pub id: String,
    pub book_id: String,
    pub account_id: String,
    /// Contract renders `posted_at` as an ISO timestamp; core stores a date.
    pub posted_at: String,
    pub description: String,
    pub merchant: Option<String>,
    pub amount_minor: i64,
    pub currency: String,
    pub category_id: Option<String>,
    pub source: String,
    pub provider_txn_id: Option<String>,
    pub hash: String,
    pub created_at: String,
}

pub fn transaction_dto(txn: &core::Transaction) -> TransactionDto {
    TransactionDto {
        id: txn.id.clone(),
        book_id: txn.book_id.clone(),
        account_id: txn.account_id.clone(),
        posted_at: format!("{}T00:00:00Z", txn.posted_date),
        description: txn
            .description
            .clone()
            .or_else(|| txn.merchant.clone())
            .unwrap_or_default(),
        merchant: txn.merchant.clone(),
        amount_minor: txn.amount_minor,
        currency: txn.currency.clone(),
        category_id: txn.category_id.clone(),
        source: txn.source.as_str().to_string(),
        provider_txn_id: txn.provider_txn_id.clone(),
        hash: txn.dedupe_hash.clone(),
        created_at: txn.created_at.clone(),
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct TransactionListQuery {
    pub book_id: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CategorizeQuery {
    pub transaction_id: String,
    pub category_id: Option<String>,
}

// ---------------------------------------------------------------------------
// category
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct CategoryDto {
    pub id: String,
    pub book_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: String,
    pub icon: Option<String>,
    pub created_at: String,
}

fn push_category(node: &CategoryNode, into: &mut Vec<CategoryDto>) {
    let c = &node.category;
    into.push(CategoryDto {
        id: c.id.clone(),
        book_id: c.book_id.clone(),
        parent_id: c.parent_id.clone(),
        name: c.name.clone(),
        kind: c.kind.as_str().to_string(),
        icon: c.icon.clone(),
        created_at: c.created_at.clone(),
    });
    for child in &node.children {
        push_category(child, into);
    }
}

/// Flatten a category tree (roots first, children directly after parents).
pub fn category_dtos(tree: &[CategoryNode]) -> Vec<CategoryDto> {
    let mut out = Vec::new();
    for node in tree {
        push_category(node, &mut out);
    }
    out
}

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct BudgetDto {
    pub id: String,
    pub book_id: String,
    pub category_id: String,
    pub month: String,
    pub amount_minor: i64,
    pub currency: String,
    pub rollover: bool,
    pub created_at: String,
}

pub fn budget_dto(b: &core::Budget) -> BudgetDto {
    BudgetDto {
        id: b.id.clone(),
        book_id: b.book_id.clone(),
        category_id: b.category_id.clone(),
        month: b.month.clone(),
        amount_minor: b.amount_minor,
        currency: b.currency.clone(),
        rollover: b.rollover,
        created_at: b.created_at.clone(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BudgetWithSpendDto {
    #[serde(flatten)]
    pub budget: BudgetDto,
    pub category_name: String,
    pub spent_minor: i64,
}

// ---------------------------------------------------------------------------
// document — slip-v2 view
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SlipLineItemDto {
    pub description: String,
    pub quantity: f64,
    pub unit_minor: i64,
    pub total_minor: i64,
    pub category_id: Option<String>,
    pub discount_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SlipExtractionDto {
    pub schema: &'static str,
    pub merchant: String,
    pub issued_at: String,
    pub currency: String,
    pub total_minor: i64,
    pub vat_minor: i64,
    pub discount_minor: i64,
    pub line_items: Vec<SlipLineItemDto>,
    pub confidence: f64,
}

/// Tolerant reader over the stored slip-v2 payload (canonical types live in
/// slipscan-extract; unknown fields are ignored).
#[derive(Debug, Deserialize)]
struct SlipPayload {
    #[serde(default)]
    merchant: Option<SlipMerchant>,
    #[serde(default)]
    purchased_at: Option<String>,
    #[serde(default)]
    currency: Option<String>,
    totals: SlipTotals,
    #[serde(default)]
    line_items: Vec<SlipItem>,
    #[serde(default)]
    confidence: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct SlipMerchant {
    name: String,
}

#[derive(Debug, Deserialize)]
struct SlipTotals {
    #[serde(default)]
    discount_minor: Option<i64>,
    #[serde(default)]
    vat_minor: Option<i64>,
    total_minor: i64,
}

#[derive(Debug, Deserialize)]
struct SlipItem {
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    quantity: Option<f64>,
    #[serde(default)]
    unit_price_minor: Option<i64>,
    total_minor: i64,
    #[serde(default)]
    discount_minor: Option<i64>,
}

fn slip_extraction_dto(
    payload_json: &str,
    fallback_issued_at: &str,
    fallback_currency: &str,
) -> Option<SlipExtractionDto> {
    let slip: SlipPayload = serde_json::from_str(payload_json).ok()?;
    Some(SlipExtractionDto {
        schema: "slip-v2",
        merchant: slip.merchant.map(|m| m.name).unwrap_or_default(),
        issued_at: slip
            .purchased_at
            .unwrap_or_else(|| fallback_issued_at.to_string()),
        currency: slip
            .currency
            .unwrap_or_else(|| fallback_currency.to_string()),
        total_minor: slip.totals.total_minor,
        vat_minor: slip.totals.vat_minor.unwrap_or(0),
        discount_minor: slip.totals.discount_minor.unwrap_or(0),
        line_items: slip
            .line_items
            .into_iter()
            .map(|li| {
                let quantity = li.quantity.unwrap_or(1.0);
                SlipLineItemDto {
                    description: li.description.unwrap_or_default(),
                    quantity,
                    unit_minor: li.unit_price_minor.unwrap_or(li.total_minor),
                    total_minor: li.total_minor,
                    category_id: None,
                    discount_minor: li.discount_minor.unwrap_or(0),
                }
            })
            .collect(),
        confidence: slip.confidence.unwrap_or(0.0),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct DocumentDto {
    pub id: String,
    pub book_id: String,
    pub kind: String,
    pub status: String,
    pub file_name: String,
    pub mime_type: String,
    pub extraction: Option<SlipExtractionDto>,
    pub merchant: Option<String>,
    pub issued_at: Option<String>,
    pub total_minor: Option<i64>,
    pub currency: String,
    pub created_at: String,
}

pub fn document_dto(
    doc: &core::Document,
    extraction_payload: Option<&str>,
    book_currency: &str,
) -> DocumentDto {
    let kind = match doc.kind {
        DocumentKind::Slip => "slip",
        DocumentKind::Invoice => "invoice",
        DocumentKind::BankStatement => "statement",
        DocumentKind::Unknown => "receipt",
    };
    // The contract has no `processing` state; it reads as still pending.
    let status = match doc.status {
        DocumentStatus::Pending | DocumentStatus::Processing => "pending",
        DocumentStatus::Extracted => "extracted",
        DocumentStatus::Reviewed => "reviewed",
        DocumentStatus::Failed => "failed",
    };
    let extraction = extraction_payload
        .and_then(|payload| slip_extraction_dto(payload, &doc.created_at, book_currency));
    let file_name = doc.original_name.clone().unwrap_or_else(|| {
        std::path::Path::new(&doc.file_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| doc.file_path.clone())
    });
    DocumentDto {
        id: doc.id.clone(),
        book_id: doc.book_id.clone(),
        kind: kind.to_string(),
        status: status.to_string(),
        file_name,
        mime_type: doc
            .mime_type
            .clone()
            .unwrap_or_else(|| "application/octet-stream".to_string()),
        merchant: extraction
            .as_ref()
            .map(|e| e.merchant.clone())
            .filter(|m| !m.is_empty()),
        issued_at: extraction.as_ref().map(|e| e.issued_at.clone()),
        total_minor: extraction.as_ref().map(|e| e.total_minor),
        currency: extraction
            .as_ref()
            .map(|e| e.currency.clone())
            .unwrap_or_else(|| book_currency.to_string()),
        extraction,
        created_at: doc.created_at.clone(),
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct DocumentImportRequest {
    pub book_id: String,
    pub file_name: String,
    pub mime_type: String,
    #[serde(default)]
    pub bytes_base64: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct LedgerAccountDto {
    pub id: String,
    pub book_id: String,
    pub code: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub vat_rate_bp: Option<i64>,
    pub archived: bool,
}

pub fn ledger_account_dto(coa: &CoaAccount) -> LedgerAccountDto {
    LedgerAccountDto {
        id: coa.id.clone(),
        book_id: coa.book_id.clone(),
        code: coa.code.clone(),
        name: coa.name.clone(),
        kind: coa.kind.as_str().to_string(),
        vat_rate_bp: None,
        archived: coa.is_archived,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct JournalLineDto {
    pub id: String,
    pub entry_id: String,
    pub ledger_account_id: String,
    pub ledger_account_name: String,
    pub debit_minor: i64,
    pub credit_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct JournalEntryDto {
    pub id: String,
    pub book_id: String,
    pub entry_date: String,
    pub memo: String,
    pub lines: Vec<JournalLineDto>,
    pub source_document_id: Option<String>,
    pub created_at: String,
}

/// `coa_name` resolves a chart-of-accounts id to its display name.
pub fn journal_entry_dto(
    posted: &core::PostedJournal,
    coa_name: impl Fn(&str) -> String,
) -> JournalEntryDto {
    let j = &posted.journal;
    JournalEntryDto {
        id: j.id.clone(),
        book_id: j.book_id.clone(),
        entry_date: j.posted_date.clone(),
        memo: j
            .narrative
            .clone()
            .or_else(|| j.reference.clone())
            .unwrap_or_default(),
        lines: posted
            .lines
            .iter()
            .map(|l| JournalLineDto {
                id: l.id.clone(),
                entry_id: l.journal_id.clone(),
                ledger_account_id: l.coa_id.clone(),
                ledger_account_name: coa_name(&l.coa_id),
                debit_minor: l.debit_minor,
                credit_minor: l.credit_minor,
            })
            .collect(),
        source_document_id: match j.source_type {
            core::JournalSourceType::Document => j.source_id.clone(),
            _ => None,
        },
        created_at: j.created_at.clone(),
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct JournalPostRequest {
    pub book_id: String,
    pub entry_date: String,
    pub memo: String,
    pub lines: Vec<JournalPostLine>,
    #[serde(default)]
    pub source_document_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JournalPostLine {
    pub ledger_account_id: String,
    pub debit_minor: i64,
    pub credit_minor: i64,
}

// ---------------------------------------------------------------------------
// recon
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ReconSuggestionDto {
    pub id: String,
    pub book_id: String,
    pub transaction_id: String,
    pub document_id: String,
    pub score: f64,
    pub status: String,
    pub transaction_description: String,
    pub transaction_amount_minor: i64,
    pub document_merchant: String,
    pub document_total_minor: i64,
    pub currency: String,
    pub created_at: String,
}

pub fn recon_state_str(state: ReconState) -> &'static str {
    match state {
        // `auto` still waits for a human; the contract calls that suggested.
        ReconState::Auto | ReconState::Suggested => "suggested",
        ReconState::Confirmed => "confirmed",
        ReconState::Rejected => "rejected",
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReconConfirmRequest {
    pub suggestion_id: String,
    pub accept: bool,
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SpendingByCategoryDto {
    pub category_id: String,
    pub category_name: String,
    pub amount_minor: i64,
    pub share: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpendingReportDto {
    pub book_id: String,
    pub from: String,
    pub to: String,
    pub currency: String,
    pub total_spent_minor: i64,
    pub by_category: Vec<SpendingByCategoryDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IncomeExpensePointDto {
    pub month: String,
    pub income_minor: i64,
    pub expense_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct IncomeExpenseReportDto {
    pub book_id: String,
    pub currency: String,
    pub months: Vec<IncomeExpensePointDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VatSummaryDto {
    pub book_id: String,
    pub period: String,
    pub currency: String,
    pub output_vat_minor: i64,
    pub input_vat_minor: i64,
    pub net_vat_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrialBalanceRowDto {
    pub ledger_account_id: String,
    pub code: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub debit_minor: i64,
    pub credit_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrialBalanceDto {
    pub book_id: String,
    pub as_of: String,
    pub currency: String,
    pub rows: Vec<TrialBalanceRowDto>,
    pub total_debit_minor: i64,
    pub total_credit_minor: i64,
}

// ---------------------------------------------------------------------------
// settings — keychain entry NAMES only, never secret material
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProviderSettings {
    pub provider: String,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub keychain_entry: Option<String>,
}

impl Default for LlmProviderSettings {
    fn default() -> Self {
        Self {
            provider: "none".to_string(),
            endpoint: None,
            model: None,
            keychain_entry: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailboxSettings {
    pub enabled: bool,
    pub host: Option<String>,
    pub port: u16,
    pub username: Option<String>,
    pub keychain_entry: Option<String>,
    pub folder: String,
}

impl Default for MailboxSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            host: None,
            port: 993,
            username: None,
            keychain_entry: None,
            folder: "INBOX".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScraperAdapter {
    pub id: String,
    pub adapter: String,
    pub institution: String,
    pub status: String,
    pub last_sync: Option<String>,
    pub keychain_entry: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledPack {
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub signer_fingerprint: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsDto {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub llm: LlmProviderSettings,
    #[serde(default)]
    pub mailbox: MailboxSettings,
    #[serde(default)]
    pub scrapers: Vec<ScraperAdapter>,
    #[serde(default)]
    pub packs: Vec<InstalledPack>,
}

fn default_theme() -> String {
    "system".to_string()
}

impl Default for SettingsDto {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            llm: LlmProviderSettings::default(),
            mailbox: MailboxSettings::default(),
            scrapers: Vec::new(),
            packs: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// vault — METADATA ONLY. No DTO in this file may ever carry secret material.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct VaultCredentialDto {
    pub name: String,
    pub label: Option<String>,
    pub version: i64,
    pub fingerprint: String,
    pub created_at: String,
    pub rotated_at: Option<String>,
    pub last_used_at: Option<String>,
}

/// Write-only input: the secret enters here and is wrapped into a
/// [`slipscan_core::secrets::SecretString`] immediately. Never serialized
/// back out, never logged (no Debug derive on purpose).
#[derive(Deserialize)]
pub struct VaultSetRequest {
    pub name: String,
    #[serde(default)]
    pub label: Option<String>,
    pub secret: String,
}

impl std::fmt::Debug for VaultSetRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultSetRequest")
            .field("name", &self.name)
            .field("label", &self.label)
            .field("secret", &"<redacted>")
            .finish()
    }
}

#[derive(Deserialize)]
pub struct VaultReplaceRequest {
    pub name: String,
    pub secret: String,
}

impl std::fmt::Debug for VaultReplaceRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultReplaceRequest")
            .field("name", &self.name)
            .field("secret", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct VaultRevokeRequest {
    pub name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basics() {
        assert_eq!(slugify("Personal"), "personal");
        assert_eq!(slugify("Molefe Consulting (Pty) Ltd"), "molefe-consulting-pty-ltd");
    }

    #[test]
    fn slip_extraction_maps_totals_and_items() {
        let payload = r#"{
            "merchant": {"name": "Checkers"},
            "purchased_at": "2026-07-15T10:00:00Z",
            "currency": "ZAR",
            "totals": {"total_minor": 63780, "vat_minor": 8319, "discount_minor": 911},
            "line_items": [
                {"description": "Milk 2L", "quantity": 2, "unit_price_minor": 3499, "total_minor": 6998}
            ],
            "confidence": 0.97
        }"#;
        let dto = slip_extraction_dto(payload, "2026-07-15T09:00:00Z", "ZAR").unwrap();
        assert_eq!(dto.merchant, "Checkers");
        assert_eq!(dto.total_minor, 63_780);
        assert_eq!(dto.vat_minor, 8_319);
        assert_eq!(dto.discount_minor, 911);
        assert_eq!(dto.line_items.len(), 1);
        assert_eq!(dto.line_items[0].unit_minor, 3_499);
        assert!(dto.confidence > 0.9);
    }

    #[test]
    fn vault_requests_redact_secrets_in_debug() {
        let set: VaultSetRequest =
            serde_json::from_str(r#"{"name":"imap","secret":"hunter2"}"#).unwrap();
        assert!(!format!("{set:?}").contains("hunter2"));
        let replace: VaultReplaceRequest =
            serde_json::from_str(r#"{"name":"imap","secret":"hunter2"}"#).unwrap();
        assert!(!format!("{replace:?}").contains("hunter2"));
    }
}
