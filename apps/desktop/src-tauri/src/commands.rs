//! Tauri IPC commands — thin adapters: parse → call core service → serialize.
//!
//! Command names match the contract in docs/ARCHITECTURE.md and the typed
//! client in `src/lib/api/client.ts` (`book_list`, `transaction_categorize`,
//! `document_import`, `recon_confirm`, …). Errors cross IPC as plain strings;
//! secret material never crosses IPC in any response.

use std::collections::HashMap;

use base64::Engine as _;
use sha2::{Digest, Sha256};
use tauri::State;

use slipscan_core::domain::{
    self as core, CategoryNode, DocumentKind, DocumentSource, JournalSourceType, NewDocument,
    NewJournal, NewJournalLine, TransactionFilter,
};
use slipscan_core::secrets::{SecretString, SecretStore, Vault};
use slipscan_core::util::{new_id, now_iso};
use slipscan_core::CoreService;

use crate::dto::{self, *};
use crate::state::AppState;

/// Settings key for the desktop UI's provider/appearance blob. Holds
/// keychain entry *names* at most — never secret material.
const UI_SETTINGS_KEY: &str = "desktop.settings";
/// Settings key for the vault's human-readable labels (metadata only).
const VAULT_LABELS_KEY: &str = "desktop.vault.labels";

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn book_by_id(service: &CoreService, book_id: &str) -> Result<core::Book, String> {
    service.book_get(book_id).map_err(err)
}

/// (id → name) lookup over the category tree.
type CategoryNames = HashMap<String, String>;
/// (id → kind) lookup over the category tree.
type CategoryKinds = HashMap<String, String>;

/// Flat (id → name) and (id → kind) lookups over the category tree.
fn category_maps(
    service: &CoreService,
    book_id: &str,
) -> Result<(CategoryNames, CategoryKinds), String> {
    fn walk(
        nodes: &[CategoryNode],
        names: &mut HashMap<String, String>,
        kinds: &mut HashMap<String, String>,
    ) {
        for n in nodes {
            names.insert(n.category.id.clone(), n.category.name.clone());
            kinds.insert(
                n.category.id.clone(),
                n.category.kind.as_str().to_string(),
            );
            walk(&n.children, names, kinds);
        }
    }
    let tree = service.category_tree(book_id).map_err(err)?;
    let mut names = HashMap::new();
    let mut kinds = HashMap::new();
    walk(&tree, &mut names, &mut kinds);
    Ok((names, kinds))
}

fn coa_names(service: &CoreService, book_id: &str) -> Result<HashMap<String, String>, String> {
    Ok(service
        .coa_list(book_id)
        .map_err(err)?
        .into_iter()
        .map(|c| (c.id, c.name))
        .collect())
}

// ---------------------------------------------------------------------------
// books / accounts
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn book_list(state: State<'_, AppState>) -> Result<Vec<BookDto>, String> {
    let service = state.service()?;
    let books = service.book_list().map_err(err)?;
    Ok(books
        .iter()
        .map(|b| dto::book_dto(b, &state.db_path))
        .collect())
}

#[derive(serde::Deserialize)]
pub struct BookScopedQuery {
    pub book_id: String,
}

#[tauri::command]
pub async fn account_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<AccountDto>, String> {
    let service = state.service()?;
    let accounts = service.account_list(&query.book_id).map_err(err)?;
    let txns = service
        .transaction_list(&query.book_id, &TransactionFilter::default())
        .map_err(err)?;
    let account_currency: HashMap<&str, &str> = accounts
        .iter()
        .map(|a| (a.id.as_str(), a.currency.as_str()))
        .collect();
    let mut sums: HashMap<&str, i64> = HashMap::new();
    for t in &txns {
        // An account balance is in the account's currency; transactions in
        // any other currency must not be summed into it.
        if account_currency.get(t.account_id.as_str()) != Some(&t.currency.as_str()) {
            continue;
        }
        *sums.entry(t.account_id.as_str()).or_insert(0) += t.amount_minor;
    }
    Ok(accounts
        .iter()
        .map(|a| dto::account_dto(a, sums.get(a.id.as_str()).copied().unwrap_or(0)))
        .collect())
}

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn transaction_list(
    state: State<'_, AppState>,
    query: TransactionListQuery,
) -> Result<Vec<TransactionDto>, String> {
    let service = state.service()?;
    let filter = TransactionFilter {
        account_id: query.account_id.clone(),
        category_id: query.category_id.clone(),
        status: None,
        from_date: query.from.clone(),
        to_date: query.to.clone(),
        limit: None,
    };
    let mut rows = service
        .transaction_list(&query.book_id, &filter)
        .map_err(err)?;
    if let Some(search) = query.search.as_deref().filter(|s| !s.is_empty()) {
        let needle = search.to_lowercase();
        rows.retain(|t| {
            t.description
                .as_deref()
                .unwrap_or("")
                .to_lowercase()
                .contains(&needle)
                || t.merchant
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&needle)
        });
    }
    let offset = query.offset.unwrap_or(0).min(rows.len());
    let mut rows = rows.split_off(offset);
    if let Some(limit) = query.limit {
        rows.truncate(limit as usize);
    }
    Ok(rows.iter().map(dto::transaction_dto).collect())
}

#[tauri::command]
pub async fn transaction_categorize(
    state: State<'_, AppState>,
    query: CategorizeQuery,
) -> Result<TransactionDto, String> {
    let service = state.service()?;
    let txn = match query.category_id.as_deref() {
        Some(category_id) => service
            .transaction_categorize(&query.transaction_id, category_id)
            .map_err(err)?,
        // `category_id: null` clears the category (back to Uncategorised).
        None => service
            .transaction_uncategorize(&query.transaction_id)
            .map_err(err)?,
    };
    Ok(dto::transaction_dto(&txn))
}

#[tauri::command]
pub async fn category_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<CategoryDto>, String> {
    let service = state.service()?;
    let tree = service.category_tree(&query.book_id).map_err(err)?;
    Ok(dto::category_dtos(&tree))
}

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct BudgetListQuery {
    pub book_id: String,
    pub month: String,
}

#[tauri::command]
pub async fn budget_list(
    state: State<'_, AppState>,
    query: BudgetListQuery,
) -> Result<Vec<BudgetWithSpendDto>, String> {
    let service = state.service()?;
    let (names, _) = category_maps(&service, &query.book_id)?;
    let status = service
        .budget_status(&query.book_id, &query.month)
        .map_err(err)?;
    // budget_status carries spend vs budget; the stored rows carry the
    // rollover flag and created_at — join them by category.
    let stored: HashMap<String, core::Budget> = service
        .budget_list(&query.book_id, &query.month)
        .map_err(err)?
        .into_iter()
        .map(|b| (b.category_id.clone(), b))
        .collect();
    Ok(status
        .into_iter()
        .map(|s| BudgetWithSpendDto {
            category_name: names
                .get(&s.category_id)
                .cloned()
                .unwrap_or_else(|| "—".to_string()),
            budget: BudgetDto {
                // budget_status is keyed by (category, month); that pair is
                // the stable identity the list UI needs.
                id: format!("{}:{}", s.category_id, s.month),
                book_id: query.book_id.clone(),
                rollover: stored.get(&s.category_id).is_some_and(|b| b.rollover),
                created_at: stored
                    .get(&s.category_id)
                    .map(|b| b.created_at.clone())
                    .unwrap_or_default(),
                category_id: s.category_id,
                month: s.month,
                amount_minor: s.budget_minor,
                currency: s.currency,
            },
            spent_minor: s.spent_minor,
        })
        .collect())
}

#[tauri::command]
pub async fn budget_upsert(
    state: State<'_, AppState>,
    query: core::BudgetUpsert,
) -> Result<BudgetDto, String> {
    let service = state.service()?;
    let budget = service.budget_upsert(query).map_err(err)?;
    Ok(dto::budget_dto(&budget))
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

fn document_with_extraction(
    service: &CoreService,
    doc: &core::Document,
    book_currency: &str,
) -> Result<DocumentDto, String> {
    let payload = match doc.status {
        core::DocumentStatus::Extracted | core::DocumentStatus::Reviewed => service
            .document_current_extraction(&doc.id)
            .map_err(err)?
            .and_then(|e| e.payload),
        _ => None,
    };
    Ok(dto::document_dto(doc, payload.as_deref(), book_currency))
}

#[tauri::command]
pub async fn document_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<DocumentDto>, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    let mut docs = service.document_list(&query.book_id, None).map_err(err)?;
    docs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    docs.iter()
        .map(|d| document_with_extraction(&service, d, &book.currency))
        .collect()
}

#[derive(serde::Deserialize)]
pub struct DocumentGetQuery {
    pub document_id: String,
}

#[tauri::command]
pub async fn document_get(
    state: State<'_, AppState>,
    query: DocumentGetQuery,
) -> Result<DocumentDto, String> {
    let service = state.service()?;
    let doc = service.document_get(&query.document_id).map_err(err)?;
    let book = book_by_id(&service, &doc.book_id)?;
    document_with_extraction(&service, &doc, &book.currency)
}

#[tauri::command]
pub async fn document_import(
    state: State<'_, AppState>,
    query: DocumentImportRequest,
) -> Result<DocumentDto, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;

    let bytes: Vec<u8> = if let Some(b64) = query.bytes_base64.as_deref() {
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("invalid base64 file payload: {e}"))?
    } else if let Some(path) = query.path.as_deref() {
        std::fs::read(path).map_err(|e| format!("cannot read {path}: {e}"))?
    } else {
        return Err("document_import needs bytes_base64 or path".to_string());
    };

    let sha256 = {
        let digest = Sha256::digest(&bytes);
        digest.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };

    // Keep the stored name collision-free but recognisable.
    let safe_name: String = query
        .file_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let dest = state.docs_dir.join(format!("{}-{safe_name}", new_id()));
    std::fs::write(&dest, &bytes).map_err(|e| format!("cannot store document: {e}"))?;

    let lower = query.file_name.to_lowercase();
    let kind = if lower.contains("invoice") {
        DocumentKind::Invoice
    } else if lower.contains("statement") {
        DocumentKind::BankStatement
    } else {
        DocumentKind::Slip
    };

    let imported = service.document_import(NewDocument {
        book_id: query.book_id.clone(),
        source: DocumentSource::Upload,
        kind,
        file_path: dest.display().to_string(),
        mime_type: Some(query.mime_type.clone()),
        size_bytes: Some(bytes.len() as i64),
        original_name: Some(query.file_name.clone()),
        sha256: Some(sha256),
    });
    match imported {
        Ok(doc) => document_with_extraction(&service, &doc, &book.currency),
        Err(e) => {
            let _ = std::fs::remove_file(&dest);
            Err(err(e))
        }
    }
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ledger_account_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<LedgerAccountDto>, String> {
    let service = state.service()?;
    let coa = service.coa_list(&query.book_id).map_err(err)?;
    Ok(coa.iter().map(dto::ledger_account_dto).collect())
}

#[tauri::command]
pub async fn journal_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<JournalEntryDto>, String> {
    let service = state.service()?;
    let names = coa_names(&service, &query.book_id)?;
    let mut journals = service
        .journal_list(&query.book_id, "0000-01-01", "9999-12-31")
        .map_err(err)?;
    journals.sort_by(|a, b| b.journal.posted_date.cmp(&a.journal.posted_date));
    Ok(journals
        .iter()
        .map(|p| {
            dto::journal_entry_dto(p, |id| {
                names.get(id).cloned().unwrap_or_else(|| "—".to_string())
            })
        })
        .collect())
}

#[tauri::command]
pub async fn journal_post(
    state: State<'_, AppState>,
    query: JournalPostRequest,
) -> Result<JournalEntryDto, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    let names = coa_names(&service, &query.book_id)?;
    let (source_type, source_id) = match query.source_document_id.clone() {
        Some(doc_id) => (JournalSourceType::Document, Some(doc_id)),
        None => (JournalSourceType::Manual, None),
    };
    let posted = service
        .journal_post(NewJournal {
            book_id: query.book_id.clone(),
            posted_date: query.entry_date.clone(),
            narrative: Some(query.memo.clone()).filter(|m| !m.is_empty()),
            reference: None,
            source_type,
            source_id,
            lines: query
                .lines
                .iter()
                .map(|l| NewJournalLine {
                    coa_id: l.ledger_account_id.clone(),
                    debit_minor: l.debit_minor,
                    credit_minor: l.credit_minor,
                    currency: book.currency.clone(),
                    description: None,
                    vat_rate_id: None,
                    vat_role: None,
                })
                .collect(),
        })
        .map_err(err)?;
    Ok(dto::journal_entry_dto(&posted, |id| {
        names.get(id).cloned().unwrap_or_else(|| "—".to_string())
    }))
}

// ---------------------------------------------------------------------------
// recon
// ---------------------------------------------------------------------------

fn recon_dto(
    service: &CoreService,
    book_currency: &str,
    m: &core::ReconMatch,
) -> Result<ReconSuggestionDto, String> {
    let txn = service.transaction_get(&m.transaction_id).map_err(err)?;
    let txn_dto = dto::transaction_dto(&txn);
    let (counterpart_id, merchant, total_minor) = if let Some(doc_id) = m.document_id.as_deref() {
        let doc = service.document_get(doc_id).map_err(err)?;
        let dto = document_with_extraction(service, &doc, book_currency)?;
        (
            doc_id.to_string(),
            dto.merchant.unwrap_or(dto.file_name),
            dto.total_minor.unwrap_or_else(|| txn.amount_minor.abs()),
        )
    } else if let Some(journal_id) = m.journal_id.as_deref() {
        let posted = service.journal_get(journal_id).map_err(err)?;
        (
            journal_id.to_string(),
            posted
                .journal
                .narrative
                .clone()
                .unwrap_or_else(|| "Journal entry".to_string()),
            txn.amount_minor.abs(),
        )
    } else {
        (String::new(), "—".to_string(), txn.amount_minor.abs())
    };
    Ok(ReconSuggestionDto {
        id: m.id.clone(),
        book_id: m.book_id.clone(),
        transaction_id: m.transaction_id.clone(),
        document_id: counterpart_id,
        score: m.confidence,
        status: dto::recon_state_str(m.state).to_string(),
        transaction_description: if txn_dto.description.is_empty() {
            txn_dto.merchant.clone().unwrap_or_default()
        } else {
            txn_dto.description
        },
        transaction_amount_minor: txn.amount_minor,
        document_merchant: merchant,
        document_total_minor: total_minor,
        currency: txn.currency.clone(),
        created_at: m.created_at.clone(),
    })
}

#[tauri::command]
pub async fn recon_suggest(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<ReconSuggestionDto>, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    let matches = service.recon_suggest(&query.book_id).map_err(err)?;
    matches
        .iter()
        .map(|m| recon_dto(&service, &book.currency, m))
        .collect()
}

#[tauri::command]
pub async fn recon_confirm(
    state: State<'_, AppState>,
    query: ReconConfirmRequest,
) -> Result<ReconSuggestionDto, String> {
    let service = state.service()?;
    let updated = if query.accept {
        service.recon_confirm(&query.suggestion_id).map_err(err)?
    } else {
        service.recon_reject(&query.suggestion_id).map_err(err)?
    };
    let book = book_by_id(&service, &updated.book_id)?;
    recon_dto(&service, &book.currency, &updated)
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct SpendingQuery {
    pub book_id: String,
    pub from: String,
    pub to: String,
}

#[tauri::command]
pub async fn report_spending(
    state: State<'_, AppState>,
    query: SpendingQuery,
) -> Result<SpendingReportDto, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    // Core rows are per (category, currency); this DTO is single-currency
    // (the book's base), so other-currency rows are excluded, never summed.
    let rows: Vec<_> = service
        .report_spending(&query.book_id, &query.from, &query.to)
        .map_err(err)?
        .into_iter()
        .filter(|r| r.currency == book.currency)
        .collect();
    let total: i64 = rows.iter().map(|r| r.total_minor).sum();
    Ok(SpendingReportDto {
        book_id: query.book_id.clone(),
        from: query.from.clone(),
        to: query.to.clone(),
        currency: book.currency,
        total_spent_minor: total,
        by_category: rows
            .into_iter()
            .map(|r| SpendingByCategoryDto {
                category_id: r
                    .category_id
                    .unwrap_or_else(|| "uncategorized".to_string()),
                category_name: r.category_name,
                amount_minor: r.total_minor,
                share: if total == 0 {
                    0.0
                } else {
                    r.total_minor as f64 / total as f64
                },
            })
            .collect(),
    })
}

#[tauri::command]
pub async fn report_income_expense(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<IncomeExpenseReportDto, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    let (_, kinds) = category_maps(&service, &query.book_id)?;
    let txns = service
        .transaction_list(&query.book_id, &TransactionFilter::default())
        .map_err(err)?;

    // Group by calendar month; transfers between own accounts stay out, and
    // so do transactions in other currencies (the DTO is single-currency).
    let mut by_month: std::collections::BTreeMap<String, (i64, i64)> = Default::default();
    for t in &txns {
        if t.posted_date.len() < 7 || t.currency != book.currency {
            continue;
        }
        let is_transfer = t
            .category_id
            .as_deref()
            .and_then(|id| kinds.get(id))
            .is_some_and(|k| k == "transfer");
        if is_transfer {
            continue;
        }
        let entry = by_month
            .entry(t.posted_date[..7].to_string())
            .or_insert((0, 0));
        if t.amount_minor >= 0 {
            entry.0 += t.amount_minor;
        } else {
            entry.1 += -t.amount_minor;
        }
    }
    let months: Vec<IncomeExpensePointDto> = by_month
        .into_iter()
        .map(|(month, (income, expense))| IncomeExpensePointDto {
            month,
            income_minor: income,
            expense_minor: expense,
        })
        .collect();
    let start = months.len().saturating_sub(6);
    Ok(IncomeExpenseReportDto {
        book_id: query.book_id.clone(),
        currency: book.currency,
        months: months[start..].to_vec(),
    })
}

#[derive(serde::Deserialize)]
pub struct VatSummaryQuery {
    pub book_id: String,
    /// Calendar month, `YYYY-MM`.
    pub period: String,
}

#[tauri::command]
pub async fn report_vat_summary(
    state: State<'_, AppState>,
    query: VatSummaryQuery,
) -> Result<VatSummaryDto, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    let summary = service
        .report_vat201(
            &query.book_id,
            &format!("{}-01", query.period),
            &format!("{}-31", query.period),
        )
        .map_err(err)?;
    Ok(VatSummaryDto {
        book_id: query.book_id.clone(),
        period: query.period.clone(),
        currency: book.currency,
        output_vat_minor: summary.output_vat_minor,
        input_vat_minor: summary.input_vat_minor,
        net_vat_minor: summary.net_vat_minor,
    })
}

#[tauri::command]
pub async fn report_trial_balance(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<TrialBalanceDto, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    let rows = service.report_trial_balance(&query.book_id).map_err(err)?;
    // The DTO is single-currency (book base): rows in other currencies are
    // excluded so the debit/credit totals below never mix currencies.
    let rows: Vec<TrialBalanceRowDto> = rows
        .into_iter()
        .filter(|r| r.currency == book.currency)
        .map(|r| TrialBalanceRowDto {
            ledger_account_id: r.coa_id,
            code: r.code,
            name: r.name,
            kind: r.kind.as_str().to_string(),
            debit_minor: r.debit_minor,
            credit_minor: r.credit_minor,
        })
        .collect();
    Ok(TrialBalanceDto {
        book_id: query.book_id.clone(),
        as_of: now_iso().chars().take(10).collect(),
        currency: book.currency,
        total_debit_minor: rows.iter().map(|r| r.debit_minor).sum(),
        total_credit_minor: rows.iter().map(|r| r.credit_minor).sum(),
        rows,
    })
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<SettingsDto, String> {
    let service = state.service()?;
    match service.settings_get(UI_SETTINGS_KEY).map_err(err)? {
        None => Ok(SettingsDto::default()),
        Some(json) => serde_json::from_str(&json).map_err(err),
    }
}

#[derive(serde::Deserialize)]
pub struct SettingsSetQuery {
    pub settings: SettingsDto,
}

#[tauri::command]
pub async fn settings_set(
    state: State<'_, AppState>,
    query: SettingsSetQuery,
) -> Result<SettingsDto, String> {
    let service = state.service()?;
    let json = serde_json::to_string(&query.settings).map_err(err)?;
    service
        .settings_set(UI_SETTINGS_KEY, &json, false)
        .map_err(err)?;
    Ok(query.settings)
}

// ---------------------------------------------------------------------------
// credential vault — write-only. Commands return METADATA ONLY; there is no
// IPC path that returns secret material, by construction (core's Vault has
// no `get`, and no DTO in dto.rs carries material).
// ---------------------------------------------------------------------------

type LabelMap = HashMap<String, String>;

fn load_labels(service: &CoreService) -> Result<LabelMap, String> {
    match service.settings_get(VAULT_LABELS_KEY).map_err(err)? {
        None => Ok(LabelMap::new()),
        Some(json) => serde_json::from_str(&json).map_err(err),
    }
}

fn store_labels(service: &CoreService, labels: &LabelMap) -> Result<(), String> {
    let json = serde_json::to_string(labels).map_err(err)?;
    service
        .settings_set(VAULT_LABELS_KEY, &json, false)
        .map_err(err)
}

fn vault_meta_dto(
    meta: slipscan_core::secrets::VaultSecretMeta,
    labels: &LabelMap,
) -> VaultCredentialDto {
    VaultCredentialDto {
        label: labels.get(&meta.name).cloned(),
        name: meta.name,
        version: meta.version,
        fingerprint: meta.fingerprint,
        created_at: meta.created_at,
        rotated_at: meta.rotated_at,
        last_used_at: meta.last_used_at,
    }
}

#[tauri::command]
pub async fn vault_list(state: State<'_, AppState>) -> Result<Vec<VaultCredentialDto>, String> {
    let labels = {
        let service = state.service()?;
        load_labels(&service)?
    };
    let db = state.vault_db()?;
    let vault = Vault::new(db.conn(), &state.keychain as &dyn SecretStore);
    let metas = vault.list_metadata().map_err(err)?;
    Ok(metas
        .into_iter()
        .map(|m| vault_meta_dto(m, &labels))
        .collect())
}

#[tauri::command]
pub async fn vault_set(
    state: State<'_, AppState>,
    query: VaultSetRequest,
) -> Result<VaultCredentialDto, String> {
    if query.secret.is_empty() {
        return Err("secret must not be empty".to_string());
    }
    let meta = {
        let db = state.vault_db()?;
        let vault = Vault::new(db.conn(), &state.keychain as &dyn SecretStore);
        vault
            .set(&query.name, SecretString::new(query.secret))
            .map_err(err)?
    };
    let service = state.service()?;
    let mut labels = load_labels(&service)?;
    if let Some(label) = query.label.clone().filter(|l| !l.trim().is_empty()) {
        labels.insert(query.name.clone(), label.trim().to_string());
        store_labels(&service, &labels)?;
    }
    Ok(vault_meta_dto(meta, &labels))
}

#[tauri::command]
pub async fn vault_replace(
    state: State<'_, AppState>,
    query: VaultReplaceRequest,
) -> Result<VaultCredentialDto, String> {
    if query.secret.is_empty() {
        return Err("secret must not be empty".to_string());
    }
    let meta = {
        let db = state.vault_db()?;
        let vault = Vault::new(db.conn(), &state.keychain as &dyn SecretStore);
        vault
            .replace(&query.name, SecretString::new(query.secret))
            .map_err(err)?
    };
    let service = state.service()?;
    let labels = load_labels(&service)?;
    Ok(vault_meta_dto(meta, &labels))
}

#[tauri::command]
pub async fn vault_revoke(
    state: State<'_, AppState>,
    query: VaultRevokeRequest,
) -> Result<(), String> {
    {
        let db = state.vault_db()?;
        let vault = Vault::new(db.conn(), &state.keychain as &dyn SecretStore);
        vault.revoke(&query.name).map_err(err)?;
    }
    let service = state.service()?;
    let mut labels = load_labels(&service)?;
    if labels.remove(&query.name).is_some() {
        store_labels(&service, &labels)?;
    }
    Ok(())
}
