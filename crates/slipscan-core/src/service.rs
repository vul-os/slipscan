//! Service layer: the operations exposed over IPC (Tauri) and HTTP (axum).
//!
//! Same names as the contract in docs/ARCHITECTURE.md: `book_list`,
//! `transaction_list`, `transaction_categorize`, `document_import`,
//! `budget_upsert`, `journal_post`, `recon_suggest`, `recon_confirm`,
//! `report_spending`, `settings_get`/`settings_set`, …
//!
//! Every mutation is wrapped in a SQLite transaction and emits an audit_log
//! entry in the same transaction.

use rusqlite::Connection;

use crate::db::Db;
use crate::domain::*;
use crate::error::{CoreError, CoreResult};
use crate::repo;
use crate::secrets::SecretString;
use crate::secrets::{KeyringSecretStore, SecretStore};
use crate::slip::SlipPayload;
use crate::util::{
    days_between, merchant_similarity, new_id, normalize_currency_code, normalize_merchant,
    now_iso, parse_date, transaction_dedupe_hash,
};
use crate::vat::split_inclusive;

// ---------------------------------------------------------------------------
// Well-known chart-of-accounts codes (stable across both seed sets) used as
// fallbacks by automatic journal generation when no coa_map entry exists.
// ---------------------------------------------------------------------------

/// Default bank/cash asset account.
const COA_CODE_BANK: &str = "1000";
/// VAT input control (asset; business seed only).
const COA_CODE_VAT_INPUT: &str = "1400";
/// VAT output control (liability; business seed only).
const COA_CODE_VAT_OUTPUT: &str = "2100";

const fn fallback_expense_code(kind: BookKind) -> &'static str {
    match kind {
        BookKind::Personal => "6000", // Living Expenses
        BookKind::Business => "6900", // General Expenses
    }
}

const fn fallback_income_code(kind: BookKind) -> &'static str {
    match kind {
        BookKind::Personal => "4100", // Other Income
        BookKind::Business => "4200", // Other Income
    }
}

type CoaSeed = (&'static str, &'static str, CoaKind);

/// Minimal personal chart of accounts.
const PERSONAL_COA: &[CoaSeed] = &[
    ("1000", "Bank", CoaKind::Asset),
    ("1100", "Cash", CoaKind::Asset),
    ("1500", "Other Assets", CoaKind::Asset),
    ("2000", "Credit Card", CoaKind::Liability),
    ("2500", "Other Liabilities", CoaKind::Liability),
    ("3000", "Opening Balances", CoaKind::Equity),
    ("4000", "Salary & Wages", CoaKind::Income),
    ("4100", "Other Income", CoaKind::Income),
    ("6000", "Living Expenses", CoaKind::Expense),
    ("6100", "Bank Fees", CoaKind::Expense),
];

/// South-African small-business chart of accounts, incl. VAT control accounts.
const BUSINESS_COA: &[CoaSeed] = &[
    ("1000", "Bank", CoaKind::Asset),
    ("1050", "Petty Cash", CoaKind::Asset),
    ("1100", "Accounts Receivable", CoaKind::Asset),
    ("1200", "Inventory", CoaKind::Asset),
    ("1400", "VAT Input Control", CoaKind::Asset),
    ("1500", "Office Equipment", CoaKind::Asset),
    ("1510", "Computer Equipment", CoaKind::Asset),
    ("1600", "Accumulated Depreciation", CoaKind::Asset),
    ("2000", "Accounts Payable", CoaKind::Liability),
    ("2100", "VAT Output Control", CoaKind::Liability),
    ("2150", "VAT Control (SARS settlement)", CoaKind::Liability),
    ("2200", "PAYE & UIF Payable", CoaKind::Liability),
    ("2300", "Loans Payable", CoaKind::Liability),
    ("3000", "Owner's Capital", CoaKind::Equity),
    ("3100", "Owner's Drawings", CoaKind::Equity),
    ("3200", "Retained Earnings", CoaKind::Equity),
    ("4000", "Sales", CoaKind::Income),
    ("4100", "Interest Received", CoaKind::Income),
    ("4200", "Other Income", CoaKind::Income),
    ("5000", "Cost of Sales", CoaKind::Expense),
    ("6000", "Accounting Fees", CoaKind::Expense),
    ("6050", "Advertising & Marketing", CoaKind::Expense),
    ("6100", "Bank Fees", CoaKind::Expense),
    ("6200", "Computer & Internet", CoaKind::Expense),
    ("6250", "Depreciation", CoaKind::Expense),
    ("6300", "Entertainment", CoaKind::Expense),
    ("6350", "Insurance", CoaKind::Expense),
    ("6400", "Motor Vehicle Expenses", CoaKind::Expense),
    ("6450", "Office Supplies & Stationery", CoaKind::Expense),
    ("6500", "Rent", CoaKind::Expense),
    ("6550", "Repairs & Maintenance", CoaKind::Expense),
    ("6600", "Salaries & Wages", CoaKind::Expense),
    ("6650", "Subscriptions", CoaKind::Expense),
    ("6700", "Telephone", CoaKind::Expense),
    ("6750", "Travel", CoaKind::Expense),
    ("6800", "Utilities", CoaKind::Expense),
    ("6900", "General Expenses", CoaKind::Expense),
];

/// Upper bound for a single journal-line or transaction amount (10^15 minor
/// units — ten trillion currency units). This is a **per-amount** cap, not a
/// per-account aggregate invariant: it keeps `abs()` and the i128 balance
/// check safe and gives SQLite `SUM()` ~9 000 bound-level lines of headroom
/// per account before its integer aggregation could overflow. Realistic books
/// stay many orders of magnitude below both limits.
const MAX_LINE_AMOUNT_MINOR: i64 = 1_000_000_000_000_000;

/// ZA VAT rates: (code, name, rate in basis points).
const VAT_RATE_SEEDS: &[(&str, &str, i64)] = &[
    ("STD", "Standard rate (15%)", 1500),
    ("ZER", "Zero-rated (0%)", 0),
    ("EXE", "Exempt", 0),
];

// ---------------------------------------------------------------------------
// Reconciliation matcher tuning.
// ---------------------------------------------------------------------------

/// Candidates dated further than this from a transaction are never suggested.
const RECON_DATE_WINDOW_DAYS: i64 = 7;
/// Amount mismatch tolerance as a fraction of the document total.
const RECON_AMOUNT_TOLERANCE: f64 = 0.05;
/// Minimum blended confidence for a suggestion.
const RECON_MIN_CONFIDENCE: f64 = 0.55;
/// Confidence at or above which a match is recorded as `auto` (still needs
/// manual confirmation to lock).
const RECON_AUTO_CONFIDENCE: f64 = 0.9;
/// Blend weights: amount is king, then date, then merchant similarity.
const RECON_WEIGHT_AMOUNT: f64 = 0.55;
const RECON_WEIGHT_DATE: f64 = 0.25;
const RECON_WEIGHT_MERCHANT: f64 = 0.20;

/// One scored reconciliation candidate for a statement line.
struct ReconCandidate {
    document_id: Option<String>,
    journal_id: Option<String>,
    confidence: f64,
    amount_delta_minor: i64,
    date_delta_days: i64,
    merchant_score: f64,
}

/// Facade over one SQLite database plus a secret store.
pub struct CoreService {
    db: Db,
    secrets: Box<dyn SecretStore>,
}

impl std::fmt::Debug for CoreService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreService").finish_non_exhaustive()
    }
}

impl CoreService {
    pub fn new(db: Db, secrets: Box<dyn SecretStore>) -> Self {
        Self { db, secrets }
    }

    /// Open a database file with the real OS-keychain secret store.
    pub fn open(path: impl AsRef<std::path::Path>) -> CoreResult<Self> {
        Ok(Self::new(
            Db::open(path)?,
            Box::new(KeyringSecretStore::default()),
        ))
    }

    fn conn(&self) -> &Connection {
        self.db.conn()
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_audit(
        &self,
        conn: &Connection,
        book_id: Option<&str>,
        entity_type: &str,
        entity_id: Option<&str>,
        action: &str,
        before_json: Option<String>,
        after_json: Option<String>,
    ) -> CoreResult<()> {
        repo::audit::insert(
            conn,
            &AuditEntry {
                id: new_id(),
                book_id: book_id.map(str::to_string),
                entity_type: entity_type.to_string(),
                entity_id: entity_id.map(str::to_string),
                action: action.to_string(),
                before_json,
                after_json,
                created_at: now_iso(),
            },
        )
    }

    // -----------------------------------------------------------------------
    // Books
    // -----------------------------------------------------------------------

    pub fn book_create(&self, new: NewBook) -> CoreResult<Book> {
        if new.name.trim().is_empty() {
            return Err(CoreError::Validation("book name must not be empty".into()));
        }
        // Normalize the base currency exactly like journal-line currencies —
        // an un-normalized book currency ("zar") would silently empty every
        // base-currency report (income statement, balance sheet, VAT201).
        let currency = match new.currency {
            Some(raw) => normalize_currency_code(&raw)?,
            None => "ZAR".to_string(),
        };
        let now = now_iso();
        let book = Book {
            id: new_id(),
            kind: new.kind,
            name: new.name.trim().to_string(),
            currency,
            country: new.country,
            locale: "en".to_string(),
            timezone: "UTC".to_string(),
            financial_lock_date: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::book::insert(&tx, &book)?;
        self.emit_audit(
            &tx,
            Some(&book.id),
            "book",
            Some(&book.id),
            "create",
            None,
            Some(serde_json::to_string(&book)?),
        )?;
        tx.commit()?;
        Ok(book)
    }

    pub fn book_list(&self) -> CoreResult<Vec<Book>> {
        repo::book::list(self.conn())
    }

    pub fn book_get(&self, id: &str) -> CoreResult<Book> {
        repo::book::get(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "book",
            id: id.to_string(),
        })
    }

    // -----------------------------------------------------------------------
    // Accounts
    // -----------------------------------------------------------------------

    pub fn account_create(&self, new: NewAccount) -> CoreResult<Account> {
        self.book_get(&new.book_id)?;
        let now = now_iso();
        let account = Account {
            id: new_id(),
            book_id: new.book_id,
            name: new.name,
            kind: new.kind,
            currency: new.currency,
            institution: new.institution,
            account_number_masked: new.account_number_masked,
            opening_balance_minor: new.opening_balance_minor.unwrap_or(0),
            is_archived: false,
            created_at: now.clone(),
            updated_at: now,
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::account::insert(&tx, &account)?;
        self.emit_audit(
            &tx,
            Some(&account.book_id),
            "account",
            Some(&account.id),
            "create",
            None,
            Some(serde_json::to_string(&account)?),
        )?;
        tx.commit()?;
        Ok(account)
    }

    pub fn account_get(&self, id: &str) -> CoreResult<Account> {
        repo::account::get(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "account",
            id: id.to_string(),
        })
    }

    pub fn account_list(&self, book_id: &str) -> CoreResult<Vec<Account>> {
        repo::account::list(self.conn(), book_id)
    }

    pub fn account_update(&self, id: &str, patch: AccountPatch) -> CoreResult<Account> {
        let before = self.account_get(id)?;
        let mut after = before.clone();
        if let Some(name) = patch.name {
            after.name = name;
        }
        if let Some(institution) = patch.institution {
            after.institution = Some(institution);
        }
        if let Some(masked) = patch.account_number_masked {
            after.account_number_masked = Some(masked);
        }
        if let Some(is_archived) = patch.is_archived {
            after.is_archived = is_archived;
        }
        after.updated_at = now_iso();

        let tx = self.conn().unchecked_transaction()?;
        repo::account::update(&tx, &after)?;
        self.emit_audit(
            &tx,
            Some(&after.book_id),
            "account",
            Some(id),
            "update",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Hard delete. Fails (FK RESTRICT) while transactions still reference it.
    pub fn account_delete(&self, id: &str) -> CoreResult<()> {
        let before = self.account_get(id)?;
        let tx = self.conn().unchecked_transaction()?;
        repo::account::delete(&tx, id)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "account",
            Some(id),
            "delete",
            Some(serde_json::to_string(&before)?),
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Transactions
    // -----------------------------------------------------------------------

    /// Create a transaction with dedupe by (account, provider_txn_id | hash).
    /// When no category is given, a stored merchant mapping is applied.
    pub fn transaction_create(&self, new: NewTransaction) -> CoreResult<Transaction> {
        let account = self.account_get(&new.account_id)?;
        if account.book_id != new.book_id {
            return Err(CoreError::Validation(
                "account does not belong to this book".into(),
            ));
        }
        let currency = normalize_currency_code(&new.currency)?;
        // Bound transaction amounts like journal lines: keeps `abs()` (journal
        // generation, recon scoring) panic-free and SQLite `SUM()` in integer
        // range for realistic row counts. `checked_abs` rejects i64::MIN.
        match new.amount_minor.checked_abs() {
            Some(a) if a <= MAX_LINE_AMOUNT_MINOR => {}
            _ => {
                return Err(CoreError::Validation(format!(
                    "transaction amount {} out of range: |amount| must be at most \
                     {MAX_LINE_AMOUNT_MINOR} minor units",
                    new.amount_minor
                )))
            }
        }

        let merchant_normalized = new
            .merchant
            .as_deref()
            .map(normalize_merchant)
            .filter(|m| !m.is_empty());
        let dedupe_hash = transaction_dedupe_hash(
            &new.account_id,
            &new.posted_date,
            new.amount_minor,
            &currency,
            new.provider_txn_id.as_deref(),
            merchant_normalized.as_deref(),
            new.description.as_deref(),
            new.dedupe_occurrence,
        );

        let tx = self.conn().unchecked_transaction()?;
        if let Some(pid) = new.provider_txn_id.as_deref() {
            if let Some(existing_id) =
                repo::transaction::find_by_provider_txn_id(&tx, &new.account_id, pid)?
            {
                return Err(CoreError::DuplicateTransaction { existing_id });
            }
        }
        if let Some(existing_id) =
            repo::transaction::find_by_dedupe_hash(&tx, &new.account_id, &dedupe_hash)?
        {
            return Err(CoreError::DuplicateTransaction { existing_id });
        }

        let mut category_id = new.category_id;
        if category_id.is_none() {
            if let Some(m) = merchant_normalized.as_deref() {
                if let Some(mapping) = repo::category::get_mapping(&tx, &new.book_id, m)? {
                    category_id = Some(mapping.category_id);
                }
            }
        }

        let now = now_iso();
        let txn = Transaction {
            id: new_id(),
            book_id: new.book_id,
            account_id: new.account_id,
            category_id,
            document_id: new.document_id,
            source: new.source,
            provider_txn_id: new.provider_txn_id,
            dedupe_hash,
            posted_date: new.posted_date,
            amount_minor: new.amount_minor,
            currency,
            merchant: new.merchant,
            merchant_normalized,
            description: new.description,
            notes: new.notes,
            status: TransactionStatus::Pending,
            created_at: now.clone(),
            updated_at: now,
        };
        repo::transaction::insert(&tx, &txn)?;
        self.emit_audit(
            &tx,
            Some(&txn.book_id),
            "transaction",
            Some(&txn.id),
            "create",
            None,
            Some(serde_json::to_string(&txn)?),
        )?;
        tx.commit()?;
        Ok(txn)
    }

    pub fn transaction_get(&self, id: &str) -> CoreResult<Transaction> {
        repo::transaction::get(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "transaction",
            id: id.to_string(),
        })
    }

    pub fn transaction_list(
        &self,
        book_id: &str,
        filter: &TransactionFilter,
    ) -> CoreResult<Vec<Transaction>> {
        repo::transaction::list(self.conn(), book_id, filter)
    }

    /// Set a category on a transaction, remembering the correction and the
    /// merchant→category mapping so future imports self-classify (the
    /// learning loop stays local).
    pub fn transaction_categorize(
        &self,
        transaction_id: &str,
        category_id: &str,
    ) -> CoreResult<Transaction> {
        let before = self.transaction_get(transaction_id)?;
        let category =
            repo::category::get(self.conn(), category_id)?.ok_or_else(|| CoreError::NotFound {
                entity: "category",
                id: category_id.to_string(),
            })?;
        if category.book_id != before.book_id {
            return Err(CoreError::Validation(
                "category does not belong to this book".into(),
            ));
        }

        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        repo::transaction::set_category(&tx, transaction_id, Some(category_id), &now)?;
        repo::category::insert_correction(
            &tx,
            &ClassificationCorrection {
                id: new_id(),
                book_id: before.book_id.clone(),
                transaction_id: transaction_id.to_string(),
                merchant_normalized: before.merchant_normalized.clone(),
                old_category_id: before.category_id.clone(),
                new_category_id: Some(category_id.to_string()),
                created_at: now.clone(),
            },
        )?;
        if let Some(m) = before.merchant_normalized.as_deref() {
            repo::category::upsert_mapping(
                &tx,
                &before.book_id,
                m,
                category_id,
                MappingSource::User,
                1.0,
            )?;
        }
        let mut after = before.clone();
        after.category_id = Some(category_id.to_string());
        after.updated_at = now;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "transaction",
            Some(transaction_id),
            "categorize",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Clear a transaction's category (back to Uncategorised). Recorded as a
    /// classification correction with `new_category_id = None`; the stored
    /// merchant mapping is left untouched (clearing one transaction is not
    /// evidence the mapping itself is wrong).
    pub fn transaction_uncategorize(&self, transaction_id: &str) -> CoreResult<Transaction> {
        let before = self.transaction_get(transaction_id)?;
        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        repo::transaction::set_category(&tx, transaction_id, None, &now)?;
        repo::category::insert_correction(
            &tx,
            &ClassificationCorrection {
                id: new_id(),
                book_id: before.book_id.clone(),
                transaction_id: transaction_id.to_string(),
                merchant_normalized: before.merchant_normalized.clone(),
                old_category_id: before.category_id.clone(),
                new_category_id: None,
                created_at: now.clone(),
            },
        )?;
        let mut after = before.clone();
        after.category_id = None;
        after.updated_at = now;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "transaction",
            Some(transaction_id),
            "uncategorize",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    // -----------------------------------------------------------------------
    // Categories
    // -----------------------------------------------------------------------

    pub fn category_create(&self, new: NewCategory) -> CoreResult<Category> {
        self.book_get(&new.book_id)?;
        if let Some(parent_id) = new.parent_id.as_deref() {
            let parent = repo::category::get(self.conn(), parent_id)?.ok_or_else(|| {
                CoreError::NotFound {
                    entity: "category",
                    id: parent_id.to_string(),
                }
            })?;
            if parent.book_id != new.book_id {
                return Err(CoreError::Validation(
                    "parent category belongs to a different book".into(),
                ));
            }
        }
        let now = now_iso();
        let category = Category {
            id: new_id(),
            book_id: new.book_id,
            parent_id: new.parent_id,
            name: new.name,
            kind: new.kind,
            icon: new.icon,
            color: new.color,
            is_system: false,
            created_at: now.clone(),
            updated_at: now,
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::category::insert(&tx, &category)?;
        self.emit_audit(
            &tx,
            Some(&category.book_id),
            "category",
            Some(&category.id),
            "create",
            None,
            Some(serde_json::to_string(&category)?),
        )?;
        tx.commit()?;
        Ok(category)
    }

    /// Full category hierarchy for a book, roots first.
    pub fn category_tree(&self, book_id: &str) -> CoreResult<Vec<CategoryNode>> {
        let flat = repo::category::list(self.conn(), book_id)?;
        Ok(build_tree(flat))
    }

    // -----------------------------------------------------------------------
    // Budgets
    // -----------------------------------------------------------------------

    pub fn budget_upsert(&self, upsert: BudgetUpsert) -> CoreResult<Budget> {
        if upsert.month.len() != 7 || upsert.month.as_bytes()[4] != b'-' {
            return Err(CoreError::Validation(format!(
                "month must be YYYY-MM, got {:?}",
                upsert.month
            )));
        }
        let category = repo::category::get(self.conn(), &upsert.category_id)?.ok_or_else(|| {
            CoreError::NotFound {
                entity: "category",
                id: upsert.category_id.clone(),
            }
        })?;
        if category.book_id != upsert.book_id {
            return Err(CoreError::Validation(
                "category does not belong to this book".into(),
            ));
        }
        // Budget spend is matched against transactions by currency; both
        // sides must be normalized or the comparison silently never matches.
        let currency = normalize_currency_code(&upsert.currency)?;
        let tx = self.conn().unchecked_transaction()?;
        let budget = repo::budget::upsert(
            &tx,
            &upsert.book_id,
            &upsert.category_id,
            &upsert.month,
            upsert.amount_minor,
            &currency,
            upsert.rollover,
        )?;
        self.emit_audit(
            &tx,
            Some(&upsert.book_id),
            "budget",
            Some(&budget.id),
            "upsert",
            None,
            Some(serde_json::to_string(&budget)?),
        )?;
        tx.commit()?;
        Ok(budget)
    }

    /// Budget vs. actual for every budgeted category in `month` (`YYYY-MM`).
    pub fn budget_status(&self, book_id: &str, month: &str) -> CoreResult<Vec<BudgetStatus>> {
        repo::budget::status(self.conn(), book_id, month)
    }

    // -----------------------------------------------------------------------
    // Documents
    // -----------------------------------------------------------------------

    pub fn document_import(&self, new: NewDocument) -> CoreResult<Document> {
        self.book_get(&new.book_id)?;
        if let Some(sha) = new.sha256.as_deref() {
            if let Some(existing_id) =
                repo::document::find_by_sha256(self.conn(), &new.book_id, sha)?
            {
                return Err(CoreError::DuplicateDocument { existing_id });
            }
        }
        let now = now_iso();
        let document = Document {
            id: new_id(),
            book_id: new.book_id,
            source: new.source,
            kind: new.kind,
            file_path: new.file_path,
            mime_type: new.mime_type,
            size_bytes: new.size_bytes,
            original_name: new.original_name,
            sha256: new.sha256,
            status: DocumentStatus::Pending,
            error: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::document::insert(&tx, &document)?;
        self.emit_audit(
            &tx,
            Some(&document.book_id),
            "document",
            Some(&document.id),
            "import",
            None,
            Some(serde_json::to_string(&document)?),
        )?;
        tx.commit()?;
        Ok(document)
    }

    pub fn document_get(&self, id: &str) -> CoreResult<Document> {
        repo::document::get(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "document",
            id: id.to_string(),
        })
    }

    pub fn document_list(
        &self,
        book_id: &str,
        status: Option<DocumentStatus>,
    ) -> CoreResult<Vec<Document>> {
        repo::document::list(self.conn(), book_id, status)
    }

    /// Move a document through its status machine:
    /// pending → processing → extracted → reviewed, with failed/retry edges.
    pub fn document_transition(
        &self,
        id: &str,
        to: DocumentStatus,
        error: Option<&str>,
    ) -> CoreResult<Document> {
        let before = self.document_get(id)?;
        if !document_transition_allowed(before.status, to) {
            return Err(CoreError::InvalidStatusTransition {
                from: before.status.to_string(),
                to: to.to_string(),
            });
        }
        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        repo::document::set_status(&tx, id, to, error, &now)?;
        let mut after = before.clone();
        after.status = to;
        after.error = error.map(str::to_string);
        after.updated_at = now;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "document",
            Some(id),
            "status",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Store a slip-v2 extraction result as the current one and mark the
    /// document extracted.
    pub fn document_record_extraction(
        &self,
        document_id: &str,
        provider: Option<&str>,
        model: Option<&str>,
        payload_json: &str,
    ) -> CoreResult<DocumentExtraction> {
        // Must be valid JSON — the payload column is a JSON document.
        let _: serde_json::Value = serde_json::from_str(payload_json)?;
        let document = self.document_get(document_id)?;
        if document.status == DocumentStatus::Reviewed {
            return Err(CoreError::InvalidStatusTransition {
                from: document.status.to_string(),
                to: DocumentStatus::Extracted.to_string(),
            });
        }
        let now = now_iso();
        let extraction = DocumentExtraction {
            id: new_id(),
            document_id: document_id.to_string(),
            book_id: document.book_id.clone(),
            provider: provider.map(str::to_string),
            model: model.map(str::to_string),
            status: DocumentStatus::Extracted,
            payload: Some(payload_json.to_string()),
            error: None,
            is_current: true,
            created_at: now.clone(),
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::document::clear_current_extraction(&tx, document_id)?;
        repo::document::insert_extraction(&tx, &extraction)?;
        repo::document::set_status(&tx, document_id, DocumentStatus::Extracted, None, &now)?;
        self.emit_audit(
            &tx,
            Some(&document.book_id),
            "document_extraction",
            Some(&extraction.id),
            "create",
            None,
            Some(serde_json::to_string(&extraction)?),
        )?;
        tx.commit()?;
        Ok(extraction)
    }

    pub fn document_current_extraction(
        &self,
        document_id: &str,
    ) -> CoreResult<Option<DocumentExtraction>> {
        repo::document::current_extraction(self.conn(), document_id)
    }

    // -----------------------------------------------------------------------
    // Ledger
    // -----------------------------------------------------------------------

    /// Post a balanced journal. Unbalanced journals are rejected atomically.
    ///
    /// Enforced here (with schema CHECKs and immutability triggers beneath):
    /// * at least two lines, each with exactly one positive side
    /// * debits equal credits **per currency** (multi-currency groundwork —
    ///   a journal may mix currencies but each must balance on its own)
    /// * every line's account belongs to the book and is not archived
    /// * lines on a fixed-currency account must be in that currency
    /// * `posted_date` is a valid date strictly after the book's financial
    ///   lock date
    /// * a non-manual source may generate at most one journal
    pub fn journal_post(&self, new: NewJournal) -> CoreResult<PostedJournal> {
        let book = self.book_get(&new.book_id)?;
        let tx = self.conn().unchecked_transaction()?;
        let posted = self.post_journal_in_tx(&tx, &book, new, None)?;
        tx.commit()?;
        Ok(posted)
    }

    /// Reverse a posted journal: post a new journal with every line's sides
    /// swapped (VAT tags preserved so the VAT201 nets out), linked via
    /// `reversal_of`. Posted journals are never edited or deleted — this is
    /// the only correction path. A journal can be reversed at most once.
    pub fn journal_reverse(
        &self,
        journal_id: &str,
        posted_date: Option<&str>,
        narrative: Option<&str>,
    ) -> CoreResult<PostedJournal> {
        let original = self.journal_get(journal_id)?;
        let book = self.book_get(&original.journal.book_id)?;
        if let Some(reversal_id) = repo::ledger::find_reversal(self.conn(), journal_id)? {
            return Err(CoreError::DuplicateJournal {
                source_type: "reversal".into(),
                source_id: reversal_id,
            });
        }
        let lines = original
            .lines
            .iter()
            .map(|line| NewJournalLine {
                coa_id: line.coa_id.clone(),
                debit_minor: line.credit_minor,
                credit_minor: line.debit_minor,
                currency: line.currency.clone(),
                description: line.description.clone(),
                vat_rate_id: line.vat_rate_id.clone(),
                vat_role: line.vat_role,
            })
            .collect();
        let new = NewJournal {
            book_id: book.id.clone(),
            posted_date: posted_date
                .unwrap_or(&original.journal.posted_date)
                .to_string(),
            narrative: Some(narrative.map(str::to_string).unwrap_or_else(|| {
                format!(
                    "Reversal of {}",
                    original.journal.reference.as_deref().unwrap_or(journal_id)
                )
            })),
            reference: original.journal.reference.clone(),
            source_type: JournalSourceType::Manual,
            source_id: None,
            lines,
        };
        let tx = self.conn().unchecked_transaction()?;
        let posted = self.post_journal_in_tx(&tx, &book, new, Some(journal_id.to_string()))?;
        tx.commit()?;
        Ok(posted)
    }

    /// Shared posting path: validates, inserts, audits. Caller owns the
    /// SQLite transaction.
    fn post_journal_in_tx(
        &self,
        tx: &Connection,
        book: &Book,
        mut new: NewJournal,
        reversal_of: Option<String>,
    ) -> CoreResult<PostedJournal> {
        if new.lines.len() < 2 {
            return Err(CoreError::Validation(
                "a journal needs at least two lines".into(),
            ));
        }
        parse_date(&new.posted_date)?;
        if let Some(lock) = book.financial_lock_date.as_deref() {
            if new.posted_date.as_str() <= lock {
                return Err(CoreError::Validation(format!(
                    "book is locked up to {lock}; cannot post on {}",
                    new.posted_date
                )));
            }
        }
        if new.source_type != JournalSourceType::Manual {
            if let Some(source_id) = new.source_id.as_deref() {
                if let Some(existing) = repo::ledger::find_journal_by_source(
                    tx,
                    &book.id,
                    new.source_type.as_str(),
                    source_id,
                )? {
                    return Err(CoreError::DuplicateJournal {
                        source_type: new.source_type.to_string(),
                        source_id: existing,
                    });
                }
            }
        }

        // Each currency must balance on its own (no implicit FX). Codes are
        // normalized to uppercase first so "zar" and "ZAR" cannot land in
        // separate balance buckets (or separate report rows later).
        for line in &mut new.lines {
            line.currency = normalize_currency_code(&line.currency)?;
        }
        // Totals accumulate in i128 with a per-line bound so the balance
        // check cannot wrap in release builds (no overflow-checks profile)
        // and downstream SQLite SUM() aggregation stays within i64.
        let mut per_currency: std::collections::BTreeMap<&str, (i128, i128)> =
            std::collections::BTreeMap::new();
        for line in &new.lines {
            let one_side = (line.debit_minor == 0 && line.credit_minor > 0)
                || (line.credit_minor == 0 && line.debit_minor > 0);
            if !one_side {
                return Err(CoreError::Validation(
                    "each journal line must have exactly one positive side".into(),
                ));
            }
            let amount = line.debit_minor.max(line.credit_minor);
            if amount > MAX_LINE_AMOUNT_MINOR {
                return Err(CoreError::Validation(format!(
                    "journal line amount {amount} exceeds the maximum of \
                     {MAX_LINE_AMOUNT_MINOR} minor units"
                )));
            }
            let entry = per_currency.entry(line.currency.as_str()).or_insert((0, 0));
            entry.0 += i128::from(line.debit_minor);
            entry.1 += i128::from(line.credit_minor);
        }
        for (debit_total, credit_total) in per_currency.values() {
            if debit_total != credit_total {
                let clamp = |v: i128| v.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64;
                return Err(CoreError::UnbalancedJournal {
                    debit_minor: clamp(*debit_total),
                    credit_minor: clamp(*credit_total),
                });
            }
        }

        for line in &new.lines {
            let coa =
                repo::ledger::get_coa(tx, &line.coa_id)?.ok_or_else(|| CoreError::NotFound {
                    entity: "chart_of_accounts",
                    id: line.coa_id.clone(),
                })?;
            if coa.book_id != book.id {
                return Err(CoreError::Validation(
                    "journal line references an account from another book".into(),
                ));
            }
            if coa.is_archived {
                return Err(CoreError::Validation(format!(
                    "account {} ({}) is archived",
                    coa.code, coa.name
                )));
            }
            if let Some(fixed) = coa.currency.as_deref() {
                if fixed != line.currency {
                    return Err(CoreError::Validation(format!(
                        "account {} is fixed to {fixed}; line is in {}",
                        coa.code, line.currency
                    )));
                }
            }
        }

        let now = now_iso();
        let journal = Journal {
            id: new_id(),
            book_id: book.id.clone(),
            posted_date: new.posted_date,
            narrative: new.narrative,
            reference: new.reference,
            source_type: new.source_type,
            source_id: new.source_id,
            reversal_of,
            created_at: now.clone(),
        };
        repo::ledger::insert_journal(tx, &journal)?;
        let mut lines = Vec::with_capacity(new.lines.len());
        for (order, line) in new.lines.iter().enumerate() {
            let stored = JournalLine {
                id: new_id(),
                journal_id: journal.id.clone(),
                book_id: book.id.clone(),
                coa_id: line.coa_id.clone(),
                debit_minor: line.debit_minor,
                credit_minor: line.credit_minor,
                currency: line.currency.clone(),
                description: line.description.clone(),
                line_order: order as i64,
                vat_rate_id: line.vat_rate_id.clone(),
                vat_role: line.vat_role,
                created_at: now.clone(),
            };
            repo::ledger::insert_line(tx, &stored)?;
            lines.push(stored);
        }
        let posted = PostedJournal { journal, lines };
        let action = if posted.journal.reversal_of.is_some() {
            "reverse"
        } else {
            "post"
        };
        self.emit_audit(
            tx,
            Some(&book.id),
            "journal",
            Some(&posted.journal.id),
            action,
            None,
            Some(serde_json::to_string(&posted)?),
        )?;
        Ok(posted)
    }

    pub fn journal_get(&self, id: &str) -> CoreResult<PostedJournal> {
        let journal =
            repo::ledger::get_journal(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
                entity: "journal",
                id: id.to_string(),
            })?;
        let lines = repo::ledger::lines_for_journal(self.conn(), id)?;
        Ok(PostedJournal { journal, lines })
    }

    /// Journals for a book within an inclusive posted-date range (with lines).
    pub fn journal_list(
        &self,
        book_id: &str,
        from_date: &str,
        to_date: &str,
    ) -> CoreResult<Vec<PostedJournal>> {
        self.book_get(book_id)?;
        let journals = repo::ledger::list_journals(self.conn(), book_id, from_date, to_date)?;
        journals
            .into_iter()
            .map(|journal| {
                let lines = repo::ledger::lines_for_journal(self.conn(), &journal.id)?;
                Ok(PostedJournal { journal, lines })
            })
            .collect()
    }

    pub fn coa_list(&self, book_id: &str) -> CoreResult<Vec<CoaAccount>> {
        repo::ledger::list_coa(self.conn(), book_id)
    }

    /// Add a chart-of-accounts entry. Codes are unique per book.
    pub fn coa_create(&self, new: NewCoaAccount) -> CoreResult<CoaAccount> {
        self.book_get(&new.book_id)?;
        if new.code.trim().is_empty() || new.name.trim().is_empty() {
            return Err(CoreError::Validation(
                "account code and name must not be empty".into(),
            ));
        }
        let currency = match new.currency.as_deref() {
            Some(raw) => Some(normalize_currency_code(raw)?),
            None => None,
        };
        let now = now_iso();
        let account = CoaAccount {
            id: new_id(),
            book_id: new.book_id,
            code: new.code.trim().to_string(),
            name: new.name.trim().to_string(),
            kind: new.kind,
            description: new.description,
            currency,
            is_archived: false,
            is_system: false,
            created_at: now.clone(),
            updated_at: now,
        };
        let tx = self.conn().unchecked_transaction()?;
        if !repo::ledger::insert_coa(&tx, &account)? {
            return Err(CoreError::Validation(format!(
                "account code {} already exists in this book",
                account.code
            )));
        }
        self.emit_audit(
            &tx,
            Some(&account.book_id),
            "chart_of_accounts",
            Some(&account.id),
            "create",
            None,
            Some(serde_json::to_string(&account)?),
        )?;
        tx.commit()?;
        Ok(account)
    }

    /// Archive a chart-of-accounts entry: it stops accepting new journal
    /// lines but history is preserved (accounts are never deleted).
    pub fn coa_archive(&self, id: &str) -> CoreResult<CoaAccount> {
        let before =
            repo::ledger::get_coa(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
                entity: "chart_of_accounts",
                id: id.to_string(),
            })?;
        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        repo::ledger::set_coa_archived(&tx, id, true, &now)?;
        let mut after = before.clone();
        after.is_archived = true;
        after.updated_at = now;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "chart_of_accounts",
            Some(id),
            "archive",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Map a personal-finance entity (account / category) to a
    /// chart-of-accounts entry for automatic journal generation.
    pub fn coa_map_set(
        &self,
        book_id: &str,
        entity_type: CoaMapEntity,
        entity_id: &str,
        coa_id: &str,
    ) -> CoreResult<CoaMapEntry> {
        self.book_get(book_id)?;
        let coa =
            repo::ledger::get_coa(self.conn(), coa_id)?.ok_or_else(|| CoreError::NotFound {
                entity: "chart_of_accounts",
                id: coa_id.to_string(),
            })?;
        if coa.book_id != book_id {
            return Err(CoreError::Validation(
                "chart-of-accounts entry belongs to a different book".into(),
            ));
        }
        match entity_type {
            CoaMapEntity::Account => {
                let account = self.account_get(entity_id)?;
                if account.book_id != book_id {
                    return Err(CoreError::Validation(
                        "account belongs to a different book".into(),
                    ));
                }
            }
            CoaMapEntity::Category => {
                let category = repo::category::get(self.conn(), entity_id)?.ok_or_else(|| {
                    CoreError::NotFound {
                        entity: "category",
                        id: entity_id.to_string(),
                    }
                })?;
                if category.book_id != book_id {
                    return Err(CoreError::Validation(
                        "category belongs to a different book".into(),
                    ));
                }
            }
        }
        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        let entry = repo::ledger::upsert_coa_map(
            &tx,
            &CoaMapEntry {
                id: new_id(),
                book_id: book_id.to_string(),
                entity_type,
                entity_id: entity_id.to_string(),
                coa_id: coa_id.to_string(),
                created_at: now.clone(),
                updated_at: now,
            },
        )?;
        self.emit_audit(
            &tx,
            Some(book_id),
            "coa_map",
            Some(&entry.id),
            "set",
            None,
            Some(serde_json::to_string(&entry)?),
        )?;
        tx.commit()?;
        Ok(entry)
    }

    /// Set (or clear) the book's financial lock date. Journals may not be
    /// posted on or before the lock date.
    pub fn book_set_lock_date(&self, book_id: &str, lock_date: Option<&str>) -> CoreResult<Book> {
        let before = self.book_get(book_id)?;
        if let Some(date) = lock_date {
            parse_date(date)?;
        }
        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        repo::book::set_lock_date(&tx, book_id, lock_date, &now)?;
        let mut after = before.clone();
        after.financial_lock_date = lock_date.map(str::to_string);
        after.updated_at = now;
        self.emit_audit(
            &tx,
            Some(book_id),
            "book",
            Some(book_id),
            "lock_date",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Seed the SA-flavoured default chart of accounts for the book's kind
    /// (personal or small-business incl. VAT control accounts) plus the ZA
    /// VAT rate table (15% standard, zero-rated, exempt).
    /// Idempotent: existing codes are left untouched.
    pub fn coa_seed(&self, book_id: &str) -> CoreResult<Vec<CoaAccount>> {
        let book = self.book_get(book_id)?;
        let seeds = match book.kind {
            BookKind::Personal => PERSONAL_COA,
            BookKind::Business => BUSINESS_COA,
        };
        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        let mut inserted_any = false;
        for &(code, name, kind) in seeds {
            let inserted = repo::ledger::insert_coa(
                &tx,
                &CoaAccount {
                    id: new_id(),
                    book_id: book_id.to_string(),
                    code: code.to_string(),
                    name: name.to_string(),
                    kind,
                    description: None,
                    currency: None,
                    is_archived: false,
                    is_system: true,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
            )?;
            inserted_any = inserted_any || inserted;
        }
        for &(code, name, rate_bps) in VAT_RATE_SEEDS {
            repo::ledger::insert_vat_rate(
                &tx,
                &VatRate {
                    id: new_id(),
                    book_id: book_id.to_string(),
                    code: code.to_string(),
                    name: name.to_string(),
                    rate_bps,
                    country: Some("ZA".to_string()),
                    is_active: true,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
            )?;
        }
        if inserted_any {
            self.emit_audit(
                &tx,
                Some(book_id),
                "chart_of_accounts",
                None,
                "seed",
                None,
                None,
            )?;
        }
        tx.commit()?;
        self.coa_list(book_id)
    }

    pub fn vat_rate_list(&self, book_id: &str) -> CoreResult<Vec<VatRate>> {
        repo::ledger::list_vat_rates(self.conn(), book_id)
    }

    // -----------------------------------------------------------------------
    // Journal generation (transactions / documents → ledger, with VAT accrual)
    // -----------------------------------------------------------------------

    /// Mapped chart-of-accounts entry for an entity, falling back to a
    /// well-known seed code.
    fn mapped_or_fallback_coa(
        &self,
        book_id: &str,
        entity_type: CoaMapEntity,
        entity_id: &str,
        fallback_code: &str,
    ) -> CoreResult<CoaAccount> {
        if let Some(entry) =
            repo::ledger::get_coa_map(self.conn(), book_id, entity_type, entity_id)?
        {
            if let Some(coa) = repo::ledger::get_coa(self.conn(), &entry.coa_id)? {
                return Ok(coa);
            }
        }
        self.coa_by_code(book_id, fallback_code)
    }

    fn coa_by_code(&self, book_id: &str, code: &str) -> CoreResult<CoaAccount> {
        repo::ledger::get_coa_by_code(self.conn(), book_id, code)?.ok_or_else(|| {
            CoreError::Validation(format!(
                "chart-of-accounts code {code} not found — run coa_seed first"
            ))
        })
    }

    /// Generate the double-entry journal for a bank transaction, with an
    /// optional VAT accrual split (VAT-inclusive amount at the given rate).
    ///
    /// * outflow: debit expense (net, `input_base`), debit VAT input control
    ///   (`input_vat`), credit bank (gross)
    /// * inflow: debit bank (gross), credit income (net, `output_base`),
    ///   credit VAT output control (`output_vat`)
    ///
    /// The VAT *side* (input vs output) follows the counter account's kind,
    /// not the cash direction: an inflow whose counter account is an expense
    /// account is a purchase refund / supplier credit note and is booked as a
    /// negative **input**-VAT adjustment (credit expense + credit VAT input
    /// control), never as a sale — so the VAT201 supply/turnover boxes are
    /// not inflated. Symmetrically, an outflow against an income account
    /// (customer refund) reduces output VAT rather than inflating input VAT.
    ///
    /// Accounts come from `coa_map` (account / category) with seed-code
    /// fallbacks. One journal per transaction, enforced.
    pub fn journal_generate_for_transaction(
        &self,
        transaction_id: &str,
        vat_rate_id: Option<&str>,
    ) -> CoreResult<PostedJournal> {
        let txn = self.transaction_get(transaction_id)?;
        let book = self.book_get(&txn.book_id)?;
        let gross = txn.amount_minor.abs();
        if gross == 0 {
            return Err(CoreError::Validation(
                "cannot generate a journal for a zero-amount transaction".into(),
            ));
        }
        let is_outflow = txn.amount_minor < 0;

        let bank = self.mapped_or_fallback_coa(
            &book.id,
            CoaMapEntity::Account,
            &txn.account_id,
            COA_CODE_BANK,
        )?;
        let counter_fallback = if is_outflow {
            fallback_expense_code(book.kind)
        } else {
            fallback_income_code(book.kind)
        };
        let counter = match txn.category_id.as_deref() {
            Some(category_id) => self.mapped_or_fallback_coa(
                &book.id,
                CoaMapEntity::Category,
                category_id,
                counter_fallback,
            )?,
            None => self.coa_by_code(&book.id, counter_fallback)?,
        };

        let vat = match vat_rate_id {
            None => None,
            Some(rate_id) => {
                let rate = repo::ledger::list_vat_rates(self.conn(), &book.id)?
                    .into_iter()
                    .find(|r| r.id == rate_id)
                    .ok_or_else(|| CoreError::NotFound {
                        entity: "vat_rate",
                        id: rate_id.to_string(),
                    })?;
                if !rate.is_active {
                    return Err(CoreError::Validation(format!(
                        "VAT rate {} is inactive",
                        rate.code
                    )));
                }
                Some(rate)
            }
        };

        let currency = txn.currency.clone();
        let line = |coa: &CoaAccount, debit: i64, credit: i64, rate: Option<&VatRate>, role| {
            NewJournalLine {
                coa_id: coa.id.clone(),
                debit_minor: debit,
                credit_minor: credit,
                currency: currency.clone(),
                description: None,
                vat_rate_id: rate.map(|r| r.id.clone()),
                vat_role: role,
            }
        };

        let mut lines = Vec::new();
        match vat {
            None => {
                if is_outflow {
                    lines.push(line(&counter, gross, 0, None, None));
                    lines.push(line(&bank, 0, gross, None, None));
                } else {
                    lines.push(line(&bank, gross, 0, None, None));
                    lines.push(line(&counter, 0, gross, None, None));
                }
            }
            Some(rate) => {
                let (net, vat_minor) = split_inclusive(gross, rate.rate_bps);
                // Input side (purchases) vs output side (supplies) follows
                // the counter account's kind: expense accounts are always
                // the purchase side even when the cash flows *in* (purchase
                // refund / supplier credit note), and income accounts are
                // always the supply side even when cash flows *out*
                // (customer refund). Other kinds fall back to cash
                // direction.
                let input_side = match counter.kind {
                    CoaKind::Expense => true,
                    CoaKind::Income => false,
                    _ => is_outflow,
                };
                let (base_role, vat_role, vat_control_code) = if input_side {
                    (VatRole::InputBase, VatRole::InputVat, COA_CODE_VAT_INPUT)
                } else {
                    (VatRole::OutputBase, VatRole::OutputVat, COA_CODE_VAT_OUTPUT)
                };
                if is_outflow {
                    lines.push(line(&counter, net, 0, Some(&rate), Some(base_role)));
                    if vat_minor > 0 {
                        let vat_control = self.coa_by_code(&book.id, vat_control_code)?;
                        lines.push(line(
                            &vat_control,
                            vat_minor,
                            0,
                            Some(&rate),
                            Some(vat_role),
                        ));
                    }
                    lines.push(line(&bank, 0, gross, None, None));
                } else {
                    lines.push(line(&bank, gross, 0, None, None));
                    lines.push(line(&counter, 0, net, Some(&rate), Some(base_role)));
                    if vat_minor > 0 {
                        let vat_control = self.coa_by_code(&book.id, vat_control_code)?;
                        lines.push(line(
                            &vat_control,
                            0,
                            vat_minor,
                            Some(&rate),
                            Some(vat_role),
                        ));
                    }
                }
            }
        }

        let new = NewJournal {
            book_id: book.id.clone(),
            posted_date: txn.posted_date.clone(),
            narrative: txn.merchant.clone().or_else(|| txn.description.clone()),
            reference: txn.provider_txn_id.clone(),
            source_type: JournalSourceType::Transaction,
            source_id: Some(txn.id.clone()),
            lines,
        };
        let tx = self.conn().unchecked_transaction()?;
        let posted = self.post_journal_in_tx(&tx, &book, new, None)?;
        tx.commit()?;
        Ok(posted)
    }

    /// Generate the expense journal for a document (slip/invoice) from its
    /// current slip-v2 extraction, with a per-rate VAT input accrual for
    /// business books:
    ///
    /// * per VAT group: debit expense (`input_base`), debit VAT input
    ///   control (`input_vat`), each tagged with the matching book VAT rate
    /// * credit bank for the gross total
    ///
    /// Personal books (no VAT input control) post the gross to expenses.
    pub fn journal_generate_for_document(&self, document_id: &str) -> CoreResult<PostedJournal> {
        let document = self.document_get(document_id)?;
        let book = self.book_get(&document.book_id)?;
        let extraction = self
            .document_current_extraction(document_id)?
            .and_then(|e| e.payload)
            .ok_or_else(|| {
                CoreError::Validation("document has no current extraction payload".into())
            })?;
        let slip = SlipPayload::parse(&extraction)?;
        let gross = slip.totals.total_minor;
        if gross <= 0 {
            return Err(CoreError::Validation(
                "slip total must be positive to generate a journal".into(),
            ));
        }
        let currency = match slip.currency.as_deref() {
            Some(raw) => normalize_currency_code(raw)?,
            None => book.currency.clone(),
        };
        let posted_date = slip
            .purchase_date()
            .unwrap_or_else(|| document.created_at.chars().take(10).collect());

        let expense = self.coa_by_code(&book.id, fallback_expense_code(book.kind))?;
        let bank = self.coa_by_code(&book.id, COA_CODE_BANK)?;
        let vat_input = match book.kind {
            BookKind::Business => {
                repo::ledger::get_coa_by_code(self.conn(), &book.id, COA_CODE_VAT_INPUT)?
            }
            BookKind::Personal => None,
        };
        let rates = repo::ledger::list_vat_rates(self.conn(), &book.id)?;
        // Prefer a non-exempt active rate with the group's exact bps.
        let rate_for = |bps: Option<i64>| -> Option<&VatRate> {
            let bps = bps?;
            rates
                .iter()
                .filter(|r| r.is_active && r.rate_bps == bps)
                .min_by_key(|r| (r.code == "EXE", r.code.clone()))
        };

        let mut lines = Vec::new();
        let line = |coa: &CoaAccount, debit: i64, credit: i64, rate: Option<&VatRate>, role| {
            NewJournalLine {
                coa_id: coa.id.clone(),
                debit_minor: debit,
                credit_minor: credit,
                currency: currency.clone(),
                description: slip.merchant_name().map(str::to_string),
                vat_rate_id: rate.map(|r| r.id.clone()),
                vat_role: role,
            }
        };
        match &vat_input {
            Some(vat_input) => {
                // Debit each VAT group's base and VAT; negative groups
                // (discounts, credit lines) become credits so the journal
                // still balances instead of being silently dropped.
                let split = |amount: i64| -> (i64, i64) {
                    if amount > 0 {
                        (amount, 0)
                    } else {
                        (0, -amount)
                    }
                };
                let mut group_net: i64 = 0;
                for group in slip.vat_groups() {
                    let rate = rate_for(group.rate_bps);
                    if group.base_minor != 0 {
                        let (debit, credit) = split(group.base_minor);
                        lines.push(line(
                            &expense,
                            debit,
                            credit,
                            rate,
                            Some(VatRole::InputBase),
                        ));
                        group_net += group.base_minor;
                    }
                    if group.vat_minor != 0 {
                        let (debit, credit) = split(group.vat_minor);
                        lines.push(line(
                            vat_input,
                            debit,
                            credit,
                            rate,
                            Some(VatRole::InputVat),
                        ));
                        group_net += group.vat_minor;
                    }
                }
                // Slips are valid within a small rounding tolerance, and tips
                // live in the stated total but never in the VAT breakdown —
                // post the remainder (gross − groups) to the expense account
                // untagged so debits always equal the gross bank credit.
                let remainder = gross - group_net;
                if remainder != 0 {
                    let (debit, credit) = split(remainder);
                    lines.push(line(&expense, debit, credit, None, None));
                }
            }
            None => lines.push(line(&expense, gross, 0, None, None)),
        }
        lines.push(line(&bank, 0, gross, None, None));

        let new = NewJournal {
            book_id: book.id.clone(),
            posted_date,
            narrative: slip.merchant_name().map(str::to_string),
            reference: None,
            source_type: JournalSourceType::Document,
            source_id: Some(document.id.clone()),
            lines,
        };
        let tx = self.conn().unchecked_transaction()?;
        let posted = self.post_journal_in_tx(&tx, &book, new, None)?;
        tx.commit()?;
        Ok(posted)
    }

    // -----------------------------------------------------------------------
    // Recon
    // -----------------------------------------------------------------------

    /// Bank reconciliation: match statement lines (transactions) against
    /// documents (slips, via their extraction) and posted manual journals
    /// (ledger side), scored by amount, date proximity, and merchant
    /// similarity. High-confidence matches are recorded as `auto`, the rest
    /// as `suggested`; both wait for [`Self::recon_confirm`] /
    /// [`Self::recon_reject`].
    ///
    /// Idempotent: actively matched transactions/documents/journals and
    /// user-rejected pairs are never re-suggested. Returns all open matches.
    pub fn recon_suggest(&self, book_id: &str) -> CoreResult<Vec<ReconMatch>> {
        let book = self.book_get(book_id)?;
        let conn = self.conn();
        let matched_txns: std::collections::HashSet<String> =
            repo::recon::actively_matched_transaction_ids(conn, book_id)?
                .into_iter()
                .collect();
        let mut matched_docs: std::collections::HashSet<String> =
            repo::recon::actively_matched_document_ids(conn, book_id)?
                .into_iter()
                .collect();
        let mut matched_journals: std::collections::HashSet<String> =
            repo::recon::actively_matched_journal_ids(conn, book_id)?
                .into_iter()
                .collect();
        let rejected: std::collections::HashSet<(String, String)> =
            repo::recon::rejected_document_pairs(conn, book_id)?
                .into_iter()
                .collect();
        let rejected_journals: std::collections::HashSet<(String, String)> =
            repo::recon::rejected_journal_pairs(conn, book_id)?
                .into_iter()
                .collect();

        // Candidate documents: current slip extractions.
        struct DocCandidate {
            document_id: String,
            total_minor: i64,
            date: Option<String>,
            merchant: Option<String>,
            currency: Option<String>,
        }
        let docs: Vec<DocCandidate> = repo::document::current_extraction_payloads(conn, book_id)?
            .into_iter()
            .filter_map(|(document_id, payload, created_at)| {
                let slip = SlipPayload::parse(&payload).ok()?;
                Some(DocCandidate {
                    document_id,
                    total_minor: slip.totals.total_minor,
                    date: slip
                        .purchase_date()
                        .or_else(|| Some(created_at.chars().take(10).collect())),
                    merchant: slip.merchant_name().map(str::to_string),
                    // Extractions may return mis-cased codes ("zar");
                    // normalize so comparison against the (normalized)
                    // transaction currency works. Un-normalizable strings
                    // are kept verbatim — they must never match anything.
                    currency: slip
                        .currency
                        .clone()
                        .map(|c| normalize_currency_code(&c).unwrap_or(c)),
                })
            })
            .collect();

        // Candidate ledger entries: manual journals' bank-side lines.
        let ledger_lines = repo::recon::bank_side_journal_lines(conn, book_id)?;

        let txns = repo::transaction::list(conn, book_id, &TransactionFilter::default())?;

        // The chart-of-accounts entry a bank account posts to (coa_map, with
        // the seed bank code as fallback). Ledger candidates must hit the
        // statement's own bank account — any other asset line (VAT input,
        // inventory, equipment) is not a bank movement.
        let mut bank_coa_by_account: std::collections::HashMap<String, Option<String>> =
            std::collections::HashMap::new();
        let mut bank_coa_for = |account_id: &str| -> CoreResult<Option<String>> {
            if let Some(cached) = bank_coa_by_account.get(account_id) {
                return Ok(cached.clone());
            }
            let mapped = match repo::ledger::get_coa_map(
                self.conn(),
                book_id,
                CoaMapEntity::Account,
                account_id,
            )? {
                Some(entry) => Some(entry.coa_id),
                None => repo::ledger::get_coa_by_code(self.conn(), book_id, COA_CODE_BANK)?
                    .map(|coa| coa.id),
            };
            bank_coa_by_account.insert(account_id.to_string(), mapped.clone());
            Ok(mapped)
        };

        let tx = conn.unchecked_transaction()?;
        for txn in &txns {
            if matched_txns.contains(&txn.id) || txn.status == TransactionStatus::Rejected {
                continue;
            }
            let txn_abs = txn.amount_minor.abs();
            if txn_abs == 0 {
                continue;
            }
            let txn_merchant = txn.merchant.as_deref().unwrap_or("");
            let mut best: Option<ReconCandidate> = None;
            let mut consider = |candidate: ReconCandidate| {
                if candidate.confidence >= RECON_MIN_CONFIDENCE
                    && best
                        .as_ref()
                        .map(|b| candidate.confidence > b.confidence)
                        .unwrap_or(true)
                {
                    best = Some(candidate);
                }
            };

            // An explicit transaction→document link is near-certain.
            if let Some(doc_id) = txn.document_id.as_deref() {
                if !matched_docs.contains(doc_id)
                    && !rejected.contains(&(txn.id.clone(), doc_id.to_string()))
                {
                    consider(ReconCandidate {
                        document_id: Some(doc_id.to_string()),
                        journal_id: None,
                        confidence: 0.95,
                        amount_delta_minor: 0,
                        date_delta_days: 0,
                        merchant_score: 0.0,
                    });
                }
            }

            for doc in &docs {
                if matched_docs.contains(&doc.document_id)
                    || rejected.contains(&(txn.id.clone(), doc.document_id.clone()))
                    || txn.document_id.as_deref() == Some(doc.document_id.as_str())
                    || doc.total_minor <= 0
                    // Slips document money going out; a deposit/refund must
                    // never be matched against a purchase slip.
                    || txn.amount_minor >= 0
                {
                    continue;
                }
                // A slip without a stated currency is assumed to be in the
                // book's currency — never matched at face value against a
                // transaction in some other currency.
                let doc_currency = doc.currency.as_deref().unwrap_or(&book.currency);
                if doc_currency != txn.currency {
                    continue;
                }
                let amount_delta = (txn_abs - doc.total_minor).abs();
                let tolerance = ((doc.total_minor as f64) * RECON_AMOUNT_TOLERANCE) as i64;
                if amount_delta > tolerance {
                    continue;
                }
                let amount_score = if tolerance == 0 {
                    1.0
                } else {
                    1.0 - amount_delta as f64 / tolerance as f64
                };
                let (date_delta, date_score) = match doc.date.as_deref() {
                    None => (RECON_DATE_WINDOW_DAYS, 0.0),
                    Some(date) => match days_between(&txn.posted_date, date) {
                        Err(_) => continue,
                        Ok(dd) if dd > RECON_DATE_WINDOW_DAYS => continue,
                        Ok(dd) => (dd, 1.0 - dd as f64 / RECON_DATE_WINDOW_DAYS as f64),
                    },
                };
                let merchant_score =
                    merchant_similarity(txn_merchant, doc.merchant.as_deref().unwrap_or(""));
                consider(ReconCandidate {
                    document_id: Some(doc.document_id.clone()),
                    journal_id: None,
                    confidence: RECON_WEIGHT_AMOUNT * amount_score
                        + RECON_WEIGHT_DATE * date_score
                        + RECON_WEIGHT_MERCHANT * merchant_score,
                    amount_delta_minor: amount_delta,
                    date_delta_days: date_delta,
                    merchant_score,
                });
            }

            // Ledger candidates only exist relative to the statement's own
            // bank chart-of-accounts entry; without one, no journal line can
            // be identified as this account's bank movement.
            let expected_bank_coa = bank_coa_for(&txn.account_id)?;
            for entry in &ledger_lines {
                if matched_journals.contains(&entry.journal_id)
                    || rejected_journals.contains(&(txn.id.clone(), entry.journal_id.clone()))
                    || entry.currency != txn.currency
                {
                    continue;
                }
                // The line must sit on the statement's own bank account —
                // not just any asset account (VAT input, inventory, …).
                if expected_bank_coa.as_deref() != Some(entry.coa_id.as_str()) {
                    continue;
                }
                // Ledger amounts must match the statement side exactly:
                // money out = credit on the bank account, money in = debit.
                let side_matches = if txn.amount_minor < 0 {
                    entry.credit_minor == txn_abs
                } else {
                    entry.debit_minor == txn_abs
                };
                if !side_matches {
                    continue;
                }
                let date_delta = match days_between(&txn.posted_date, &entry.posted_date) {
                    Err(_) => continue,
                    Ok(dd) if dd > RECON_DATE_WINDOW_DAYS => continue,
                    Ok(dd) => dd,
                };
                let date_score = 1.0 - date_delta as f64 / RECON_DATE_WINDOW_DAYS as f64;
                let merchant_score =
                    merchant_similarity(txn_merchant, entry.narrative.as_deref().unwrap_or(""));
                consider(ReconCandidate {
                    document_id: None,
                    journal_id: Some(entry.journal_id.clone()),
                    confidence: RECON_WEIGHT_AMOUNT
                        + RECON_WEIGHT_DATE * date_score
                        + RECON_WEIGHT_MERCHANT * merchant_score,
                    amount_delta_minor: 0,
                    date_delta_days: date_delta,
                    merchant_score,
                });
            }

            if let Some(chosen) = best {
                let now = now_iso();
                let state = if chosen.confidence >= RECON_AUTO_CONFIDENCE {
                    ReconState::Auto
                } else {
                    ReconState::Suggested
                };
                if let Some(doc_id) = chosen.document_id.as_deref() {
                    matched_docs.insert(doc_id.to_string());
                }
                if let Some(journal_id) = chosen.journal_id.as_deref() {
                    matched_journals.insert(journal_id.to_string());
                }
                repo::recon::insert(
                    &tx,
                    &ReconMatch {
                        id: new_id(),
                        book_id: book_id.to_string(),
                        transaction_id: txn.id.clone(),
                        document_id: chosen.document_id,
                        journal_id: chosen.journal_id,
                        state,
                        confidence: chosen.confidence.min(1.0),
                        amount_delta_minor: chosen.amount_delta_minor,
                        date_delta_days: chosen.date_delta_days,
                        merchant_score: chosen.merchant_score,
                        created_at: now.clone(),
                        updated_at: now,
                    },
                )?;
            }
        }
        tx.commit()?;
        repo::recon::list_open(self.conn(), book_id)
    }

    pub fn recon_confirm(&self, match_id: &str) -> CoreResult<ReconMatch> {
        self.recon_set_state(match_id, ReconState::Confirmed, "confirm")
    }

    /// Reject a match. The (transaction, document) or (transaction, journal)
    /// pair is remembered and never re-suggested; both sides become
    /// matchable again (against other counterparts).
    pub fn recon_reject(&self, match_id: &str) -> CoreResult<ReconMatch> {
        self.recon_set_state(match_id, ReconState::Rejected, "reject")
    }

    fn recon_set_state(
        &self,
        match_id: &str,
        state: ReconState,
        action: &str,
    ) -> CoreResult<ReconMatch> {
        let before =
            repo::recon::get(self.conn(), match_id)?.ok_or_else(|| CoreError::NotFound {
                entity: "recon_match",
                id: match_id.to_string(),
            })?;
        if before.state == ReconState::Confirmed && state != ReconState::Confirmed {
            return Err(CoreError::InvalidStatusTransition {
                from: before.state.to_string(),
                to: state.to_string(),
            });
        }
        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        repo::recon::set_state(&tx, match_id, state, &now)?;
        let mut after = before.clone();
        after.state = state;
        after.updated_at = now;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "recon_match",
            Some(match_id),
            action,
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    // -----------------------------------------------------------------------
    // Reports
    // -----------------------------------------------------------------------

    pub fn report_spending(
        &self,
        book_id: &str,
        from_date: &str,
        to_date: &str,
    ) -> CoreResult<Vec<SpendingRow>> {
        repo::report::spending(self.conn(), book_id, from_date, to_date)
    }

    /// Spending grouped by calendar month and category.
    pub fn report_spending_by_month(
        &self,
        book_id: &str,
        from_date: &str,
        to_date: &str,
    ) -> CoreResult<Vec<MonthlySpendingRow>> {
        repo::report::spending_by_month(self.conn(), book_id, from_date, to_date)
    }

    /// Trial balance per (account, currency): rows never sum amounts from
    /// different currencies together.
    pub fn report_trial_balance(&self, book_id: &str) -> CoreResult<Vec<TrialBalanceRow>> {
        let book = self.book_get(book_id)?;
        repo::report::trial_balance(self.conn(), book_id, &book.currency)
    }

    /// Income statement (profit & loss) over an inclusive posted-date range,
    /// computed in the book's base currency (foreign-currency lines are
    /// excluded, not mixed in — see the trial balance for per-currency
    /// figures).
    pub fn report_income_statement(
        &self,
        book_id: &str,
        from_date: &str,
        to_date: &str,
    ) -> CoreResult<IncomeStatement> {
        let book = self.book_get(book_id)?;
        repo::report::income_statement(self.conn(), book_id, from_date, to_date, &book.currency)
    }

    /// Balance sheet as of an inclusive date, in the book's base currency.
    pub fn report_balance_sheet(
        &self,
        book_id: &str,
        as_of_date: &str,
    ) -> CoreResult<BalanceSheet> {
        let book = self.book_get(book_id)?;
        parse_date(as_of_date)?;
        repo::report::balance_sheet(self.conn(), book_id, as_of_date, &book.currency)
    }

    /// VAT-period summary suitable for filling in a VAT201: output/input VAT
    /// and their bases per rate, plus supply-type totals and the net
    /// position — in the book's base currency (a return is filed in one
    /// currency).
    pub fn report_vat201(
        &self,
        book_id: &str,
        from_date: &str,
        to_date: &str,
    ) -> CoreResult<Vat201Summary> {
        let book = self.book_get(book_id)?;
        repo::report::vat201(self.conn(), book_id, from_date, to_date, &book.currency)
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    /// Store a setting. With `secret = true` the value goes to the OS
    /// keychain and only the keychain entry name is stored in SQLite.
    pub fn settings_set(&self, key: &str, value: &str, secret: bool) -> CoreResult<()> {
        let now = now_iso();
        if secret {
            let entry = format!("settings.{key}");
            self.secrets.set_secret(&entry, value)?;
            repo::settings::upsert(self.conn(), key, "", Some(&entry), &now)?;
        } else {
            repo::settings::upsert(self.conn(), key, value, None, &now)?;
        }
        // Never put secret values in the audit log.
        self.emit_audit(
            self.conn(),
            None,
            "settings",
            Some(key),
            "set",
            None,
            Some(serde_json::to_string(
                &serde_json::json!({ "key": key, "secret": secret }),
            )?),
        )?;
        Ok(())
    }

    /// Read a plain (non-secret) setting.
    ///
    /// Secrets are **write-only** at this boundary (mantra #4, credential
    /// vault spec): a key stored with `secret = true` is never dereferenced
    /// and returned here — the call fails instead of leaking material to
    /// whatever IPC/HTTP surface sits above. Consumers that legitimately
    /// need the material use [`CoreService::settings_use_secret`], which
    /// hands it to a closure and never returns it.
    pub fn settings_get(&self, key: &str) -> CoreResult<Option<String>> {
        match repo::settings::get(self.conn(), key)? {
            None => Ok(None),
            Some(row) => match row.secret_ref {
                Some(_) => Err(CoreError::Validation(format!(
                    "setting {key:?} is secret and write-only; secret material is never \
                     returned — consumers use it in place via settings_use_secret"
                ))),
                None => Ok(Some(row.value)),
            },
        }
    }

    /// Hand a secret-backed setting's material to `f` for the duration of
    /// the call — the internal `use_with` path of the write-only contract.
    ///
    /// Returns `Ok(None)` when the key is unset (or its keychain entry is
    /// gone) and an error when the key holds a plain, non-secret value —
    /// plain settings are not credentials and must not be laundered into
    /// secret handling. Never exposed over IPC/HTTP. Every access is
    /// recorded in the audit log (metadata only, never material) — same
    /// posture as the envelope vault's `use_with`.
    pub fn settings_use_secret<R>(
        &self,
        key: &str,
        f: impl FnOnce(&SecretString) -> R,
    ) -> CoreResult<Option<R>> {
        match repo::settings::get(self.conn(), key)? {
            None => Ok(None),
            Some(row) => match row.secret_ref {
                Some(entry) => match self.secrets.get_secret(&entry)? {
                    Some(material) => {
                        let secret = SecretString::new(material);
                        let result = f(&secret);
                        self.emit_audit(
                            self.conn(),
                            None,
                            "settings",
                            Some(key),
                            "use_secret",
                            None,
                            None,
                        )?;
                        Ok(Some(result))
                    }
                    None => Ok(None),
                },
                None => Err(CoreError::Validation(format!(
                    "setting {key:?} is not secret-backed; read it with settings_get"
                ))),
            },
        }
    }

    // -----------------------------------------------------------------------
    // Audit
    // -----------------------------------------------------------------------

    pub fn audit_list(&self, book_id: Option<&str>, limit: u32) -> CoreResult<Vec<AuditEntry>> {
        repo::audit::list(self.conn(), book_id, limit)
    }
}

fn document_transition_allowed(from: DocumentStatus, to: DocumentStatus) -> bool {
    use DocumentStatus::*;
    matches!(
        (from, to),
        (Pending, Processing)
            | (Pending, Failed)
            | (Processing, Extracted)
            | (Processing, Failed)
            | (Extracted, Reviewed)
            | (Failed, Pending)
    )
}

fn build_tree(flat: Vec<Category>) -> Vec<CategoryNode> {
    fn attach(parent_id: Option<&str>, remaining: &mut Vec<Category>) -> Vec<CategoryNode> {
        let (matches, rest): (Vec<Category>, Vec<Category>) = std::mem::take(remaining)
            .into_iter()
            .partition(|c| c.parent_id.as_deref() == parent_id);
        *remaining = rest;
        matches
            .into_iter()
            .map(|category| {
                let children = attach(Some(category.id.as_str()), remaining);
                CategoryNode { category, children }
            })
            .collect()
    }
    let mut remaining = flat;
    attach(None, &mut remaining)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecretStore;

    fn svc() -> CoreService {
        CoreService::new(
            Db::open_in_memory().expect("in-memory db"),
            Box::new(MemorySecretStore::new()),
        )
    }

    fn make_book(svc: &CoreService) -> Book {
        svc.book_create(NewBook {
            name: "Personal".into(),
            kind: BookKind::Personal,
            currency: None,
            country: Some("ZA".into()),
        })
        .unwrap()
    }

    fn make_account(svc: &CoreService, book: &Book) -> Account {
        svc.account_create(NewAccount {
            book_id: book.id.clone(),
            name: "Cheque".into(),
            kind: AccountKind::Bank,
            currency: "ZAR".into(),
            institution: Some("FNB".into()),
            account_number_masked: Some("****1234".into()),
            opening_balance_minor: Some(0),
        })
        .unwrap()
    }

    fn make_category(svc: &CoreService, book: &Book, name: &str) -> Category {
        svc.category_create(NewCategory {
            book_id: book.id.clone(),
            parent_id: None,
            name: name.into(),
            kind: CategoryKind::Expense,
            icon: None,
            color: None,
        })
        .unwrap()
    }

    fn make_txn(_svc: &CoreService, book: &Book, account: &Account) -> NewTransaction {
        NewTransaction {
            book_id: book.id.clone(),
            account_id: account.id.clone(),
            source: TransactionSource::Manual,
            provider_txn_id: None,
            posted_date: "2026-07-01".into(),
            amount_minor: -12_345,
            currency: "ZAR".into(),
            merchant: Some("PICK N PAY *42".into()),
            description: Some("groceries".into()),
            notes: None,
            category_id: None,
            document_id: None,
            dedupe_occurrence: 0,
        }
    }

    // -- books --------------------------------------------------------------

    #[test]
    fn book_create_and_list() {
        let svc = svc();
        let book = make_book(&svc);
        assert_eq!(book.currency, "ZAR");
        let books = svc.book_list().unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0], book);
        // Audit entry recorded.
        let audit = svc.audit_list(Some(&book.id), 10).unwrap();
        assert!(audit
            .iter()
            .any(|a| a.entity_type == "book" && a.action == "create"));
    }

    #[test]
    fn book_create_normalizes_lowercase_currency() {
        // Regression: an un-normalized book currency ("zar") silently emptied
        // every base-currency report (they filter journal lines by
        // l.currency = book.currency, and lines are always uppercased).
        let svc = svc();
        let book = svc
            .book_create(NewBook {
                name: "Lower".into(),
                kind: BookKind::Business,
                currency: Some("zar".into()),
                country: Some("ZA".into()),
            })
            .unwrap();
        assert_eq!(book.currency, "ZAR");
        assert!(matches!(
            svc.book_create(NewBook {
                name: "Bad".into(),
                kind: BookKind::Personal,
                currency: Some("z!r".into()),
                country: None,
            }),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn book_create_rejects_empty_name() {
        let svc = svc();
        let err = svc
            .book_create(NewBook {
                name: "  ".into(),
                kind: BookKind::Business,
                currency: None,
                country: None,
            })
            .unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)));
    }

    // -- accounts -----------------------------------------------------------

    #[test]
    fn account_crud() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);

        assert_eq!(svc.account_get(&account.id).unwrap(), account);
        assert_eq!(svc.account_list(&book.id).unwrap().len(), 1);

        let updated = svc
            .account_update(
                &account.id,
                AccountPatch {
                    name: Some("Everyday".into()),
                    is_archived: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.name, "Everyday");
        assert!(updated.is_archived);
        // Untouched fields survive.
        assert_eq!(updated.institution.as_deref(), Some("FNB"));

        svc.account_delete(&account.id).unwrap();
        assert!(matches!(
            svc.account_get(&account.id),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    fn account_create_requires_existing_book() {
        let svc = svc();
        let err = svc
            .account_create(NewAccount {
                book_id: "nope".into(),
                name: "x".into(),
                kind: AccountKind::Cash,
                currency: "ZAR".into(),
                institution: None,
                account_number_masked: None,
                opening_balance_minor: None,
            })
            .unwrap_err();
        assert!(matches!(err, CoreError::NotFound { entity: "book", .. }));
    }

    #[test]
    fn account_delete_blocked_by_transactions() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        svc.transaction_create(make_txn(&svc, &book, &account))
            .unwrap();
        assert!(svc.account_delete(&account.id).is_err());
    }

    // -- transactions -------------------------------------------------------

    #[test]
    fn transaction_create_normalizes_merchant_and_lists() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let txn = svc
            .transaction_create(make_txn(&svc, &book, &account))
            .unwrap();
        assert_eq!(txn.merchant_normalized.as_deref(), Some("pick n pay 42"));
        assert_eq!(txn.status, TransactionStatus::Pending);

        let listed = svc
            .transaction_list(&book.id, &TransactionFilter::default())
            .unwrap();
        assert_eq!(listed, vec![txn]);
    }

    #[test]
    fn transaction_dedupe_by_content_hash() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let first = svc
            .transaction_create(make_txn(&svc, &book, &account))
            .unwrap();
        let err = svc
            .transaction_create(make_txn(&svc, &book, &account))
            .unwrap_err();
        match err {
            CoreError::DuplicateTransaction { existing_id } => assert_eq!(existing_id, first.id),
            other => panic!("expected duplicate, got {other:?}"),
        }
    }

    #[test]
    fn transaction_dedupe_by_provider_txn_id() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let mut new = make_txn(&svc, &book, &account);
        new.provider_txn_id = Some("prov-1".into());
        let first = svc.transaction_create(new.clone()).unwrap();

        // Same provider id, different observable fields — still a duplicate.
        new.amount_minor = -999;
        new.posted_date = "2026-07-02".into();
        let err = svc.transaction_create(new).unwrap_err();
        match err {
            CoreError::DuplicateTransaction { existing_id } => assert_eq!(existing_id, first.id),
            other => panic!("expected duplicate, got {other:?}"),
        }
    }

    #[test]
    fn transaction_list_filters() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let cat = make_category(&svc, &book, "Groceries");

        let mut a = make_txn(&svc, &book, &account);
        a.category_id = Some(cat.id.clone());
        let a = svc.transaction_create(a).unwrap();

        let mut b = make_txn(&svc, &book, &account);
        b.posted_date = "2026-06-15".into();
        b.amount_minor = -500;
        let b = svc.transaction_create(b).unwrap();

        let by_category = svc
            .transaction_list(
                &book.id,
                &TransactionFilter {
                    category_id: Some(cat.id.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(by_category, vec![a.clone()]);

        let june = svc
            .transaction_list(
                &book.id,
                &TransactionFilter {
                    from_date: Some("2026-06-01".into()),
                    to_date: Some("2026-06-30".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(june, vec![b]);

        let limited = svc
            .transaction_list(
                &book.id,
                &TransactionFilter {
                    limit: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0], a); // newest first
    }

    #[test]
    fn transaction_categorize_records_correction_and_mapping() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let cat = make_category(&svc, &book, "Groceries");
        let txn = svc
            .transaction_create(make_txn(&svc, &book, &account))
            .unwrap();

        let updated = svc.transaction_categorize(&txn.id, &cat.id).unwrap();
        assert_eq!(updated.category_id.as_deref(), Some(cat.id.as_str()));

        let corrections = repo::category::list_corrections(svc.conn(), &book.id).unwrap();
        assert_eq!(corrections.len(), 1);
        assert_eq!(
            corrections[0].new_category_id.as_deref(),
            Some(cat.id.as_str())
        );

        // The mapping now auto-classifies the next import of that merchant.
        let mut next = make_txn(&svc, &book, &account);
        next.posted_date = "2026-07-03".into();
        next.amount_minor = -777;
        let next = svc.transaction_create(next).unwrap();
        assert_eq!(next.category_id.as_deref(), Some(cat.id.as_str()));
    }

    #[test]
    fn transaction_create_bounds_amounts() {
        // Regression: unbounded transaction amounts (incl. i64::MIN, whose
        // abs() overflows) poisoned journal generation, recon scoring, and
        // SQLite SUM() in the spending report.
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);

        let mut min = make_txn(&svc, &book, &account);
        min.amount_minor = i64::MIN;
        assert!(matches!(
            svc.transaction_create(min),
            Err(CoreError::Validation(_))
        ));

        let mut huge = make_txn(&svc, &book, &account);
        huge.amount_minor = MAX_LINE_AMOUNT_MINOR + 1;
        huge.posted_date = "2026-07-02".into();
        assert!(matches!(
            svc.transaction_create(huge),
            Err(CoreError::Validation(_))
        ));

        // The boundary itself is accepted, in both directions.
        let mut at_bound = make_txn(&svc, &book, &account);
        at_bound.amount_minor = -MAX_LINE_AMOUNT_MINOR;
        at_bound.posted_date = "2026-07-03".into();
        svc.transaction_create(at_bound).unwrap();
    }

    #[test]
    fn transaction_uncategorize_clears_category_and_records_correction() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let cat = make_category(&svc, &book, "Groceries");
        let txn = svc
            .transaction_create(make_txn(&svc, &book, &account))
            .unwrap();
        svc.transaction_categorize(&txn.id, &cat.id).unwrap();

        let cleared = svc.transaction_uncategorize(&txn.id).unwrap();
        assert_eq!(cleared.category_id, None);
        assert_eq!(
            svc.transaction_get(&txn.id).unwrap().category_id,
            None,
            "clearing must persist"
        );

        let corrections = repo::category::list_corrections(svc.conn(), &book.id).unwrap();
        let last = corrections
            .iter()
            .find(|c| c.new_category_id.is_none())
            .expect("uncategorize records a correction with no new category");
        assert_eq!(last.old_category_id.as_deref(), Some(cat.id.as_str()));
    }

    #[test]
    fn transaction_categorize_rejects_cross_book_category() {
        let svc = svc();
        let book = make_book(&svc);
        let other = svc
            .book_create(NewBook {
                name: "Biz".into(),
                kind: BookKind::Business,
                currency: None,
                country: None,
            })
            .unwrap();
        let account = make_account(&svc, &book);
        let foreign_cat = make_category(&svc, &other, "Foreign");
        let txn = svc
            .transaction_create(make_txn(&svc, &book, &account))
            .unwrap();
        assert!(matches!(
            svc.transaction_categorize(&txn.id, &foreign_cat.id),
            Err(CoreError::Validation(_))
        ));
    }

    // -- categories ---------------------------------------------------------

    #[test]
    fn category_tree_nests_children() {
        let svc = svc();
        let book = make_book(&svc);
        let parent = make_category(&svc, &book, "Home");
        let child = svc
            .category_create(NewCategory {
                book_id: book.id.clone(),
                parent_id: Some(parent.id.clone()),
                name: "Rent".into(),
                kind: CategoryKind::Expense,
                icon: None,
                color: None,
            })
            .unwrap();
        let other_root = make_category(&svc, &book, "Transport");

        let tree = svc.category_tree(&book.id).unwrap();
        assert_eq!(tree.len(), 2);
        let home = tree.iter().find(|n| n.category.id == parent.id).unwrap();
        assert_eq!(home.children.len(), 1);
        assert_eq!(home.children[0].category.id, child.id);
        let transport = tree
            .iter()
            .find(|n| n.category.id == other_root.id)
            .unwrap();
        assert!(transport.children.is_empty());
    }

    #[test]
    fn category_create_rejects_cross_book_parent() {
        let svc = svc();
        let book = make_book(&svc);
        let other = svc
            .book_create(NewBook {
                name: "Biz".into(),
                kind: BookKind::Business,
                currency: None,
                country: None,
            })
            .unwrap();
        let parent = make_category(&svc, &other, "Foreign");
        let err = svc
            .category_create(NewCategory {
                book_id: book.id.clone(),
                parent_id: Some(parent.id),
                name: "Child".into(),
                kind: CategoryKind::Expense,
                icon: None,
                color: None,
            })
            .unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)));
    }

    // -- budgets ------------------------------------------------------------

    #[test]
    fn budget_upsert_and_status() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let cat = make_category(&svc, &book, "Groceries");

        let budget = svc
            .budget_upsert(BudgetUpsert {
                book_id: book.id.clone(),
                category_id: cat.id.clone(),
                month: "2026-07".into(),
                amount_minor: 500_000,
                currency: "ZAR".into(),
                rollover: false,
            })
            .unwrap();
        assert_eq!(budget.amount_minor, 500_000);

        // Upsert overwrites.
        let budget = svc
            .budget_upsert(BudgetUpsert {
                book_id: book.id.clone(),
                category_id: cat.id.clone(),
                month: "2026-07".into(),
                amount_minor: 600_000,
                currency: "ZAR".into(),
                rollover: true,
            })
            .unwrap();
        assert_eq!(budget.amount_minor, 600_000);
        assert!(budget.rollover);

        // Spend against it.
        let mut spend = make_txn(&svc, &book, &account);
        spend.category_id = Some(cat.id.clone());
        spend.amount_minor = -150_000;
        svc.transaction_create(spend).unwrap();

        let status = svc.budget_status(&book.id, "2026-07").unwrap();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].budget_minor, 600_000);
        assert_eq!(status[0].spent_minor, 150_000);
        assert_eq!(status[0].remaining_minor, 450_000);
    }

    #[test]
    fn budget_upsert_normalizes_currency_for_spend_matching() {
        // Regression: a budget saved with currency "zar" never matched any
        // (normalized, "ZAR") transaction — spent_minor stayed 0 forever.
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let cat = make_category(&svc, &book, "Groceries");
        let budget = svc
            .budget_upsert(BudgetUpsert {
                book_id: book.id.clone(),
                category_id: cat.id.clone(),
                month: "2026-07".into(),
                amount_minor: 100_000,
                currency: "zar".into(),
                rollover: false,
            })
            .unwrap();
        assert_eq!(budget.currency, "ZAR");

        let mut spend = make_txn(&svc, &book, &account);
        spend.category_id = Some(cat.id.clone());
        spend.amount_minor = -25_000;
        svc.transaction_create(spend).unwrap();

        let status = svc.budget_status(&book.id, "2026-07").unwrap();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].spent_minor, 25_000);
        assert_eq!(status[0].remaining_minor, 75_000);
    }

    #[test]
    fn budget_upsert_rejects_bad_month() {
        let svc = svc();
        let book = make_book(&svc);
        let cat = make_category(&svc, &book, "Groceries");
        let err = svc
            .budget_upsert(BudgetUpsert {
                book_id: book.id,
                category_id: cat.id,
                month: "July 2026".into(),
                amount_minor: 1,
                currency: "ZAR".into(),
                rollover: false,
            })
            .unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)));
    }

    // -- documents ----------------------------------------------------------

    fn make_document(svc: &CoreService, book: &Book, sha: &str) -> Document {
        svc.document_import(NewDocument {
            book_id: book.id.clone(),
            source: DocumentSource::Upload,
            kind: DocumentKind::Slip,
            file_path: format!("/docs/{sha}.jpg"),
            mime_type: Some("image/jpeg".into()),
            size_bytes: Some(1024),
            original_name: Some("slip.jpg".into()),
            sha256: Some(sha.into()),
        })
        .unwrap()
    }

    #[test]
    fn document_import_get_list_and_dedupe() {
        let svc = svc();
        let book = make_book(&svc);
        let doc = make_document(&svc, &book, "abc123");
        assert_eq!(doc.status, DocumentStatus::Pending);
        assert_eq!(svc.document_get(&doc.id).unwrap(), doc);
        assert_eq!(svc.document_list(&book.id, None).unwrap().len(), 1);
        assert_eq!(
            svc.document_list(&book.id, Some(DocumentStatus::Pending))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            svc.document_list(&book.id, Some(DocumentStatus::Extracted))
                .unwrap()
                .len(),
            0
        );

        let err = svc
            .document_import(NewDocument {
                book_id: book.id.clone(),
                source: DocumentSource::Email,
                kind: DocumentKind::Slip,
                file_path: "/docs/dup.jpg".into(),
                mime_type: None,
                size_bytes: None,
                original_name: None,
                sha256: Some("abc123".into()),
            })
            .unwrap_err();
        match err {
            CoreError::DuplicateDocument { existing_id } => assert_eq!(existing_id, doc.id),
            other => panic!("expected duplicate, got {other:?}"),
        }
    }

    #[test]
    fn document_status_machine() {
        let svc = svc();
        let book = make_book(&svc);
        let doc = make_document(&svc, &book, "s1");

        // pending -> reviewed is illegal.
        assert!(matches!(
            svc.document_transition(&doc.id, DocumentStatus::Reviewed, None),
            Err(CoreError::InvalidStatusTransition { .. })
        ));

        let doc2 = svc
            .document_transition(&doc.id, DocumentStatus::Processing, None)
            .unwrap();
        assert_eq!(doc2.status, DocumentStatus::Processing);
        let doc3 = svc
            .document_transition(&doc.id, DocumentStatus::Extracted, None)
            .unwrap();
        assert_eq!(doc3.status, DocumentStatus::Extracted);
        let doc4 = svc
            .document_transition(&doc.id, DocumentStatus::Reviewed, None)
            .unwrap();
        assert_eq!(doc4.status, DocumentStatus::Reviewed);

        // Failure + retry path.
        let doc_b = make_document(&svc, &book, "s2");
        let failed = svc
            .document_transition(&doc_b.id, DocumentStatus::Failed, Some("no text found"))
            .unwrap();
        assert_eq!(failed.status, DocumentStatus::Failed);
        assert_eq!(failed.error.as_deref(), Some("no text found"));
        let retried = svc
            .document_transition(&doc_b.id, DocumentStatus::Pending, None)
            .unwrap();
        assert_eq!(retried.status, DocumentStatus::Pending);
    }

    #[test]
    fn document_record_extraction_sets_current_payload() {
        let svc = svc();
        let book = make_book(&svc);
        let doc = make_document(&svc, &book, "s1");
        svc.document_transition(&doc.id, DocumentStatus::Processing, None)
            .unwrap();

        let payload = r#"{"schema":"slip-v2","totals":{"total_minor":12345}}"#;
        let extraction = svc
            .document_record_extraction(&doc.id, Some("openai"), Some("gpt-x"), payload)
            .unwrap();
        assert!(extraction.is_current);
        assert_eq!(
            svc.document_get(&doc.id).unwrap().status,
            DocumentStatus::Extracted
        );

        // A re-run replaces the current extraction.
        let second = svc
            .document_record_extraction(&doc.id, Some("openai"), Some("gpt-y"), payload)
            .unwrap();
        let current = svc.document_current_extraction(&doc.id).unwrap().unwrap();
        assert_eq!(current.id, second.id);
        assert_ne!(current.id, extraction.id);

        // Invalid JSON payloads are rejected.
        assert!(matches!(
            svc.document_record_extraction(&doc.id, None, None, "not json"),
            Err(CoreError::Json(_))
        ));
    }

    // -- ledger -------------------------------------------------------------

    #[test]
    fn coa_seed_is_idempotent() {
        let svc = svc();
        let book = make_book(&svc);
        let first = svc.coa_seed(&book.id).unwrap();
        assert!(!first.is_empty());
        let second = svc.coa_seed(&book.id).unwrap();
        assert_eq!(first.len(), second.len());
        assert_eq!(
            first.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
            second.iter().map(|c| c.id.clone()).collect::<Vec<_>>()
        );
        // ZA VAT rate table seeded too: standard, zero-rated, exempt.
        let rates = svc.vat_rate_list(&book.id).unwrap();
        assert_eq!(rates.len(), 3);
        let std = rates.iter().find(|r| r.code == "STD").unwrap();
        assert_eq!(std.rate_bps, 1500);
        assert!(rates
            .iter()
            .filter(|r| r.code == "ZER" || r.code == "EXE")
            .all(|r| r.rate_bps == 0));
    }

    #[test]
    fn coa_seed_is_kind_specific() {
        let svc = svc();
        let personal = make_book(&svc);
        let business = svc
            .book_create(NewBook {
                name: "Biz".into(),
                kind: BookKind::Business,
                currency: None,
                country: Some("ZA".into()),
            })
            .unwrap();
        let personal_coa = svc.coa_seed(&personal.id).unwrap();
        let business_coa = svc.coa_seed(&business.id).unwrap();

        // Personal books have no VAT control accounts.
        assert!(personal_coa.iter().all(|c| !c.name.contains("VAT")));
        assert!(personal_coa.iter().any(|c| c.code == "6000"));

        // Business seed is the SA small-business chart with VAT controls.
        let vat_input = business_coa.iter().find(|c| c.code == "1400").unwrap();
        assert_eq!(vat_input.kind, CoaKind::Asset);
        let vat_output = business_coa.iter().find(|c| c.code == "2100").unwrap();
        assert_eq!(vat_output.kind, CoaKind::Liability);
        assert!(business_coa.iter().any(|c| c.code == "5000"));
        assert!(business_coa.len() > personal_coa.len());
        // All seeded accounts are system accounts without a fixed currency.
        assert!(business_coa
            .iter()
            .all(|c| c.is_system && c.currency.is_none()));
    }

    #[test]
    fn journal_post_balanced_and_trial_balance() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let bank = coa.iter().find(|c| c.code == "1000").unwrap();
        let expenses = coa.iter().find(|c| c.code == "6000").unwrap();

        let posted = svc
            .journal_post(NewJournal {
                book_id: book.id.clone(),
                posted_date: "2026-07-01".into(),
                narrative: Some("Office chair".into()),
                reference: None,
                source_type: JournalSourceType::Manual,
                source_id: None,
                lines: vec![
                    NewJournalLine {
                        coa_id: expenses.id.clone(),
                        debit_minor: 250_000,
                        credit_minor: 0,
                        currency: "ZAR".into(),
                        description: None,
                        vat_rate_id: None,
                        vat_role: None,
                    },
                    NewJournalLine {
                        coa_id: bank.id.clone(),
                        debit_minor: 0,
                        credit_minor: 250_000,
                        currency: "ZAR".into(),
                        description: None,
                        vat_rate_id: None,
                        vat_role: None,
                    },
                ],
            })
            .unwrap();
        assert_eq!(posted.lines.len(), 2);
        assert_eq!(svc.journal_get(&posted.journal.id).unwrap(), posted);

        let tb = svc.report_trial_balance(&book.id).unwrap();
        let bank_row = tb.iter().find(|r| r.code == "1000").unwrap();
        assert_eq!(bank_row.credit_minor, 250_000);
        let exp_row = tb.iter().find(|r| r.code == "6000").unwrap();
        assert_eq!(exp_row.debit_minor, 250_000);
        let debits: i64 = tb.iter().map(|r| r.debit_minor).sum();
        let credits: i64 = tb.iter().map(|r| r.credit_minor).sum();
        assert_eq!(debits, credits);
    }

    #[test]
    fn journal_post_rejects_unbalanced() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let bank = &coa[0];
        let err = svc
            .journal_post(NewJournal {
                book_id: book.id.clone(),
                posted_date: "2026-07-01".into(),
                narrative: None,
                reference: None,
                source_type: JournalSourceType::Manual,
                source_id: None,
                lines: vec![
                    NewJournalLine {
                        coa_id: bank.id.clone(),
                        debit_minor: 100,
                        credit_minor: 0,
                        currency: "ZAR".into(),
                        description: None,
                        vat_rate_id: None,
                        vat_role: None,
                    },
                    NewJournalLine {
                        coa_id: bank.id.clone(),
                        debit_minor: 0,
                        credit_minor: 99,
                        currency: "ZAR".into(),
                        description: None,
                        vat_rate_id: None,
                        vat_role: None,
                    },
                ],
            })
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::UnbalancedJournal {
                debit_minor: 100,
                credit_minor: 99
            }
        ));
        // Nothing was written.
        assert!(svc
            .report_trial_balance(&book.id)
            .unwrap()
            .iter()
            .all(|r| r.debit_minor == 0 && r.credit_minor == 0));
    }

    #[test]
    fn journal_post_rejects_too_few_lines_and_two_sided_lines() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let bank = &coa[0];

        let err = svc
            .journal_post(NewJournal {
                book_id: book.id.clone(),
                posted_date: "2026-07-01".into(),
                narrative: None,
                reference: None,
                source_type: JournalSourceType::Manual,
                source_id: None,
                lines: vec![],
            })
            .unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)));

        let err = svc
            .journal_post(NewJournal {
                book_id: book.id.clone(),
                posted_date: "2026-07-01".into(),
                narrative: None,
                reference: None,
                source_type: JournalSourceType::Manual,
                source_id: None,
                lines: vec![
                    NewJournalLine {
                        coa_id: bank.id.clone(),
                        debit_minor: 50,
                        credit_minor: 50,
                        currency: "ZAR".into(),
                        description: None,
                        vat_rate_id: None,
                        vat_role: None,
                    },
                    NewJournalLine {
                        coa_id: bank.id.clone(),
                        debit_minor: 0,
                        credit_minor: 50,
                        currency: "ZAR".into(),
                        description: None,
                        vat_rate_id: None,
                        vat_role: None,
                    },
                ],
            })
            .unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)));
    }

    // -- recon --------------------------------------------------------------

    #[test]
    fn recon_suggest_and_confirm() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let doc = make_document(&svc, &book, "r1");

        let mut new = make_txn(&svc, &book, &account);
        new.document_id = Some(doc.id.clone());
        let txn = svc.transaction_create(new).unwrap();

        let suggestions = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].transaction_id, txn.id);
        assert_eq!(suggestions[0].document_id.as_deref(), Some(doc.id.as_str()));

        // Idempotent: re-running does not duplicate.
        let again = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(again.len(), 1);

        let confirmed = svc.recon_confirm(&suggestions[0].id).unwrap();
        assert_eq!(confirmed.state, ReconState::Confirmed);
        // Confirmed matches leave the suggestion list.
        assert!(svc.recon_suggest(&book.id).unwrap().is_empty());
    }

    // -- reports ------------------------------------------------------------

    #[test]
    fn report_spending_groups_by_category() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let cat = make_category(&svc, &book, "Groceries");

        let mut a = make_txn(&svc, &book, &account);
        a.category_id = Some(cat.id.clone());
        a.amount_minor = -10_000;
        svc.transaction_create(a).unwrap();

        let mut b = make_txn(&svc, &book, &account);
        b.merchant = Some("Uncategorized Store".into());
        b.amount_minor = -5_000;
        b.posted_date = "2026-07-02".into();
        svc.transaction_create(b).unwrap();

        // Income must not appear in spending.
        let mut income = make_txn(&svc, &book, &account);
        income.merchant = Some("Employer".into());
        income.amount_minor = 100_000;
        income.posted_date = "2026-07-03".into();
        svc.transaction_create(income).unwrap();

        let rows = svc
            .report_spending(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].category_name, "Groceries");
        assert_eq!(rows[0].total_minor, 10_000);
        assert_eq!(rows[1].category_name, "Uncategorized");
        assert_eq!(rows[1].total_minor, 5_000);
    }

    // -- settings -----------------------------------------------------------

    #[test]
    fn settings_plain_round_trip() {
        let svc = svc();
        assert_eq!(svc.settings_get("theme").unwrap(), None);
        svc.settings_set("theme", "dark", false).unwrap();
        assert_eq!(svc.settings_get("theme").unwrap(), Some("dark".into()));
        svc.settings_set("theme", "light", false).unwrap();
        assert_eq!(svc.settings_get("theme").unwrap(), Some("light".into()));
    }

    #[test]
    fn settings_secret_never_touches_sqlite_and_is_write_only() {
        let svc = svc();
        svc.settings_set("llm.api_key", "sk-super-secret", true)
            .unwrap();
        // The generic getter never dereferences secret material — the
        // settings read path over IPC/HTTP cannot become a secret exfil path.
        assert!(matches!(
            svc.settings_get("llm.api_key"),
            Err(CoreError::Validation(_))
        ));
        // Consumers receive the material only inside a closure.
        let len = svc
            .settings_use_secret("llm.api_key", |s| s.expose_secret().len())
            .unwrap();
        assert_eq!(len, Some("sk-super-secret".len()));
        // Unset keys read as absent; plain keys are not secrets.
        assert_eq!(svc.settings_use_secret("missing", |_| ()).unwrap(), None);
        svc.settings_set("theme", "dark", false).unwrap();
        assert!(matches!(
            svc.settings_use_secret("theme", |_| ()),
            Err(CoreError::Validation(_))
        ));
        // The DB row holds only the keychain reference, never the value.
        let row = repo::settings::get(svc.conn(), "llm.api_key")
            .unwrap()
            .unwrap();
        assert_eq!(row.value, "");
        assert_eq!(row.secret_ref.as_deref(), Some("settings.llm.api_key"));
        // And the audit log never contains the secret.
        let audit = svc.audit_list(None, 50).unwrap();
        assert!(audit.iter().all(|e| !e
            .after_json
            .as_deref()
            .unwrap_or("")
            .contains("sk-super-secret")));
    }

    // -- audit --------------------------------------------------------------

    #[test]
    fn audit_log_is_append_only() {
        let svc = svc();
        let book = make_book(&svc);
        let entries = svc.audit_list(Some(&book.id), 10).unwrap();
        assert!(!entries.is_empty());

        let update = svc.conn().execute(
            "UPDATE audit_log SET action = 'tampered' WHERE id = ?1",
            rusqlite::params![entries[0].id],
        );
        assert!(update.is_err(), "UPDATE on audit_log must be blocked");

        let delete = svc
            .conn()
            .execute("DELETE FROM audit_log", rusqlite::params![]);
        assert!(delete.is_err(), "DELETE on audit_log must be blocked");
    }

    #[test]
    fn mutations_emit_audit_entries() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let cat = make_category(&svc, &book, "Groceries");
        let txn = svc
            .transaction_create(make_txn(&svc, &book, &account))
            .unwrap();
        svc.transaction_categorize(&txn.id, &cat.id).unwrap();

        let actions: Vec<(String, String)> = svc
            .audit_list(Some(&book.id), 50)
            .unwrap()
            .into_iter()
            .map(|e| (e.entity_type, e.action))
            .collect();
        for expected in [
            ("book", "create"),
            ("account", "create"),
            ("category", "create"),
            ("transaction", "create"),
            ("transaction", "categorize"),
        ] {
            assert!(
                actions
                    .iter()
                    .any(|(t, a)| t == expected.0 && a == expected.1),
                "missing audit entry {expected:?}"
            );
        }
    }

    // =======================================================================
    // Accounting engine
    // =======================================================================

    fn make_business(svc: &CoreService) -> Book {
        svc.book_create(NewBook {
            name: "Biz".into(),
            kind: BookKind::Business,
            currency: None,
            country: Some("ZA".into()),
        })
        .unwrap()
    }

    fn by_code<'a>(coa: &'a [CoaAccount], code: &str) -> &'a CoaAccount {
        coa.iter()
            .find(|c| c.code == code)
            .unwrap_or_else(|| panic!("missing CoA code {code}"))
    }

    fn rate<'a>(rates: &'a [VatRate], code: &str) -> &'a VatRate {
        rates
            .iter()
            .find(|r| r.code == code)
            .unwrap_or_else(|| panic!("missing VAT rate {code}"))
    }

    fn jl(coa: &CoaAccount, debit: i64, credit: i64) -> NewJournalLine {
        NewJournalLine {
            coa_id: coa.id.clone(),
            debit_minor: debit,
            credit_minor: credit,
            currency: "ZAR".into(),
            description: None,
            vat_rate_id: None,
            vat_role: None,
        }
    }

    fn jl_vat(
        coa: &CoaAccount,
        debit: i64,
        credit: i64,
        vat_rate: &VatRate,
        role: VatRole,
    ) -> NewJournalLine {
        let mut line = jl(coa, debit, credit);
        line.vat_rate_id = Some(vat_rate.id.clone());
        line.vat_role = Some(role);
        line
    }

    fn manual(book: &Book, date: &str, lines: Vec<NewJournalLine>) -> NewJournal {
        NewJournal {
            book_id: book.id.clone(),
            posted_date: date.into(),
            narrative: None,
            reference: None,
            source_type: JournalSourceType::Manual,
            source_id: None,
            lines,
        }
    }

    /// A seeded business book with a small, fully-VAT-tagged history:
    ///
    /// * 2026-01-05 capital: bank D 100 000 / owner's capital C 100 000
    /// * 2026-02-01 sale: bank D 11 500 / sales C 10 000 (output base) /
    ///   VAT output C 1 500 (output VAT)
    /// * 2026-02-10 purchase: expenses D 2 000 (input base) / VAT input
    ///   D 300 (input VAT) / bank C 2 300
    /// * 2026-04-01 rent: rent D 5 000 / bank C 5 000
    fn fixture_book(svc: &CoreService) -> (Book, Vec<CoaAccount>, Vec<VatRate>) {
        let book = make_business(svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let rates = svc.vat_rate_list(&book.id).unwrap();
        let std = rate(&rates, "STD");
        let bank = by_code(&coa, "1000");
        let capital = by_code(&coa, "3000");
        let sales = by_code(&coa, "4000");
        let vat_out = by_code(&coa, "2100");
        let vat_in = by_code(&coa, "1400");
        let general = by_code(&coa, "6900");
        let rent = by_code(&coa, "6500");

        svc.journal_post(manual(
            &book,
            "2026-01-05",
            vec![jl(bank, 100_000, 0), jl(capital, 0, 100_000)],
        ))
        .unwrap();
        svc.journal_post(manual(
            &book,
            "2026-02-01",
            vec![
                jl(bank, 11_500, 0),
                jl_vat(sales, 0, 10_000, std, VatRole::OutputBase),
                jl_vat(vat_out, 0, 1_500, std, VatRole::OutputVat),
            ],
        ))
        .unwrap();
        svc.journal_post(manual(
            &book,
            "2026-02-10",
            vec![
                jl_vat(general, 2_000, 0, std, VatRole::InputBase),
                jl_vat(vat_in, 300, 0, std, VatRole::InputVat),
                jl(bank, 0, 2_300),
            ],
        ))
        .unwrap();
        svc.journal_post(manual(
            &book,
            "2026-04-01",
            vec![jl(rent, 5_000, 0), jl(bank, 0, 5_000)],
        ))
        .unwrap();
        (book, coa, rates)
    }

    // -- immutability & reversal --------------------------------------------

    #[test]
    fn posted_journals_are_immutable() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let posted = svc
            .journal_post(manual(
                &book,
                "2026-07-01",
                vec![
                    jl(by_code(&coa, "6000"), 100, 0),
                    jl(by_code(&coa, "1000"), 0, 100),
                ],
            ))
            .unwrap();

        let update_journal = svc.conn().execute(
            "UPDATE journals SET narrative = 'tampered' WHERE id = ?1",
            rusqlite::params![posted.journal.id],
        );
        assert!(update_journal.is_err(), "UPDATE journals must be blocked");
        let delete_journal = svc.conn().execute(
            "DELETE FROM journals WHERE id = ?1",
            rusqlite::params![posted.journal.id],
        );
        assert!(delete_journal.is_err(), "DELETE journals must be blocked");
        let update_line = svc.conn().execute(
            "UPDATE journal_lines SET debit_minor = 999 WHERE journal_id = ?1",
            rusqlite::params![posted.journal.id],
        );
        assert!(update_line.is_err(), "UPDATE journal_lines must be blocked");
        let delete_line = svc.conn().execute(
            "DELETE FROM journal_lines WHERE journal_id = ?1",
            rusqlite::params![posted.journal.id],
        );
        assert!(delete_line.is_err(), "DELETE journal_lines must be blocked");
    }

    #[test]
    fn journal_reverse_flips_lines_and_nets_out() {
        let svc = svc();
        let (book, _, _) = fixture_book(&svc);
        // Reverse the purchase (the only journal on 2026-02-10).
        let purchase = &svc
            .journal_list(&book.id, "2026-02-10", "2026-02-10")
            .unwrap()[0];

        let reversal = svc
            .journal_reverse(&purchase.journal.id, None, None)
            .unwrap();
        assert_eq!(
            reversal.journal.reversal_of.as_deref(),
            Some(purchase.journal.id.as_str())
        );
        assert_eq!(reversal.lines.len(), purchase.lines.len());
        for (orig, rev) in purchase.lines.iter().zip(&reversal.lines) {
            assert_eq!(orig.coa_id, rev.coa_id);
            assert_eq!(orig.debit_minor, rev.credit_minor);
            assert_eq!(orig.credit_minor, rev.debit_minor);
            // VAT tags survive so the VAT201 nets out.
            assert_eq!(orig.vat_rate_id, rev.vat_rate_id);
            assert_eq!(orig.vat_role, rev.vat_role);
        }

        // The purchase's input VAT is cancelled in the VAT201.
        let vat = svc
            .report_vat201(&book.id, "2026-02-01", "2026-02-28")
            .unwrap();
        assert_eq!(vat.input_vat_minor, 0);
        assert_eq!(vat.output_vat_minor, 1_500);

        // Expenses net to zero on the trial balance for that account.
        let tb = svc.report_trial_balance(&book.id).unwrap();
        let general = tb.iter().find(|r| r.code == "6900").unwrap();
        assert_eq!(general.debit_minor, general.credit_minor);

        // A journal can be reversed exactly once.
        assert!(matches!(
            svc.journal_reverse(&purchase.journal.id, None, None),
            Err(CoreError::DuplicateJournal { .. })
        ));
        // Audit trail records the reversal.
        let audit = svc.audit_list(Some(&book.id), 50).unwrap();
        assert!(audit
            .iter()
            .any(|a| a.entity_type == "journal" && a.action == "reverse"));
    }

    // -- posting rules ------------------------------------------------------

    #[test]
    fn journal_post_respects_lock_date() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let locked = svc
            .book_set_lock_date(&book.id, Some("2026-06-30"))
            .unwrap();
        assert_eq!(locked.financial_lock_date.as_deref(), Some("2026-06-30"));

        let lines =
            |date: &str| manual(&book, date, vec![jl(&coa[0], 100, 0), jl(&coa[1], 0, 100)]);
        assert!(matches!(
            svc.journal_post(lines("2026-06-30")),
            Err(CoreError::Validation(_))
        ));
        assert!(matches!(
            svc.journal_post(lines("2026-05-01")),
            Err(CoreError::Validation(_))
        ));
        svc.journal_post(lines("2026-07-01")).unwrap();

        // Unlock and backfill.
        svc.book_set_lock_date(&book.id, None).unwrap();
        svc.journal_post(lines("2026-05-01")).unwrap();

        // Garbage lock dates are rejected.
        assert!(matches!(
            svc.book_set_lock_date(&book.id, Some("June 2026")),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn journal_post_rejects_bad_dates_and_archived_accounts() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        assert!(matches!(
            svc.journal_post(manual(
                &book,
                "yesterday",
                vec![jl(&coa[0], 100, 0), jl(&coa[1], 0, 100)],
            )),
            Err(CoreError::Validation(_))
        ));

        let archived = svc.coa_archive(&coa[0].id).unwrap();
        assert!(archived.is_archived);
        assert!(matches!(
            svc.journal_post(manual(
                &book,
                "2026-07-01",
                vec![jl(&coa[0], 100, 0), jl(&coa[1], 0, 100)],
            )),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn journal_post_balances_per_currency() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let bank = by_code(&coa, "1000");
        let expenses = by_code(&coa, "6000");
        let usd = |coa: &CoaAccount, d: i64, c: i64| {
            let mut line = jl(coa, d, c);
            line.currency = "USD".into();
            line
        };

        // Balanced in each currency: accepted.
        svc.journal_post(manual(
            &book,
            "2026-07-01",
            vec![
                jl(expenses, 10_000, 0),
                jl(bank, 0, 10_000),
                usd(expenses, 500, 0),
                usd(bank, 0, 500),
            ],
        ))
        .unwrap();

        // Balanced only across currencies: rejected.
        assert!(matches!(
            svc.journal_post(manual(
                &book,
                "2026-07-01",
                vec![jl(expenses, 700, 0), usd(bank, 0, 700)],
            )),
            Err(CoreError::UnbalancedJournal { .. })
        ));
    }

    #[test]
    fn journal_post_normalizes_currency_case() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let mut debit = jl(by_code(&coa, "6000"), 100, 0);
        debit.currency = "zar".into();
        let mut credit = jl(by_code(&coa, "1000"), 0, 100);
        credit.currency = "ZAR".into();
        // "zar" and "ZAR" are the same currency — the journal balances and
        // both stored lines carry the canonical uppercase code.
        let posted = svc
            .journal_post(manual(&book, "2026-07-01", vec![debit, credit]))
            .unwrap();
        assert!(posted.lines.iter().all(|l| l.currency == "ZAR"));

        // Garbage codes are rejected outright.
        let mut bad = jl(by_code(&coa, "6000"), 100, 0);
        bad.currency = "Z1R".into();
        assert!(matches!(
            svc.journal_post(manual(
                &book,
                "2026-07-01",
                vec![bad, jl(by_code(&coa, "1000"), 0, 100)],
            )),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn journal_post_bounds_line_amounts() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        // Lines above the bound are rejected — huge values could wrap the
        // release-mode balance check and overflow SQLite SUM() aggregation.
        assert!(matches!(
            svc.journal_post(manual(
                &book,
                "2026-07-01",
                vec![
                    jl(by_code(&coa, "6000"), i64::MAX, 0),
                    jl(by_code(&coa, "1000"), 0, i64::MAX),
                ],
            )),
            Err(CoreError::Validation(_))
        ));
        // A wrap-crafted journal (debits [MAX, MAX, 4] vs credits [1, 1]
        // wraps to equality in i64) must not pass the balance check.
        assert!(svc
            .journal_post(manual(
                &book,
                "2026-07-01",
                vec![
                    jl(by_code(&coa, "6000"), i64::MAX, 0),
                    jl(by_code(&coa, "6000"), i64::MAX, 0),
                    jl(by_code(&coa, "6000"), 4, 0),
                    jl(by_code(&coa, "1000"), 0, 1),
                    jl(by_code(&coa, "1000"), 0, 1),
                ],
            ))
            .is_err());
    }

    #[test]
    fn fixed_currency_accounts_reject_other_currencies() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let usd_account = svc
            .coa_create(NewCoaAccount {
                book_id: book.id.clone(),
                code: "1900".into(),
                name: "USD Savings".into(),
                kind: CoaKind::Asset,
                description: None,
                currency: Some("USD".into()),
            })
            .unwrap();
        assert_eq!(usd_account.currency.as_deref(), Some("USD"));

        // A ZAR line on the USD-fixed account is rejected.
        assert!(matches!(
            svc.journal_post(manual(
                &book,
                "2026-07-01",
                vec![jl(&usd_account, 100, 0), jl(by_code(&coa, "1000"), 0, 100)],
            )),
            Err(CoreError::Validation(_))
        ));

        // USD lines are fine (bank has no fixed currency).
        let mut d = jl(&usd_account, 100, 0);
        d.currency = "USD".into();
        let mut c = jl(by_code(&coa, "1000"), 0, 100);
        c.currency = "USD".into();
        svc.journal_post(manual(&book, "2026-07-01", vec![d, c]))
            .unwrap();

        // Duplicate CoA codes are rejected.
        assert!(matches!(
            svc.coa_create(NewCoaAccount {
                book_id: book.id.clone(),
                code: "1900".into(),
                name: "Again".into(),
                kind: CoaKind::Asset,
                description: None,
                currency: None,
            }),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn one_journal_per_source() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let mut journal = manual(
            &book,
            "2026-07-01",
            vec![jl(&coa[0], 100, 0), jl(&coa[1], 0, 100)],
        );
        journal.source_type = JournalSourceType::Transaction;
        journal.source_id = Some("txn-1".into());
        let first = svc.journal_post(journal.clone()).unwrap();
        match svc.journal_post(journal).unwrap_err() {
            CoreError::DuplicateJournal { source_id, .. } => {
                assert_eq!(source_id, first.journal.id)
            }
            other => panic!("expected DuplicateJournal, got {other:?}"),
        }
    }

    // -- VAT accrual via journal generation ---------------------------------

    #[test]
    fn generate_expense_journal_with_vat_split() {
        let svc = svc();
        let book = make_business(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let rates = svc.vat_rate_list(&book.id).unwrap();
        let std = rate(&rates, "STD");
        let account = make_account(&svc, &book);
        let cat = make_category(&svc, &book, "Bank charges");
        svc.coa_map_set(
            &book.id,
            CoaMapEntity::Category,
            &cat.id,
            &by_code(&coa, "6100").id,
        )
        .unwrap();

        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = -11_500;
        new.category_id = Some(cat.id.clone());
        let txn = svc.transaction_create(new).unwrap();

        let posted = svc
            .journal_generate_for_transaction(&txn.id, Some(&std.id))
            .unwrap();
        assert_eq!(posted.journal.source_type, JournalSourceType::Transaction);
        assert_eq!(posted.journal.source_id.as_deref(), Some(txn.id.as_str()));
        assert_eq!(posted.lines.len(), 3);

        let base = &posted.lines[0];
        assert_eq!(base.coa_id, by_code(&coa, "6100").id); // mapped category
        assert_eq!(base.debit_minor, 10_000);
        assert_eq!(base.vat_role, Some(VatRole::InputBase));
        assert_eq!(base.vat_rate_id.as_deref(), Some(std.id.as_str()));
        let vat = &posted.lines[1];
        assert_eq!(vat.coa_id, by_code(&coa, "1400").id);
        assert_eq!(vat.debit_minor, 1_500);
        assert_eq!(vat.vat_role, Some(VatRole::InputVat));
        let bank = &posted.lines[2];
        assert_eq!(bank.coa_id, by_code(&coa, "1000").id);
        assert_eq!(bank.credit_minor, 11_500);
        assert_eq!(bank.vat_role, None);

        // End-to-end: it lands in the VAT201.
        let vat201 = svc
            .report_vat201(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        assert_eq!(vat201.input_vat_minor, 1_500);
        assert_eq!(vat201.net_vat_minor, -1_500);
        let row = vat201.rows.iter().find(|r| r.code == "STD").unwrap();
        assert_eq!(row.input_base_minor, 10_000);

        // One journal per transaction.
        assert!(matches!(
            svc.journal_generate_for_transaction(&txn.id, Some(&std.id)),
            Err(CoreError::DuplicateJournal { .. })
        ));
    }

    #[test]
    fn generate_income_journal_with_vat_and_zero_rated() {
        let svc = svc();
        let book = make_business(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let rates = svc.vat_rate_list(&book.id).unwrap();
        let account = make_account(&svc, &book);

        // Standard-rated sale: R230.00 in.
        let mut sale = make_txn(&svc, &book, &account);
        sale.amount_minor = 23_000;
        sale.merchant = Some("Client A".into());
        let sale = svc.transaction_create(sale).unwrap();
        let posted = svc
            .journal_generate_for_transaction(&sale.id, Some(&rate(&rates, "STD").id))
            .unwrap();
        assert_eq!(posted.lines.len(), 3);
        assert_eq!(posted.lines[0].debit_minor, 23_000); // bank
        assert_eq!(posted.lines[1].credit_minor, 20_000); // income net
        assert_eq!(posted.lines[1].vat_role, Some(VatRole::OutputBase));
        assert_eq!(posted.lines[2].credit_minor, 3_000); // VAT output
        assert_eq!(posted.lines[2].coa_id, by_code(&coa, "2100").id);
        assert_eq!(posted.lines[2].vat_role, Some(VatRole::OutputVat));

        // Zero-rated sale: no VAT line, base still tagged for the return.
        let mut zero = make_txn(&svc, &book, &account);
        zero.amount_minor = 5_000;
        zero.merchant = Some("Export client".into());
        zero.posted_date = "2026-07-02".into();
        let zero = svc.transaction_create(zero).unwrap();
        let posted = svc
            .journal_generate_for_transaction(&zero.id, Some(&rate(&rates, "ZER").id))
            .unwrap();
        assert_eq!(posted.lines.len(), 2);
        assert_eq!(posted.lines[1].vat_role, Some(VatRole::OutputBase));

        let vat201 = svc
            .report_vat201(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        assert_eq!(vat201.output_vat_minor, 3_000);
        assert_eq!(vat201.standard_rated_supplies_minor, 20_000);
        assert_eq!(vat201.zero_rated_supplies_minor, 5_000);
        assert_eq!(vat201.net_vat_minor, 3_000);
    }

    #[test]
    fn purchase_refund_books_input_vat_adjustment_not_a_sale() {
        // Regression: a supplier refund (inflow whose counter account is an
        // expense) was booked as a sale, inflating the VAT201 supply and
        // output-VAT boxes even though net VAT was right.
        let svc = svc();
        let book = make_business(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let rates = svc.vat_rate_list(&book.id).unwrap();
        let std = rate(&rates, "STD");
        let account = make_account(&svc, &book);
        let cat = make_category(&svc, &book, "Supplies");
        svc.coa_map_set(
            &book.id,
            CoaMapEntity::Category,
            &cat.id,
            &by_code(&coa, "6450").id,
        )
        .unwrap();

        // R115.00 purchase, then its R115.00 refund — both STD 15%.
        let mut purchase = make_txn(&svc, &book, &account);
        purchase.amount_minor = -11_500;
        purchase.category_id = Some(cat.id.clone());
        let purchase = svc.transaction_create(purchase).unwrap();
        svc.journal_generate_for_transaction(&purchase.id, Some(&std.id))
            .unwrap();

        let mut refund = make_txn(&svc, &book, &account);
        refund.amount_minor = 11_500;
        refund.category_id = Some(cat.id.clone());
        refund.posted_date = "2026-07-05".into();
        let refund = svc.transaction_create(refund).unwrap();
        let posted = svc
            .journal_generate_for_transaction(&refund.id, Some(&std.id))
            .unwrap();

        // Refund journal: debit bank, credit expense (input base), credit
        // VAT *input* control — never the output side.
        assert_eq!(posted.lines.len(), 3);
        assert_eq!(posted.lines[0].debit_minor, 11_500); // bank
        let base = &posted.lines[1];
        assert_eq!(base.coa_id, by_code(&coa, "6450").id);
        assert_eq!(base.credit_minor, 10_000);
        assert_eq!(base.vat_role, Some(VatRole::InputBase));
        let vat = &posted.lines[2];
        assert_eq!(vat.coa_id, by_code(&coa, "1400").id); // VAT Input Control
        assert_eq!(vat.credit_minor, 1_500);
        assert_eq!(vat.vat_role, Some(VatRole::InputVat));

        // VAT201: the supply/turnover boxes must not be inflated — the
        // purchase and its refund cancel on the *input* side.
        let vat201 = svc
            .report_vat201(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        assert_eq!(vat201.output_vat_minor, 0);
        assert_eq!(vat201.standard_rated_supplies_minor, 0);
        assert_eq!(vat201.input_vat_minor, 0);
        assert_eq!(vat201.net_vat_minor, 0);
    }

    #[test]
    fn generate_document_journal_splits_vat_by_rate() {
        let svc = svc();
        let book = make_business(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let doc = make_document(&svc, &book, "slip-vat");
        let payload = r#"{
            "merchant": {"name": "Pick n Pay"},
            "purchased_at": "2026-03-05T09:00:00Z",
            "currency": "ZAR",
            "totals": {"total_minor": 14500, "vat_minor": 1500},
            "vat_breakdown": [
                {"rate_bps": 1500, "base_minor": 10000, "vat_minor": 1500},
                {"rate_bps": 0, "base_minor": 3000, "vat_minor": 0}
            ]
        }"#;
        svc.document_record_extraction(&doc.id, Some("test"), None, payload)
            .unwrap();

        let posted = svc.journal_generate_for_document(&doc.id).unwrap();
        assert_eq!(posted.journal.source_type, JournalSourceType::Document);
        assert_eq!(posted.journal.posted_date, "2026-03-05");
        assert_eq!(posted.lines.len(), 4);
        let expense = by_code(&coa, "6900");
        let vat_in = by_code(&coa, "1400");
        // Standard-rated group: base + input VAT.
        assert_eq!(posted.lines[0].coa_id, expense.id);
        assert_eq!(posted.lines[0].debit_minor, 10_000);
        assert_eq!(posted.lines[0].vat_role, Some(VatRole::InputBase));
        assert_eq!(posted.lines[1].coa_id, vat_in.id);
        assert_eq!(posted.lines[1].debit_minor, 1_500);
        // Zero-rated group: base only, tagged with the ZER rate.
        assert_eq!(posted.lines[2].debit_minor, 3_000);
        let rates = svc.vat_rate_list(&book.id).unwrap();
        assert_eq!(
            posted.lines[2].vat_rate_id.as_deref(),
            Some(rate(&rates, "ZER").id.as_str())
        );
        // Gross credit against bank.
        assert_eq!(posted.lines[3].credit_minor, 14_500);

        // Debits equal credits, always.
        let d: i64 = posted.lines.iter().map(|l| l.debit_minor).sum();
        let c: i64 = posted.lines.iter().map(|l| l.credit_minor).sum();
        assert_eq!(d, c);

        assert!(matches!(
            svc.journal_generate_for_document(&doc.id),
            Err(CoreError::DuplicateJournal { .. })
        ));
    }

    #[test]
    fn generate_document_journal_balances_rounded_and_tipped_slips() {
        let svc = svc();
        let book = make_business(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();

        // Cash-rounded slip: breakdown sums to 996 but the stated (paid)
        // total is 1000 — valid within the extract tolerance. The 4-minor
        // remainder posts to expenses untagged so the journal balances.
        let doc = make_document(&svc, &book, "slip-rounded");
        let payload = r#"{
            "merchant": {"name": "Cafe"},
            "currency": "ZAR",
            "totals": {"total_minor": 1000, "vat_minor": 130},
            "vat_breakdown": [
                {"rate_bps": 1500, "base_minor": 866, "vat_minor": 130}
            ]
        }"#;
        svc.document_record_extraction(&doc.id, Some("test"), None, payload)
            .unwrap();
        let posted = svc.journal_generate_for_document(&doc.id).unwrap();
        let d: i64 = posted.lines.iter().map(|l| l.debit_minor).sum();
        let c: i64 = posted.lines.iter().map(|l| l.credit_minor).sum();
        assert_eq!(d, c, "rounded slips must balance");
        assert_eq!(c, 1_000);
        let rounding = posted
            .lines
            .iter()
            .find(|l| l.vat_role.is_none() && l.debit_minor == 4)
            .expect("rounding remainder line");
        assert_eq!(rounding.coa_id, by_code(&coa, "6900").id);
        // The VAT figures stay exactly as stated on the invoice.
        let vat = posted
            .lines
            .iter()
            .find(|l| l.vat_role == Some(VatRole::InputVat))
            .unwrap();
        assert_eq!(vat.debit_minor, 130);

        // Tipped slip: 11 500 breakdown + 1 000 tip = 12 500 paid.
        let doc = make_document(&svc, &book, "slip-tipped");
        let payload = r#"{
            "merchant": {"name": "Restaurant"},
            "currency": "ZAR",
            "totals": {"total_minor": 12500, "vat_minor": 1500, "tip_minor": 1000},
            "vat_breakdown": [
                {"rate_bps": 1500, "base_minor": 10000, "vat_minor": 1500}
            ]
        }"#;
        svc.document_record_extraction(&doc.id, Some("test"), None, payload)
            .unwrap();
        let posted = svc.journal_generate_for_document(&doc.id).unwrap();
        let d: i64 = posted.lines.iter().map(|l| l.debit_minor).sum();
        let c: i64 = posted.lines.iter().map(|l| l.credit_minor).sum();
        assert_eq!(d, c, "tipped slips must balance");
        assert_eq!(c, 12_500);
        assert!(posted
            .lines
            .iter()
            .any(|l| l.vat_role.is_none() && l.debit_minor == 1_000));

        // Negative group (discount / credit line): posts as credits, and the
        // journal still balances instead of erroring or dropping the group.
        let doc = make_document(&svc, &book, "slip-discount");
        let payload = r#"{
            "merchant": {"name": "Outlet"},
            "currency": "ZAR",
            "totals": {"total_minor": 10350, "vat_minor": 1350},
            "vat_breakdown": [
                {"rate_bps": 1500, "base_minor": 10000, "vat_minor": 1500},
                {"rate_bps": 1500, "base_minor": -1000, "vat_minor": -150}
            ]
        }"#;
        svc.document_record_extraction(&doc.id, Some("test"), None, payload)
            .unwrap();
        let posted = svc.journal_generate_for_document(&doc.id).unwrap();
        let d: i64 = posted.lines.iter().map(|l| l.debit_minor).sum();
        let c: i64 = posted.lines.iter().map(|l| l.credit_minor).sum();
        assert_eq!(d, c);
        assert_eq!(c, 10_350 + 1_000 + 150); // gross credit + negative group credits
        assert!(posted
            .lines
            .iter()
            .any(|l| l.vat_role == Some(VatRole::InputVat) && l.credit_minor == 150));
    }

    #[test]
    fn generate_document_journal_personal_book_posts_gross() {
        let svc = svc();
        let book = make_book(&svc);
        svc.coa_seed(&book.id).unwrap();
        let doc = make_document(&svc, &book, "slip-personal");
        let payload = r#"{
            "merchant": {"name": "Spar"},
            "totals": {"total_minor": 4600, "vat_minor": 600}
        }"#;
        svc.document_record_extraction(&doc.id, None, None, payload)
            .unwrap();
        let posted = svc.journal_generate_for_document(&doc.id).unwrap();
        // Personal books have no VAT input control: gross to expenses.
        assert_eq!(posted.lines.len(), 2);
        assert_eq!(posted.lines[0].debit_minor, 4_600);
        assert_eq!(posted.lines[0].vat_role, None);
        assert_eq!(posted.lines[1].credit_minor, 4_600);
    }

    // -- bank reconciliation ------------------------------------------------

    fn slip_doc(svc: &CoreService, book: &Book, sha: &str, payload: &str) -> Document {
        let doc = make_document(svc, book, sha);
        svc.document_record_extraction(&doc.id, Some("test"), None, payload)
            .unwrap();
        doc
    }

    #[test]
    fn recon_matches_document_by_amount_date_merchant() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let doc = slip_doc(
            &svc,
            &book,
            "r-exact",
            r#"{"merchant": {"name": "Woolworths"},
                "purchased_at": "2026-07-01T10:00:00Z",
                "currency": "ZAR",
                "totals": {"total_minor": 11500}}"#,
        );
        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = -11_500;
        new.merchant = Some("WOOLWORTHS SANDTON".into());
        new.posted_date = "2026-07-02".into();
        let txn = svc.transaction_create(new).unwrap();

        let matches = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(matches.len(), 1);
        let m = &matches[0];
        assert_eq!(m.transaction_id, txn.id);
        assert_eq!(m.document_id.as_deref(), Some(doc.id.as_str()));
        assert_eq!(m.amount_delta_minor, 0);
        assert_eq!(m.date_delta_days, 1);
        assert!(
            m.merchant_score > 0.5,
            "merchant_score {}",
            m.merchant_score
        );
        // Exact amount + adjacent date + strong merchant → auto.
        assert_eq!(m.state, ReconState::Auto);
        assert!(m.confidence >= 0.9);

        let confirmed = svc.recon_confirm(&m.id).unwrap();
        assert_eq!(confirmed.state, ReconState::Confirmed);
        assert!(svc.recon_suggest(&book.id).unwrap().is_empty());
    }

    #[test]
    fn recon_close_amount_is_suggested_not_auto() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        slip_doc(
            &svc,
            &book,
            "r-close",
            r#"{"merchant": {"name": "Engen"},
                "purchased_at": "2026-07-01T10:00:00Z",
                "totals": {"total_minor": 11500}}"#,
        );
        // R3.00 off (within the 5% tolerance) — plausible, not certain.
        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = -11_800;
        new.merchant = Some("ENGEN GARAGE".into());
        new.posted_date = "2026-07-01".into();
        svc.transaction_create(new).unwrap();

        let matches = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].state, ReconState::Suggested);
        assert_eq!(matches[0].amount_delta_minor, 300);
        assert!(matches[0].confidence < 0.9);
        assert!(matches[0].confidence >= 0.55);
    }

    #[test]
    fn recon_skips_out_of_tolerance_and_out_of_window() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        // >5% amount mismatch.
        slip_doc(
            &svc,
            &book,
            "r-far-amount",
            r#"{"merchant": {"name": "Spar"},
                "purchased_at": "2026-07-01T10:00:00Z",
                "totals": {"total_minor": 10000}}"#,
        );
        let mut a = make_txn(&svc, &book, &account);
        a.amount_minor = -12_000;
        a.merchant = Some("SPAR".into());
        a.posted_date = "2026-07-01".into();
        svc.transaction_create(a).unwrap();
        assert!(svc.recon_suggest(&book.id).unwrap().is_empty());

        // Right amount, ten days away.
        slip_doc(
            &svc,
            &book,
            "r-far-date",
            r#"{"merchant": {"name": "Checkers"},
                "purchased_at": "2026-06-21T10:00:00Z",
                "totals": {"total_minor": 12000}}"#,
        );
        assert!(svc.recon_suggest(&book.id).unwrap().is_empty());

        // Currency mismatch never matches.
        slip_doc(
            &svc,
            &book,
            "r-currency",
            r#"{"merchant": {"name": "Spar"},
                "purchased_at": "2026-07-01T10:00:00Z",
                "currency": "USD",
                "totals": {"total_minor": 12000}}"#,
        );
        assert!(svc.recon_suggest(&book.id).unwrap().is_empty());
    }

    #[test]
    fn recon_matches_statement_line_to_ledger_journal() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let account = make_account(&svc, &book);

        let mut journal = manual(
            &book,
            "2026-07-01",
            vec![
                jl(by_code(&coa, "6000"), 5_000, 0),
                jl(by_code(&coa, "1000"), 0, 5_000),
            ],
        );
        journal.narrative = Some("Pick n Pay".into());
        let posted = svc.journal_post(journal).unwrap();

        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = -5_000; // money out ↔ credit on the bank account
        new.posted_date = "2026-07-02".into();
        let txn = svc.transaction_create(new).unwrap();

        let matches = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].transaction_id, txn.id);
        assert_eq!(
            matches[0].journal_id.as_deref(),
            Some(posted.journal.id.as_str())
        );
        assert_eq!(matches[0].document_id, None);
        assert!(matches[0].merchant_score > 0.5);
    }

    #[test]
    fn recon_rejected_journal_match_is_never_resuggested() {
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let account = make_account(&svc, &book);

        let mut journal = manual(
            &book,
            "2026-07-01",
            vec![
                jl(by_code(&coa, "6000"), 5_000, 0),
                jl(by_code(&coa, "1000"), 0, 5_000),
            ],
        );
        journal.narrative = Some("Pick n Pay".into());
        let posted = svc.journal_post(journal).unwrap();

        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = -5_000;
        new.posted_date = "2026-07-02".into();
        svc.transaction_create(new).unwrap();

        let matches = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(
            matches[0].journal_id.as_deref(),
            Some(posted.journal.id.as_str())
        );
        svc.recon_reject(&matches[0].id).unwrap();

        // The rejected (transaction, journal) pair must never come back.
        assert!(
            svc.recon_suggest(&book.id).unwrap().is_empty(),
            "rejected journal match was re-suggested"
        );
        assert!(svc.recon_suggest(&book.id).unwrap().is_empty());
    }

    #[test]
    fn recon_never_suggests_reversed_journals() {
        // Regression: a journal that HAS a reversal (net ledger effect zero)
        // was still suggested as a match for a real bank movement.
        let svc = svc();
        let book = make_book(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let account = make_account(&svc, &book);

        let mut journal = manual(
            &book,
            "2026-07-01",
            vec![
                jl(by_code(&coa, "6000"), 12_345, 0),
                jl(by_code(&coa, "1000"), 0, 12_345),
            ],
        );
        journal.narrative = Some("Pick n Pay".into());
        let posted = svc.journal_post(journal).unwrap();
        svc.journal_reverse(&posted.journal.id, None, None).unwrap();

        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = -12_345;
        new.posted_date = "2026-07-02".into();
        svc.transaction_create(new).unwrap();

        assert!(
            svc.recon_suggest(&book.id).unwrap().is_empty(),
            "a reversed (cancelled) journal must never be suggested"
        );
    }

    #[test]
    fn recon_only_matches_the_statements_own_bank_account_lines() {
        let svc = svc();
        let book = make_business(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let account = make_account(&svc, &book);

        // Manual expense journal: exp 1000 / VAT input 150 / bank 1150.
        // The 150 VAT-input debit sits on an *asset* account but is not a
        // bank movement — a 150 deposit must not match it.
        svc.journal_post(manual(
            &book,
            "2026-07-01",
            vec![
                jl(by_code(&coa, "6900"), 1_000, 0),
                jl(by_code(&coa, "1400"), 150, 0),
                jl(by_code(&coa, "1000"), 0, 1_150),
            ],
        ))
        .unwrap();

        let mut deposit = make_txn(&svc, &book, &account);
        deposit.amount_minor = 150; // unrelated money in
        deposit.posted_date = "2026-07-01".into();
        svc.transaction_create(deposit).unwrap();
        assert!(
            svc.recon_suggest(&book.id).unwrap().is_empty(),
            "VAT-input line must not be treated as a bank movement"
        );

        // The journal's real bank line still matches the genuine outflow.
        let mut outflow = make_txn(&svc, &book, &account);
        outflow.amount_minor = -1_150;
        outflow.posted_date = "2026-07-02".into();
        let outflow = svc.transaction_create(outflow).unwrap();
        let matches = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].transaction_id, outflow.id);
        assert!(matches[0].journal_id.is_some());
    }

    #[test]
    fn recon_deposit_never_matches_a_purchase_slip() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        slip_doc(
            &svc,
            &book,
            "r-deposit",
            r#"{"merchant": {"name": "Woolworths"},
                "purchased_at": "2026-07-01T10:00:00Z",
                "currency": "ZAR",
                "totals": {"total_minor": 11500}}"#,
        );
        // A refund/deposit of the same magnitude is money *in* — a purchase
        // slip must never reconcile against it.
        let mut refund = make_txn(&svc, &book, &account);
        refund.amount_minor = 11_500;
        refund.merchant = Some("WOOLWORTHS SANDTON".into());
        refund.posted_date = "2026-07-01".into();
        svc.transaction_create(refund).unwrap();
        assert!(svc.recon_suggest(&book.id).unwrap().is_empty());
    }

    #[test]
    fn recon_normalizes_mis_cased_slip_currency() {
        // Regression: a slip extracted with `"currency": "zar"` never matched
        // an otherwise perfect "ZAR" transaction.
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let doc = slip_doc(
            &svc,
            &book,
            "r-lowercase",
            r#"{"merchant": {"name": "Pick n Pay"},
                "purchased_at": "2026-07-01T10:00:00Z",
                "currency": "zar",
                "totals": {"total_minor": 12345}}"#,
        );
        let txn = svc
            .transaction_create(make_txn(&svc, &book, &account))
            .unwrap();

        let matches = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].transaction_id, txn.id);
        assert_eq!(matches[0].document_id.as_deref(), Some(doc.id.as_str()));
    }

    #[test]
    fn recon_currencyless_slip_assumes_book_currency() {
        let svc = svc();
        let book = make_book(&svc); // ZAR book
        let usd_account = svc
            .account_create(NewAccount {
                book_id: book.id.clone(),
                name: "USD Card".into(),
                kind: AccountKind::Card,
                currency: "USD".into(),
                institution: None,
                account_number_masked: None,
                opening_balance_minor: None,
            })
            .unwrap();
        slip_doc(
            &svc,
            &book,
            "r-nocurrency",
            r#"{"merchant": {"name": "Spar"},
                "purchased_at": "2026-07-01T10:00:00Z",
                "totals": {"total_minor": 11500}}"#,
        );
        // Same face value, but the transaction is USD and the slip (implied
        // book currency, ZAR) is not.
        let usd_txn = NewTransaction {
            book_id: book.id.clone(),
            account_id: usd_account.id.clone(),
            source: TransactionSource::Manual,
            provider_txn_id: None,
            posted_date: "2026-07-01".into(),
            amount_minor: -11_500,
            currency: "USD".into(),
            merchant: Some("SPAR".into()),
            description: None,
            notes: None,
            category_id: None,
            document_id: None,
            dedupe_occurrence: 0,
        };
        svc.transaction_create(usd_txn).unwrap();
        assert!(svc.recon_suggest(&book.id).unwrap().is_empty());
    }

    #[test]
    fn recon_reject_is_remembered_and_confirm_is_final() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        slip_doc(
            &svc,
            &book,
            "r-reject",
            r#"{"merchant": {"name": "Pick n Pay"},
                "purchased_at": "2026-07-01T10:00:00Z",
                "totals": {"total_minor": 12345}}"#,
        );
        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = -12_345;
        new.posted_date = "2026-07-01".into();
        svc.transaction_create(new).unwrap();

        let matches = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(matches.len(), 1);
        let rejected = svc.recon_reject(&matches[0].id).unwrap();
        assert_eq!(rejected.state, ReconState::Rejected);

        // The rejected pair is never re-suggested.
        assert!(svc.recon_suggest(&book.id).unwrap().is_empty());

        // A confirmed match cannot be flipped to rejected.
        slip_doc(
            &svc,
            &book,
            "r-final",
            r#"{"merchant": {"name": "Other Store"},
                "purchased_at": "2026-07-03T10:00:00Z",
                "totals": {"total_minor": 777}}"#,
        );
        let mut other = make_txn(&svc, &book, &account);
        other.amount_minor = -777;
        other.merchant = Some("OTHER STORE".into());
        other.posted_date = "2026-07-03".into();
        svc.transaction_create(other).unwrap();
        let matches = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(matches.len(), 1);
        svc.recon_confirm(&matches[0].id).unwrap();
        assert!(matches!(
            svc.recon_reject(&matches[0].id),
            Err(CoreError::InvalidStatusTransition { .. })
        ));
    }

    #[test]
    fn recon_never_double_matches_a_document() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        slip_doc(
            &svc,
            &book,
            "r-one-doc",
            r#"{"merchant": {"name": "Pick n Pay"},
                "purchased_at": "2026-07-01T10:00:00Z",
                "totals": {"total_minor": 12345}}"#,
        );
        let a = svc
            .transaction_create(make_txn(&svc, &book, &account))
            .unwrap();
        let mut b = make_txn(&svc, &book, &account);
        b.posted_date = "2026-07-02".into();
        let b = svc.transaction_create(b).unwrap();

        let matches = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(matches.len(), 1, "one document, one match");
        assert!(matches[0].transaction_id == a.id || matches[0].transaction_id == b.id);
    }

    // -- reports on the fixture book ----------------------------------------

    #[test]
    fn trial_balance_always_balances_on_fixture() {
        let svc = svc();
        let (book, _, _) = fixture_book(&svc);
        let tb = svc.report_trial_balance(&book.id).unwrap();
        let debits: i64 = tb.iter().map(|r| r.debit_minor).sum();
        let credits: i64 = tb.iter().map(|r| r.credit_minor).sum();
        assert_eq!(debits, credits);
        assert_eq!(debits, 100_000 + 11_500 + 2_300 + 5_000);
    }

    #[test]
    fn reports_never_mix_currencies() {
        let svc = svc();
        let book = make_business(&svc); // ZAR base currency
        let coa = svc.coa_seed(&book.id).unwrap();
        let bank = by_code(&coa, "1000");
        let sales = by_code(&coa, "4000");
        let usd = |coa: &CoaAccount, d: i64, c: i64| {
            let mut line = jl(coa, d, c);
            line.currency = "USD".into();
            line
        };

        // A ZAR 10 000 sale and a USD 5 000 sale hit the same accounts.
        svc.journal_post(manual(
            &book,
            "2026-07-01",
            vec![jl(bank, 10_000, 0), jl(sales, 0, 10_000)],
        ))
        .unwrap();
        svc.journal_post(manual(
            &book,
            "2026-07-02",
            vec![usd(bank, 5_000, 0), usd(sales, 0, 5_000)],
        ))
        .unwrap();

        // Trial balance: one row per (account, currency) — never 15 000.
        let tb = svc.report_trial_balance(&book.id).unwrap();
        let bank_rows: Vec<_> = tb.iter().filter(|r| r.code == "1000").collect();
        assert_eq!(bank_rows.len(), 2);
        let zar = bank_rows.iter().find(|r| r.currency == "ZAR").unwrap();
        assert_eq!(zar.debit_minor, 10_000);
        let usd_row = bank_rows.iter().find(|r| r.currency == "USD").unwrap();
        assert_eq!(usd_row.debit_minor, 5_000);
        // Per-currency, debits still equal credits.
        for currency in ["ZAR", "USD"] {
            let d: i64 = tb
                .iter()
                .filter(|r| r.currency == currency)
                .map(|r| r.debit_minor)
                .sum();
            let c: i64 = tb
                .iter()
                .filter(|r| r.currency == currency)
                .map(|r| r.credit_minor)
                .sum();
            assert_eq!(d, c, "{currency} out of balance");
        }

        // Income statement / balance sheet / VAT201 are single-currency
        // (book base): the USD amounts are excluded, never summed in.
        let is = svc
            .report_income_statement(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        assert_eq!(is.currency, "ZAR");
        assert_eq!(is.income_total_minor, 10_000, "USD must not leak into ZAR");
        let bs = svc.report_balance_sheet(&book.id, "2026-07-31").unwrap();
        assert_eq!(bs.currency, "ZAR");
        assert_eq!(bs.assets_total_minor, 10_000);
        assert_eq!(
            bs.assets_total_minor,
            bs.liabilities_total_minor + bs.equity_total_minor
        );
        let vat = svc
            .report_vat201(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        assert_eq!(vat.currency, "ZAR");
    }

    #[test]
    fn spending_and_budget_reports_are_per_currency() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book); // ZAR
        let usd_account = svc
            .account_create(NewAccount {
                book_id: book.id.clone(),
                name: "USD Card".into(),
                kind: AccountKind::Card,
                currency: "USD".into(),
                institution: None,
                account_number_masked: None,
                opening_balance_minor: None,
            })
            .unwrap();
        let cat = make_category(&svc, &book, "Groceries");

        let mut zar = make_txn(&svc, &book, &account);
        zar.category_id = Some(cat.id.clone());
        zar.amount_minor = -10_000;
        svc.transaction_create(zar).unwrap();

        let mut usd = make_txn(&svc, &book, &usd_account);
        usd.account_id = usd_account.id.clone();
        usd.category_id = Some(cat.id.clone());
        usd.currency = "USD".into();
        usd.amount_minor = -5_000;
        usd.posted_date = "2026-07-02".into();
        svc.transaction_create(usd).unwrap();

        // Spending: one row per (category, currency), never a 15 000 mix.
        let rows = svc
            .report_spending(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|r| r.currency == "ZAR" && r.total_minor == 10_000));
        assert!(rows
            .iter()
            .any(|r| r.currency == "USD" && r.total_minor == 5_000));

        // Budget status: only spend in the budget's currency counts.
        svc.budget_upsert(BudgetUpsert {
            book_id: book.id.clone(),
            category_id: cat.id.clone(),
            month: "2026-07".into(),
            amount_minor: 50_000,
            currency: "ZAR".into(),
            rollover: false,
        })
        .unwrap();
        let status = svc.budget_status(&book.id, "2026-07").unwrap();
        assert_eq!(status.len(), 1);
        assert_eq!(
            status[0].spent_minor, 10_000,
            "USD spend must not count against a ZAR budget"
        );
    }

    #[test]
    fn income_statement_on_fixture() {
        let svc = svc();
        let (book, _, _) = fixture_book(&svc);
        let is = svc
            .report_income_statement(&book.id, "2026-02-01", "2026-02-28")
            .unwrap();
        assert_eq!(is.income_total_minor, 10_000);
        assert_eq!(is.expense_total_minor, 2_000);
        assert_eq!(is.net_profit_minor, 8_000);
        assert_eq!(is.income.len(), 1);
        assert_eq!(is.income[0].code, "4000");
        assert_eq!(is.expenses[0].code, "6900");

        // April only sees the rent.
        let april = svc
            .report_income_statement(&book.id, "2026-04-01", "2026-04-30")
            .unwrap();
        assert_eq!(april.income_total_minor, 0);
        assert_eq!(april.expense_total_minor, 5_000);
        assert_eq!(april.net_profit_minor, -5_000);
    }

    #[test]
    fn balance_sheet_on_fixture_balances_at_every_date() {
        let svc = svc();
        let (book, _, _) = fixture_book(&svc);

        // Before the rent journal.
        let march = svc.report_balance_sheet(&book.id, "2026-03-31").unwrap();
        // Bank 100 000 + 11 500 − 2 300 and VAT input control 300.
        assert_eq!(march.assets_total_minor, 109_200 + 300);
        assert_eq!(march.liabilities_total_minor, 1_500); // VAT output
        assert_eq!(march.retained_earnings_minor, 8_000);
        assert_eq!(march.equity_total_minor, 100_000 + 8_000);
        assert_eq!(
            march.assets_total_minor,
            march.liabilities_total_minor + march.equity_total_minor
        );

        // After the rent journal.
        let april = svc.report_balance_sheet(&book.id, "2026-04-30").unwrap();
        assert_eq!(april.assets_total_minor, 104_200 + 300);
        assert_eq!(april.retained_earnings_minor, 3_000);
        assert_eq!(
            april.assets_total_minor,
            april.liabilities_total_minor + april.equity_total_minor
        );

        // Before anything: an empty statement that still balances.
        let genesis = svc.report_balance_sheet(&book.id, "2026-01-01").unwrap();
        assert_eq!(genesis.assets_total_minor, 0);
        assert_eq!(genesis.liabilities_total_minor, 0);
        assert_eq!(genesis.equity_total_minor, 0);
        assert!(genesis.assets.is_empty());
    }

    #[test]
    fn vat201_on_fixture() {
        let svc = svc();
        let (book, _, _) = fixture_book(&svc);
        let vat = svc
            .report_vat201(&book.id, "2026-01-01", "2026-03-31")
            .unwrap();
        assert_eq!(vat.output_vat_minor, 1_500);
        assert_eq!(vat.input_vat_minor, 300);
        assert_eq!(vat.net_vat_minor, 1_200); // payable to SARS
        assert_eq!(vat.standard_rated_supplies_minor, 10_000);
        assert_eq!(vat.zero_rated_supplies_minor, 0);
        let std_row = vat.rows.iter().find(|r| r.code == "STD").unwrap();
        assert_eq!(std_row.output_base_minor, 10_000);
        assert_eq!(std_row.output_vat_minor, 1_500);
        assert_eq!(std_row.input_base_minor, 2_000);
        assert_eq!(std_row.input_vat_minor, 300);

        // Outside the period: nothing.
        let empty = svc
            .report_vat201(&book.id, "2026-05-01", "2026-05-31")
            .unwrap();
        assert_eq!(empty.output_vat_minor, 0);
        assert_eq!(empty.input_vat_minor, 0);
        assert_eq!(empty.net_vat_minor, 0);
    }

    #[test]
    fn journal_list_scopes_to_range() {
        let svc = svc();
        let (book, _, _) = fixture_book(&svc);
        let feb = svc
            .journal_list(&book.id, "2026-02-01", "2026-02-28")
            .unwrap();
        assert_eq!(feb.len(), 2);
        assert!(feb.iter().all(|j| !j.lines.is_empty()));
        let all = svc
            .journal_list(&book.id, "2026-01-01", "2026-12-31")
            .unwrap();
        assert_eq!(all.len(), 4);
    }

    #[test]
    fn spending_by_month_groups() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let cat = make_category(&svc, &book, "Groceries");
        for (date, amount) in [("2026-06-15", -1_000), ("2026-07-01", -2_000)] {
            let mut t = make_txn(&svc, &book, &account);
            t.posted_date = date.into();
            t.amount_minor = amount;
            t.category_id = Some(cat.id.clone());
            svc.transaction_create(t).unwrap();
        }
        let rows = svc
            .report_spending_by_month(&book.id, "2026-06-01", "2026-07-31")
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].month, "2026-06");
        assert_eq!(rows[0].total_minor, 1_000);
        assert_eq!(rows[1].month, "2026-07");
        assert_eq!(rows[1].total_minor, 2_000);
    }
}
