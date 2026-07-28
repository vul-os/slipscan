//! Tauri IPC commands — thin adapters: parse → call core service → serialize.
//!
//! Command names match the contract in docs/ARCHITECTURE.md and the typed
//! client in `src/lib/api/client.ts` (`book_list`, `transaction_categorize`,
//! `document_import`, `recon_confirm`, …). Errors cross IPC as plain strings;
//! secret material never crosses IPC in any response — with exactly one
//! sanctioned exception: `pay_endpoint_add` / `pay_endpoint_rotate_secret`
//! return the just-generated webhook signing secret once (core's
//! [`slipscan_core::domain::PayEndpointWithSecret`] single-display contract,
//! needed so the receiver operator can configure verification), after which
//! it exists only in the vault.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use base64::Engine as _;
use sha2::{Digest, Sha256};
use tauri::State;

use slipscan_core::domain::{
    self as core, CategoryNode, DocumentKind, DocumentSource, JournalSourceType, NewDocument,
    NewJournal, NewJournalLine, TransactionFilter,
};
use slipscan_core::secrets::{SecretStore, SecretString, Vault};
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
            kinds.insert(n.category.id.clone(), n.category.kind.as_str().to_string());
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
    let db_path = slipscan_core::datadir::db_path(&state.data_dir()?);
    let books = service.book_list().map_err(err)?;
    Ok(books.iter().map(|b| dto::book_dto(b, &db_path)).collect())
}

/// Create a book, then seed it the way a fresh install's book is seeded.
///
/// The payload is core's own [`core::NewBook`], so region and currency are
/// whatever the caller picked out of `region_list` — nothing jurisdictional
/// is decided here or anywhere below. Core rejects an unknown region id, and
/// falls back to the *generic* profile (never a country) when neither
/// `region` nor `country` is given; the currency comes from the chosen
/// profile's data when omitted.
///
/// Unlike the HTTP route of the same name, this also runs
/// [`crate::state::seed_book_contents`]: the desktop has no `coa_seed`
/// command, so a bare create would leave first-run setup holding a book with
/// no chart of accounts and no categories.
#[tauri::command]
pub async fn book_create(
    state: State<'_, AppState>,
    query: core::NewBook,
) -> Result<BookDto, String> {
    let service = state.service()?;
    let db_path = slipscan_core::datadir::db_path(&state.data_dir()?);
    let book = service.book_create(query).map_err(err)?;
    crate::state::seed_book_contents(&service, &book).map_err(err)?;
    Ok(dto::book_dto(&book, &db_path))
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
// data folder — movable, per the "Data location & backup" contract. Backup is
// the user's own cloud pointed at this folder; SlipScan ships no backup
// service.
// ---------------------------------------------------------------------------

fn data_status_dto(state: &AppState) -> Result<DataStatusDto, String> {
    // Core's shared resolver computes the status (the CLI and server read
    // the same one); the desktop only adds the cloud-sync display hint.
    let status = slipscan_core::datadir::status(&state.resolver).map_err(err)?;
    let hint = crate::datadir::cloud_sync_hint(std::path::Path::new(&status.data_dir));
    Ok(DataStatusDto {
        cloud_sync_hint: hint.map(str::to_string),
        status,
    })
}

#[tauri::command]
pub async fn data_status(state: State<'_, AppState>) -> Result<DataStatusDto, String> {
    data_status_dto(&state)
}

#[derive(serde::Deserialize)]
pub struct DataMoveRequest {
    /// Target folder as a typed path (no dialog plugin is bundled — adding
    /// tauri-plugin-dialog would enable a native picker later); a leading
    /// `~` expands to the home dir.
    pub target: String,
    /// Adopt a folder that already contains a SlipScan database instead of
    /// copying into it ("open instead" — the current folder is left as-is).
    #[serde(default)]
    pub use_existing: bool,
}

/// Move (or with `use_existing`, switch) the data folder. One await for the
/// whole copy→verify→check→switch→cleanup sequence: the promise resolving IS
/// the completion signal, and while it is pending the app is read-only —
/// every other command blocks on the state locks held by the move.
#[tauri::command]
pub async fn data_move(
    state: State<'_, AppState>,
    query: DataMoveRequest,
) -> Result<DataStatusDto, String> {
    let target = expand_home(query.target.trim());
    if target.as_os_str().is_empty() {
        return Err("enter a destination folder".to_string());
    }
    if !target.is_absolute() {
        return Err(format!(
            "enter an absolute path (got \"{}\")",
            target.display()
        ));
    }
    // The copy is blocking filesystem work; hop off the async workers like
    // fx_fetch_rate does.
    tokio::task::block_in_place(|| state.move_data_dir(&target, query.use_existing))?;
    data_status_dto(&state)
}

/// `~` / `~/…` → the user's home directory. Anything else passes through.
fn expand_home(raw: &str) -> std::path::PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match (raw.strip_prefix("~"), home) {
        (Some(""), Some(home)) => std::path::PathBuf::from(home),
        (Some(rest), Some(home)) if rest.starts_with('/') || rest.starts_with('\\') => {
            std::path::Path::new(&home).join(&rest[1..])
        }
        _ => std::path::PathBuf::from(raw),
    }
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
// household members & per-person attribution — see ARCHITECTURE.md
// "Household members & per-person attribution". Members are local data, not
// logins; attribution is metadata that never touches debits/credits. Core's
// domain types serialize straight across IPC (same pattern as vat rates / FX
// / payments) — the only translation needed is `MemberUpdateRequest`'s
// clear-flag, because plain JSON can't express nested-Option "explicit null".
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn member_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::Member>, String> {
    state.service()?.member_list(&query.book_id).map_err(err)
}

#[tauri::command]
pub async fn member_add(
    state: State<'_, AppState>,
    query: core::NewMember,
) -> Result<core::Member, String> {
    state.service()?.member_add(query).map_err(err)
}

#[tauri::command]
pub async fn member_update(
    state: State<'_, AppState>,
    query: MemberUpdateRequest,
) -> Result<core::Member, String> {
    let id = query.id.clone();
    state
        .service()?
        .member_update(&id, query.into_patch())
        .map_err(err)
}

#[tauri::command]
pub async fn member_remove(
    state: State<'_, AppState>,
    query: MemberRemoveRequest,
) -> Result<(), String> {
    state
        .service()?
        .member_remove(&query.id, query.reassign_to.as_deref())
        .map_err(err)
}

/// Override (or clear, with `member_id: null`) a transaction's attribution.
/// Metadata only — never touches amount/currency/category.
#[tauri::command]
pub async fn transaction_attribute(
    state: State<'_, AppState>,
    query: TransactionAttributeRequest,
) -> Result<TransactionDto, String> {
    let service = state.service()?;
    let txn = service
        .transaction_attribute(&query.transaction_id, query.member_id.as_deref())
        .map_err(err)?;
    Ok(dto::transaction_dto(&txn))
}

#[tauri::command]
pub async fn transaction_splits_list(
    state: State<'_, AppState>,
    query: TransactionIdQuery,
) -> Result<Vec<core::TransactionSplit>, String> {
    state
        .service()?
        .transaction_splits_list(&query.transaction_id)
        .map_err(err)
}

/// Replace a transaction's split set; an empty `shares` list clears the
/// split (back to single-member attribution / unattributed).
#[tauri::command]
pub async fn transaction_split_set(
    state: State<'_, AppState>,
    query: TransactionSplitSetRequest,
) -> Result<Vec<core::TransactionSplit>, String> {
    state
        .service()?
        .transaction_split_set(&query.transaction_id, query.shares)
        .map_err(err)
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
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
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
    let dest = slipscan_core::datadir::documents_dir(&state.data_dir()?)
        .join(format!("{}-{safe_name}", new_id()));
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
                category_id: r.category_id.unwrap_or_else(|| "uncategorized".to_string()),
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
        .report_tax_summary(
            &query.book_id,
            &format!("{}-01", query.period),
            &format!("{}-31", query.period),
        )
        .map_err(err)?;
    Ok(VatSummaryDto {
        book_id: query.book_id.clone(),
        period: query.period.clone(),
        currency: book.currency,
        // Report name + box labels come from the book's region profile
        // ("VAT201" for za, "Tax summary" generically) — never hardcoded.
        report_name: summary.report_name,
        labels: summary.labels,
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

/// Per-member outflow (expense) totals over the period, in the book's base
/// currency. Split shares are distributed; unattributed spend rolls into an
/// "Unattributed" row.
#[tauri::command]
pub async fn report_member_expense(
    state: State<'_, AppState>,
    query: MemberReportQuery,
) -> Result<Vec<core::MemberAmountRow>, String> {
    state
        .service()?
        .report_member_expense(&query.book_id, &query.from, &query.to)
        .map_err(err)
}

/// Per-member inflow (contribution) totals over the period — mirrors
/// [`report_member_expense`] for money coming in.
#[tauri::command]
pub async fn report_member_contribution(
    state: State<'_, AppState>,
    query: MemberReportQuery,
) -> Result<Vec<core::MemberAmountRow>, String> {
    state
        .service()?
        .report_member_contribution(&query.book_id, &query.from, &query.to)
        .map_err(err)
}

/// Each member's share of each category's spend over the period.
#[tauri::command]
pub async fn report_member_category(
    state: State<'_, AppState>,
    query: MemberReportQuery,
) -> Result<Vec<core::MemberCategoryRow>, String> {
    state
        .service()?
        .report_member_category(&query.book_id, &query.from, &query.to)
        .map_err(err)
}

/// Net position per member over the period (contributions minus attributed
/// expenses) — "who owes whom".
#[tauri::command]
pub async fn report_settle_up(
    state: State<'_, AppState>,
    query: MemberReportQuery,
) -> Result<Vec<core::MemberSettleRow>, String> {
    state
        .service()?
        .report_settle_up(&query.book_id, &query.from, &query.to)
        .map_err(err)
}

// ---------------------------------------------------------------------------
// regions — profiles are data the user picks, never a hardcoded default
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn region_list() -> Result<Vec<slipscan_core::region::RegionInfo>, String> {
    Ok(slipscan_core::region::region_infos())
}

// ---------------------------------------------------------------------------
// tax rates — listed and configurable per book (the generic profile's
// standard rate is a placeholder until the user sets it)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn vat_rate_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::VatRate>, String> {
    state.service()?.vat_rate_list(&query.book_id).map_err(err)
}

#[derive(serde::Deserialize)]
pub struct VatRateSetQuery {
    pub book_id: String,
    /// Rate code within the book, e.g. "STD".
    pub code: String,
    /// Basis points: 1500 = 15.00%.
    pub rate_bps: i64,
}

#[tauri::command]
pub async fn vat_rate_set_bps(
    state: State<'_, AppState>,
    query: VatRateSetQuery,
) -> Result<core::VatRate, String> {
    state
        .service()?
        .vat_rate_set_bps(&query.book_id, &query.code, query.rate_bps)
        .map_err(err)
}

// ---------------------------------------------------------------------------
// FX (OpenRate) — opt-in. Only `fx_fetch_rate` ever touches the network,
// only on an explicit user action, and only against the configured base URL.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fx_status(state: State<'_, AppState>) -> Result<slipscan_core::fx::FxStatus, String> {
    state.service()?.fx_status().map_err(err)
}

#[derive(serde::Deserialize)]
pub struct FxConfigureQuery {
    /// OpenRate base URL; an empty string clears it (FX off).
    pub base_url: String,
}

#[tauri::command]
pub async fn fx_configure(
    state: State<'_, AppState>,
    query: FxConfigureQuery,
) -> Result<slipscan_core::fx::FxStatus, String> {
    let service = state.service()?;
    service.fx_configure(&query.base_url).map_err(err)?;
    service.fx_status().map_err(err)
}

#[derive(serde::Deserialize)]
pub struct FxPairQuery {
    pub from: String,
    pub to: String,
}

#[tauri::command]
pub async fn fx_fetch_rate(
    state: State<'_, AppState>,
    query: FxPairQuery,
) -> Result<slipscan_core::fx::FxQuote, String> {
    // Core's FX future is `?Send`, so it cannot ride Tauri's async workers
    // directly: hop off the runtime with block_in_place and drive it on a
    // self-contained current-thread runtime. Network happens only here, only
    // because the user clicked, and only to the configured OpenRate URL.
    tokio::task::block_in_place(|| {
        let transport = slipscan_ingest::fx::ReqwestFxTransport::new().map_err(err)?;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("fx runtime: {e}"))?;
        let service = state.service()?;
        rt.block_on(service.fx_fetch_rate(&transport, &query.from, &query.to))
            .map_err(err)
    })
}

#[derive(serde::Deserialize)]
pub struct FxConvertQuery {
    pub from: String,
    pub to: String,
    pub amount_minor: i64,
    /// Optional pinned rate (decimal string): replays a booked conversion at
    /// exactly this rate instead of the current cached one.
    #[serde(default)]
    pub rate: Option<String>,
}

#[tauri::command]
pub async fn fx_convert(
    state: State<'_, AppState>,
    query: FxConvertQuery,
) -> Result<slipscan_core::fx::FxConversion, String> {
    let service = state.service()?;
    match query.rate.as_deref() {
        // Pinned-rate replay — booked conversions reproduce, never re-rate.
        Some(rate) => service
            .fx_convert_at(&query.from, &query.to, query.amount_minor, rate)
            .map_err(err),
        // Cache-only: a missing pair is an error, never a silent fetch.
        None => service
            .fx_convert(&query.from, &query.to, query.amount_minor)
            .map_err(err),
    }
}

// ---------------------------------------------------------------------------
// Payments — watch codes, webhook endpoints, deliveries. Deliberately
// simple: watch codes are a flat list, detection happens in core's
// transaction_create, signing secrets are vault-only. Core's domain
// types serialize straight across IPC (same pattern as vat rates / FX).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pay_watch_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::PayWatch>, String> {
    state.service()?.pay_watch_list(&query.book_id).map_err(err)
}

#[tauri::command]
pub async fn pay_watch_add(
    state: State<'_, AppState>,
    query: core::NewPayWatch,
) -> Result<core::PayWatch, String> {
    state.service()?.pay_watch_add(query).map_err(err)
}

#[derive(serde::Deserialize)]
pub struct PayWatchIdQuery {
    pub watch_id: String,
}

#[tauri::command]
pub async fn pay_watch_remove(
    state: State<'_, AppState>,
    query: PayWatchIdQuery,
) -> Result<(), String> {
    state
        .service()?
        .pay_watch_remove(&query.watch_id)
        .map_err(err)
}

#[derive(serde::Deserialize)]
pub struct PayWatchSetEnabledQuery {
    pub watch_id: String,
    pub enabled: bool,
}

#[tauri::command]
pub async fn pay_watch_set_enabled(
    state: State<'_, AppState>,
    query: PayWatchSetEnabledQuery,
) -> Result<core::PayWatch, String> {
    state
        .service()?
        .pay_watch_set_enabled(&query.watch_id, query.enabled)
        .map_err(err)
}

#[tauri::command]
pub async fn pay_endpoint_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::PayEndpoint>, String> {
    state
        .service()?
        .pay_endpoint_list(&query.book_id)
        .map_err(err)
}

/// The response carries the generated signing secret — the one sanctioned
/// display, exactly once (see the module docs). The frontend shows it in a
/// copy-once reveal and drops it.
#[tauri::command]
pub async fn pay_endpoint_add(
    state: State<'_, AppState>,
    query: core::NewPayEndpoint,
) -> Result<core::PayEndpointWithSecret, String> {
    state.service()?.pay_endpoint_add(query).map_err(err)
}

#[derive(serde::Deserialize)]
pub struct PayEndpointIdQuery {
    pub endpoint_id: String,
}

/// Same single-display contract as [`pay_endpoint_add`]; the old vault
/// ciphertext is overwritten, so the previous secret is gone.
#[tauri::command]
pub async fn pay_endpoint_rotate_secret(
    state: State<'_, AppState>,
    query: PayEndpointIdQuery,
) -> Result<core::PayEndpointWithSecret, String> {
    state
        .service()?
        .pay_endpoint_rotate_secret(&query.endpoint_id)
        .map_err(err)
}

/// Removes the endpoint (queued deliveries cascade) and revokes its
/// vault-held signing secret.
#[tauri::command]
pub async fn pay_endpoint_remove(
    state: State<'_, AppState>,
    query: PayEndpointIdQuery,
) -> Result<(), String> {
    state
        .service()?
        .pay_endpoint_remove(&query.endpoint_id)
        .map_err(err)
}

#[derive(serde::Deserialize)]
pub struct PayEndpointSetEnabledQuery {
    pub endpoint_id: String,
    pub enabled: bool,
}

#[tauri::command]
pub async fn pay_endpoint_set_enabled(
    state: State<'_, AppState>,
    query: PayEndpointSetEnabledQuery,
) -> Result<core::PayEndpoint, String> {
    state
        .service()?
        .pay_endpoint_set_enabled(&query.endpoint_id, query.enabled)
        .map_err(err)
}

#[tauri::command]
pub async fn pay_match_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::PayMatch>, String> {
    state.service()?.pay_match_list(&query.book_id).map_err(err)
}

#[tauri::command]
pub async fn pay_delivery_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::PayDelivery>, String> {
    state
        .service()?
        .pay_delivery_list(&query.book_id)
        .map_err(err)
}

/// POST every due pending delivery now. Network happens only here, only on
/// an explicit user action, and only to endpoint URLs the user registered;
/// signing runs inside the vault's `use_with` closure in core. Same
/// `?Send`-future bridge as `fx_fetch_rate`.
#[tauri::command]
pub async fn pay_deliver_due(state: State<'_, AppState>) -> Result<Vec<core::PayDelivery>, String> {
    tokio::task::block_in_place(|| {
        let transport = slipscan_ingest::pay::ReqwestWebhookTransport::new().map_err(err)?;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("pay runtime: {e}"))?;
        let service = state.service()?;
        rt.block_on(service.pay_deliver_due(&transport, &now_iso()))
            .map_err(err)
    })
}

// ---------------------------------------------------------------------------
// classification packs — the one install pipeline (ARCHITECTURE.md
// "Classification packs — one install pipeline").
//
// Every path here goes through `verify_detached` -> `VerifiedPack` ->
// `Installer`, so signature verification, TOFU signer pinning, semver
// ordering, safe category re-mapping and the audit log apply to a pack the
// desktop installs exactly as they do to one the CLI or the HTTP route
// installs. `compat` / `INSTALLED_PACKS_SETTING` are not referenced: the
// desktop reads the `pack_*` tables and nothing else. (A book whose packs
// were recorded by a pre-installer CLI shows them here once that CLI or the
// server adopts its index, which it does on its next pack call.)
//
// The response shapes below live beside their commands rather than in
// dto.rs because they exist only to serialize slipscan-packs types, which
// dto.rs — deliberately core-only — does not know about.
// ---------------------------------------------------------------------------

/// One installed pack. Metadata only: `signer` is a public key, never
/// secret material, and the payload itself is not shipped over IPC.
#[derive(serde::Serialize)]
pub struct InstalledPackDto {
    pub pack_id: String,
    pub book_id: String,
    pub name: String,
    pub version: String,
    /// `taxonomy` or `benchmark`.
    pub kind: String,
    /// ISO 3166-1 alpha-2 the pack targets; `null` = global.
    pub region: Option<String>,
    /// Short human-checkable fingerprint of the signer's key.
    pub signer_fingerprint: String,
    /// The trust store's label for this signer, or `null` if it is not (or
    /// no longer) trusted — a revoked signer's packs stay installed.
    pub signer_label: Option<String>,
    pub installed_at: String,
    pub updated_at: String,
}

/// The preflight for an install: what this signed file is, who signed it,
/// and what installing it would actually do — including refusing.
#[derive(serde::Serialize)]
pub struct PackVerificationDto {
    pub pack_id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub region: Option<String>,
    pub author: Option<String>,
    /// The fingerprint to check out-of-band before accepting the signer.
    pub signer_fingerprint: String,
    /// Trust label if this key is already trusted; `null` on first use.
    pub trusted_as: Option<String>,
    /// Fingerprint the pack id is pinned to, if it has been installed
    /// before. Differs from `signer_fingerprint` exactly when the publisher
    /// key changed — which is a refusal, never a silent success.
    pub pinned_fingerprint: Option<String>,
    /// Version of this pack id currently installed in the book, if any.
    pub installed_version: Option<String>,
    pub categories: usize,
    pub merchant_rules: usize,
    pub keyword_rules: usize,
    /// `install`, `upgrade`, or `refuse`.
    pub action: String,
    /// Set only when `action == "refuse"`: the installer's own wording for
    /// why, so the preflight and the attempt can never disagree.
    pub refusal: Option<String>,
    /// Whether installing needs the user to accept this fingerprint first.
    /// Always false for a file the user picked with its key in hand — passing
    /// the key *is* the decision there. True for a pack that arrived over a
    /// transport, where nothing was hand-carried.
    pub needs_signer_acceptance: bool,
    /// Where the bytes came from, when they came from a source rather than a
    /// file the user picked.
    pub origin: Option<String>,
}

/// What an install did.
#[derive(serde::Serialize)]
pub struct PackInstallDto {
    pub pack_id: String,
    pub name: String,
    pub version: String,
    /// ISO 3166-1 alpha-2 the pack targets; `null` = global. Carried so a
    /// screen can show *which jurisdiction's* chart it just took on —
    /// seeding installs regional taxonomies, and that is not a detail to
    /// leave the user guessing about.
    pub region: Option<String>,
    /// `installed` or `upgraded`.
    pub outcome: String,
    /// The version replaced, when `outcome == "upgraded"`.
    pub upgraded_from: Option<String>,
    pub categories_created: usize,
    pub categories_reused: usize,
    pub rules_installed: usize,
}

/// A signed pack as the user holds it: the document, its detached signature
/// and the publisher's public key — the same three inputs `slipscan pack
/// install` takes.
#[derive(serde::Deserialize)]
pub struct PackDocumentRequest {
    pub book_id: String,
    /// The exact signed bytes of the pack document, base64 for IPC transit.
    /// Base64 is transport encoding only: the bytes are verified as given,
    /// before anything interprets them.
    pub document_base64: String,
    /// Detached ed25519 signature: 128 hex characters, or base64 of 64 bytes.
    pub signature: String,
    /// Publisher public key: 64 hex characters, or base64 of 32 bytes.
    pub public_key: String,
}

#[derive(serde::Deserialize)]
pub struct PackIdRequest {
    pub book_id: String,
    pub pack_id: String,
}

/// Decode a signature or public key in either of the two forms publishers
/// distribute them in — hex (the form humans paste) or base64 (the form a
/// raw key/signature file base64s to). The length is checked here so a
/// truncated paste reports itself as such instead of as a failed signature.
fn decode_key_material(raw: &str, expect: usize, what: &str) -> Result<Vec<u8>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(format!("{what} is required"));
    }
    let bytes = if raw.len() == expect * 2 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        (0..raw.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&raw[i..i + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
            .map_err(|e| format!("invalid hex {what}: {e}"))?
    } else {
        base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map_err(|_| format!("{what} must be {} hex characters or base64", expect * 2))?
    };
    if bytes.len() != expect {
        return Err(format!(
            "{what} must be {expect} bytes; this one is {}",
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// Verify the three inputs and hand back the pack the installer would take.
fn verify_request(query: &PackDocumentRequest) -> Result<slipscan_packs::VerifiedPack, String> {
    let document = base64::engine::general_purpose::STANDARD
        .decode(query.document_base64.trim())
        .map_err(|e| format!("invalid base64 pack document: {e}"))?;
    let signature = decode_key_material(&query.signature, 64, "signature")?;
    let public_key = decode_key_material(&query.public_key, 32, "public key")?;
    slipscan_packs::verify_detached(&document, &signature, &public_key).map_err(err)
}

/// The label a first-use trust decision is recorded under. Comes from
/// slipscan-packs so the CLI, the server and this screen record the same
/// thing: the pack's own author when it declares one, else the fingerprint.
use slipscan_packs::transport::signer_label;

#[tauri::command]
pub async fn pack_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<InstalledPackDto>, String> {
    use slipscan_packs::{key_fingerprint, Installer, TrustStatus, TrustStore};

    let service = state.service()?;
    book_by_id(&service, &query.book_id)?;
    service.with_connection(|conn| {
        // Nothing to read — and nothing to create on a read path — until a
        // pack has actually been installed into this database.
        let Some(installer) = Installer::open_readonly(conn).map_err(err)? else {
            return Ok(Vec::new());
        };
        let trust = TrustStore::open(conn).map_err(err)?;
        installer
            .list(&query.book_id)
            .map_err(err)?
            .into_iter()
            .map(|pack| {
                let signer_label = match trust.status(&pack.signer) {
                    Ok(TrustStatus::Trusted { label }) => Some(label),
                    // A non-key signer id (builtin seed, dev override,
                    // legacy adoption) is not a trust-store row and never
                    // will be; that is not an error, it is "no label".
                    Ok(TrustStatus::Unknown { .. }) | Err(_) => None,
                };
                Ok(InstalledPackDto {
                    signer_fingerprint: key_fingerprint(&pack.signer),
                    signer_label,
                    pack_id: pack.pack_id,
                    book_id: pack.book_id,
                    name: pack.name,
                    version: pack.version,
                    kind: pack.kind.as_str().to_string(),
                    region: pack.region,
                    installed_at: pack.installed_at,
                    updated_at: pack.updated_at,
                })
            })
            .collect()
    })
}

/// Verify a signed pack **without installing it**: check the signature,
/// surface the signer's fingerprint for the out-of-band check that makes
/// trust-on-first-use mean anything, and report what installing would do.
///
/// The refusals — a changed publisher key, the version already installed, a
/// downgrade — come from `slipscan_packs::transport::plan`, the single
/// preflight the CLI, the HTTP routes and this screen all share, so the
/// preview can never promise something the attempt then refuses. A key change
/// is a refusal, not a silent success: the pack id is pinned to the key that
/// first signed it, and no other key can take the id over.
#[tauri::command]
pub async fn pack_verify(
    state: State<'_, AppState>,
    query: PackDocumentRequest,
) -> Result<PackVerificationDto, String> {
    let verified = verify_request(&query)?;
    let service = state.service()?;
    book_by_id(&service, &query.book_id)?;
    service.with_connection(|conn| {
        let plan =
            slipscan_packs::transport::plan(conn, &query.book_id, &verified, None).map_err(err)?;
        Ok(PackVerificationDto::from(plan))
    })
}

impl From<slipscan_packs::transport::PackPlan> for PackVerificationDto {
    fn from(plan: slipscan_packs::transport::PackPlan) -> Self {
        Self {
            action: plan.action.as_str().to_string(),
            needs_signer_acceptance: plan.needs_signer_acceptance(),
            pack_id: plan.pack_id,
            name: plan.name,
            version: plan.version,
            kind: plan.kind,
            region: plan.region,
            author: plan.author,
            signer_fingerprint: plan.signer_fingerprint,
            trusted_as: plan.trusted_as,
            pinned_fingerprint: plan.pinned_fingerprint,
            installed_version: plan.installed_version,
            categories: plan.categories,
            merchant_rules: plan.merchant_rules,
            keyword_rules: plan.keyword_rules,
            refusal: plan.refusal,
            origin: plan.origin,
        }
    }
}

/// Verify and install (or upgrade) a signed pack into a book.
///
/// Passing the publisher's key *is* the trust decision — that is what
/// trust-on-first-use means, and `pack_verify` exists so the user makes it
/// having seen the fingerprint. The pack id is then pinned to that key
/// forever; a later version signed by a different key is refused, and there
/// is no flag here that overrides it.
///
/// Rules are not applied retroactively: they classify transactions imported
/// from here on, not the ones already in the book.
#[tauri::command]
pub async fn pack_install(
    state: State<'_, AppState>,
    query: PackDocumentRequest,
) -> Result<PackInstallDto, String> {
    use slipscan_packs::{engine, InstallOutcome, Installer, TrustStatus, TrustStore};

    let verified = verify_request(&query)?;
    let label = signer_label(&verified);
    let service = state.service()?;
    book_by_id(&service, &query.book_id)?;
    // Installing a pack is also where this process picks up the classifier:
    // from here on core consults the rules being written.
    engine::register_classifier();

    service.with_connection(|conn| {
        let installer = Installer::open(conn).map_err(err)?;
        let trust = TrustStore::open(conn).map_err(err)?;
        if let TrustStatus::Unknown { .. } = trust.status(verified.signer()).map_err(err)? {
            trust.trust(verified.signer(), &label).map_err(err)?;
        }
        let report = installer.install(&query.book_id, &verified).map_err(err)?;
        let (outcome, upgraded_from) = match report.outcome {
            InstallOutcome::Installed => ("installed", None),
            InstallOutcome::Upgraded { from } => ("upgraded", Some(from)),
        };
        Ok(PackInstallDto {
            pack_id: report.pack.pack_id,
            name: report.pack.name,
            version: report.pack.version,
            region: report.pack.region,
            outcome: outcome.to_string(),
            upgraded_from,
            categories_created: report.categories_created,
            categories_reused: report.categories_reused,
            rules_installed: report.rules_installed,
        })
    })
}

/// Install the built-in seed packs into a book: the SA pair (`za-personal`,
/// `za-business-vat`) and the global `intl-starter`.
///
/// An **explicit user action**, never something book creation does on its
/// own: which taxonomy a book starts from is the user's decision, and
/// auto-installing a ZA chart for someone in Portugal would be wrong.
///
/// Seeds carry [`slipscan_packs::Provenance::Builtin`] — their payload is
/// embedded in this binary, so there is no key to trust on first use and the
/// TOFU store is not touched (`builtin`'s module docs state the trust model
/// plainly). Idempotent and non-clobbering: a seed already installed at the
/// same version is skipped, and categories the user already has are adopted
/// by (parent, name) rather than duplicated.
#[tauri::command]
pub async fn pack_install_seeds(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<PackInstallDto>, String> {
    let service = state.service()?;
    book_by_id(&service, &query.book_id)?;
    // Seeding is also an import path for rules, so make sure this process is
    // consulting them (idempotent — the startup call in lib.rs already did).
    slipscan_packs::engine::register_classifier();
    service.with_connection(|conn| {
        let reports =
            slipscan_packs::builtin::install_seed_packs(conn, &query.book_id).map_err(err)?;
        Ok(reports
            .into_iter()
            .map(|report| {
                let (outcome, upgraded_from) = match report.outcome {
                    slipscan_packs::InstallOutcome::Installed => ("installed", None),
                    slipscan_packs::InstallOutcome::Upgraded { from } => ("upgraded", Some(from)),
                };
                PackInstallDto {
                    pack_id: report.pack.pack_id,
                    name: report.pack.name,
                    version: report.pack.version,
                    region: report.pack.region,
                    outcome: outcome.to_string(),
                    upgraded_from,
                    categories_created: report.categories_created,
                    categories_reused: report.categories_reused,
                    rules_installed: report.rules_installed,
                }
            })
            .collect())
    })
}

/// Remove an installed pack's rules and its registration.
///
/// Categories the pack created are kept — they are ordinary local
/// categories now, and transactions still point at them, so history never
/// breaks. The signer pin is kept too: the pack id stays bound to its
/// original key even after the pack is gone. Returns whether a pack was
/// removed.
#[tauri::command]
pub async fn pack_uninstall(
    state: State<'_, AppState>,
    query: PackIdRequest,
) -> Result<bool, String> {
    let service = state.service()?;
    book_by_id(&service, &query.book_id)?;
    service.with_connection(|conn| {
        slipscan_packs::Installer::open(conn)
            .map_err(err)?
            .uninstall(&query.book_id, &query.pack_id)
            .map_err(err)
    })
}

// ---------------------------------------------------------------------------
// pack sources — the FETCH half (docs/PACKS.md "Getting a pack").
//
// A transport grants no authority. Every path below hands raw bytes to
// `slipscan_packs::transport`, which checks the signature before the database
// is touched, and then to the same `Installer` a hand-picked file goes
// through. There is no second install path and no way to reach one.
//
// Two things this surface exists to make legible, on top of what the install
// screen already shows:
//
// * **arriving is not accepting.** A signer this machine has never seen is
//   refused until the user accepts that exact fingerprint. Naming a source is
//   not consent to everything it will ever serve.
// * **there is no registry.** The source list starts empty and only the user
//   writes to it, so a fresh install makes no outbound pack request at all.
// ---------------------------------------------------------------------------

/// One configured source.
#[derive(serde::Serialize)]
pub struct PackSourceDto {
    pub name: String,
    /// Canonical URI: `file:`, `folder:`, `git:` or `https://`.
    pub uri: String,
    pub kind: String,
    /// Whether reading it can put packets on a network.
    pub network: bool,
    pub added_at: String,
    pub last_synced_at: Option<String>,
}

/// One pack a source offers: the catalogue's claim, plus the verified
/// preflight when the bytes check out. The two are separate fields because
/// only the second is derived from a checked signature.
#[derive(serde::Serialize)]
pub struct PackOfferDto {
    /// Claimed id (catalogue — a hint, not a fact).
    pub pack_id: String,
    /// Claimed version (catalogue).
    pub version: String,
    /// Claimed display name (catalogue).
    pub name: Option<String>,
    /// Blob name within the source; the handle `pack_source_install` takes.
    pub document: String,
    /// The verified preflight, present iff the signature verified.
    pub verified: Option<PackVerificationDto>,
    /// Why this entry could not be verified. One unreadable file in a shared
    /// folder must not hide the rest of the catalogue.
    pub error: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct PackSourceAddRequest {
    pub name: String,
    /// `file:<path>`, `folder:<path>`, `git:<url>[#ref]` or `https://<url>`.
    pub uri: String,
}

#[derive(serde::Deserialize)]
pub struct PackSourceNameRequest {
    pub name: String,
}

#[derive(serde::Deserialize)]
pub struct PackSourceFetchRequest {
    pub book_id: String,
    pub source: String,
}

#[derive(serde::Deserialize)]
pub struct PackSourceInstallRequest {
    pub book_id: String,
    pub source: String,
    pub pack_id: String,
    /// Exact document name from `pack_source_fetch`, when one source offers
    /// the same pack id from more than one publisher.
    #[serde(default)]
    pub document: Option<String>,
    /// The trust-on-first-use answer: the fingerprint the user compared
    /// against the publisher's own channel. Omit and an unknown signer
    /// refuses. Never an override for a changed publisher key.
    #[serde(default)]
    pub accept_signer: Option<String>,
}

/// Transport capabilities for one source read: the git checkout cache (kept
/// inside the user's own data folder, so it is part of the one thing they
/// back up or delete) and the HTTPS client.
///
/// Built per call and only for a pack-source command. It carries no endpoint
/// — slipscan-packs has none — so every request goes to a base URL the user
/// added, and with no source added, none is ever made.
fn pack_transport_context(
    state: &AppState,
) -> Result<slipscan_packs::transport::TransportContext, String> {
    let cache = state.data_dir()?;
    let http = slipscan_ingest::packs::ReqwestPackHttp::new()?;
    Ok(slipscan_packs::transport::TransportContext::new()
        .with_cache_dir(cache)
        .with_http(std::sync::Arc::new(http)))
}

fn to_source_dto(row: slipscan_packs::transport::PackSourceRow) -> PackSourceDto {
    PackSourceDto {
        uri: row.source.uri(),
        kind: row.source.kind().as_str().to_string(),
        network: row.source.is_network(),
        name: row.name,
        added_at: row.added_at,
        last_synced_at: row.last_synced_at,
    }
}

/// Add a pack source. Nothing is contacted by adding one — the source is read
/// when the user asks for it. This is the **only** way a source ever exists.
#[tauri::command]
pub async fn pack_source_add(
    state: State<'_, AppState>,
    query: PackSourceAddRequest,
) -> Result<PackSourceDto, String> {
    use slipscan_packs::transport::{PackSource, SourceStore};

    let source = PackSource::parse(&query.uri).map_err(err)?;
    let service = state.service()?;
    service.with_connection(|conn| {
        let row = SourceStore::open(conn)
            .map_err(err)?
            .add(&query.name, &source)
            .map_err(err)?;
        Ok(to_source_dto(row))
    })
}

/// Forget a source. Installed packs are untouched: where a pack came from is
/// history, not a dependency. `false` = there was no source by that name.
#[tauri::command]
pub async fn pack_source_remove(
    state: State<'_, AppState>,
    query: PackSourceNameRequest,
) -> Result<bool, String> {
    let service = state.service()?;
    service.with_connection(|conn| {
        slipscan_packs::transport::SourceStore::open(conn)
            .map_err(err)?
            .remove(&query.name)
            .map_err(err)
    })
}

/// Configured sources. Empty on a fresh install — and empty is what makes
/// "no outbound request until you name a source" true rather than promised.
#[tauri::command]
pub async fn pack_source_list(state: State<'_, AppState>) -> Result<Vec<PackSourceDto>, String> {
    let service = state.service()?;
    service.with_connection(|conn| {
        // Nothing to read, and nothing to create on a read path, until a
        // source has actually been added.
        let Some(store) =
            slipscan_packs::transport::SourceStore::open_readonly(conn).map_err(err)?
        else {
            return Ok(Vec::new());
        };
        Ok(store
            .list()
            .map_err(err)?
            .into_iter()
            .map(to_source_dto)
            .collect())
    })
}

/// Read a source's catalogue and preflight every pack it offers against the
/// book. **Installs nothing.** This is where a publisher's fingerprint is put
/// in front of the user, before any decision is possible.
#[tauri::command]
pub async fn pack_source_fetch(
    state: State<'_, AppState>,
    query: PackSourceFetchRequest,
) -> Result<Vec<PackOfferDto>, String> {
    use slipscan_packs::transport::{self, SourceStore};

    // Reading a folder, a git remote or an HTTPS base is synchronous and can
    // be slow: hop off Tauri's async workers rather than blocking one, the
    // same way the explicit FX fetch does.
    tokio::task::block_in_place(|| {
        let ctx = pack_transport_context(&state)?;
        let service = state.service()?;
        book_by_id(&service, &query.book_id)?;

        let row = service.with_connection(|conn| {
            SourceStore::open_readonly(conn)
                .map_err(err)?
                .ok_or_else(|| format!("no pack source named {:?}", query.source))?
                .require(&query.source)
                .map_err(err)
        })?;

        let store = transport::open(&row.source, &ctx).map_err(err)?;
        let entries = transport::discover(store.as_ref()).map_err(err)?;

        let mut offers = Vec::with_capacity(entries.len());
        for entry in &entries {
            let (verified, error) = match transport::fetch(store.as_ref(), entry) {
                Ok(bundle) => match service
                    .with_connection(|conn| transport::plan_bundle(conn, &query.book_id, &bundle))
                {
                    Ok(plan) => (Some(PackVerificationDto::from(plan)), None),
                    Err(e) => (None, Some(e.to_string())),
                },
                Err(e) => (None, Some(e.to_string())),
            };
            offers.push(PackOfferDto {
                pack_id: entry.id.clone(),
                version: entry.version.clone(),
                name: entry.name.clone(),
                document: entry.document.clone(),
                verified,
                error,
            });
        }
        service.with_connection(|conn| {
            SourceStore::open(conn)
                .map_err(err)?
                .touch(&row.name)
                .map_err(err)
        })?;
        Ok(offers)
    })
}

/// Fetch one pack from a source and install it.
///
/// The signature is checked on the bytes before the database is touched, and
/// the catalogue's claims are cross-checked against the signed payload, so a
/// source cannot list one pack and deliver another. An unknown signer is
/// refused unless `accept_signer` carries the fingerprint the user was shown
/// and checked — and a pack id whose publisher key has changed is refused
/// regardless of what is passed, because the pin is not overridable.
#[tauri::command]
pub async fn pack_source_install(
    state: State<'_, AppState>,
    query: PackSourceInstallRequest,
) -> Result<PackInstallDto, String> {
    use slipscan_packs::transport::{self, SignerDecision, SourceStore};
    use slipscan_packs::InstallOutcome;

    tokio::task::block_in_place(|| {
        let ctx = pack_transport_context(&state)?;
        let service = state.service()?;
        book_by_id(&service, &query.book_id)?;
        // Installing a pack is also where this process picks up the
        // classifier (idempotent — startup already did it).
        slipscan_packs::engine::register_classifier();

        let row = service.with_connection(|conn| {
            SourceStore::open_readonly(conn)
                .map_err(err)?
                .ok_or_else(|| format!("no pack source named {:?}", query.source))?
                .require(&query.source)
                .map_err(err)
        })?;

        let store = transport::open(&row.source, &ctx).map_err(err)?;
        let entries = transport::discover(store.as_ref()).map_err(err)?;
        let entry = entries
            .iter()
            .find(|e| match query.document.as_deref() {
                Some(doc) => e.document == doc,
                None => e.id == query.pack_id,
            })
            .ok_or_else(|| format!("{} does not offer {:?}", row.name, query.pack_id))?;

        let bundle = transport::fetch(store.as_ref(), entry).map_err(err)?;
        let decision = match query.accept_signer.as_deref() {
            Some(fp) => SignerDecision::Accept(fp),
            None => SignerDecision::RequireKnown,
        };

        let report = service.with_connection(|conn| {
            transport::install_bundle(conn, &query.book_id, &bundle, decision).map_err(err)
        })?;
        let (outcome, upgraded_from) = match report.outcome {
            InstallOutcome::Installed => ("installed", None),
            InstallOutcome::Upgraded { from } => ("upgraded", Some(from)),
        };
        Ok(PackInstallDto {
            pack_id: report.pack.pack_id,
            name: report.pack.name,
            version: report.pack.version,
            region: report.pack.region,
            outcome: outcome.to_string(),
            upgraded_from,
            categories_created: report.categories_created,
            categories_reused: report.categories_reused,
            rules_installed: report.rules_installed,
        })
    })
}

// ---------------------------------------------------------------------------
// benchmark packs — the READ side of anonymous peer comparison, and the only
// thing SlipScan does with benchmark packs at all.
//
// Reading is perfectly private (docs/BENCHMARKS.md): a benchmark pack is a
// public file of cohort aggregates, the comparison is arithmetic performed
// here, and nothing is transmitted. The *contribution* half — and with it the
// local differential privacy the design calls for — is NOT IMPLEMENTED. There
// is no contribution code, no noise generation and no transport anywhere in
// this repo, so this command has nothing to send and nowhere to send it. No
// wording on this surface may imply otherwise.
//
// Semantics mirror `slipscan_server::ops::pack_benchmark` exactly (the desktop
// does not depend on slipscan-server; see this crate's Cargo.toml for why):
// your side is core's own `report_spending` for the month, child categories
// roll into their parent's key with ids de-duplicated, no FX conversion is
// ever applied, and a key nothing maps to is reported rather than dropped.
// ---------------------------------------------------------------------------

/// The cohort a benchmark set describes. Deliberately coarse — region, a
/// household-size bucket and an opaque income band — and about *the pack*,
/// never about this user.
#[derive(serde::Serialize)]
pub struct BenchmarkCohortDto {
    /// ISO 3166-1 alpha-2, e.g. `ZA`.
    pub region: String,
    pub household_size: u32,
    /// Short community-defined band label, e.g. `C`.
    pub income_band: String,
}

/// One category placed against the cohort's quartiles. Amounts are integer
/// minor units in the set's currency — never floats, never converted.
#[derive(serde::Serialize)]
pub struct BenchmarkComparisonDto {
    pub category_key: String,
    pub currency: String,
    /// Your total for the key this period, including descendant categories.
    pub yours_minor: i64,
    pub median_minor: i64,
    pub p25_minor: i64,
    pub p75_minor: i64,
    /// `yours - median`; positive means you spend more than the cohort's
    /// median.
    pub delta_minor: i64,
    /// `yours / median`, `null` when the cohort median is zero (dividing by
    /// it would invent a number).
    pub ratio_to_median: Option<f64>,
    /// `below_p25`, `typical` (inside the interquartile range), or
    /// `above_p75`.
    pub position: String,
    /// Contributions behind the stat — always >= the pack's k-floor.
    pub sample_size: u64,
}

/// One installed benchmark pack compared against this book's own spend for
/// one calendar month.
#[derive(serde::Serialize)]
pub struct BenchmarkReportDto {
    pub pack_id: String,
    /// The installed pack's display name, so a screen showing this need not
    /// re-query `pack_list` to name what it is showing.
    pub pack_name: String,
    /// The calendar month `YYYY-MM` that was compared.
    pub period: String,
    /// The pack's own currency. **Never converted** — see `skipped`.
    pub currency: String,
    pub cohort: BenchmarkCohortDto,
    /// The k-anonymity floor the pack's aggregator enforced.
    pub k_floor: u64,
    /// Why nothing was compared, when nothing was — a currency mismatch, or
    /// no spend at all in the pack's currency. `null` on a real comparison,
    /// which may still be empty if the pack has no stat for the period.
    /// Rendering this as a row of zeroes would be a lie, so it is a reason.
    pub skipped: Option<String>,
    pub comparisons: Vec<BenchmarkComparisonDto>,
    /// Taxonomy keys the pack has a stat for that no installed pack maps to
    /// a local category. Reported rather than silently dropped, so "why is
    /// groceries missing?" has an answer.
    pub unmapped_keys: Vec<String>,
}

#[derive(serde::Deserialize)]
pub struct BenchmarkQuery {
    pub book_id: String,
    /// Calendar month, `YYYY-MM`.
    pub period: String,
}

/// Compare this book's spend for `period` against every installed benchmark
/// pack — computed here, transmitting nothing.
///
/// How your side of the comparison is computed, exactly as the CLI and HTTP
/// surfaces compute it:
///
/// * spend is core's own [`CoreService::report_spending`] for the month, so a
///   figure here is the figure the spending report shows;
/// * a pack's taxonomy key resolves to local category ids through
///   `pack_category_map` — the map installs already write — and the total
///   **includes descendant categories**, so a `transport` stat counts
///   `transport.fuel` too. Ids are de-duplicated first, so two packs mapping
///   the same key onto the same category cannot double-count;
/// * only spend in the pack's own currency is counted and **no FX conversion
///   is applied**: a pack in a currency this book does not use comes back
///   with `skipped` set, not a fabricated zero.
#[tauri::command]
pub async fn pack_benchmark(
    state: State<'_, AppState>,
    query: BenchmarkQuery,
) -> Result<Vec<BenchmarkReportDto>, String> {
    use slipscan_packs::{benchmark, Installer, QuartilePosition};

    if !is_calendar_month(&query.period) {
        return Err(format!(
            "period {:?} must be a calendar month, YYYY-MM",
            query.period
        ));
    }
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    // `-01`..`-31` spans any month: posted dates are ISO strings compared
    // lexicographically, so a 30-day month simply has no `-31` row.
    let spending = service
        .report_spending(
            &query.book_id,
            &format!("{}-01", query.period),
            &format!("{}-31", query.period),
        )
        .map_err(err)?;
    let subtrees = subtree_ids(&service.category_tree(&query.book_id).map_err(err)?);

    // Spend per (currency, category) — never summed across currencies.
    let mut by_currency: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for row in &spending {
        let Some(category_id) = &row.category_id else {
            continue; // uncategorised spend belongs to no taxonomy key
        };
        *by_currency
            .entry(row.currency.clone())
            .or_default()
            .entry(category_id.clone())
            .or_insert(0) += row.total_minor;
    }

    service.with_connection(|conn| {
        // Read path: no pack has ever been installed here, so there is
        // nothing to compare — and nothing to create either.
        let Some(installer) = Installer::open_readonly(conn).map_err(err)? else {
            return Ok(Vec::new());
        };
        let sets = installer.benchmark_sets(&query.book_id).map_err(err)?;
        if sets.is_empty() {
            return Ok(Vec::new());
        }

        // Taxonomy key -> local category ids, pooled across every installed
        // pack: benchmark packs declare no categories of their own, so the
        // keys they cite are resolved through the taxonomy packs.
        let mut names: HashMap<String, String> = HashMap::new();
        let mut key_to_ids: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for pack in installer.list(&query.book_id).map_err(err)? {
            for (key, category_id) in installer
                .category_map(&query.book_id, &pack.pack_id)
                .map_err(err)?
            {
                key_to_ids.entry(key).or_default().insert(category_id);
            }
            names.insert(pack.pack_id, pack.name);
        }

        let mut reports = Vec::new();
        for (pack_id, set) in sets {
            let pack_name = names
                .get(&pack_id)
                .cloned()
                .unwrap_or_else(|| pack_id.clone());
            let mut report = BenchmarkReportDto {
                pack_id,
                pack_name,
                period: query.period.clone(),
                currency: set.currency.clone(),
                cohort: BenchmarkCohortDto {
                    region: set.cohort.region.clone(),
                    household_size: set.cohort.household_size,
                    income_band: set.cohort.income_band.clone(),
                },
                k_floor: set.k_floor,
                skipped: None,
                comparisons: Vec::new(),
                unmapped_keys: Vec::new(),
            };
            let Some(spend_by_category) = by_currency.get(&set.currency) else {
                report.skipped = Some(if set.currency != book.currency {
                    format!(
                        "pack is in {} and this book is in {} — no conversion is applied",
                        set.currency, book.currency
                    )
                } else {
                    format!("no {} spend recorded in {}", set.currency, query.period)
                });
                reports.push(report);
                continue;
            };

            let mut spend_minor: BTreeMap<String, i64> = BTreeMap::new();
            for stat in set.stats.iter().filter(|stat| stat.period == query.period) {
                let Some(ids) = key_to_ids.get(&stat.category_key) else {
                    report.unmapped_keys.push(stat.category_key.clone());
                    continue;
                };
                // De-duplicate first: two packs may map the same key onto
                // the same category, or a category onto one of its own
                // ancestors.
                let covered: BTreeSet<&str> = ids
                    .iter()
                    .flat_map(|id| subtrees.get(id).map(Vec::as_slice).unwrap_or_default())
                    .map(String::as_str)
                    .collect();
                let total = covered
                    .iter()
                    .filter_map(|id| spend_by_category.get(*id))
                    .fold(0i64, |acc, amount| acc.saturating_add(*amount));
                spend_minor.insert(stat.category_key.clone(), total);
            }
            report.unmapped_keys.sort();
            report.unmapped_keys.dedup();
            report.comparisons = benchmark::compare(&set, &query.period, &spend_minor)
                .into_iter()
                .map(|c| BenchmarkComparisonDto {
                    category_key: c.category_key,
                    currency: c.currency,
                    yours_minor: c.yours_minor,
                    median_minor: c.median_minor,
                    p25_minor: c.p25_minor,
                    p75_minor: c.p75_minor,
                    delta_minor: c.delta_minor,
                    ratio_to_median: c.ratio_to_median,
                    position: match c.position {
                        QuartilePosition::BelowP25 => "below_p25",
                        QuartilePosition::Typical => "typical",
                        QuartilePosition::AboveP75 => "above_p75",
                    }
                    .to_string(),
                    sample_size: c.sample_size,
                })
                .collect();
            reports.push(report);
        }
        Ok(reports)
    })
}

/// `YYYY-MM`, with a month in 01..=12. An impossible month like `2026-13`
/// would compare against nothing and report "no stats" forever, so it is a
/// validation error rather than an empty result.
fn is_calendar_month(period: &str) -> bool {
    let bytes = period.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..].iter().all(u8::is_ascii_digit)
        && matches!(period[5..].parse::<u32>(), Ok(1..=12))
}

/// Every category id mapped to itself plus all of its descendants, so a
/// benchmark stat for a parent key counts spend booked to its children.
fn subtree_ids(tree: &[CategoryNode]) -> BTreeMap<String, Vec<String>> {
    fn walk(node: &CategoryNode, out: &mut BTreeMap<String, Vec<String>>) -> Vec<String> {
        let mut ids = vec![node.category.id.clone()];
        for child in &node.children {
            ids.extend(walk(child, out));
        }
        out.insert(node.category.id.clone(), ids.clone());
        ids
    }
    let mut out = BTreeMap::new();
    for node in tree {
        walk(node, &mut out);
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;
    use slipscan_core::domain::CategoryKind;

    fn node(id: &str, children: Vec<CategoryNode>) -> CategoryNode {
        CategoryNode {
            category: core::Category {
                id: id.to_string(),
                book_id: "b".to_string(),
                parent_id: None,
                name: id.to_string(),
                kind: CategoryKind::Expense,
                icon: None,
                color: None,
                is_system: false,
                created_at: "2026-07-01T00:00:00Z".to_string(),
                updated_at: "2026-07-01T00:00:00Z".to_string(),
            },
            children,
        }
    }

    /// An impossible month must be a validation error, not an empty result:
    /// "2026-13" compared against nothing would report "no stats" forever.
    #[test]
    fn calendar_month_accepts_only_yyyy_mm_with_a_real_month() {
        for good in ["2026-01", "2026-07", "2026-12", "0001-05"] {
            assert!(is_calendar_month(good), "{good} should be accepted");
        }
        for bad in [
            "2026-13",
            "2026-00",
            "2026-7",
            "2026-07-01",
            "july",
            "202607",
            "2026-ab",
            "",
        ] {
            assert!(!is_calendar_month(bad), "{bad:?} should be rejected");
        }
    }

    /// A benchmark stat for a parent key must count spend booked to the
    /// parent's children — otherwise `transport` reads as zero for anyone who
    /// categorises to `transport.fuel`.
    #[test]
    fn subtree_ids_rolls_children_into_their_parent() {
        let tree = vec![
            node(
                "transport",
                vec![
                    node("fuel", vec![node("tolls", vec![])]),
                    node("taxi", vec![]),
                ],
            ),
            node("groceries", vec![]),
        ];
        let subtrees = subtree_ids(&tree);

        let mut transport = subtrees["transport"].clone();
        transport.sort();
        assert_eq!(transport, ["fuel", "taxi", "tolls", "transport"]);

        // Every node is its own subtree root, and a leaf covers only itself.
        assert_eq!(subtrees["groceries"], vec!["groceries".to_string()]);
        assert_eq!(subtrees["tolls"], vec!["tolls".to_string()]);
        let mut fuel = subtrees["fuel"].clone();
        fuel.sort();
        assert_eq!(fuel, vec!["fuel".to_string(), "tolls".to_string()]);
    }

    /// Two packs mapping the same key onto overlapping categories must not
    /// double-count — the op de-duplicates ids before summing, and this pins
    /// the property the de-duplication exists for.
    #[test]
    fn overlapping_subtrees_de_duplicate_before_summing() {
        let tree = vec![node("transport", vec![node("fuel", vec![])])];
        let subtrees = subtree_ids(&tree);
        // One pack maps "transport" -> transport, another -> fuel (a
        // descendant of the first). Pooled, the covered set must be 2 ids.
        let ids: BTreeSet<String> = ["transport".to_string(), "fuel".to_string()].into();
        let covered: BTreeSet<&str> = ids
            .iter()
            .flat_map(|id| subtrees.get(id).map(Vec::as_slice).unwrap_or_default())
            .map(String::as_str)
            .collect();
        assert_eq!(covered.len(), 2, "fuel must not be counted twice");
    }
}
