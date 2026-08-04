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
    /// Region profile id ("za", "generic", …) — regions are data, not code.
    pub region: String,
    /// Region profile display name, e.g. "South Africa".
    pub region_name: String,
    /// The region profile's name for the tax-period report (e.g. "VAT201").
    pub tax_report_name: String,
    pub file_path: String,
    pub created_at: String,
}

pub fn book_dto(book: &core::Book, db_path: &std::path::Path) -> BookDto {
    // Unknown stored regions render as the generic profile — same tolerance
    // core applies (`profile_or_generic`).
    let profile = slipscan_core::region::profile_or_generic(&book.region);
    BookDto {
        id: book.id.clone(),
        name: book.name.clone(),
        slug: slugify(&book.name),
        kind: book.kind.as_str().to_string(),
        currency: book.currency.clone(),
        region: book.region.clone(),
        region_name: profile.display_name.to_string(),
        tax_report_name: profile.tax_report.report_name.to_string(),
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

// ---------------------------------------------------------------------------
// data folder (movable) — contract: "Data location & backup"
// ---------------------------------------------------------------------------

/// Where the user's data lives and how big it is. The payload is core's
/// `datadir::DataStatus` exactly as the server's `GET /api/v1/data_status`
/// serves it (surface parity), plus one desktop-only display nicety.
#[derive(Debug, Serialize)]
pub struct DataStatusDto {
    #[serde(flatten)]
    pub status: slipscan_core::datadir::DataStatus,
    /// Cloud-sync provider name when the folder is trivially inside a known
    /// synced tree ("iCloud Drive", "Dropbox", …). Omitted when not
    /// detectable — absence never means "not synced".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud_sync_hint: Option<String>,
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
// net worth — periodic balance snapshots (PARITY.md "Net worth over time").
// Core's `NetWorthSnapshot`/`NetWorthSeries` already serialize display-ready
// (money in minor units + currency, no floats), so these are plain queries,
// not DTOs with their own mapping function.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct NetWorthCaptureQuery {
    pub book_id: String,
    /// `YYYY-MM-DD`; omitted means today (UTC) — the same default the CLI's
    /// `--date` flag falls back to.
    #[serde(default)]
    pub as_of_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NetWorthSeriesQuery {
    pub book_id: String,
    pub from: String,
    pub to: String,
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
    /// Who actually incurred this transaction — metadata only, never
    /// influences amount/currency/category (ARCHITECTURE.md "Household
    /// members & per-person attribution"). `None` = unattributed. When the
    /// transaction is split across members, this field still reflects
    /// whatever single attribution it carries underneath, but reports
    /// distribute by the split shares instead — see `transaction_splits_list`.
    pub attributed_member_id: Option<String>,
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
        attributed_member_id: txn.attributed_member_id.clone(),
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
// household members & per-person attribution — see ARCHITECTURE.md
// "Household members & per-person attribution". Members are local data, not
// logins; attribution is metadata that never touches debits/credits.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct MemberUpdateRequest {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub initial: Option<String>,
    #[serde(default)]
    pub colour: Option<String>,
    /// Omit to leave untouched, send `null` to clear, send a value to set —
    /// see `slipscan_core::util::double_option`. This used to travel as a
    /// separate `clear_default_account` boolean because plain serde could not
    /// tell an absent key from an explicit null; that is fixed at the source
    /// now, so the workaround is gone and JSON means what it says.
    #[serde(
        default,
        deserialize_with = "slipscan_core::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_account_id: Option<Option<String>>,
}

impl MemberUpdateRequest {
    pub fn into_patch(self) -> core::MemberPatch {
        core::MemberPatch {
            label: self.label,
            initial: self.initial,
            colour: self.colour,
            default_account_id: self.default_account_id,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct MemberRemoveRequest {
    pub id: String,
    #[serde(default)]
    pub reassign_to: Option<String>,
}

// ---------------------------------------------------------------------------
// locations (Phase 6.1 — the flowstock fold, foundation).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct LocationUpdateRequest {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub kind: Option<core::LocationKind>,
    /// Omit / `null` / value — see `MemberUpdateRequest::default_account_id`.
    #[serde(
        default,
        deserialize_with = "slipscan_core::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub code: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "slipscan_core::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub address: Option<Option<String>>,
    #[serde(default)]
    pub is_archived: Option<bool>,
}

impl LocationUpdateRequest {
    pub fn into_patch(self) -> core::LocationPatch {
        core::LocationPatch {
            name: self.name,
            kind: self.kind,
            code: self.code,
            address: self.address,
            is_archived: self.is_archived,
        }
    }
}

// ---------------------------------------------------------------------------
// purchasing — purchase orders, their line items, and goods receipts
// (Phase 6.4, the flowstock fold). No screen calls these yet (that is
// ROADMAP.md 6.9, "Desktop screens") — wired now so the IPC layer, like the
// CLI and HTTP surfaces, does not wait on a UI to exist first. Core's domain
// types serialize straight across IPC for create/add/receive, the same
// `NewLocation`/`core::Location` treatment above; only `_update` needs its
// own clear-flag request shape.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct PoUpdateRequest {
    pub id: String,
    #[serde(default)]
    pub supplier_id: Option<String>,
    #[serde(default)]
    pub location_id: Option<String>,
    #[serde(default)]
    pub po_number: Option<String>,
    #[serde(default)]
    pub order_date: Option<String>,
    /// Omit / `null` / value — see `MemberUpdateRequest::default_account_id`.
    #[serde(
        default,
        deserialize_with = "slipscan_core::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub expected_delivery: Option<Option<String>>,
    #[serde(default)]
    pub tax_minor: Option<i64>,
    #[serde(
        default,
        deserialize_with = "slipscan_core::util::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub notes: Option<Option<String>>,
}

impl PoUpdateRequest {
    pub fn into_patch(self) -> core::PurchaseOrderPatch {
        core::PurchaseOrderPatch {
            supplier_id: self.supplier_id,
            location_id: self.location_id,
            po_number: self.po_number,
            order_date: self.order_date,
            expected_delivery: self.expected_delivery,
            tax_minor: self.tax_minor,
            notes: self.notes,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PoIdQuery {
    pub po_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PoSetStatusRequest {
    pub po_id: String,
    pub status: core::PurchaseOrderStatus,
}

/// Scopes a read to a whole purchase order rather than one of its lines
/// (`po_item_list`, `po_receipts_for_po`, `po_items_with_receiving`,
/// `po_receiving_status`) — same field name HTTP's `PurchaseOrderIdReq` uses.
#[derive(Debug, Clone, Deserialize)]
pub struct PurchaseOrderIdQuery {
    pub purchase_order_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PoItemIdQuery {
    pub item_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PoItemUpdateRequest {
    pub id: String,
    #[serde(default)]
    pub qty_ordered: Option<i64>,
    #[serde(default)]
    pub unit_price_minor: Option<i64>,
}

impl PoItemUpdateRequest {
    pub fn into_patch(self) -> core::PurchaseOrderItemPatch {
        core::PurchaseOrderItemPatch {
            qty_ordered: self.qty_ordered,
            unit_price_minor: self.unit_price_minor,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct TransactionIdQuery {
    pub transaction_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TransactionAttributeRequest {
    pub transaction_id: String,
    #[serde(default)]
    pub member_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TransactionSplitSetRequest {
    pub transaction_id: String,
    pub shares: Vec<core::SplitShare>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MemberReportQuery {
    pub book_id: String,
    pub from: String,
    pub to: String,
}

/// `report_balance_sheet`'s request — `as_of` defaults to today (UTC) when
/// omitted, the same default `networth_capture` and the HTTP API use.
#[derive(Debug, Clone, Deserialize)]
pub struct AsOfQuery {
    pub book_id: String,
    #[serde(default)]
    pub as_of: Option<String>,
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
    /// Inclusive posted-date range this summary covers. Used to be a
    /// calendar-month `period` with the range end synthesized as
    /// `{period}-31` — wrong for any month with fewer than 31 days — now the
    /// caller states the exact range it wants, same as every other period
    /// report.
    pub from: String,
    pub to: String,
    pub currency: String,
    /// Region-profile display name for this report ("VAT201" for za,
    /// "Tax summary" generically) — the UI never hardcodes it.
    pub report_name: String,
    /// Box labels straight from the region profile.
    pub labels: core::TaxBoxLabels,
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

// ---------------------------------------------------------------------------
// device identity and pairing.
//
// The read shapes — `DeviceIdentity`, `DevicePeer`, `DeviceRotation`,
// `PairingInviteMeta` — cross IPC as **core's own types**, unwrapped. They are
// public information (public keys, key-names, cosmetic labels, timestamps),
// they are already `Serialize`, and a hand-copied DTO beside them would be one
// more thing that can silently disagree with the wire names the HTTP routes
// serve.
//
// The two shapes below exist because they carry a **pairing blob**, and a blob
// is a credential until it is redeemed or expires: it contains the single-use
// claim token. Core's `PairingInvite` and `PairingAcceptance` derive `Debug`,
// which prints it. These do not — the whole reason they are not passed through.
// ---------------------------------------------------------------------------

/// A minted invite. `blob` is the text the user carries to the other device
/// **and a credential while it lives** — show it, let it be copied, then drop
/// it from state. Never log it and never put it in an error message.
#[derive(Clone, Serialize)]
pub struct PairingInviteDto {
    pub id: String,
    pub blob: String,
    /// This device's key-name — what the other person must see match.
    pub keyname: String,
    pub expires_at: String,
}

impl std::fmt::Debug for PairingInviteDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingInviteDto")
            .field("id", &self.id)
            .field("blob", &"<redacted>")
            .field("keyname", &self.keyname)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// The result of accepting an invite: the inviter is pinned, and `blob` goes
/// back so the inviter can pin us. Same credential discipline as above — it
/// echoes the claim token.
#[derive(Clone, Serialize)]
pub struct PairingAcceptanceDto {
    pub peer: slipscan_core::device::DevicePeer,
    pub blob: String,
}

impl std::fmt::Debug for PairingAcceptanceDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingAcceptanceDto")
            .field("peer", &self.peer)
            .field("blob", &"<redacted>")
            .finish()
    }
}

/// This device's key after a rotation, plus the rotation that proves it
/// replaced the previous one.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceRotateDto {
    pub identity: slipscan_core::device::DeviceIdentity,
    pub rotation: slipscan_core::device::DeviceRotation,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceInitRequest {
    /// Cosmetic name for this device. Not an identity — two devices may share
    /// one and nothing anywhere cares.
    #[serde(default)]
    pub label: Option<String>,
}

/// A device id: the lowercase hex ed25519 public key. There is no other kind
/// of device identifier — no account, no email, no username.
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceIdRequest {
    pub device_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceInviteRequest {
    /// Cosmetic label for the device you expect to pair with.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub ttl_seconds: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceInviteIdRequest {
    pub id: String,
}

/// Destroying this device's private key is not undoable, so the intent is
/// carried explicitly — the same `--yes` the CLI's `device reset` requires.
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceResetRequest {
    #[serde(default)]
    pub confirm: bool,
}

/// Redeeming a pairing blob: the blob, plus **how the human check was
/// discharged**.
///
/// The two fields are the two arms of
/// [`slipscan_core::device::pairing::KeynameCheck`] and nothing else. There is
/// deliberately no third state: unlike the CLI, which offers `--unverified`
/// for scripted use, this boundary has no way to skip the comparison at all.
/// A caller that supplies neither field is refused (see
/// `commands::keyname_check`) rather than silently downgraded, because the
/// comparison *is* the authentication — everything else in the ceremony is a
/// signature under a key the attacker would have substituted wholesale.
#[derive(Clone, Deserialize)]
pub struct DevicePairRedeemRequest {
    /// The `ss-pair1.…` blob. A credential: not logged, not echoed into an
    /// error message.
    pub blob: String,
    /// The key-name the user read off the *other device's screen* and typed
    /// here. Compared against the key inside the blob; a mismatch refuses.
    #[serde(default)]
    pub expect_keyname: Option<String>,
    /// Set only when this UI genuinely displayed the key-name and the user
    /// affirmed it. A rubber stamp here is the one way to turn a human
    /// verification step into decoration.
    #[serde(default)]
    pub confirmed_by_human: bool,
}

impl std::fmt::Debug for DevicePairRedeemRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DevicePairRedeemRequest")
            .field("blob", &"<redacted>")
            .field("expect_keyname", &self.expect_keyname)
            .field("confirmed_by_human", &self.confirmed_by_human)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basics() {
        assert_eq!(slugify("Personal"), "personal");
        assert_eq!(
            slugify("Molefe Consulting (Pty) Ltd"),
            "molefe-consulting-pty-ltd"
        );
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

    /// Absent / `null` / value, over the wire these requests actually travel
    /// on. This used to assert a `clear_default_account: true` flag, which
    /// existed only because plain serde could not tell an absent key from an
    /// explicit null — fixed in `slipscan_core::util::double_option`, so the
    /// flag is gone and `null` carries the intent directly.
    #[test]
    fn member_update_request_maps_leave_clear_and_set_default_account() {
        // Omitted entirely: leave the default account untouched.
        let leave: MemberUpdateRequest =
            serde_json::from_str(r#"{"id":"m1","label":"Alexis"}"#).unwrap();
        assert_eq!(leave.clone().into_patch().default_account_id, None);
        assert_eq!(leave.into_patch().label, Some("Alexis".to_string()));

        // Explicit null clears it.
        let clear: MemberUpdateRequest =
            serde_json::from_str(r#"{"id":"m1","default_account_id":null}"#).unwrap();
        assert_eq!(clear.into_patch().default_account_id, Some(None));

        // A new account id sets it.
        let set: MemberUpdateRequest =
            serde_json::from_str(r#"{"id":"m1","default_account_id":"acc-1"}"#).unwrap();
        assert_eq!(
            set.into_patch().default_account_id,
            Some(Some("acc-1".to_string()))
        );
    }

    /// The same three states for the other two request shapes that carry
    /// nullable fields, so this is not proven on one struct and assumed for
    /// the rest.
    #[test]
    fn location_and_po_requests_map_leave_clear_and_set() {
        let leave: LocationUpdateRequest =
            serde_json::from_str(r#"{"id":"l1","name":"Main"}"#).unwrap();
        assert_eq!(leave.into_patch().code, None);
        let clear: LocationUpdateRequest =
            serde_json::from_str(r#"{"id":"l1","code":null}"#).unwrap();
        assert_eq!(clear.into_patch().code, Some(None));
        let set: LocationUpdateRequest =
            serde_json::from_str(r#"{"id":"l1","address":"1 Road"}"#).unwrap();
        assert_eq!(set.into_patch().address, Some(Some("1 Road".to_string())));

        let leave: PoUpdateRequest = serde_json::from_str(r#"{"id":"p1"}"#).unwrap();
        assert_eq!(leave.into_patch().notes, None);
        let clear: PoUpdateRequest =
            serde_json::from_str(r#"{"id":"p1","expected_delivery":null}"#).unwrap();
        assert_eq!(clear.into_patch().expected_delivery, Some(None));
        let set: PoUpdateRequest = serde_json::from_str(r#"{"id":"p1","notes":"n"}"#).unwrap();
        assert_eq!(set.into_patch().notes, Some(Some("n".to_string())));
    }

    /// A pairing blob carries a single-use claim token, which makes it a
    /// credential until it is redeemed. Core's own `PairingInvite` prints it
    /// in `Debug`; these wrappers exist so nothing on this side can, and the
    /// test is here because re-deriving `Debug` is a one-word edit.
    #[test]
    fn pairing_blobs_are_redacted_in_debug() {
        const BLOB: &str = "ss-pair1.THIS-IS-A-CLAIM-TOKEN";

        let invite = PairingInviteDto {
            id: "inv-1".to_string(),
            blob: BLOB.to_string(),
            keyname: "amber-brisk-cedar-dune-ember-flint-grove-harbor-ink".to_string(),
            expires_at: "2026-07-20T09:10:00Z".to_string(),
        };
        assert!(!format!("{invite:?}").contains("CLAIM-TOKEN"));
        // …and it is still on the wire, because carrying it is the point.
        assert!(serde_json::to_string(&invite).unwrap().contains(BLOB));

        let acceptance = PairingAcceptanceDto {
            peer: slipscan_core::device::DevicePeer {
                public_key: "ab".repeat(32),
                keyname: "amber-brisk-cedar-dune-ember-flint-grove-harbor-ink".to_string(),
                label: "laptop".to_string(),
                paired_at: "2026-07-20T09:00:00Z".to_string(),
                revoked_at: None,
                last_seen_at: None,
            },
            blob: BLOB.to_string(),
        };
        assert!(!format!("{acceptance:?}").contains("CLAIM-TOKEN"));

        let redeem: DevicePairRedeemRequest =
            serde_json::from_str(&format!(r#"{{"blob":"{BLOB}"}}"#)).unwrap();
        assert!(!format!("{redeem:?}").contains("CLAIM-TOKEN"));
        // Neither key-name field was supplied, so the request is *not* a
        // pairing that can proceed; commands::keyname_check refuses it.
        assert!(redeem.expect_keyname.is_none());
        assert!(!redeem.confirmed_by_human);
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
