//! Service layer: the operations exposed over IPC (Tauri) and HTTP (axum).
//!
//! Same names as the contract in docs/ARCHITECTURE.md: `book_list`,
//! `transaction_list`, `transaction_categorize`, `document_import`,
//! `budget_upsert`, `journal_post`, `recon_suggest`, `recon_confirm`,
//! `report_spending`, `settings_get`/`settings_set`, …
//!
//! Every mutation is wrapped in a SQLite transaction and emits an audit_log
//! entry in the same transaction.

use std::collections::HashSet;

use rusqlite::Connection;

use crate::db::Db;
use crate::domain::*;
use crate::error::{CoreError, CoreResult};
use crate::repo;
use crate::secrets::{KeyringSecretStore, SecretStore};
use crate::slip::SlipPayload;
use crate::util::{
    days_between, merchant_similarity, new_id, normalize_merchant, now_iso,
    transaction_dedupe_hash,
};

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
/// Accounts payable (business seed only).
const COA_CODE_ACCOUNTS_PAYABLE: &str = "2000";

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

/// ZA VAT rates: (code, name, rate in basis points).
const VAT_RATE_SEEDS: &[(&str, &str, i64)] = &[
    ("STD", "Standard rate (15%)", 1500),
    ("ZER", "Zero-rated (0%)", 0),
    ("EXE", "Exempt", 0),
];

// ---------------------------------------------------------------------------
// Reconciliation matcher tuning.
// ---------------------------------------------------------------------------

/// Documents dated further than this from a transaction are never suggested.
const RECON_DATE_WINDOW_DAYS: i64 = 7;
/// Amount mismatch tolerance as a fraction of the document total.
const RECON_AMOUNT_TOLERANCE: f64 = 0.05;
/// Minimum blended confidence for a suggestion.
const RECON_MIN_CONFIDENCE: f64 = 0.55;

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
        let now = now_iso();
        let book = Book {
            id: new_id(),
            kind: new.kind,
            name: new.name.trim().to_string(),
            currency: new.currency.unwrap_or_else(|| "ZAR".to_string()),
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

        let merchant_normalized = new
            .merchant
            .as_deref()
            .map(normalize_merchant)
            .filter(|m| !m.is_empty());
        let dedupe_hash = transaction_dedupe_hash(
            &new.account_id,
            &new.posted_date,
            new.amount_minor,
            &new.currency,
            new.provider_txn_id.as_deref(),
            merchant_normalized.as_deref(),
            new.description.as_deref(),
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
            currency: new.currency,
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
        repo::transaction::set_category(&tx, transaction_id, category_id, &now)?;
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
        let tx = self.conn().unchecked_transaction()?;
        let budget = repo::budget::upsert(
            &tx,
            &upsert.book_id,
            &upsert.category_id,
            &upsert.month,
            upsert.amount_minor,
            &upsert.currency,
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
    pub fn journal_post(&self, new: NewJournal) -> CoreResult<PostedJournal> {
        self.book_get(&new.book_id)?;
        if new.lines.len() < 2 {
            return Err(CoreError::Validation(
                "a journal needs at least two lines".into(),
            ));
        }
        let mut debit_total: i64 = 0;
        let mut credit_total: i64 = 0;
        for line in &new.lines {
            let one_side = (line.debit_minor == 0 && line.credit_minor > 0)
                || (line.credit_minor == 0 && line.debit_minor > 0);
            if !one_side {
                return Err(CoreError::Validation(
                    "each journal line must have exactly one positive side".into(),
                ));
            }
            debit_total += line.debit_minor;
            credit_total += line.credit_minor;
        }
        if debit_total != credit_total {
            return Err(CoreError::UnbalancedJournal {
                debit_minor: debit_total,
                credit_minor: credit_total,
            });
        }

        let now = now_iso();
        let journal = Journal {
            id: new_id(),
            book_id: new.book_id.clone(),
            posted_date: new.posted_date,
            narrative: new.narrative,
            reference: new.reference,
            source_type: new.source_type,
            source_id: new.source_id,
            created_at: now.clone(),
        };

        let tx = self.conn().unchecked_transaction()?;
        for line in &new.lines {
            let coa =
                repo::ledger::get_coa(&tx, &line.coa_id)?.ok_or_else(|| CoreError::NotFound {
                    entity: "chart_of_accounts",
                    id: line.coa_id.clone(),
                })?;
            if coa.book_id != new.book_id {
                return Err(CoreError::Validation(
                    "journal line references an account from another book".into(),
                ));
            }
        }
        repo::ledger::insert_journal(&tx, &journal)?;
        let mut lines = Vec::with_capacity(new.lines.len());
        for (order, line) in new.lines.iter().enumerate() {
            let stored = JournalLine {
                id: new_id(),
                journal_id: journal.id.clone(),
                book_id: new.book_id.clone(),
                coa_id: line.coa_id.clone(),
                debit_minor: line.debit_minor,
                credit_minor: line.credit_minor,
                currency: line.currency.clone(),
                description: line.description.clone(),
                line_order: order as i64,
                created_at: now.clone(),
            };
            repo::ledger::insert_line(&tx, &stored)?;
            lines.push(stored);
        }
        let posted = PostedJournal { journal, lines };
        self.emit_audit(
            &tx,
            Some(&new.book_id),
            "journal",
            Some(&posted.journal.id),
            "post",
            None,
            Some(serde_json::to_string(&posted)?),
        )?;
        tx.commit()?;
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

    pub fn coa_list(&self, book_id: &str) -> CoreResult<Vec<CoaAccount>> {
        repo::ledger::list_coa(self.conn(), book_id)
    }

    /// Seed a minimal default chart of accounts (and a standard VAT rate).
    /// Idempotent: existing codes are left untouched.
    pub fn coa_seed(&self, book_id: &str) -> CoreResult<Vec<CoaAccount>> {
        self.book_get(book_id)?;
        const DEFAULT_COA: &[(&str, &str, CoaKind)] = &[
            ("1000", "Bank", CoaKind::Asset),
            ("1100", "Accounts Receivable", CoaKind::Asset),
            ("1500", "Fixed Assets", CoaKind::Asset),
            ("2000", "Accounts Payable", CoaKind::Liability),
            ("2100", "VAT Payable", CoaKind::Liability),
            ("3000", "Owner's Equity", CoaKind::Equity),
            ("4000", "Sales", CoaKind::Income),
            ("4100", "Other Income", CoaKind::Income),
            ("5000", "Cost of Sales", CoaKind::Expense),
            ("6000", "Operating Expenses", CoaKind::Expense),
            ("6100", "Bank Fees", CoaKind::Expense),
        ];
        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        let mut inserted_any = false;
        for &(code, name, kind) in DEFAULT_COA {
            let inserted = repo::ledger::insert_coa(
                &tx,
                &CoaAccount {
                    id: new_id(),
                    book_id: book_id.to_string(),
                    code: code.to_string(),
                    name: name.to_string(),
                    kind,
                    description: None,
                    is_archived: false,
                    is_system: true,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
            )?;
            inserted_any = inserted_any || inserted;
        }
        repo::ledger::insert_vat_rate(
            &tx,
            &VatRate {
                id: new_id(),
                book_id: book_id.to_string(),
                code: "STD".to_string(),
                name: "Standard rate".to_string(),
                rate_bps: 1500,
                country: Some("ZA".to_string()),
                is_active: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            },
        )?;
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
    // Recon
    // -----------------------------------------------------------------------

    /// Suggest matches between transactions and documents.
    ///
    /// v1 heuristic (deliberately simple; a real matcher lands with the recon
    /// feature work): a transaction explicitly linked to a document but with
    /// no active match gets a high-confidence suggestion. Returns all
    /// currently suggested matches for the book.
    pub fn recon_suggest(&self, book_id: &str) -> CoreResult<Vec<ReconMatch>> {
        let matched = repo::recon::actively_matched_transaction_ids(self.conn(), book_id)?;
        let mut stmt = self.conn().prepare(
            "SELECT id, document_id FROM transactions
             WHERE book_id = ?1 AND document_id IS NOT NULL",
        )?;
        let linked: Vec<(String, String)> = stmt
            .query_map(rusqlite::params![book_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let tx = self.conn().unchecked_transaction()?;
        for (transaction_id, document_id) in linked {
            if matched.contains(&transaction_id) {
                continue;
            }
            let now = now_iso();
            let suggestion = ReconMatch {
                id: new_id(),
                book_id: book_id.to_string(),
                transaction_id,
                document_id: Some(document_id),
                journal_id: None,
                state: ReconState::Suggested,
                confidence: 0.9,
                amount_delta_minor: 0,
                date_delta_days: 0,
                created_at: now.clone(),
                updated_at: now,
            };
            repo::recon::insert(&tx, &suggestion)?;
        }
        tx.commit()?;
        repo::recon::list_by_state(self.conn(), book_id, ReconState::Suggested)
    }

    pub fn recon_confirm(&self, match_id: &str) -> CoreResult<ReconMatch> {
        let before =
            repo::recon::get(self.conn(), match_id)?.ok_or_else(|| CoreError::NotFound {
                entity: "recon_match",
                id: match_id.to_string(),
            })?;
        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        repo::recon::set_state(&tx, match_id, ReconState::Confirmed, &now)?;
        let mut after = before.clone();
        after.state = ReconState::Confirmed;
        after.updated_at = now;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "recon_match",
            Some(match_id),
            "confirm",
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

    pub fn report_trial_balance(&self, book_id: &str) -> CoreResult<Vec<TrialBalanceRow>> {
        repo::report::trial_balance(self.conn(), book_id)
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

    pub fn settings_get(&self, key: &str) -> CoreResult<Option<String>> {
        match repo::settings::get(self.conn(), key)? {
            None => Ok(None),
            Some(row) => match row.secret_ref {
                Some(entry) => self.secrets.get_secret(&entry),
                None => Ok(Some(row.value)),
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
        // VAT default seeded too.
        let rates = svc.vat_rate_list(&book.id).unwrap();
        assert_eq!(rates.len(), 1);
        assert_eq!(rates[0].rate_bps, 1500);
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
                    },
                    NewJournalLine {
                        coa_id: bank.id.clone(),
                        debit_minor: 0,
                        credit_minor: 250_000,
                        currency: "ZAR".into(),
                        description: None,
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
                    },
                    NewJournalLine {
                        coa_id: bank.id.clone(),
                        debit_minor: 0,
                        credit_minor: 99,
                        currency: "ZAR".into(),
                        description: None,
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
                    },
                    NewJournalLine {
                        coa_id: bank.id.clone(),
                        debit_minor: 0,
                        credit_minor: 50,
                        currency: "ZAR".into(),
                        description: None,
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
    fn settings_secret_never_touches_sqlite() {
        let svc = svc();
        svc.settings_set("llm.api_key", "sk-super-secret", true)
            .unwrap();
        assert_eq!(
            svc.settings_get("llm.api_key").unwrap(),
            Some("sk-super-secret".into())
        );
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
}
