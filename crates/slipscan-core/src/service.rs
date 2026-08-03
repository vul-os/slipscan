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
use crate::fx;
use crate::repo;
use crate::secrets::SecretString;
use crate::secrets::{KeyringSecretStore, SecretStore};
use crate::slip::SlipPayload;
use crate::util::{
    days_between, merchant_key_from_description, merchant_similarity, new_id,
    normalize_currency_code, normalize_merchant, now_iso, parse_date, transaction_dedupe_hash,
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

// Chart-of-accounts and tax-rate seed data lives in the region profiles
// (`crate::region`) — core seeds whatever the book's profile carries and
// never hardcodes a jurisdiction.

/// Upper bound for a single journal-line or transaction amount (10^15 minor
/// units — ten trillion currency units). This is a **per-amount** cap, not a
/// per-account aggregate invariant: it keeps `abs()` and the i128 balance
/// check safe and gives SQLite `SUM()` ~9 000 bound-level lines of headroom
/// per account before its integer aggregation could overflow. Realistic books
/// stay many orders of magnitude below both limits.
const MAX_LINE_AMOUNT_MINOR: i64 = 1_000_000_000_000_000;

/// Default swatches for `member_add` when no colour is given, cycled by how
/// many members already exist in the book. Drawn straight from the design
/// system's own palette (ARCHITECTURE.md "Design system": accent, success,
/// warning, danger) so a member never gets a colour invented on the spot.
const DEFAULT_MEMBER_COLOURS: &[&str] = &["#C8FF00", "#16A34A", "#D97706", "#DC2626"];

/// Derive a member's display initial from their label when none is given
/// explicitly: the first alphanumeric character, uppercased. Unicode-aware,
/// like `normalize_merchant` — falls back to "?" only if the label somehow
/// carries no alphanumeric character at all (label emptiness is already
/// rejected before this runs).
fn derive_initial(label: &str) -> String {
    label
        .chars()
        .find(|c| c.is_alphanumeric())
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_else(|| "?".to_string())
}

/// Trim an optional text field and fold "" to `None`. Used by contact fields
/// (`email`, `phone`, addresses, …) so clearing a field in the UI (typing it
/// down to empty) reads back as "not set" rather than a stored empty string
/// that would still show as a value.
/// Today's date, `YYYY-MM-DD`, in UTC — the same clock `now_iso` reads,
/// truncated to the date component `parse_date` expects. Used to default
/// `order_date`/`issue_date`/`paid_at` when a caller omits them.
fn today() -> String {
    now_iso()[..10].to_string()
}

fn normalize_optional(raw: Option<String>) -> Option<String> {
    raw.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// A product variant's `attributes` column is stored and returned verbatim —
/// nothing in this crate reads a specific key out of it — but it must at
/// least be the JSON object shape the column's own doc comment promises, so
/// a caller that later does read a key does not have to also handle "this is
/// a JSON array" or "this is not JSON at all".
fn validate_attributes_json(raw: &str) -> CoreResult<()> {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Object(_)) => Ok(()),
        Ok(_) => Err(CoreError::Validation(
            "variant attributes must be a JSON object".into(),
        )),
        Err(e) => Err(CoreError::Validation(format!(
            "variant attributes is not valid JSON: {e}"
        ))),
    }
}

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

// ---------------------------------------------------------------------------
// Merchant classification hook.
//
// Core holds no classification knowledge of its own: rules arrive in signed
// packs, and slipscan-packs depends on core, never the other way round. This
// is that dependency inversion — the one seam through which installed pack
// rules reach categorisation.
// ---------------------------------------------------------------------------

/// One category suggestion for a merchant, from a classifier outside core.
#[derive(Debug, Clone, PartialEq)]
pub struct CategorySuggestion {
    pub category_id: String,
    /// Rule confidence in `[0, 1]`, recorded on the mapping it produces.
    pub confidence: f64,
}

/// A source of merchant→category suggestions, consulted by
/// [`CoreService::transaction_create`] only when the book's own
/// `merchant_mappings` have nothing to say about the merchant.
///
/// `slipscan_packs::engine::PackClassifier` implements this over the
/// `pack_rules` tables installed packs write into the same database; a host
/// binary registers it once with [`register_merchant_classifier`]. With
/// nothing registered — the default — categorisation behaves exactly as it
/// did before packs existed.
///
/// The implementation is handed core's *current* connection, inside the
/// insert transaction, so it reads the same database at the same snapshot.
/// It must only read: a categorisation path may run against a connection the
/// user has flagged read-only.
pub trait MerchantClassifier: Send + Sync {
    /// Suggest a category for an already-normalized merchant string
    /// (`util::normalize_merchant`), optionally with the transaction's
    /// free-text description. `None` means "no opinion".
    fn suggest(
        &self,
        conn: &Connection,
        book_id: &str,
        merchant_normalized: &str,
        description: Option<&str>,
    ) -> Option<CategorySuggestion>;
}

static MERCHANT_CLASSIFIER: std::sync::OnceLock<&'static dyn MerchantClassifier> =
    std::sync::OnceLock::new();

/// Register the process-wide merchant classifier. The first call wins and
/// returns `true`; later calls are ignored and return `false`, so no library
/// can quietly replace the host's choice. Safe to call from several entry
/// points.
pub fn register_merchant_classifier(classifier: &'static dyn MerchantClassifier) -> bool {
    MERCHANT_CLASSIFIER.set(classifier).is_ok()
}

/// The registered classifier, if the host registered one.
pub fn merchant_classifier() -> Option<&'static dyn MerchantClassifier> {
    MERCHANT_CLASSIFIER.get().copied()
}

/// Facade over one SQLite database plus a secret store.
pub struct CoreService {
    db: Db,
    secrets: Box<dyn SecretStore>,
    /// Caller-visible read-only flag (ARCHITECTURE.md "Safety rails").
    /// Reporting flag only — enforcement is SQLite's own `PRAGMA query_only`
    /// on the connection.
    read_only: std::cell::Cell<bool>,
}

impl std::fmt::Debug for CoreService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreService").finish_non_exhaustive()
    }
}

impl CoreService {
    pub fn new(db: Db, secrets: Box<dyn SecretStore>) -> Self {
        Self {
            db,
            secrets,
            read_only: std::cell::Cell::new(false),
        }
    }

    /// Flag the service read-only (or lift the flag). Enforcement is
    /// `PRAGMA query_only`, so **every** mutation on this connection fails
    /// at the SQLite layer until the flag is lifted — no per-operation checks
    /// to forget. Reads keep working throughout. (Note: a data-folder move
    /// needs open handles **closed**, not merely read-only —
    /// `crate::datadir::move_data_dir` holds SQLite's exclusive lock on the
    /// source database and refuses while any connection is open.)
    pub fn set_read_only(&self, read_only: bool) -> CoreResult<()> {
        self.db
            .conn()
            .pragma_update(None, "query_only", read_only)?;
        self.read_only.set(read_only);
        Ok(())
    }

    /// The underlying connection, for tests that need to look at what a
    /// service call did to the database rather than at what it returned —
    /// notably `crate::sync::tests`, which checks that ordinary service writes
    /// reach the operation log.
    #[cfg(test)]
    pub(crate) fn conn_for_test(&self) -> &Connection {
        self.db.conn()
    }

    /// Whether the service is currently flagged read-only (moving data).
    pub fn is_read_only(&self) -> bool {
        self.read_only.get()
    }

    /// Open a database file with the real OS-keychain secret store.
    ///
    /// Sets a busy timeout on this connection specifically because a real
    /// file (unlike `Db::open_in_memory`, which nothing else can ever share)
    /// can genuinely be opened by more than one process or thread at once —
    /// exactly the scenario `invoice_issue`'s numbering has to survive. Without
    /// this, a second writer racing the first for the same book's counter
    /// would fail immediately with `SQLITE_BUSY` instead of simply waiting
    /// its turn; with it, SQLite's own writer-serialization does the rest.
    /// See migration `0014_sales`'s header for what this guarantee does and
    /// does not cover.
    pub fn open(path: impl AsRef<std::path::Path>) -> CoreResult<Self> {
        let db = Db::open(path)?;
        db.conn()
            .busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self::new(db, Box::new(KeyringSecretStore::default())))
    }

    fn conn(&self) -> &Connection {
        self.db.conn()
    }

    /// Run `f` against this service's SQLite connection.
    ///
    /// The escape hatch for sibling crates that own their own tables in the
    /// same database file — today only slipscan-packs, whose `pack_*` tables
    /// (installer, trust store, rule engine) must live beside the categories
    /// they map onto. Core keeps the connection private otherwise; this is
    /// the one, greppable way out, and the read-only flag still applies
    /// because enforcement is SQLite's own `PRAGMA query_only`.
    pub fn with_connection<T, E>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, E>,
    ) -> Result<T, E> {
        f(self.conn())
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
        // Region profile: an explicit region wins; otherwise inferred from
        // the country when given (e.g. "ZA" → the za profile); otherwise the
        // generic profile — never a hardcoded jurisdiction ("global by
        // default — regions are data, not code"). Unknown explicit ids are
        // rejected here so a typo cannot silently produce a generic book;
        // *stored* regions stay tolerant via `profile_or_generic`.
        let profile = match new.region.as_deref() {
            Some(id) => crate::region::profile(id).ok_or_else(|| {
                CoreError::Validation(format!(
                    "unknown region profile {id:?} (known: {})",
                    crate::region::profiles()
                        .iter()
                        .map(|p| p.id)
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
            })?,
            None => crate::region::for_country(new.country.as_deref()).unwrap_or_else(|| {
                crate::region::profile_or_generic(crate::region::DEFAULT_REGION_ID)
            }),
        };
        // Normalize the base currency exactly like journal-line currencies —
        // an un-normalized book currency ("zar") would silently empty every
        // base-currency report (income statement, balance sheet, tax summary).
        // When omitted it comes from the region profile's data, not from core.
        let currency = match new.currency {
            Some(raw) => normalize_currency_code(&raw)?,
            None => match profile.default_currency {
                Some(c) => c.to_string(),
                None => {
                    return Err(CoreError::Validation(
                        "currency is required (the selected region profile has no default)".into(),
                    ))
                }
            },
        };
        let now = now_iso();
        let book = Book {
            id: new_id(),
            kind: new.kind,
            name: new.name.trim().to_string(),
            currency,
            country: new.country,
            region: profile.id.to_string(),
            locale: "en".to_string(),
            timezone: "UTC".to_string(),
            financial_lock_date: None,
            // Left to derive (see `crate::profile::resolve`) until Settings
            // pins it explicitly — a book created before it has a second
            // location has nothing to derive from yet, which is exactly the
            // "not multi-location" answer this gives.
            multi_location_override: None,
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

    /// Resolve which capability groups this book should show right now
    /// (Phase 6.0 — see `crate::profile`). The one function every surface
    /// (CLI, HTTP, desktop) should call instead of re-deriving `kind ==
    /// business` or a locations count itself.
    pub fn book_profile(&self, book_id: &str) -> CoreResult<crate::profile::BookProfile> {
        let book = self.book_get(book_id)?;
        let location_count = repo::location::count(self.conn(), book_id)?;
        Ok(crate::profile::resolve(
            book.kind,
            location_count,
            book.multi_location_override,
        ))
    }

    /// Change a book's kind later, in either direction (Phase 6 decision #1:
    /// the tier is a display concern, never a schema fork). Flipping
    /// business → personal hides the Contacts/Catalogue/Purchasing/Sales
    /// groups from `book_profile` on the next read; it does not touch a
    /// single row in `locations`, `contacts`, `product_categories`,
    /// `products` or `product_variants` — flipping back to business
    /// immediately shows whatever was already there.
    pub fn book_set_kind(&self, book_id: &str, kind: BookKind) -> CoreResult<Book> {
        let before = self.book_get(book_id)?;
        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        repo::book::set_kind(&tx, book_id, kind, &now)?;
        let mut after = before.clone();
        after.kind = kind;
        after.updated_at = now;
        self.emit_audit(
            &tx,
            Some(book_id),
            "book",
            Some(book_id),
            "set_kind",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Pin (`Some`) or clear back to derived (`None`) the multi-location
    /// override (Phase 6 decision #3). Pinning `Some(true)` is how a
    /// business setting up its first branch gets the location axis before a
    /// second `locations` row exists; pinning `Some(false)` hides the axis
    /// even with two or more rows present, without deleting any of them —
    /// clearing the override later goes straight back to whatever the row
    /// count says.
    pub fn book_set_multi_location_override(
        &self,
        book_id: &str,
        multi_location_override: Option<bool>,
    ) -> CoreResult<Book> {
        let before = self.book_get(book_id)?;
        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        repo::book::set_multi_location_override(&tx, book_id, multi_location_override, &now)?;
        let mut after = before.clone();
        after.multi_location_override = multi_location_override;
        after.updated_at = now;
        self.emit_audit(
            &tx,
            Some(book_id),
            "book",
            Some(book_id),
            "set_multi_location_override",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
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
    ///
    /// The matching key is the source's merchant when it reports one, and
    /// otherwise a conservatively derived key from the description
    /// ([`merchant_key_from_description`]) — which is what lets bank and CSV
    /// statement imports, whose lines only ever carry a description, reach
    /// the same cascade. `merchant` itself is left exactly as the source gave
    /// it (`None` for a statement line): we never invent a display name.
    pub fn transaction_create(&self, new: NewTransaction) -> CoreResult<Transaction> {
        let account = self.account_get(&new.account_id)?;
        if account.book_id != new.book_id {
            return Err(CoreError::Validation(
                "account does not belong to this book".into(),
            ));
        }
        let currency = normalize_currency_code(&new.currency)?;
        // A malformed posted_date would not error anywhere downstream — the
        // transaction silently escapes every date-ranged report, month
        // bucket, and budget-spend match. Reject it here, like journal
        // posting does.
        parse_date(&new.posted_date)?;
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

        // The merchant the *source* reported, if any. This — not the derived
        // key below — is what the dedupe hash is taken over, so hashes stay
        // byte-identical to the ones already stored in existing books and an
        // overlapping re-import still dedupes across this change. Nothing is
        // lost by excluding the derived key: it is a pure function of the
        // description, which the hash already covers.
        let source_merchant_normalized = new
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
            source_merchant_normalized.as_deref(),
            new.description.as_deref(),
            new.dedupe_occurrence,
        );

        // Statement and CSV imports carry a description and no merchant —
        // the bank never sends one. Without a key derived from that
        // description they reach neither pack rules nor this book's own
        // mappings and corrections, so a primary ingestion path would import
        // permanently uncategorised. `merchant_key_from_description` declines
        // whenever the narrative does not clearly name a merchant, leaving
        // the row exactly as it is today; see its docs for the rule.
        let merchant_normalized = match source_merchant_normalized {
            Some(m) => Some(m),
            None => new
                .description
                .as_deref()
                .and_then(merchant_key_from_description),
        };

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

        // Categorisation cascade. A stored mapping always wins: it is either
        // the user's own correction, something learned from one, an LLM
        // verdict they accepted, or a pack's exact rule seeded at install —
        // so pack rules are only ever consulted for a merchant this book has
        // no opinion about yet. That ordering is the whole point of
        // MappingSource: user judgement over community rules, silently.
        let mut category_id = new.category_id;
        if category_id.is_none() {
            if let Some(m) = merchant_normalized.as_deref() {
                if let Some(mapping) = repo::category::get_mapping(&tx, &new.book_id, m)? {
                    category_id = Some(mapping.category_id);
                } else if let Some(classifier) = merchant_classifier() {
                    category_id =
                        self.classify_by_packs(&tx, classifier, &new.book_id, m, &new.description)?;
                }
            }
        }

        // Default attribution: the account's owning member, when one has
        // claimed it as their default account. Purely a starting point — the
        // caller overrides per transaction via `transaction_attribute`.
        // Backward compatible by construction: a book with zero members (or
        // an account nobody claimed) always yields None here.
        let attributed_member_id =
            repo::member::find_default_owner(&tx, &new.book_id, &new.account_id)?.map(|m| m.id);

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
            attributed_member_id,
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
        // Payment detection hook: every ingestion source (statement import,
        // email, scraper, manual) flows through this path, so watch-code
        // detection inherits all of them. Runs inside the same SQLite
        // transaction — a failed insert enqueues nothing, and the dedupe
        // rejections above mean a re-imported duplicate can never re-fire.
        self.detect_payment_matches(&tx, &txn)?;
        tx.commit()?;
        Ok(txn)
    }

    /// Ask the registered classifier (installed pack rules) about a merchant
    /// the book has no mapping for, and remember its verdict as a `pack`
    /// mapping.
    ///
    /// Remembering is what makes the answer durable: the same merchant then
    /// classifies identically on surfaces that do not link slipscan-packs,
    /// and uninstalling the pack deletes its `pack`-sourced mappings again.
    /// A later correction overwrites the row with `MappingSource::User`, so
    /// the precedence above is unaffected.
    ///
    /// A suggestion pointing at a category that no longer exists (or belongs
    /// to another book) is dropped rather than written — a stale rule must
    /// never fail an import.
    fn classify_by_packs(
        &self,
        conn: &Connection,
        classifier: &dyn MerchantClassifier,
        book_id: &str,
        merchant_normalized: &str,
        description: &Option<String>,
    ) -> CoreResult<Option<String>> {
        let Some(hit) =
            classifier.suggest(conn, book_id, merchant_normalized, description.as_deref())
        else {
            return Ok(None);
        };
        match repo::category::get(conn, &hit.category_id)? {
            Some(category) if category.book_id == book_id => {}
            _ => return Ok(None),
        }
        repo::category::upsert_mapping(
            conn,
            book_id,
            merchant_normalized,
            &hit.category_id,
            MappingSource::Pack,
            hit.confidence,
        )?;
        Ok(Some(hit.category_id))
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
        // Already uncategorised: a no-op. Recording a None→None "correction"
        // plus an audit row on every repeat call is pure noise.
        if before.category_id.is_none() {
            return Ok(before);
        }
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

    /// Override a transaction's attribution (or clear it with `None`).
    /// Metadata only: never touches amount/currency/category/journals, so
    /// double-entry integrity — and every other field on the transaction —
    /// is untouched.
    pub fn transaction_attribute(
        &self,
        transaction_id: &str,
        member_id: Option<&str>,
    ) -> CoreResult<Transaction> {
        let before = self.transaction_get(transaction_id)?;
        if let Some(mid) = member_id {
            let member = self.member_get(mid)?;
            if member.book_id != before.book_id {
                return Err(CoreError::Validation(
                    "member does not belong to this book".into(),
                ));
            }
        }
        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        repo::transaction::set_attribution(&tx, transaction_id, member_id, &now)?;
        let mut after = before.clone();
        after.attributed_member_id = member_id.map(str::to_string);
        after.updated_at = now;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "transaction",
            Some(transaction_id),
            "attribute",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// The split rows on a transaction, if any (empty when it is either
    /// singly-attributed or unattributed).
    pub fn transaction_splits_list(
        &self,
        transaction_id: &str,
    ) -> CoreResult<Vec<TransactionSplit>> {
        repo::member::splits_for_transaction(self.conn(), transaction_id)
    }

    /// Replace a transaction's split set. `shares` must name each member at
    /// most once and sum exactly to the transaction's absolute amount (the
    /// only invariant the splits table has to satisfy); an empty list clears
    /// the split, reverting the transaction to single-member attribution /
    /// unattributed via `attributed_member_id`. Metadata only, like
    /// `transaction_attribute` — never touches the ledger.
    pub fn transaction_split_set(
        &self,
        transaction_id: &str,
        shares: Vec<SplitShare>,
    ) -> CoreResult<Vec<TransactionSplit>> {
        let txn = self.transaction_get(transaction_id)?;
        let target = txn.amount_minor.checked_abs().ok_or_else(|| {
            CoreError::Validation("transaction amount out of range for splitting".into())
        })?;

        let mut seen = std::collections::HashSet::new();
        let mut sum: i64 = 0;
        for share in &shares {
            if !seen.insert(share.member_id.as_str()) {
                return Err(CoreError::Validation(format!(
                    "member {} appears more than once in the split",
                    share.member_id
                )));
            }
            if share.share_minor <= 0 {
                return Err(CoreError::Validation(
                    "split shares must be positive".into(),
                ));
            }
            let member = self.member_get(&share.member_id)?;
            if member.book_id != txn.book_id {
                return Err(CoreError::Validation(
                    "split member does not belong to this book".into(),
                ));
            }
            sum = sum
                .checked_add(share.share_minor)
                .ok_or_else(|| CoreError::Validation("split shares overflow".into()))?;
        }
        if !shares.is_empty() && sum != target {
            return Err(CoreError::Validation(format!(
                "split shares must sum to the transaction's absolute amount \
                 ({target} minor units), got {sum}"
            )));
        }

        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        repo::member::set_splits(&tx, transaction_id, &txn.book_id, &shares, &now)?;
        self.emit_audit(
            &tx,
            Some(&txn.book_id),
            "transaction",
            Some(transaction_id),
            "split_set",
            None,
            Some(serde_json::to_string(&shares)?),
        )?;
        tx.commit()?;
        repo::member::splits_for_transaction(self.conn(), transaction_id)
    }

    // -----------------------------------------------------------------------
    // Household members
    //
    // Local data, never logins (ARCHITECTURE.md "Household members &
    // per-person attribution"). A book may have zero members — every method
    // above that touches attribution degrades to a no-op / None in that case,
    // so pre-existing books keep working unchanged.
    // -----------------------------------------------------------------------

    pub fn member_add(&self, new: NewMember) -> CoreResult<Member> {
        let book = self.book_get(&new.book_id)?;
        let label = new.label.trim().to_string();
        if label.is_empty() {
            return Err(CoreError::Validation(
                "member label must not be empty".into(),
            ));
        }
        if let Some(account_id) = &new.default_account_id {
            let account = self.account_get(account_id)?;
            if account.book_id != book.id {
                return Err(CoreError::Validation(
                    "default account does not belong to this book".into(),
                ));
            }
        }
        let initial = match new.initial.as_deref().map(str::trim) {
            Some(explicit) if !explicit.is_empty() => explicit.to_string(),
            _ => derive_initial(&label),
        };
        let colour = match new.colour.as_deref().map(str::trim) {
            Some(explicit) if !explicit.is_empty() => explicit.to_string(),
            _ => {
                let existing = repo::member::count(self.conn(), &book.id)?;
                DEFAULT_MEMBER_COLOURS[(existing as usize) % DEFAULT_MEMBER_COLOURS.len()]
                    .to_string()
            }
        };

        let now = now_iso();
        let member = Member {
            id: new_id(),
            book_id: book.id,
            label,
            initial,
            colour,
            default_account_id: new.default_account_id,
            created_at: now.clone(),
            updated_at: now,
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::member::insert(&tx, &member)?;
        self.emit_audit(
            &tx,
            Some(&member.book_id),
            "member",
            Some(&member.id),
            "create",
            None,
            Some(serde_json::to_string(&member)?),
        )?;
        tx.commit()?;
        Ok(member)
    }

    pub fn member_get(&self, id: &str) -> CoreResult<Member> {
        repo::member::get(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "member",
            id: id.to_string(),
        })
    }

    /// Every member of the book, empty for a book nobody has set up
    /// household members on yet (the common case remains fully supported).
    pub fn member_list(&self, book_id: &str) -> CoreResult<Vec<Member>> {
        repo::member::list(self.conn(), book_id)
    }

    pub fn member_update(&self, id: &str, patch: MemberPatch) -> CoreResult<Member> {
        let before = self.member_get(id)?;
        let mut after = before.clone();
        if let Some(label) = patch.label {
            let label = label.trim().to_string();
            if label.is_empty() {
                return Err(CoreError::Validation(
                    "member label must not be empty".into(),
                ));
            }
            after.label = label;
        }
        if let Some(initial) = patch.initial {
            let initial = initial.trim().to_string();
            if initial.is_empty() {
                return Err(CoreError::Validation(
                    "member initial must not be empty".into(),
                ));
            }
            after.initial = initial;
        }
        if let Some(colour) = patch.colour {
            let colour = colour.trim().to_string();
            if colour.is_empty() {
                return Err(CoreError::Validation(
                    "member colour must not be empty".into(),
                ));
            }
            after.colour = colour;
        }
        if let Some(default_account_id) = patch.default_account_id {
            if let Some(account_id) = &default_account_id {
                let account = self.account_get(account_id)?;
                if account.book_id != before.book_id {
                    return Err(CoreError::Validation(
                        "default account does not belong to this book".into(),
                    ));
                }
            }
            after.default_account_id = default_account_id;
        }
        after.updated_at = now_iso();

        let tx = self.conn().unchecked_transaction()?;
        repo::member::update(&tx, &after)?;
        self.emit_audit(
            &tx,
            Some(&after.book_id),
            "member",
            Some(id),
            "update",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Remove a member. Refused when the member carries any attribution
    /// (single `attributed_member_id` or split rows) unless `reassign_to`
    /// names another member in the same book — every one of those
    /// attributions is then moved onto the reassignment target before the
    /// member row is deleted, so no transaction silently loses its history.
    pub fn member_remove(&self, id: &str, reassign_to: Option<&str>) -> CoreResult<()> {
        let before = self.member_get(id)?;
        let target = match reassign_to {
            Some(target_id) => {
                if target_id == id {
                    return Err(CoreError::Validation(
                        "cannot reassign a member's attributions to themselves".into(),
                    ));
                }
                let target = self.member_get(target_id)?;
                if target.book_id != before.book_id {
                    return Err(CoreError::Validation(
                        "reassignment target does not belong to this book".into(),
                    ));
                }
                Some(target)
            }
            None => {
                if repo::member::has_attributions(self.conn(), id)? {
                    return Err(CoreError::Validation(format!(
                        "member {id} still has attributed transactions or splits — pass a \
                         reassign-target member to move them first, or clear the \
                         attributions/splits before removing"
                    )));
                }
                None
            }
        };

        let tx = self.conn().unchecked_transaction()?;
        if let Some(target) = &target {
            repo::member::reassign_attributions(&tx, id, &target.id)?;
        }
        repo::member::delete(&tx, id)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "member",
            Some(id),
            "remove",
            Some(serde_json::to_string(&before)?),
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Contacts (Xero axis — PARITY.md "Contacts (customers & suppliers)")
    //
    // One table per book with a `role` (customer / supplier / both) rather
    // than separate customer and supplier tables — see migration
    // `0010_contacts` for why. Nothing posts a bill or invoice off a contact
    // yet; this is the record the next link in that chain hangs off.
    // -----------------------------------------------------------------------

    pub fn contact_add(&self, new: NewContact) -> CoreResult<Contact> {
        let book = self.book_get(&new.book_id)?;
        let name = new.name.trim().to_string();
        if name.is_empty() {
            return Err(CoreError::Validation(
                "contact name must not be empty".into(),
            ));
        }
        if let Some(days) = new.payment_terms_days {
            if days < 0 {
                return Err(CoreError::Validation(
                    "payment terms must be zero or more days".into(),
                ));
            }
        }
        if let Some(limit) = new.credit_limit_minor {
            if limit < 0 {
                return Err(CoreError::Validation(
                    "credit limit must not be negative".into(),
                ));
            }
        }

        let now = now_iso();
        let contact = Contact {
            id: new_id(),
            book_id: book.id,
            role: new.role,
            name,
            company_name: normalize_optional(new.company_name),
            email: normalize_optional(new.email),
            phone: normalize_optional(new.phone),
            billing_address: normalize_optional(new.billing_address),
            shipping_address: normalize_optional(new.shipping_address),
            tax_number: normalize_optional(new.tax_number),
            payment_terms_days: new.payment_terms_days,
            credit_limit_minor: new.credit_limit_minor,
            notes: normalize_optional(new.notes),
            is_active: true,
            created_at: now.clone(),
            updated_at: now,
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::contact::insert(&tx, &contact)?;
        self.emit_audit(
            &tx,
            Some(&contact.book_id),
            "contact",
            Some(&contact.id),
            "create",
            None,
            Some(serde_json::to_string(&contact)?),
        )?;
        tx.commit()?;
        Ok(contact)
    }

    pub fn contact_get(&self, id: &str) -> CoreResult<Contact> {
        repo::contact::get(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "contact",
            id: id.to_string(),
        })
    }

    /// Every contact in the book, either role, alphabetical by name.
    pub fn contact_list(&self, book_id: &str) -> CoreResult<Vec<Contact>> {
        repo::contact::list(self.conn(), book_id)
    }

    /// Contacts this book buys from: role `supplier` or `both`.
    pub fn contact_list_suppliers(&self, book_id: &str) -> CoreResult<Vec<Contact>> {
        repo::contact::list_by_role(self.conn(), book_id, ContactRole::Supplier.as_str())
    }

    /// Contacts this book sells to: role `customer` or `both`.
    pub fn contact_list_customers(&self, book_id: &str) -> CoreResult<Vec<Contact>> {
        repo::contact::list_by_role(self.conn(), book_id, ContactRole::Customer.as_str())
    }

    pub fn contact_update(&self, id: &str, patch: ContactPatch) -> CoreResult<Contact> {
        let before = self.contact_get(id)?;
        let mut after = before.clone();
        if let Some(role) = patch.role {
            after.role = role;
        }
        if let Some(name) = patch.name {
            let name = name.trim().to_string();
            if name.is_empty() {
                return Err(CoreError::Validation(
                    "contact name must not be empty".into(),
                ));
            }
            after.name = name;
        }
        if let Some(company_name) = patch.company_name {
            after.company_name = normalize_optional(company_name);
        }
        if let Some(email) = patch.email {
            after.email = normalize_optional(email);
        }
        if let Some(phone) = patch.phone {
            after.phone = normalize_optional(phone);
        }
        if let Some(billing_address) = patch.billing_address {
            after.billing_address = normalize_optional(billing_address);
        }
        if let Some(shipping_address) = patch.shipping_address {
            after.shipping_address = normalize_optional(shipping_address);
        }
        if let Some(tax_number) = patch.tax_number {
            after.tax_number = normalize_optional(tax_number);
        }
        if let Some(days) = patch.payment_terms_days {
            if let Some(days) = days {
                if days < 0 {
                    return Err(CoreError::Validation(
                        "payment terms must be zero or more days".into(),
                    ));
                }
            }
            after.payment_terms_days = days;
        }
        if let Some(limit) = patch.credit_limit_minor {
            if let Some(limit) = limit {
                if limit < 0 {
                    return Err(CoreError::Validation(
                        "credit limit must not be negative".into(),
                    ));
                }
            }
            after.credit_limit_minor = limit;
        }
        if let Some(notes) = patch.notes {
            after.notes = normalize_optional(notes);
        }
        if let Some(is_active) = patch.is_active {
            after.is_active = is_active;
        }
        after.updated_at = now_iso();

        let tx = self.conn().unchecked_transaction()?;
        repo::contact::update(&tx, &after)?;
        self.emit_audit(
            &tx,
            Some(&after.book_id),
            "contact",
            Some(id),
            "update",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Hard delete. As of migration `0014_sales`, a contact with any sales
    /// order or invoice history is restrained the same way `account_delete`
    /// is restrained by transactions — `sales_orders.contact_id` and
    /// `invoices.contact_id` are both `ON DELETE RESTRICT`. That surfaces as
    /// a raw SQLite foreign-key error here rather than a friendly
    /// `CoreError`, the same trade-off migration 0012 accepted for
    /// `stock_movements.variant_id`/`location_id`: nobody has hit it as a
    /// caller yet.
    pub fn contact_remove(&self, id: &str) -> CoreResult<()> {
        let before = self.contact_get(id)?;
        let tx = self.conn().unchecked_transaction()?;
        repo::contact::delete(&tx, id)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "contact",
            Some(id),
            "remove",
            Some(serde_json::to_string(&before)?),
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Locations (Phase 6.1 — the FlowStock fold, foundation)
    //
    // Branches, sites and warehouses, per book. A book may have zero
    // locations — nothing else in core references one yet, so every existing
    // book keeps working exactly as it does today.
    // -----------------------------------------------------------------------

    pub fn location_create(&self, new: NewLocation) -> CoreResult<Location> {
        let book = self.book_get(&new.book_id)?;
        let name = new.name.trim().to_string();
        if name.is_empty() {
            return Err(CoreError::Validation(
                "location name must not be empty".into(),
            ));
        }
        let code = match new.code.as_deref().map(str::trim) {
            Some(explicit) if !explicit.is_empty() => Some(explicit.to_string()),
            _ => None,
        };
        let address = match new.address.as_deref().map(str::trim) {
            Some(explicit) if !explicit.is_empty() => Some(explicit.to_string()),
            _ => None,
        };

        let now = now_iso();
        let location = Location {
            id: new_id(),
            book_id: book.id,
            name,
            kind: new.kind.unwrap_or(LocationKind::Branch),
            code,
            address,
            is_archived: false,
            created_at: now.clone(),
            updated_at: now,
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::location::insert(&tx, &location)?;
        self.emit_audit(
            &tx,
            Some(&location.book_id),
            "location",
            Some(&location.id),
            "create",
            None,
            Some(serde_json::to_string(&location)?),
        )?;
        tx.commit()?;
        Ok(location)
    }

    pub fn location_get(&self, id: &str) -> CoreResult<Location> {
        repo::location::get(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "location",
            id: id.to_string(),
        })
    }

    /// Every location in the book, empty for a book nobody has set this axis
    /// up on yet (the common case remains fully supported).
    pub fn location_list(&self, book_id: &str) -> CoreResult<Vec<Location>> {
        repo::location::list(self.conn(), book_id)
    }

    pub fn location_update(&self, id: &str, patch: LocationPatch) -> CoreResult<Location> {
        let before = self.location_get(id)?;
        let mut after = before.clone();
        if let Some(name) = patch.name {
            let name = name.trim().to_string();
            if name.is_empty() {
                return Err(CoreError::Validation(
                    "location name must not be empty".into(),
                ));
            }
            after.name = name;
        }
        if let Some(kind) = patch.kind {
            after.kind = kind;
        }
        if let Some(code) = patch.code {
            after.code = code
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_string);
        }
        if let Some(address) = patch.address {
            after.address = address
                .as_deref()
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .map(str::to_string);
        }
        if let Some(is_archived) = patch.is_archived {
            after.is_archived = is_archived;
        }
        after.updated_at = now_iso();

        let tx = self.conn().unchecked_transaction()?;
        repo::location::update(&tx, &after)?;
        self.emit_audit(
            &tx,
            Some(&after.book_id),
            "location",
            Some(id),
            "update",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Hard delete. Nothing references a location yet (see migration
    /// `0009_locations`), so unlike `member_remove` there is no reassignment
    /// guard to run first.
    pub fn location_delete(&self, id: &str) -> CoreResult<()> {
        let before = self.location_get(id)?;
        let tx = self.conn().unchecked_transaction()?;
        repo::location::delete(&tx, id)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "location",
            Some(id),
            "delete",
            Some(serde_json::to_string(&before)?),
            None,
        )?;
        tx.commit()?;
        Ok(())
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
    // Product catalogue (ROADMAP.md Phase 6.3a). `product_categories` is a
    // deliberately separate concept from the transaction `categories` just
    // above — see migration 0011's header. A book with no catalogue entries
    // behaves exactly as before: nothing here is read by any other service
    // function yet.
    // -----------------------------------------------------------------------

    pub fn product_category_create(&self, new: NewProductCategory) -> CoreResult<ProductCategory> {
        let book = self.book_get(&new.book_id)?;
        let name = new.name.trim().to_string();
        if name.is_empty() {
            return Err(CoreError::Validation(
                "product category name must not be empty".into(),
            ));
        }
        let now = now_iso();
        let category = ProductCategory {
            id: new_id(),
            book_id: book.id,
            name,
            created_at: now.clone(),
            updated_at: now,
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::catalogue::category_insert(&tx, &category)?;
        self.emit_audit(
            &tx,
            Some(&category.book_id),
            "product_category",
            Some(&category.id),
            "create",
            None,
            Some(serde_json::to_string(&category)?),
        )?;
        tx.commit()?;
        Ok(category)
    }

    pub fn product_category_get(&self, id: &str) -> CoreResult<ProductCategory> {
        repo::catalogue::category_get(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "product_category",
            id: id.to_string(),
        })
    }

    /// Every product category in the book, empty for a book that has not
    /// created one yet — the common case for anyone not running a shop.
    pub fn product_category_list(&self, book_id: &str) -> CoreResult<Vec<ProductCategory>> {
        repo::catalogue::category_list(self.conn(), book_id)
    }

    pub fn product_category_rename(&self, id: &str, name: String) -> CoreResult<ProductCategory> {
        let before = self.product_category_get(id)?;
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(CoreError::Validation(
                "product category name must not be empty".into(),
            ));
        }
        let mut after = before.clone();
        after.name = name;
        after.updated_at = now_iso();

        let tx = self.conn().unchecked_transaction()?;
        repo::catalogue::category_update(&tx, &after)?;
        self.emit_audit(
            &tx,
            Some(&after.book_id),
            "product_category",
            Some(id),
            "update",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Hard delete. Products in the category are detached (`ON DELETE SET
    /// NULL`), never removed with it.
    pub fn product_category_delete(&self, id: &str) -> CoreResult<()> {
        let before = self.product_category_get(id)?;
        let tx = self.conn().unchecked_transaction()?;
        repo::catalogue::category_delete(&tx, id)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "product_category",
            Some(id),
            "delete",
            Some(serde_json::to_string(&before)?),
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn product_create(&self, new: NewProduct) -> CoreResult<Product> {
        let book = self.book_get(&new.book_id)?;
        let name = new.name.trim().to_string();
        if name.is_empty() {
            return Err(CoreError::Validation(
                "product name must not be empty".into(),
            ));
        }
        if let Some(category_id) = &new.product_category_id {
            let category = self.product_category_get(category_id)?;
            if category.book_id != book.id {
                return Err(CoreError::Validation(
                    "product category belongs to a different book".into(),
                ));
            }
        }
        let now = now_iso();
        let product = Product {
            id: new_id(),
            book_id: book.id,
            product_category_id: new.product_category_id,
            name,
            description: new.description,
            created_at: now.clone(),
            updated_at: now,
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::catalogue::product_insert(&tx, &product)?;
        self.emit_audit(
            &tx,
            Some(&product.book_id),
            "product",
            Some(&product.id),
            "create",
            None,
            Some(serde_json::to_string(&product)?),
        )?;
        tx.commit()?;
        Ok(product)
    }

    pub fn product_get(&self, id: &str) -> CoreResult<Product> {
        repo::catalogue::product_get(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "product",
            id: id.to_string(),
        })
    }

    pub fn product_list(&self, book_id: &str) -> CoreResult<Vec<Product>> {
        repo::catalogue::product_list(self.conn(), book_id)
    }

    pub fn product_update(&self, id: &str, patch: ProductPatch) -> CoreResult<Product> {
        let before = self.product_get(id)?;
        let mut after = before.clone();
        if let Some(name) = patch.name {
            let name = name.trim().to_string();
            if name.is_empty() {
                return Err(CoreError::Validation(
                    "product name must not be empty".into(),
                ));
            }
            after.name = name;
        }
        if let Some(description) = patch.description {
            after.description = description;
        }
        if let Some(product_category_id) = patch.product_category_id {
            if let Some(category_id) = &product_category_id {
                let category = self.product_category_get(category_id)?;
                if category.book_id != before.book_id {
                    return Err(CoreError::Validation(
                        "product category belongs to a different book".into(),
                    ));
                }
            }
            after.product_category_id = product_category_id;
        }
        after.updated_at = now_iso();

        let tx = self.conn().unchecked_transaction()?;
        repo::catalogue::product_update(&tx, &after)?;
        self.emit_audit(
            &tx,
            Some(&after.book_id),
            "product",
            Some(id),
            "update",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Hard delete. `product_variants.product_id` is `ON DELETE CASCADE`, so
    /// every variant of this product goes with it — there is no stock
    /// ledger yet to leave a dangling reference in (ROADMAP.md 6.3 lands
    /// that separately, over the `locations` table).
    pub fn product_delete(&self, id: &str) -> CoreResult<()> {
        let before = self.product_get(id)?;
        let tx = self.conn().unchecked_transaction()?;
        repo::catalogue::product_delete(&tx, id)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "product",
            Some(id),
            "delete",
            Some(serde_json::to_string(&before)?),
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn product_variant_add(&self, new: NewProductVariant) -> CoreResult<ProductVariant> {
        let product = self.product_get(&new.product_id)?;
        let sku = new.sku.trim().to_string();
        if sku.is_empty() {
            return Err(CoreError::Validation(
                "variant SKU must not be empty".into(),
            ));
        }
        let name = new.name.trim().to_string();
        if name.is_empty() {
            return Err(CoreError::Validation(
                "variant name must not be empty".into(),
            ));
        }
        let currency = normalize_currency_code(&new.currency)?;
        let price_minor = new.price_minor.unwrap_or(0);
        if price_minor < 0 {
            return Err(CoreError::Validation(
                "variant price must not be negative".into(),
            ));
        }
        let cost_price_minor = new.cost_price_minor.unwrap_or(0);
        if cost_price_minor < 0 {
            return Err(CoreError::Validation(
                "variant cost price must not be negative".into(),
            ));
        }
        let reorder_point = new.reorder_point.unwrap_or(0);
        if reorder_point < 0 {
            return Err(CoreError::Validation(
                "variant reorder point must not be negative".into(),
            ));
        }
        if let Some(attributes) = &new.attributes {
            validate_attributes_json(attributes)?;
        }

        let now = now_iso();
        let variant = ProductVariant {
            id: new_id(),
            product_id: product.id,
            book_id: product.book_id,
            sku,
            name,
            price_minor,
            cost_price_minor,
            currency,
            reorder_point,
            attributes: new.attributes,
            created_at: now.clone(),
            updated_at: now,
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::catalogue::variant_insert(&tx, &variant)?;
        self.emit_audit(
            &tx,
            Some(&variant.book_id),
            "product_variant",
            Some(&variant.id),
            "create",
            None,
            Some(serde_json::to_string(&variant)?),
        )?;
        tx.commit()?;
        Ok(variant)
    }

    pub fn product_variant_get(&self, id: &str) -> CoreResult<ProductVariant> {
        repo::catalogue::variant_get(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "product_variant",
            id: id.to_string(),
        })
    }

    pub fn product_variant_list(&self, product_id: &str) -> CoreResult<Vec<ProductVariant>> {
        repo::catalogue::variant_list_for_product(self.conn(), product_id)
    }

    /// Every variant in the book, across every product — the scope SKU
    /// uniqueness is enforced over.
    pub fn product_variant_list_for_book(&self, book_id: &str) -> CoreResult<Vec<ProductVariant>> {
        repo::catalogue::variant_list_for_book(self.conn(), book_id)
    }

    pub fn product_variant_update(
        &self,
        id: &str,
        patch: ProductVariantPatch,
    ) -> CoreResult<ProductVariant> {
        let before = self.product_variant_get(id)?;
        let mut after = before.clone();
        if let Some(sku) = patch.sku {
            let sku = sku.trim().to_string();
            if sku.is_empty() {
                return Err(CoreError::Validation(
                    "variant SKU must not be empty".into(),
                ));
            }
            after.sku = sku;
        }
        if let Some(name) = patch.name {
            let name = name.trim().to_string();
            if name.is_empty() {
                return Err(CoreError::Validation(
                    "variant name must not be empty".into(),
                ));
            }
            after.name = name;
        }
        if let Some(price_minor) = patch.price_minor {
            if price_minor < 0 {
                return Err(CoreError::Validation(
                    "variant price must not be negative".into(),
                ));
            }
            after.price_minor = price_minor;
        }
        if let Some(cost_price_minor) = patch.cost_price_minor {
            if cost_price_minor < 0 {
                return Err(CoreError::Validation(
                    "variant cost price must not be negative".into(),
                ));
            }
            after.cost_price_minor = cost_price_minor;
        }
        if let Some(reorder_point) = patch.reorder_point {
            if reorder_point < 0 {
                return Err(CoreError::Validation(
                    "variant reorder point must not be negative".into(),
                ));
            }
            after.reorder_point = reorder_point;
        }
        if let Some(attributes) = patch.attributes {
            if let Some(raw) = &attributes {
                validate_attributes_json(raw)?;
            }
            after.attributes = attributes;
        }
        after.updated_at = now_iso();

        let tx = self.conn().unchecked_transaction()?;
        repo::catalogue::variant_update(&tx, &after)?;
        self.emit_audit(
            &tx,
            Some(&after.book_id),
            "product_variant",
            Some(id),
            "update",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    pub fn product_variant_delete(&self, id: &str) -> CoreResult<()> {
        let before = self.product_variant_get(id)?;
        let tx = self.conn().unchecked_transaction()?;
        repo::catalogue::variant_delete(&tx, id)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "product_variant",
            Some(id),
            "delete",
            Some(serde_json::to_string(&before)?),
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Stock movements (migration 0012, ROADMAP.md Phase 6.3b — the
    // append-only stock-movement ledger).
    //
    // There is no `stock_movement_update` or `stock_movement_delete` here,
    // and there is deliberately no way to build one that reaches the table:
    // `repo::stock` has no update/delete function to call, and the schema's
    // own triggers refuse the raw SQL besides. A correction is always a new
    // row that nets against the one it corrects.
    // -----------------------------------------------------------------------

    /// Shared insert path for one movement: mints the id and timestamp,
    /// writes the row, and audits it. Callers own the transaction and have
    /// already validated the variant/location/book agreement — this is the
    /// part that is identical whether one row is being written
    /// (`stock_movement_record`) or two (`stock_transfer`).
    #[allow(clippy::too_many_arguments)]
    fn insert_movement_in_tx(
        &self,
        tx: &Connection,
        book_id: &str,
        variant_id: &str,
        location_id: &str,
        qty_delta: i64,
        kind: StockMovementKind,
        ref_kind: Option<String>,
        ref_id: Option<String>,
        note: Option<String>,
        created_by: Option<String>,
    ) -> CoreResult<StockMovement> {
        let movement = StockMovement {
            id: new_id(),
            book_id: book_id.to_string(),
            variant_id: variant_id.to_string(),
            location_id: location_id.to_string(),
            qty_delta,
            kind,
            ref_kind,
            ref_id,
            note,
            created_by,
            created_at: now_iso(),
        };
        repo::stock::insert(tx, &movement)?;
        self.emit_audit(
            tx,
            Some(book_id),
            "stock_movement",
            Some(&movement.id),
            "record",
            None,
            Some(serde_json::to_string(&movement)?),
        )?;
        Ok(movement)
    }

    /// Record one stock-movement fact: a receipt, a sale, an adjustment or a
    /// count. (`Transfer` is accepted here too, for a caller that already has
    /// both legs some other way, but `stock_transfer` below is the path that
    /// guarantees the pair actually sums to zero — prefer it for a transfer.)
    pub fn stock_movement_record(&self, new: NewStockMovement) -> CoreResult<StockMovement> {
        let variant = self.product_variant_get(&new.variant_id)?;
        let location = self.location_get(&new.location_id)?;
        if location.book_id != variant.book_id {
            return Err(CoreError::Validation(
                "stock movement location and variant belong to different books".into(),
            ));
        }
        if new.qty_delta == 0 {
            return Err(CoreError::Validation(
                "stock movement qty_delta must not be zero".into(),
            ));
        }
        if new.ref_id.is_some() && new.ref_kind.is_none() {
            return Err(CoreError::Validation(
                "stock movement has a ref_id but no ref_kind to name what it refers to".into(),
            ));
        }
        let tx = self.conn().unchecked_transaction()?;
        let movement = self.insert_movement_in_tx(
            &tx,
            &variant.book_id,
            &variant.id,
            &location.id,
            new.qty_delta,
            new.kind,
            new.ref_kind,
            new.ref_id,
            new.note,
            new.created_by,
        )?;
        tx.commit()?;
        Ok(movement)
    }

    /// Move stock between two locations by recording two movements — one
    /// leaving `from_location_id`, one arriving at `to_location_id` — that
    /// share a `ref_id` and always sum to zero. This is the invariant
    /// ROADMAP.md 6.3b names explicitly: a transfer is never a single row
    /// that "moves" a quantity, because a single row cannot express which
    /// location lost it and which gained it once two devices each see only
    /// their own half. Two rows, correlated by `ref_id`, converge under
    /// union exactly like any other pair of ledger facts.
    pub fn stock_transfer(
        &self,
        variant_id: &str,
        from_location_id: &str,
        to_location_id: &str,
        qty: i64,
        note: Option<String>,
        created_by: Option<String>,
    ) -> CoreResult<TransferResult> {
        if qty <= 0 {
            return Err(CoreError::Validation(
                "transfer quantity must be positive".into(),
            ));
        }
        if from_location_id == to_location_id {
            return Err(CoreError::Validation(
                "transfer source and destination locations must differ".into(),
            ));
        }
        let variant = self.product_variant_get(variant_id)?;
        let from = self.location_get(from_location_id)?;
        let to = self.location_get(to_location_id)?;
        if from.book_id != variant.book_id || to.book_id != variant.book_id {
            return Err(CoreError::Validation(
                "stock transfer location and variant belong to different books".into(),
            ));
        }

        let ref_id = new_id();
        let tx = self.conn().unchecked_transaction()?;
        let out = self.insert_movement_in_tx(
            &tx,
            &variant.book_id,
            &variant.id,
            &from.id,
            -qty,
            StockMovementKind::Transfer,
            Some("transfer".to_string()),
            Some(ref_id.clone()),
            note.clone(),
            created_by.clone(),
        )?;
        let in_ = self.insert_movement_in_tx(
            &tx,
            &variant.book_id,
            &variant.id,
            &to.id,
            qty,
            StockMovementKind::Transfer,
            Some("transfer".to_string()),
            Some(ref_id),
            note,
            created_by,
        )?;
        tx.commit()?;
        Ok(TransferResult { out, in_ })
    }

    /// A variant's full movement history, any location, oldest first.
    pub fn stock_movements_for_variant(&self, variant_id: &str) -> CoreResult<Vec<StockMovement>> {
        repo::stock::list_for_variant(self.conn(), variant_id)
    }

    /// A location's full movement history, any variant, oldest first — a
    /// branch's stock ledger.
    pub fn stock_movements_for_location(
        &self,
        location_id: &str,
    ) -> CoreResult<Vec<StockMovement>> {
        repo::stock::list_for_location(self.conn(), location_id)
    }

    /// The two legs of one transfer, or (once 6.4/6.5 exist) every movement
    /// one receipt or sale produced.
    pub fn stock_movements_for_ref(
        &self,
        ref_kind: &str,
        ref_id: &str,
    ) -> CoreResult<Vec<StockMovement>> {
        repo::stock::list_for_ref(self.conn(), ref_kind, ref_id)
    }

    /// On-hand for one variant at one location: `SUM(qty_delta)` over exactly
    /// those rows. Never a stored figure — see migration `0012_stock`.
    pub fn stock_on_hand(&self, variant_id: &str, location_id: &str) -> CoreResult<i64> {
        repo::stock::on_hand(self.conn(), variant_id, location_id)
    }

    /// On-hand for one variant, summed across every location.
    pub fn stock_on_hand_total(&self, variant_id: &str) -> CoreResult<i64> {
        repo::stock::on_hand_total(self.conn(), variant_id)
    }

    /// On-hand for one variant, broken down per location it has ever moved
    /// at.
    pub fn stock_on_hand_by_location(&self, variant_id: &str) -> CoreResult<Vec<(String, i64)>> {
        repo::stock::on_hand_by_location(self.conn(), variant_id)
    }

    /// Every variant in the book whose total on-hand (summed across every
    /// location) has fallen to or below its own `reorder_point`.
    pub fn stock_low_variants(&self, book_id: &str) -> CoreResult<Vec<LowStockVariant>> {
        Ok(repo::stock::low_stock(self.conn(), book_id)?
            .into_iter()
            .map(|(variant, on_hand)| LowStockVariant { variant, on_hand })
            .collect())
    }

    // -----------------------------------------------------------------------
    // Sales orders (Phase 6.5 — ROADMAP.md "Inventory & trade", PARITY.md's
    // single largest Xero-axis gap). See migration `0014_sales`'s header for
    // the LWW/ledger split this section and the next mirror exactly.
    // -----------------------------------------------------------------------

    pub fn sales_order_create(&self, new: NewSalesOrder) -> CoreResult<SalesOrder> {
        let book = self.book_get(&new.book_id)?;
        let contact = self.contact_get(&new.contact_id)?;
        if contact.book_id != book.id {
            return Err(CoreError::Validation(
                "sales order contact belongs to a different book".into(),
            ));
        }
        let location_id = match &new.location_id {
            Some(id) => {
                let location = self.location_get(id)?;
                if location.book_id != book.id {
                    return Err(CoreError::Validation(
                        "sales order location belongs to a different book".into(),
                    ));
                }
                Some(location.id)
            }
            None => None,
        };
        let order_date = new.order_date.clone().unwrap_or_else(today);
        parse_date(&order_date)?;
        let currency = match &new.currency {
            Some(c) => normalize_currency_code(c)?,
            None => book.currency.clone(),
        };

        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        // Own numbering series ("sales_order") from invoices' ("invoice") —
        // an order and the invoice raised from it are not required to share
        // a number, the same way a Xero sales order and its invoice do not.
        let number = repo::sales::allocate_number(&tx, &book.id, "sales_order")?;
        let order = SalesOrder {
            id: new_id(),
            book_id: book.id.clone(),
            contact_id: contact.id,
            location_id,
            number,
            order_date,
            status: SalesOrderStatus::Draft,
            currency,
            notes: normalize_optional(new.notes),
            confirmed_at: None,
            cancelled_at: None,
            paid_at: None,
            created_at: now.clone(),
            updated_at: now,
        };
        repo::sales::order_insert(&tx, &order)?;
        self.emit_audit(
            &tx,
            Some(&order.book_id),
            "sales_order",
            Some(&order.id),
            "create",
            None,
            Some(serde_json::to_string(&order)?),
        )?;
        tx.commit()?;
        Ok(order)
    }

    pub fn sales_order_get(&self, id: &str) -> CoreResult<SalesOrder> {
        repo::sales::order_get(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "sales_order",
            id: id.to_string(),
        })
    }

    /// Every order in the book, most recently numbered first.
    pub fn sales_order_list(&self, book_id: &str) -> CoreResult<Vec<SalesOrder>> {
        repo::sales::order_list(self.conn(), book_id)
    }

    /// Header edit — location, order date, notes. Only reachable while the
    /// order is still `draft`; `status` moves through the dedicated
    /// transition functions below, never through this patch.
    pub fn sales_order_update(&self, id: &str, patch: SalesOrderPatch) -> CoreResult<SalesOrder> {
        let before = self.sales_order_get(id)?;
        if before.status != SalesOrderStatus::Draft {
            return Err(CoreError::Validation(
                "only a draft sales order can be edited; a confirmed one can be cancelled".into(),
            ));
        }
        let mut after = before.clone();
        if let Some(location_id) = patch.location_id {
            after.location_id = match location_id {
                Some(loc_id) => {
                    let location = self.location_get(&loc_id)?;
                    if location.book_id != before.book_id {
                        return Err(CoreError::Validation(
                            "sales order location belongs to a different book".into(),
                        ));
                    }
                    Some(location.id)
                }
                None => None,
            };
        }
        if let Some(order_date) = patch.order_date {
            parse_date(&order_date)?;
            after.order_date = order_date;
        }
        if let Some(notes) = patch.notes {
            after.notes = normalize_optional(notes);
        }
        after.updated_at = now_iso();

        let tx = self.conn().unchecked_transaction()?;
        repo::sales::order_update(&tx, &after)?;
        self.emit_audit(
            &tx,
            Some(&after.book_id),
            "sales_order",
            Some(id),
            "update",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Hard delete. Only reachable while `draft` — a confirmed order has
    /// already moved stock and a paid or cancelled one is history; all three
    /// are cancelled or left alone, never deleted.
    pub fn sales_order_delete(&self, id: &str) -> CoreResult<()> {
        let before = self.sales_order_get(id)?;
        if before.status != SalesOrderStatus::Draft {
            return Err(CoreError::Validation(
                "only a draft sales order can be deleted; cancel a confirmed one instead".into(),
            ));
        }
        let tx = self.conn().unchecked_transaction()?;
        repo::sales::order_delete(&tx, id)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "sales_order",
            Some(id),
            "delete",
            Some(serde_json::to_string(&before)?),
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// `subtotal + tax == total`, derived from the order's own items at call
    /// time — see `SalesOrder`'s header note on why nothing here is stored.
    pub fn sales_order_totals(&self, id: &str) -> CoreResult<SalesOrderTotals> {
        self.sales_order_get(id)?;
        repo::sales::order_totals(self.conn(), id)
    }

    fn resolve_sales_order_line(
        &self,
        order_book_id: &str,
        variant_id: Option<&str>,
        description: Option<&str>,
        unit_price_minor: Option<i64>,
    ) -> CoreResult<(Option<String>, String, i64)> {
        match variant_id {
            Some(vid) => {
                let variant = self.product_variant_get(vid)?;
                if variant.book_id != order_book_id {
                    return Err(CoreError::Validation(
                        "sales order line variant belongs to a different book".into(),
                    ));
                }
                let description = description
                    .map(str::trim)
                    .filter(|d| !d.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| variant.name.clone());
                let unit_price_minor = unit_price_minor.unwrap_or(variant.price_minor);
                Ok((Some(variant.id), description, unit_price_minor))
            }
            None => {
                let description = description
                    .map(str::trim)
                    .filter(|d| !d.is_empty())
                    .ok_or_else(|| {
                        CoreError::Validation(
                            "a free-text sales order line needs a description".into(),
                        )
                    })?
                    .to_string();
                let unit_price_minor = unit_price_minor.ok_or_else(|| {
                    CoreError::Validation("a free-text sales order line needs a unit price".into())
                })?;
                Ok((None, description, unit_price_minor))
            }
        }
    }

    /// Add a line to a draft order: a catalogue line (`variant_id: Some`,
    /// description/price default from the variant) or a free-text/service
    /// line (`variant_id: None`, description and price required). Only
    /// reachable while the order is `draft`.
    pub fn sales_order_item_add(&self, new: NewSalesOrderItem) -> CoreResult<SalesOrderItem> {
        let order = self.sales_order_get(&new.sales_order_id)?;
        if order.status != SalesOrderStatus::Draft {
            return Err(CoreError::Validation(
                "cannot add a line to a non-draft sales order".into(),
            ));
        }
        if new.quantity <= 0 {
            return Err(CoreError::Validation(
                "sales order line quantity must be positive".into(),
            ));
        }
        let (variant_id, description, unit_price_minor) = self.resolve_sales_order_line(
            &order.book_id,
            new.variant_id.as_deref(),
            new.description.as_deref(),
            new.unit_price_minor,
        )?;
        if unit_price_minor < 0 {
            return Err(CoreError::Validation(
                "sales order line unit price must not be negative".into(),
            ));
        }
        let tax_rate_bps = new.tax_rate_bps.unwrap_or(0);
        if !(0..=10_000).contains(&tax_rate_bps) {
            return Err(CoreError::Validation(
                "sales order line tax rate must be between 0 and 10000 basis points".into(),
            ));
        }

        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        let line_order = repo::sales::order_item_list(&tx, &order.id)?.len() as i64;
        let item = SalesOrderItem {
            id: new_id(),
            sales_order_id: order.id.clone(),
            book_id: order.book_id.clone(),
            variant_id,
            description,
            quantity: new.quantity,
            unit_price_minor,
            tax_rate_bps,
            line_order,
            created_at: now.clone(),
            updated_at: now,
        };
        repo::sales::order_item_insert(&tx, &item)?;
        self.emit_audit(
            &tx,
            Some(&item.book_id),
            "sales_order_item",
            Some(&item.id),
            "create",
            None,
            Some(serde_json::to_string(&item)?),
        )?;
        tx.commit()?;
        Ok(item)
    }

    /// Every line on an order, in the order they were added.
    pub fn sales_order_items_list(&self, sales_order_id: &str) -> CoreResult<Vec<SalesOrderItem>> {
        repo::sales::order_item_list(self.conn(), sales_order_id)
    }

    /// Edit a line's description/quantity/price/tax rate. `variant_id` is
    /// never reassigned — remove the line and add a new one to change which
    /// product it is. Only reachable while the order is `draft`.
    pub fn sales_order_item_update(
        &self,
        id: &str,
        patch: SalesOrderItemPatch,
    ) -> CoreResult<SalesOrderItem> {
        let before = repo::sales::order_item_get(self.conn(), id)?.ok_or_else(|| {
            CoreError::NotFound {
                entity: "sales_order_item",
                id: id.to_string(),
            }
        })?;
        let order = self.sales_order_get(&before.sales_order_id)?;
        if order.status != SalesOrderStatus::Draft {
            return Err(CoreError::Validation(
                "cannot edit a line on a non-draft sales order".into(),
            ));
        }
        let mut after = before.clone();
        if let Some(description) = patch.description {
            let description = description.trim().to_string();
            if description.is_empty() {
                return Err(CoreError::Validation(
                    "sales order line description must not be empty".into(),
                ));
            }
            after.description = description;
        }
        if let Some(quantity) = patch.quantity {
            if quantity <= 0 {
                return Err(CoreError::Validation(
                    "sales order line quantity must be positive".into(),
                ));
            }
            after.quantity = quantity;
        }
        if let Some(unit_price_minor) = patch.unit_price_minor {
            if unit_price_minor < 0 {
                return Err(CoreError::Validation(
                    "sales order line unit price must not be negative".into(),
                ));
            }
            after.unit_price_minor = unit_price_minor;
        }
        if let Some(tax_rate_bps) = patch.tax_rate_bps {
            if !(0..=10_000).contains(&tax_rate_bps) {
                return Err(CoreError::Validation(
                    "sales order line tax rate must be between 0 and 10000 basis points".into(),
                ));
            }
            after.tax_rate_bps = tax_rate_bps;
        }
        after.updated_at = now_iso();

        let tx = self.conn().unchecked_transaction()?;
        repo::sales::order_item_update(&tx, &after)?;
        self.emit_audit(
            &tx,
            Some(&after.book_id),
            "sales_order_item",
            Some(id),
            "update",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Remove a line from a draft order. Only reachable while `draft`.
    pub fn sales_order_item_remove(&self, id: &str) -> CoreResult<()> {
        let before = repo::sales::order_item_get(self.conn(), id)?.ok_or_else(|| {
            CoreError::NotFound {
                entity: "sales_order_item",
                id: id.to_string(),
            }
        })?;
        let order = self.sales_order_get(&before.sales_order_id)?;
        if order.status != SalesOrderStatus::Draft {
            return Err(CoreError::Validation(
                "cannot remove a line from a non-draft sales order".into(),
            ));
        }
        let tx = self.conn().unchecked_transaction()?;
        repo::sales::order_item_delete(&tx, id)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "sales_order_item",
            Some(id),
            "delete",
            Some(serde_json::to_string(&before)?),
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// draft -> confirmed. Deducts stock for every stock-tracked line
    /// (`kind = sale`, `ref_kind = "sales_order"`) — the "delivery" ROADMAP.md
    /// promises alongside invoicing; see migration `0014_sales`'s header for
    /// why there is no separate delivery table. Requires at least one line
    /// item, and a location the moment any line is stock-tracked. Does not
    /// check availability — see the migration header's note on why that
    /// matches the stock ledger's existing permissive model.
    ///
    /// NOTE (Phase 6.6): this is exactly the call site that will also post a
    /// revenue/COGS/VAT journal once double-entry posting lands. It does not
    /// today — Phase 6.5 is inventory and documents only.
    pub fn sales_order_confirm(&self, id: &str) -> CoreResult<SalesOrder> {
        let before = self.sales_order_get(id)?;
        if before.status != SalesOrderStatus::Draft {
            return Err(CoreError::InvalidStatusTransition {
                from: before.status.to_string(),
                to: SalesOrderStatus::Confirmed.to_string(),
            });
        }
        let items = self.sales_order_items_list(id)?;
        if items.is_empty() {
            return Err(CoreError::Validation(
                "cannot confirm a sales order with no line items".into(),
            ));
        }
        let stock_items: Vec<&SalesOrderItem> =
            items.iter().filter(|i| i.variant_id.is_some()).collect();
        if !stock_items.is_empty() && before.location_id.is_none() {
            return Err(CoreError::Validation(
                "cannot confirm: this order has stock-tracked line items but no location set"
                    .into(),
            ));
        }

        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        if let Some(location_id) = &before.location_id {
            for item in &stock_items {
                let variant_id = item.variant_id.as_deref().expect("filtered above");
                self.insert_movement_in_tx(
                    &tx,
                    &before.book_id,
                    variant_id,
                    location_id,
                    -item.quantity,
                    StockMovementKind::Sale,
                    Some("sales_order".to_string()),
                    Some(before.id.clone()),
                    Some(format!("sale: order #{}", before.number)),
                    None,
                )?;
            }
        }
        let mut after = before.clone();
        after.status = SalesOrderStatus::Confirmed;
        after.confirmed_at = Some(now.clone());
        after.updated_at = now;
        repo::sales::order_update(&tx, &after)?;
        self.emit_audit(
            &tx,
            Some(&after.book_id),
            "sales_order",
            Some(id),
            "confirm",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// draft|confirmed -> cancelled. A cancel from `confirmed` writes one
    /// compensating movement per stock-tracked line — `kind` stays `sale`
    /// (this reverses a sale; it is not new stock arriving), correlated by
    /// the same `ref_kind`/`ref_id` as the original deduction so
    /// `stock_movements_for_ref` shows the whole story for one order,
    /// exactly as migration 0012 already does for a transfer's two legs. A
    /// cancel from `draft` never touched stock and moves none.
    pub fn sales_order_cancel(&self, id: &str) -> CoreResult<SalesOrder> {
        let before = self.sales_order_get(id)?;
        if !matches!(
            before.status,
            SalesOrderStatus::Draft | SalesOrderStatus::Confirmed
        ) {
            return Err(CoreError::InvalidStatusTransition {
                from: before.status.to_string(),
                to: SalesOrderStatus::Cancelled.to_string(),
            });
        }

        let now = now_iso();
        let tx = self.conn().unchecked_transaction()?;
        if before.status == SalesOrderStatus::Confirmed {
            let items = repo::sales::order_item_list(&tx, id)?;
            let stock_items: Vec<_> = items.iter().filter(|i| i.variant_id.is_some()).collect();
            if !stock_items.is_empty() {
                let location_id = before.location_id.clone().expect(
                    "a confirmed order with stock lines always has a location — \
                     sales_order_confirm requires it",
                );
                for item in stock_items {
                    let variant_id = item.variant_id.as_deref().expect("filtered above");
                    self.insert_movement_in_tx(
                        &tx,
                        &before.book_id,
                        variant_id,
                        &location_id,
                        item.quantity,
                        StockMovementKind::Sale,
                        Some("sales_order".to_string()),
                        Some(before.id.clone()),
                        Some(format!("cancelled: reversing sales_order {}", before.id)),
                        None,
                    )?;
                }
            }
        }
        let mut after = before.clone();
        after.status = SalesOrderStatus::Cancelled;
        after.cancelled_at = Some(now.clone());
        after.updated_at = now;
        repo::sales::order_update(&tx, &after)?;
        self.emit_audit(
            &tx,
            Some(&after.book_id),
            "sales_order",
            Some(id),
            "cancel",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// confirmed -> paid. A cash-sale convenience for an order settled with
    /// no invoice at all; an invoiced order instead tracks payment through
    /// `invoice_payment_record` against the invoice raised from it — the two
    /// paths do not update each other automatically today (see migration
    /// `0014_sales`'s scope notes).
    pub fn sales_order_mark_paid(&self, id: &str) -> CoreResult<SalesOrder> {
        let before = self.sales_order_get(id)?;
        if before.status != SalesOrderStatus::Confirmed {
            return Err(CoreError::InvalidStatusTransition {
                from: before.status.to_string(),
                to: SalesOrderStatus::Paid.to_string(),
            });
        }
        let now = now_iso();
        let mut after = before.clone();
        after.status = SalesOrderStatus::Paid;
        after.paid_at = Some(now.clone());
        after.updated_at = now;
        let tx = self.conn().unchecked_transaction()?;
        repo::sales::order_update(&tx, &after)?;
        self.emit_audit(
            &tx,
            Some(&after.book_id),
            "sales_order",
            Some(id),
            "mark_paid",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    // -----------------------------------------------------------------------
    // Invoices (Phase 6.5). See migration `0014_sales`'s header for why every
    // function here either reads or inserts — there is no update, no delete,
    // and no draft phase: `invoice_issue` is the only way one comes into
    // being, already numbered.
    // -----------------------------------------------------------------------

    /// Issue an invoice — either from a confirmed/paid sales order (its line
    /// items are copied; its `contact_id`/`currency` win over anything this
    /// call was given) or standalone (`sales_order_id: None`, `contact_id`
    /// and `items` required). Assigns the next number for `series`
    /// (`"invoice"` by default) atomically in the same transaction as the
    /// insert — see `repo::sales::allocate_number` and this migration's
    /// header for the concurrency guarantee that follows from doing it that
    /// way, proven in this module's own tests under real concurrent access.
    pub fn invoice_issue(&self, new: NewInvoice) -> CoreResult<Invoice> {
        let book = self.book_get(&new.book_id)?;
        let issue_date = new.issue_date.clone().unwrap_or_else(today);
        parse_date(&issue_date)?;
        parse_date(&new.due_date)?;
        if new.due_date.as_str() < issue_date.as_str() {
            return Err(CoreError::Validation(
                "invoice due date must not be before its issue date".into(),
            ));
        }
        let series = new
            .series
            .clone()
            .unwrap_or_else(|| "invoice".to_string())
            .trim()
            .to_string();
        if series.is_empty() {
            return Err(CoreError::Validation(
                "invoice numbering series must not be empty".into(),
            ));
        }

        type Line = (Option<String>, String, i64, i64, i64);
        let (contact_id, currency, sales_order_id, lines): (String, String, Option<String>, Vec<Line>) =
            if let Some(order_id) = &new.sales_order_id {
                let order = self.sales_order_get(order_id)?;
                if order.book_id != book.id {
                    return Err(CoreError::Validation(
                        "invoice sales order belongs to a different book".into(),
                    ));
                }
                if !matches!(order.status, SalesOrderStatus::Confirmed | SalesOrderStatus::Paid) {
                    return Err(CoreError::Validation(
                        "cannot issue an invoice from a sales order that is not confirmed or paid"
                            .into(),
                    ));
                }
                let items = self.sales_order_items_list(order_id)?;
                if items.is_empty() {
                    return Err(CoreError::Validation(
                        "cannot issue an invoice with no line items".into(),
                    ));
                }
                let lines = items
                    .into_iter()
                    .map(|i| {
                        (
                            i.variant_id,
                            i.description,
                            i.quantity,
                            i.unit_price_minor,
                            i.tax_rate_bps,
                        )
                    })
                    .collect();
                (order.contact_id.clone(), order.currency.clone(), Some(order.id.clone()), lines)
            } else {
                let contact_id = new.contact_id.clone().ok_or_else(|| {
                    CoreError::Validation("a standalone invoice needs a contact_id".into())
                })?;
                let contact = self.contact_get(&contact_id)?;
                if contact.book_id != book.id {
                    return Err(CoreError::Validation(
                        "invoice contact belongs to a different book".into(),
                    ));
                }
                let currency = match &new.currency {
                    Some(c) => normalize_currency_code(c)?,
                    None => book.currency.clone(),
                };
                if new.items.is_empty() {
                    return Err(CoreError::Validation(
                        "a standalone invoice needs at least one line item".into(),
                    ));
                }
                let mut lines = Vec::with_capacity(new.items.len());
                for item in &new.items {
                    let (variant_id, description, unit_price_minor) = self
                        .resolve_sales_order_line(
                            &book.id,
                            item.variant_id.as_deref(),
                            Some(&item.description),
                            Some(item.unit_price_minor),
                        )?;
                    if item.quantity <= 0 {
                        return Err(CoreError::Validation(
                            "invoice line quantity must be positive".into(),
                        ));
                    }
                    if unit_price_minor < 0 {
                        return Err(CoreError::Validation(
                            "invoice line unit price must not be negative".into(),
                        ));
                    }
                    let tax_rate_bps = item.tax_rate_bps.unwrap_or(0);
                    if !(0..=10_000).contains(&tax_rate_bps) {
                        return Err(CoreError::Validation(
                            "invoice line tax rate must be between 0 and 10000 basis points"
                                .into(),
                        ));
                    }
                    lines.push((variant_id, description, item.quantity, unit_price_minor, tax_rate_bps));
                }
                (contact.id, currency, None, lines)
            };

        let now = now_iso();
        // Deferred is enough here (rusqlite's `unchecked_transaction` is the
        // only variant `&self` can start — `transaction_with_behavior`
        // needs `&mut Connection`, which a shared service does not have):
        // `allocate_number`'s UPSERT is the very first statement this
        // transaction executes, so it acquires SQLite's write lock right
        // there regardless of the transaction's declared mode. A second
        // issuer racing this one blocks on that same lock — see
        // `CoreService::open`'s busy timeout — and reads the post-increment
        // value once this transaction commits, never the same pre-increment
        // one.
        let tx = self.conn().unchecked_transaction()?;
        let number = repo::sales::allocate_number(&tx, &book.id, &series)?;
        let invoice = Invoice {
            id: new_id(),
            book_id: book.id.clone(),
            contact_id,
            sales_order_id,
            series,
            number,
            issue_date,
            due_date: new.due_date,
            currency,
            notes: normalize_optional(new.notes),
            created_at: now.clone(),
        };
        repo::sales::invoice_insert(&tx, &invoice)?;
        for (line_order, (variant_id, description, quantity, unit_price_minor, tax_rate_bps)) in
            lines.into_iter().enumerate()
        {
            let item = InvoiceItem {
                id: new_id(),
                invoice_id: invoice.id.clone(),
                book_id: invoice.book_id.clone(),
                variant_id,
                description,
                quantity,
                unit_price_minor,
                tax_rate_bps,
                line_order: line_order as i64,
                created_at: now.clone(),
            };
            repo::sales::invoice_item_insert(&tx, &item)?;
        }
        self.emit_audit(
            &tx,
            Some(&invoice.book_id),
            "invoice",
            Some(&invoice.id),
            "issue",
            None,
            Some(serde_json::to_string(&invoice)?),
        )?;
        tx.commit()?;
        Ok(invoice)
    }

    pub fn invoice_get(&self, id: &str) -> CoreResult<Invoice> {
        repo::sales::invoice_get(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "invoice",
            id: id.to_string(),
        })
    }

    /// Every invoice in the book, most recently numbered first per series.
    pub fn invoice_list(&self, book_id: &str) -> CoreResult<Vec<Invoice>> {
        repo::sales::invoice_list(self.conn(), book_id)
    }

    pub fn invoice_items_list(&self, invoice_id: &str) -> CoreResult<Vec<InvoiceItem>> {
        repo::sales::invoice_item_list(self.conn(), invoice_id)
    }

    /// `subtotal + tax == total`, `paid + due == total`, `status` derived —
    /// see `InvoiceTotals`'s header note on why none of it is stored.
    pub fn invoice_totals(&self, id: &str) -> CoreResult<InvoiceTotals> {
        self.invoice_get(id)?;
        repo::sales::invoice_totals(self.conn(), id)
    }

    /// Record a payment against an invoice. Not blocked from exceeding the
    /// balance due — a genuine overpayment happens, and `invoice_totals`
    /// simply reports `due_minor` at or below zero rather than refusing the
    /// fact that it happened.
    pub fn invoice_payment_record(&self, new: NewInvoicePayment) -> CoreResult<InvoicePayment> {
        let invoice = self.invoice_get(&new.invoice_id)?;
        if new.amount_minor <= 0 {
            return Err(CoreError::Validation(
                "invoice payment amount must be positive".into(),
            ));
        }
        let paid_at = new.paid_at.clone().unwrap_or_else(today);
        parse_date(&paid_at)?;

        let payment = InvoicePayment {
            id: new_id(),
            invoice_id: invoice.id.clone(),
            book_id: invoice.book_id.clone(),
            amount_minor: new.amount_minor,
            paid_at,
            method: normalize_optional(new.method),
            note: normalize_optional(new.note),
            created_at: now_iso(),
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::sales::invoice_payment_insert(&tx, &payment)?;
        self.emit_audit(
            &tx,
            Some(&payment.book_id),
            "invoice_payment",
            Some(&payment.id),
            "record",
            None,
            Some(serde_json::to_string(&payment)?),
        )?;
        tx.commit()?;
        Ok(payment)
    }

    /// Every payment recorded against an invoice, oldest first.
    pub fn invoice_payments_list(&self, invoice_id: &str) -> CoreResult<Vec<InvoicePayment>> {
        repo::sales::invoice_payment_list(self.conn(), invoice_id)
    }

    /// PARITY.md's #2-ranked gap, the receivables half: every outstanding
    /// invoice, by contact, bucketed by age as of `as_of` (defaults to
    /// today). Cheap now that invoices and contacts both exist.
    pub fn report_aged_receivables(
        &self,
        book_id: &str,
        as_of: Option<&str>,
    ) -> CoreResult<AgedReceivables> {
        self.book_get(book_id)?;
        let as_of = match as_of {
            Some(d) => {
                parse_date(d)?;
                d.to_string()
            }
            None => today(),
        };
        repo::sales::aged_receivables(self.conn(), book_id, &as_of)
    }

    // -----------------------------------------------------------------------
    // Budgets
    // -----------------------------------------------------------------------

    pub fn budget_upsert(&self, upsert: BudgetUpsert) -> CoreResult<Budget> {
        // Shape *and* range: an impossible month like "2026-13" would be
        // stored fine (the schema CHECK is digits-only) but can never match
        // any transaction's substr(posted_date, 1, 7) — a budget that
        // silently reports zero spend forever.
        let month_ok = {
            let b = upsert.month.as_bytes();
            b.len() == 7
                && b[4] == b'-'
                && b[..4].iter().all(u8::is_ascii_digit)
                && b[5..].iter().all(u8::is_ascii_digit)
                && ("01"..="12").contains(&&upsert.month[5..])
        };
        if !month_ok {
            return Err(CoreError::Validation(format!(
                "month must be YYYY-MM (MM in 01..=12), got {:?}",
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

    /// The stored budget rows for a book and month (amount, currency, and
    /// the rollover flag — which `budget_status` does not carry).
    pub fn budget_list(&self, book_id: &str, month: &str) -> CoreResult<Vec<Budget>> {
        repo::budget::list(self.conn(), book_id, month)
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
    /// * a non-manual source may have at most one net-live generated journal
    ///   (a reversed one no longer blocks posting a corrected replacement)
    pub fn journal_post(&self, new: NewJournal) -> CoreResult<PostedJournal> {
        let book = self.book_get(&new.book_id)?;
        let tx = self.conn().unchecked_transaction()?;
        let posted = self.post_journal_in_tx(&tx, &book, new, None)?;
        tx.commit()?;
        Ok(posted)
    }

    /// Reverse a posted journal: post a new journal with every line's sides
    /// swapped (VAT tags preserved so the tax-period summary nets out), linked via
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
        // A non-manual source may have at most one *net-live* generated
        // journal. Journals whose effect was cancelled by reversal do not
        // block regeneration — reversing the wrong generated journal and
        // posting a corrected one is the documented correction path.
        if new.source_type != JournalSourceType::Manual {
            if let Some(source_id) = new.source_id.as_deref() {
                for existing in repo::ledger::find_journals_by_source(
                    tx,
                    &book.id,
                    new.source_type.as_str(),
                    source_id,
                )? {
                    if !repo::ledger::is_net_reversed(tx, &existing)? {
                        return Err(CoreError::DuplicateJournal {
                            source_type: new.source_type.to_string(),
                            source_id: existing,
                        });
                    }
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

    /// Seed the default chart of accounts for the book's kind plus the tax
    /// rate table, both taken from the book's **region profile** (e.g. the
    /// za profile seeds VAT control accounts and the 15%/zero/exempt VAT
    /// table; the generic profile seeds a neutral chart and one
    /// standard-rate placeholder to be configured via
    /// [`Self::vat_rate_set_bps`]). Idempotent: existing codes are left
    /// untouched.
    pub fn coa_seed(&self, book_id: &str) -> CoreResult<Vec<CoaAccount>> {
        let book = self.book_get(book_id)?;
        let profile = crate::region::profile_or_generic(&book.region);
        let seeds = match book.kind {
            BookKind::Personal => profile.personal_coa,
            BookKind::Business => profile.business_coa,
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
        for seed in profile.tax_rates {
            repo::ledger::insert_vat_rate(
                &tx,
                &VatRate {
                    id: new_id(),
                    book_id: book_id.to_string(),
                    code: seed.code.to_string(),
                    name: seed.label.to_string(),
                    // `None` marks a profile placeholder: it seeds at 0 and
                    // is configured per book via `vat_rate_set_bps`.
                    rate_bps: seed.rate_bps.unwrap_or(0),
                    country: profile.country.map(str::to_string),
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

    /// Configure a tax rate's percentage (basis points) for one book — how
    /// the generic profile's standard-rate placeholder gets its actual rate
    /// at book init, and how a statutory rate change is tracked. Audited;
    /// already-posted journal lines are never touched.
    pub fn vat_rate_set_bps(
        &self,
        book_id: &str,
        code: &str,
        rate_bps: i64,
    ) -> CoreResult<VatRate> {
        if !(0..=10_000).contains(&rate_bps) {
            return Err(CoreError::Validation(format!(
                "rate_bps must be between 0 and 10000 (0%..100%), got {rate_bps}"
            )));
        }
        let before = repo::ledger::list_vat_rates(self.conn(), book_id)?
            .into_iter()
            .find(|r| r.code == code)
            .ok_or_else(|| CoreError::NotFound {
                entity: "vat_rate",
                id: format!("{book_id}/{code}"),
            })?;
        let now = now_iso();
        let mut after = before.clone();
        after.rate_bps = rate_bps;
        after.updated_at = now.clone();
        let tx = self.conn().unchecked_transaction()?;
        repo::ledger::set_vat_rate_bps(&tx, &before.id, rate_bps, &now)?;
        self.emit_audit(
            &tx,
            Some(book_id),
            "vat_rate",
            Some(&before.id),
            "set_rate",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
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
    /// control), never as a sale — so the tax-summary supply/turnover boxes are
    /// not inflated. Symmetrically, an outflow against an income account
    /// (customer refund) reduces output VAT rather than inflating input VAT.
    ///
    /// Accounts come from `coa_map` (account / category) with seed-code
    /// fallbacks; the counter fallback follows the category's kind (income /
    /// expense) before cash direction, so refunds classify correctly even
    /// without an explicit mapping. A VAT rate is rejected when the counter
    /// account is not income/expense (transfers carry no supply/purchase).
    /// One net-live journal per transaction, enforced.
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
        // The seed-code fallback follows the *category's* kind when there is
        // one — a customer refund (outflow on an income category) must land
        // on the income fallback, not the expense one, or the VAT side flips
        // (see the VAT-side rule below). Cash direction only decides for
        // transfer categories and uncategorised transactions.
        let category_kind = match txn.category_id.as_deref() {
            Some(category_id) => repo::category::get(self.conn(), category_id)?.map(|c| c.kind),
            None => None,
        };
        let counter_fallback = match category_kind {
            Some(CategoryKind::Income) => fallback_income_code(book.kind),
            Some(CategoryKind::Expense) => fallback_expense_code(book.kind),
            Some(CategoryKind::Transfer) | None => {
                if is_outflow {
                    fallback_expense_code(book.kind)
                } else {
                    fallback_income_code(book.kind)
                }
            }
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
                // A VAT split only makes sense against a P&L counter: an
                // asset/liability/equity counter (a transfer between own
                // accounts, a loan repayment) is neither a supply nor a
                // purchase, and booking output/input VAT for it would put
                // phantom amounts in the tax-period summary boxes.
                if !matches!(counter.kind, CoaKind::Expense | CoaKind::Income) {
                    return Err(CoreError::Validation(format!(
                        "cannot apply VAT rate {} to this transaction: its \
                         counter account {} ({}) is {}, not an income or \
                         expense account — transfer-like movements carry no \
                         VAT supply or purchase",
                        rate.code,
                        counter.code,
                        counter.name,
                        counter.kind.as_str(),
                    )));
                }
                let (net, vat_minor) = split_inclusive(gross, rate.rate_bps);
                // Input side (purchases) vs output side (supplies) follows
                // the counter account's kind: expense accounts are always
                // the purchase side even when the cash flows *in* (purchase
                // refund / supplier credit note), and income accounts are
                // always the supply side even when cash flows *out*
                // (customer refund).
                let input_side = counter.kind == CoaKind::Expense;
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
        // A rejected pair is remembered so it is never re-suggested; both
        // sides become matchable against other counterparts. Confirming the
        // stale rejected match later could put a transaction/document into
        // two active confirmed matches at once (recon_confirm never re-checks
        // the active-match sets — only recon_suggest does).
        if before.state == ReconState::Rejected && state == ReconState::Confirmed {
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

    /// Tax-period summary: output/input tax and their bases per rate, plus
    /// supply-type totals and the net position — in the book's base
    /// currency (a return is filed in one currency). The report name and
    /// box labels come from the book's region profile (e.g. "VAT201" for
    /// za, "Tax summary" for generic).
    pub fn report_tax_summary(
        &self,
        book_id: &str,
        from_date: &str,
        to_date: &str,
    ) -> CoreResult<TaxPeriodSummary> {
        let book = self.book_get(book_id)?;
        let profile = crate::region::profile_or_generic(&book.region);
        repo::report::tax_period_summary(
            self.conn(),
            book_id,
            from_date,
            to_date,
            &book.currency,
            profile,
        )
    }

    /// Deprecated alias for [`Self::report_tax_summary`] — "VAT201" is the
    /// SA region profile's label for the generic tax-period summary, not a
    /// core concept.
    #[deprecated(note = "renamed to report_tax_summary — VAT201 is the SA profile's report label")]
    pub fn report_vat201(
        &self,
        book_id: &str,
        from_date: &str,
        to_date: &str,
    ) -> CoreResult<TaxPeriodSummary> {
        self.report_tax_summary(book_id, from_date, to_date)
    }

    /// Per-member outflow (expense) totals over an inclusive date range, in
    /// the book's base currency. Split shares are distributed; unattributed
    /// spend rolls into an "Unattributed" row.
    pub fn report_member_expense(
        &self,
        book_id: &str,
        from_date: &str,
        to_date: &str,
    ) -> CoreResult<Vec<MemberAmountRow>> {
        let book = self.book_get(book_id)?;
        repo::report::member_expense(self.conn(), book_id, from_date, to_date, &book.currency)
    }

    /// Per-member inflow (contribution) totals over an inclusive date range,
    /// in the book's base currency — mirrors [`Self::report_member_expense`]
    /// for money coming in.
    pub fn report_member_contribution(
        &self,
        book_id: &str,
        from_date: &str,
        to_date: &str,
    ) -> CoreResult<Vec<MemberAmountRow>> {
        let book = self.book_get(book_id)?;
        repo::report::member_contribution(self.conn(), book_id, from_date, to_date, &book.currency)
    }

    /// Each member's share of each category's spend over an inclusive date
    /// range, in the book's base currency.
    pub fn report_member_category(
        &self,
        book_id: &str,
        from_date: &str,
        to_date: &str,
    ) -> CoreResult<Vec<MemberCategoryRow>> {
        let book = self.book_get(book_id)?;
        repo::report::member_category(self.conn(), book_id, from_date, to_date, &book.currency)
    }

    /// Net position per member over an inclusive date range (contributions
    /// minus attributed expenses) — "who owes whom" — in the book's base
    /// currency.
    pub fn report_settle_up(
        &self,
        book_id: &str,
        from_date: &str,
        to_date: &str,
    ) -> CoreResult<Vec<MemberSettleRow>> {
        let book = self.book_get(book_id)?;
        repo::report::settle_up(self.conn(), book_id, from_date, to_date, &book.currency)
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    /// Store a setting. With `secret = true` the value goes to the OS
    /// keychain and only the keychain entry name is stored in SQLite.
    pub fn settings_set(&self, key: &str, value: &str, secret: bool) -> CoreResult<()> {
        // The FX base URL gets the same validation here as in
        // `fx_configure` — otherwise the generic settings surface would be a
        // bypass for storing a credentialed URL in plaintext (mantra #4).
        if key == fx::FX_BASE_URL_KEY && !secret && !value.trim().is_empty() {
            let normalized = fx::normalize_base_url(value)?;
            return self.settings_set_raw(key, &normalized, false);
        }
        self.settings_set_raw(key, value, secret)
    }

    fn settings_set_raw(&self, key: &str, value: &str, secret: bool) -> CoreResult<()> {
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
    // FX (OpenRate) — opt-in, cached, decimal-only. See `crate::fx` docs.
    // -----------------------------------------------------------------------

    /// Set the OpenRate base URL (validated, normalized), or clear it with
    /// an empty string. A plain setting — an endpoint the user chose, not a
    /// secret. While unset, every FX fetch path fails with
    /// [`CoreError::FxNotConfigured`] before any transport is touched.
    pub fn fx_configure(&self, base_url: &str) -> CoreResult<()> {
        if base_url.trim().is_empty() {
            self.settings_set(fx::FX_BASE_URL_KEY, "", false)
        } else {
            let normalized = fx::normalize_base_url(base_url)?;
            self.settings_set(fx::FX_BASE_URL_KEY, &normalized, false)
        }
    }

    fn fx_base_url(&self) -> CoreResult<Option<String>> {
        Ok(self
            .settings_get(fx::FX_BASE_URL_KEY)?
            .filter(|url| !url.is_empty()))
    }

    /// FX configuration plus the cached rates with computed staleness.
    /// Purely local — never performs network I/O.
    pub fn fx_status(&self) -> CoreResult<fx::FxStatus> {
        let base_url = self.fx_base_url()?;
        let now = time::OffsetDateTime::now_utc();
        let cached_rates = fx::cache::list(self.conn())?
            .into_iter()
            .map(|row| fx::cached_rate_from_row(row, now))
            .collect::<CoreResult<Vec<_>>>()?;
        Ok(fx::FxStatus {
            configured: base_url.is_some(),
            base_url,
            cached_rates,
        })
    }

    /// Fetch the current rate for a pair from the configured OpenRate
    /// instance over `transport`, persist it to the local cache, and return
    /// the quote (rate, `as_of`, quality grade, staleness, sources).
    ///
    /// This is the **only** FX path that talks to the network, and only when
    /// the user configured a base URL — otherwise it fails with
    /// [`CoreError::FxNotConfigured`] without invoking the transport.
    pub async fn fx_fetch_rate(
        &self,
        transport: &dyn fx::FxTransport,
        from: &str,
        to: &str,
    ) -> CoreResult<fx::FxQuote> {
        let from = normalize_currency_code(from)?;
        let to = normalize_currency_code(to)?;
        let base_url = self.fx_base_url()?.ok_or(CoreError::FxNotConfigured)?;
        let client = fx::OpenRateClient::new(&base_url, transport)?;
        let quote = client.convert_one(&from, &to).await?;
        // Sanity-check before persisting: a non-positive rate would poison
        // the cache (0 silently converts everything to 0; negative fails
        // every later conversion) until a refetch.
        if quote.rate <= rust_decimal::Decimal::ZERO {
            return Err(CoreError::FxParse(format!(
                "OpenRate returned a non-positive rate {} for {from}/{to} — not caching it",
                quote.rate
            )));
        }
        let row = fx::cache::FxRateRow {
            from_currency: from.clone(),
            to_currency: to.clone(),
            rate: quote.rate.to_string(),
            as_of: quote.as_of.clone(),
            grade: quote.grade.clone(),
            fetched_at: now_iso(),
        };
        let tx = self.conn().unchecked_transaction()?;
        fx::cache::upsert(&tx, &row)?;
        self.emit_audit(
            &tx,
            None,
            "fx_rate",
            Some(&format!("{from}/{to}")),
            "fetch",
            None,
            Some(serde_json::to_string(&quote)?),
        )?;
        tx.commit()?;
        Ok(quote)
    }

    /// Convert an amount in minor units using the **cached** rate for the
    /// pair — never a network call, never a silent refresh. The returned
    /// conversion carries the exact decimal rate it used plus provenance
    /// (`as_of`, grade, `fetched_at`, computed staleness), and the same
    /// record lands in the audit log so booked conversions reproduce
    /// offline. A missing pair is a cache miss (`NotFound`): fetch first,
    /// explicitly.
    pub fn fx_convert(
        &self,
        from: &str,
        to: &str,
        amount_minor: i64,
    ) -> CoreResult<fx::FxConversion> {
        use std::str::FromStr as _;

        let from = normalize_currency_code(from)?;
        let to = normalize_currency_code(to)?;
        let conversion = if from == to {
            // Identity: no rate involved, works offline and unconfigured.
            let now = now_iso();
            fx::FxConversion {
                from_currency: from.clone(),
                to_currency: to.clone(),
                amount_minor,
                converted_minor: amount_minor,
                rate: rust_decimal::Decimal::ONE,
                as_of: now.clone(),
                grade: "identity".to_string(),
                fetched_at: now,
                age_secs: Some(0),
            }
        } else {
            let row =
                fx::cache::get(self.conn(), &from, &to)?.ok_or_else(|| CoreError::NotFound {
                    entity: "fx_rate",
                    id: format!("{from}/{to}"),
                })?;
            let rate = rust_decimal::Decimal::from_str(&row.rate).map_err(|e| {
                CoreError::FxParse(format!("cached rate {:?} for {from}/{to}: {e}", row.rate))
            })?;
            let converted_minor = fx::convert_minor(amount_minor, rate)?;
            let age_secs = fx::age_secs_since(&row.as_of, time::OffsetDateTime::now_utc());
            fx::FxConversion {
                from_currency: row.from_currency,
                to_currency: row.to_currency,
                amount_minor,
                converted_minor,
                rate,
                as_of: row.as_of,
                grade: row.grade,
                fetched_at: row.fetched_at,
                age_secs,
            }
        };
        // Record the rate used at booking time (rate serializes as a decimal
        // string) — conversions must reproduce offline, never re-rate.
        self.emit_audit(
            self.conn(),
            None,
            "fx_conversion",
            Some(&format!("{from}/{to}")),
            "convert",
            None,
            Some(serde_json::to_string(&conversion)?),
        )?;
        Ok(conversion)
    }

    /// Convert an amount **at a caller-supplied pinned rate** — the replay
    /// half of the contract "every conversion records the rate it used at
    /// booking time; reports reproduce offline and never silently re-rate".
    /// [`Self::fx_convert`] rates at the *current* cached rate; a booked
    /// conversion is replayed by feeding its recorded rate (a decimal
    /// string, e.g. from the returned [`fx::FxConversion`] or the audit log)
    /// back through here — the result is identical no matter how the cache
    /// has moved since. Purely local, never a network call.
    pub fn fx_convert_at(
        &self,
        from: &str,
        to: &str,
        amount_minor: i64,
        rate: &str,
    ) -> CoreResult<fx::FxConversion> {
        use std::str::FromStr as _;

        let from = normalize_currency_code(from)?;
        let to = normalize_currency_code(to)?;
        let rate = rust_decimal::Decimal::from_str(rate.trim())
            .map_err(|e| CoreError::Validation(format!("pinned rate {rate:?}: {e}")))?;
        if rate <= rust_decimal::Decimal::ZERO {
            return Err(CoreError::Validation(format!(
                "pinned rate must be positive, got {rate}"
            )));
        }
        let converted_minor = fx::convert_minor(amount_minor, rate)?;
        let conversion = fx::FxConversion {
            from_currency: from.clone(),
            to_currency: to.clone(),
            amount_minor,
            converted_minor,
            rate,
            // Provenance of a pinned rate lives with the original booking;
            // this replay only knows the rate itself.
            as_of: String::new(),
            grade: "pinned".to_string(),
            fetched_at: String::new(),
            age_secs: None,
        };
        self.emit_audit(
            self.conn(),
            None,
            "fx_conversion",
            Some(&format!("{from}/{to}")),
            "convert_at",
            None,
            Some(serde_json::to_string(&conversion)?),
        )?;
        Ok(conversion)
    }

    // -----------------------------------------------------------------------
    // Payments — watch codes, webhook endpoints, delivery dispatch.
    // Deliberately simple: watch codes are a flat list, detection lives in
    // `transaction_create`, secrets live in the vault. Pure logic (matching,
    // signing, backoff) is in `crate::pay`.
    // -----------------------------------------------------------------------

    /// The credential vault over this service's database + keychain.
    fn vault(&self) -> crate::secrets::Vault<'_> {
        crate::secrets::Vault::new(self.conn(), &*self.secrets)
    }

    /// Vault metadata for every stored secret — labels, versions,
    /// fingerprints, timestamps. Never material (the vault has no read path
    /// besides `use_with`).
    pub fn vault_list(&self) -> CoreResult<Vec<crate::secrets::VaultSecretMeta>> {
        self.vault().list_metadata()
    }

    /// Add a watch code: a reference to detect on inbound transactions,
    /// optionally narrowed to one exact amount. No lifecycle — the list is
    /// flat and `enabled` is the only state.
    pub fn pay_watch_add(&self, new: NewPayWatch) -> CoreResult<PayWatch> {
        self.book_get(&new.book_id)?;
        let code = new.code.trim().to_string();
        if code.is_empty() {
            return Err(CoreError::Validation("watch code must not be empty".into()));
        }
        let expected_currency = match (new.expected_amount_minor, new.expected_currency) {
            (Some(amount), currency) => {
                if amount <= 0 || amount > MAX_LINE_AMOUNT_MINOR {
                    return Err(CoreError::Validation(format!(
                        "expected amount {amount} out of range: must be positive (only inbound \
                         transactions match) and at most {MAX_LINE_AMOUNT_MINOR} minor units"
                    )));
                }
                match currency {
                    Some(raw) => Some(normalize_currency_code(&raw)?),
                    None => {
                        return Err(CoreError::Validation(
                            "an exact expected amount needs a currency (e.g. \"ZAR\") — \
                             the same number means different money in different currencies"
                                .into(),
                        ))
                    }
                }
            }
            (None, Some(raw)) => Some(normalize_currency_code(&raw)?),
            (None, None) => None,
        };
        let watch = PayWatch {
            id: new_id(),
            book_id: new.book_id,
            code,
            label: new
                .label
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty()),
            expected_amount_minor: new.expected_amount_minor,
            expected_currency,
            enabled: true,
            created_at: now_iso(),
        };
        let tx = self.conn().unchecked_transaction()?;
        repo::pay::insert_watch(&tx, &watch)?;
        self.emit_audit(
            &tx,
            Some(&watch.book_id),
            "pay_watch",
            Some(&watch.id),
            "create",
            None,
            Some(serde_json::to_string(&watch)?),
        )?;
        tx.commit()?;
        Ok(watch)
    }

    pub fn pay_watch_list(&self, book_id: &str) -> CoreResult<Vec<PayWatch>> {
        repo::pay::list_watches(self.conn(), book_id)
    }

    pub fn pay_watch_remove(&self, id: &str) -> CoreResult<()> {
        let before = repo::pay::get_watch(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "pay_watch",
            id: id.to_string(),
        })?;
        let tx = self.conn().unchecked_transaction()?;
        repo::pay::delete_watch(&tx, id)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "pay_watch",
            Some(id),
            "remove",
            Some(serde_json::to_string(&before)?),
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Flip a watch on/off — the only state a watch has.
    pub fn pay_watch_set_enabled(&self, id: &str, enabled: bool) -> CoreResult<PayWatch> {
        let before = repo::pay::get_watch(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
            entity: "pay_watch",
            id: id.to_string(),
        })?;
        let mut after = before.clone();
        after.enabled = enabled;
        let tx = self.conn().unchecked_transaction()?;
        repo::pay::set_watch_enabled(&tx, id, enabled)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "pay_watch",
            Some(id),
            "set_enabled",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    /// Register a webhook endpoint. Generates the signing secret (32 random
    /// bytes, hex) in core, stores it ONLY in the credential vault (under a
    /// name derived from the endpoint id), and returns it **exactly once**
    /// in [`PayEndpointWithSecret`] — the sanctioned single display, needed
    /// so the receiver operator can configure verification. From then on the
    /// vault's write-only contract applies: signing happens inside
    /// `use_with`, and a lost secret means rotating it.
    pub fn pay_endpoint_add(&self, new: NewPayEndpoint) -> CoreResult<PayEndpointWithSecret> {
        self.book_get(&new.book_id)?;
        let label = new.label.trim().to_string();
        if label.is_empty() {
            return Err(CoreError::Validation(
                "endpoint label must not be empty".into(),
            ));
        }
        let url = crate::pay::normalize_webhook_url(&new.url)?;
        let endpoint = PayEndpoint {
            id: new_id(),
            book_id: new.book_id,
            label,
            url,
            enabled: true,
            created_at: now_iso(),
        };
        // Vault first (it runs its own transaction — SQLite transactions do
        // not nest), then the endpoint row; if that fails, take the orphan
        // secret back out so nothing dangles.
        let secret = crate::pay::generate_secret_hex();
        let secret_name = crate::pay::endpoint_secret_name(&endpoint.id);
        self.vault()
            .set(&secret_name, SecretString::new(secret.as_str()))?;
        let stored: CoreResult<()> = (|| {
            let tx = self.conn().unchecked_transaction()?;
            repo::pay::insert_endpoint(&tx, &endpoint)?;
            self.emit_audit(
                &tx,
                Some(&endpoint.book_id),
                "pay_endpoint",
                Some(&endpoint.id),
                "create",
                None,
                Some(serde_json::to_string(&endpoint)?),
            )?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(e) = stored {
            let _ = self.vault().revoke(&secret_name);
            return Err(e);
        }
        Ok(PayEndpointWithSecret { endpoint, secret })
    }

    pub fn pay_endpoint_list(&self, book_id: &str) -> CoreResult<Vec<PayEndpoint>> {
        repo::pay::list_endpoints(self.conn(), book_id)
    }

    /// Rotate an endpoint's signing secret: the vault ciphertext is
    /// overwritten (old material destroyed) and the new secret is returned
    /// **exactly once** — same single-display contract as
    /// [`Self::pay_endpoint_add`].
    pub fn pay_endpoint_rotate_secret(&self, id: &str) -> CoreResult<PayEndpointWithSecret> {
        let endpoint =
            repo::pay::get_endpoint(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
                entity: "pay_endpoint",
                id: id.to_string(),
            })?;
        let secret = crate::pay::generate_secret_hex();
        self.vault().replace(
            &crate::pay::endpoint_secret_name(id),
            SecretString::new(secret.as_str()),
        )?;
        self.emit_audit(
            self.conn(),
            Some(&endpoint.book_id),
            "pay_endpoint",
            Some(id),
            "rotate_secret",
            None,
            None,
        )?;
        Ok(PayEndpointWithSecret { endpoint, secret })
    }

    /// Remove an endpoint: deletes the row (queued deliveries cascade) and
    /// revokes its vault-held signing secret.
    pub fn pay_endpoint_remove(&self, id: &str) -> CoreResult<()> {
        let before =
            repo::pay::get_endpoint(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
                entity: "pay_endpoint",
                id: id.to_string(),
            })?;
        let tx = self.conn().unchecked_transaction()?;
        repo::pay::delete_endpoint(&tx, id)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "pay_endpoint",
            Some(id),
            "remove",
            Some(serde_json::to_string(&before)?),
            None,
        )?;
        tx.commit()?;
        // Revoke the secret after the row is gone; a missing vault entry is
        // fine (already revoked), anything else surfaces.
        match self.vault().revoke(&crate::pay::endpoint_secret_name(id)) {
            Ok(()) | Err(CoreError::NotFound { .. }) => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn pay_endpoint_set_enabled(&self, id: &str, enabled: bool) -> CoreResult<PayEndpoint> {
        let before =
            repo::pay::get_endpoint(self.conn(), id)?.ok_or_else(|| CoreError::NotFound {
                entity: "pay_endpoint",
                id: id.to_string(),
            })?;
        let mut after = before.clone();
        after.enabled = enabled;
        let tx = self.conn().unchecked_transaction()?;
        repo::pay::set_endpoint_enabled(&tx, id, enabled)?;
        self.emit_audit(
            &tx,
            Some(&before.book_id),
            "pay_endpoint",
            Some(id),
            "set_enabled",
            Some(serde_json::to_string(&before)?),
            Some(serde_json::to_string(&after)?),
        )?;
        tx.commit()?;
        Ok(after)
    }

    pub fn pay_match_list(&self, book_id: &str) -> CoreResult<Vec<PayMatch>> {
        repo::pay::list_matches(self.conn(), book_id)
    }

    pub fn pay_delivery_list(&self, book_id: &str) -> CoreResult<Vec<PayDelivery>> {
        repo::pay::list_deliveries(self.conn(), book_id)
    }

    /// Detection hook, called from `transaction_create` inside its SQLite
    /// transaction. When a new INBOUND (positive) transaction's text carries
    /// an enabled watch code as a whole token (and the optional exact
    /// amount/currency match), writes a match row, enqueues one delivery per
    /// enabled endpoint, and audits — metadata only, never the description.
    fn detect_payment_matches(&self, conn: &Connection, txn: &Transaction) -> CoreResult<()> {
        if txn.amount_minor <= 0 {
            return Ok(()); // Outflows never match: watches are money-IN only.
        }
        let watches = repo::pay::list_enabled_watches(conn, &txn.book_id)?;
        if watches.is_empty() {
            return Ok(());
        }
        let endpoints = repo::pay::list_enabled_endpoints(conn, &txn.book_id)?;
        for watch in &watches {
            if let Some(expected) = watch.expected_amount_minor {
                if txn.amount_minor != expected {
                    continue;
                }
            }
            if let Some(expected) = watch.expected_currency.as_deref() {
                if txn.currency != expected {
                    continue;
                }
            }
            if !crate::pay::transaction_carries_code(txn, &watch.code) {
                continue;
            }
            let matched_at = now_iso();
            let m = PayMatch {
                id: new_id(),
                book_id: txn.book_id.clone(),
                watch_id: watch.id.clone(),
                transaction_id: txn.id.clone(),
                matched_at,
            };
            repo::pay::insert_match(conn, &m)?;
            let payload = crate::pay::build_payload(watch, txn, &m.matched_at);
            for endpoint in &endpoints {
                repo::pay::insert_delivery(
                    conn,
                    &PayDelivery {
                        id: new_id(),
                        book_id: txn.book_id.clone(),
                        endpoint_id: endpoint.id.clone(),
                        match_id: m.id.clone(),
                        payload: payload.clone(),
                        state: PayDeliveryState::Pending,
                        attempts: 0,
                        next_attempt_at: m.matched_at.clone(), // due immediately
                        last_status: None,
                        last_error: None,
                        created_at: m.matched_at.clone(),
                        updated_at: m.matched_at.clone(),
                    },
                )?;
            }
            // Metadata only: ids and a count — no reference text, no bank
            // description, no amounts beyond what the payload itself holds.
            self.emit_audit(
                conn,
                Some(&txn.book_id),
                "pay_match",
                Some(&m.id),
                "match",
                None,
                Some(
                    serde_json::json!({
                        "watch_id": m.watch_id,
                        "transaction_id": m.transaction_id,
                        "deliveries_enqueued": endpoints.len(),
                    })
                    .to_string(),
                ),
            )?;
        }
        Ok(())
    }

    /// Dispatch every due pending delivery over `transport`: POST the stored
    /// payload with HMAC-SHA256 signature headers
    /// (`X-SlipScan-Signature` / `-Timestamp` / `-Nonce`), the signature
    /// computed **inside** the vault's `use_with` closure so secret material
    /// never leaves it. Returns the deliveries it acted on, updated.
    ///
    /// Outcomes: 2xx → `delivered`; 4xx → `failed` immediately (the receiver
    /// rejected a well-formed request — retrying cannot help); 5xx, transport
    /// errors, and per-delivery signing failures (e.g. a revoked vault
    /// secret) → retried with exponential backoff (1m, 5m, 30m, 2h, 12h,
    /// then daily) up to [`crate::pay::MAX_DELIVERY_ATTEMPTS`]. A failure on
    /// one delivery never aborts the pass for the others.
    ///
    /// At-least-once: the outcome is written **after** the POST, so a crash
    /// between the two redelivers on the next run — the stable per-delivery
    /// nonce lets receivers deduplicate. `now` (RFC 3339) drives both the
    /// due-check and the signature timestamp, keeping runs reproducible.
    pub async fn pay_deliver_due(
        &self,
        transport: &dyn crate::pay::WebhookTransport,
        now: &str,
    ) -> CoreResult<Vec<PayDelivery>> {
        use time::format_description::well_known::Rfc3339;
        let now_dt = time::OffsetDateTime::parse(now, &Rfc3339)
            .map_err(|e| CoreError::Validation(format!("invalid now {now:?}: {e}")))?;
        let timestamp = now_dt.unix_timestamp().to_string();
        let due = repo::pay::list_due(self.conn(), now)?;
        let mut out = Vec::with_capacity(due.len());
        for item in due {
            let delivery = item.delivery;
            // Sign inside the vault: the closure sees the secret, the
            // dispatcher only ever holds the resulting hex signature. A
            // signing failure (secret revoked from the vault, a database
            // restored onto a machine without its keychain KEK, …) is scoped
            // to THIS delivery: it flows into the same failure handling as a
            // transport error below — recorded, retried with backoff,
            // abandoned at the cap — so one broken endpoint never stalls the
            // rest of the pass.
            let result = match self.vault().use_with(
                &crate::pay::endpoint_secret_name(&item.endpoint_id),
                |secret| {
                    Ok(crate::pay::sign_webhook(
                        secret.expose_secret(),
                        &timestamp,
                        &delivery.id,
                        delivery.payload.as_bytes(),
                    ))
                },
            ) {
                Ok(signature) => {
                    let headers = vec![
                        ("Content-Type".to_string(), "application/json".to_string()),
                        (crate::pay::HEADER_SIGNATURE.to_string(), signature),
                        (crate::pay::HEADER_TIMESTAMP.to_string(), timestamp.clone()),
                        (crate::pay::HEADER_NONCE.to_string(), delivery.id.clone()),
                    ];
                    transport
                        .post(&item.url, &headers, delivery.payload.as_bytes())
                        .await
                }
                Err(e) => Err(e),
            };

            // The POST has happened; record the outcome (at-least-once: a
            // crash before this write redelivers, the nonce dedupes).
            let mut updated = delivery;
            updated.attempts += 1;
            updated.updated_at = now.to_string();
            // Response bodies are receiver-controlled: only the status is
            // ever recorded, never echoed content (same posture as FX).
            let action = match &result {
                Ok(resp) if (200..300).contains(&resp.status) => {
                    updated.state = PayDeliveryState::Delivered;
                    updated.last_status = Some(i64::from(resp.status));
                    updated.last_error = None;
                    "delivered"
                }
                Ok(resp) if (400..500).contains(&resp.status) => {
                    // The receiver understood us and said no — fail fast.
                    updated.state = PayDeliveryState::Failed;
                    updated.last_status = Some(i64::from(resp.status));
                    updated.last_error = Some(format!("HTTP {}", resp.status));
                    "failed"
                }
                Ok(resp) => {
                    updated.last_status = Some(i64::from(resp.status));
                    Self::schedule_retry(&mut updated, now_dt, format!("HTTP {}", resp.status))
                }
                Err(e) => {
                    updated.last_status = None;
                    Self::schedule_retry(&mut updated, now_dt, e.to_string())
                }
            };
            // Outcome + audit commit atomically — a crash must never leave a
            // state transition without its append-only audit record. (The
            // POST itself stays outside any transaction: at-least-once.)
            let tx = self.conn().unchecked_transaction()?;
            repo::pay::update_delivery_outcome(&tx, &updated)?;
            self.emit_audit(
                &tx,
                Some(&updated.book_id),
                "pay_delivery",
                Some(&updated.id),
                action,
                None,
                Some(
                    serde_json::json!({
                        "endpoint_id": updated.endpoint_id,
                        "state": updated.state.as_str(),
                        "attempts": updated.attempts,
                        "last_status": updated.last_status,
                    })
                    .to_string(),
                ),
            )?;
            tx.commit()?;
            out.push(updated);
        }
        Ok(out)
    }

    /// Mark a retryable failure on `updated` (attempts already bumped):
    /// schedule the next attempt with exponential backoff, or abandon at the
    /// cap. Returns the audit action.
    fn schedule_retry(
        updated: &mut PayDelivery,
        now_dt: time::OffsetDateTime,
        error: String,
    ) -> &'static str {
        use time::format_description::well_known::Rfc3339;
        updated.last_error = Some(error);
        if updated.attempts >= crate::pay::MAX_DELIVERY_ATTEMPTS {
            updated.state = PayDeliveryState::Failed;
            "failed"
        } else {
            let delay = crate::pay::backoff_delay_secs(updated.attempts);
            updated.next_attempt_at = (now_dt + time::Duration::seconds(delay))
                .format(&Rfc3339)
                .expect("RFC 3339 formatting of a valid instant cannot fail");
            "retry_scheduled"
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
            region: None,
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
                region: None,
            })
            .unwrap();
        assert_eq!(book.currency, "ZAR");
        assert!(matches!(
            svc.book_create(NewBook {
                name: "Bad".into(),
                kind: BookKind::Personal,
                currency: Some("z!r".into()),
                country: None,
                region: None,
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
                region: None,
            })
            .unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)));
    }

    #[test]
    fn book_create_takes_explicit_region() {
        let svc = svc();
        // Explicit region, no country: za profile and its default currency.
        let za = svc
            .book_create(NewBook {
                name: "SA books".into(),
                kind: BookKind::Business,
                currency: None,
                country: None,
                region: Some("za".into()),
            })
            .unwrap();
        assert_eq!(za.region, "za");
        assert_eq!(za.currency, "ZAR");

        // Case-insensitive; canonical lowercase id is stored.
        let shouty = svc
            .book_create(NewBook {
                name: "Shouty".into(),
                kind: BookKind::Personal,
                currency: None,
                country: None,
                region: Some("GENERIC".into()),
            })
            .unwrap();
        assert_eq!(shouty.region, "generic");

        // Explicit region wins over country inference.
        let expat = svc
            .book_create(NewBook {
                name: "Expat".into(),
                kind: BookKind::Personal,
                currency: Some("EUR".into()),
                country: Some("ZA".into()),
                region: Some("generic".into()),
            })
            .unwrap();
        assert_eq!(expat.region, "generic");
        assert_eq!(expat.currency, "EUR");

        // Neither region nor country: the generic default.
        let default = svc
            .book_create(NewBook {
                name: "Anywhere".into(),
                kind: BookKind::Personal,
                currency: None,
                country: None,
                region: None,
            })
            .unwrap();
        assert_eq!(default.region, crate::region::DEFAULT_REGION_ID);

        // Unknown explicit region is rejected, not silently generic.
        let err = svc
            .book_create(NewBook {
                name: "Lost".into(),
                kind: BookKind::Personal,
                currency: None,
                country: None,
                region: Some("atlantis".into()),
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

    /// Stand-in for slipscan-packs' classifier: it recognises exactly one
    /// merchant, so registering it process-wide leaves every other test in
    /// this binary behaving as if nothing were registered.
    struct StubClassifier;

    /// The merchant the stub has an opinion about, normalized.
    const STUB_MERCHANT: &str = "stub pack merchant";

    impl MerchantClassifier for StubClassifier {
        fn suggest(
            &self,
            conn: &Connection,
            book_id: &str,
            merchant_normalized: &str,
            _description: Option<&str>,
        ) -> Option<CategorySuggestion> {
            if merchant_normalized != STUB_MERCHANT {
                return None;
            }
            // Whatever category the test named "Pack suggestion" in this book
            // — the real classifier resolves ids the same way, out of its own
            // tables in this same connection.
            let id: String = conn
                .query_row(
                    "SELECT id FROM categories WHERE book_id = ?1 AND name = 'Pack suggestion'",
                    [book_id],
                    |row| row.get(0),
                )
                .ok()?;
            Some(CategorySuggestion {
                category_id: id,
                confidence: 0.9,
            })
        }
    }

    #[test]
    fn registered_classifier_categorizes_and_user_mappings_still_win() {
        register_merchant_classifier(&StubClassifier);
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let suggested = make_category(&svc, &book, "Pack suggestion");
        let mine = make_category(&svc, &book, "Mine");

        let import = |merchant: &str, occurrence: u32| {
            let mut new = make_txn(&svc, &book, &account);
            new.merchant = Some(merchant.to_string());
            new.dedupe_occurrence = occurrence;
            svc.transaction_create(new).unwrap()
        };

        // No mapping for this merchant: the classifier is consulted, and its
        // verdict is remembered as a `pack` mapping.
        let txn = import("Stub Pack Merchant", 0);
        assert_eq!(txn.category_id.as_deref(), Some(suggested.id.as_str()));
        let mapping = repo::category::get_mapping(svc.conn(), &book.id, STUB_MERCHANT)
            .unwrap()
            .unwrap();
        assert_eq!(mapping.category_id, suggested.id);
        assert_eq!(mapping.source, MappingSource::Pack);

        // A merchant it has no opinion about is left uncategorised.
        assert!(import("Somewhere Else Entirely", 0).category_id.is_none());

        // The user corrects it: their mapping outranks the classifier from
        // then on, silently and permanently.
        svc.transaction_categorize(&txn.id, &mine.id).unwrap();
        let later = import("Stub Pack Merchant", 1);
        assert_eq!(later.category_id.as_deref(), Some(mine.id.as_str()));
        assert_eq!(
            repo::category::get_mapping(svc.conn(), &book.id, STUB_MERCHANT)
                .unwrap()
                .unwrap()
                .source,
            MappingSource::User
        );
    }

    /// A statement line as bank/CSV import builds it: a description, and no
    /// merchant at all. Before the key was derived from the description this
    /// path skipped categorisation entirely — no pack rules, and none of the
    /// book's own mappings or corrections either.
    fn statement_txn(book: &Book, account: &Account, narrative: &str) -> NewTransaction {
        NewTransaction {
            book_id: book.id.clone(),
            account_id: account.id.clone(),
            source: TransactionSource::Import,
            provider_txn_id: None,
            posted_date: "2026-07-01".into(),
            amount_minor: -45_900,
            currency: "ZAR".into(),
            merchant: None,
            description: Some(narrative.to_string()),
            notes: None,
            category_id: None,
            document_id: None,
            dedupe_occurrence: 0,
        }
    }

    #[test]
    fn statement_lines_categorize_from_their_description() {
        register_merchant_classifier(&StubClassifier);
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let suggested = make_category(&svc, &book, "Pack suggestion");

        // Description only, merchant None — the classifier is reached
        // through the key derived from the narrative, and its verdict is
        // remembered under that key like any other.
        let txn = svc
            .transaction_create(statement_txn(&book, &account, "STUB PACK MERCHANT"))
            .unwrap();
        assert_eq!(txn.merchant, None, "we never invent a display merchant");
        assert_eq!(txn.merchant_normalized.as_deref(), Some(STUB_MERCHANT));
        assert_eq!(txn.category_id.as_deref(), Some(suggested.id.as_str()));
        assert_eq!(
            repo::category::get_mapping(svc.conn(), &book.id, STUB_MERCHANT)
                .unwrap()
                .unwrap()
                .source,
            MappingSource::Pack
        );
    }

    #[test]
    fn statement_line_that_names_no_merchant_stays_untouched() {
        register_merchant_classifier(&StubClassifier);
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        make_category(&svc, &book, "Pack suggestion");

        // A bank housekeeping line names nobody. Declining is the point: a
        // key here would be guessed, and the moment the user categorised the
        // row it would write a durable mapping under that guess.
        let txn = svc
            .transaction_create(statement_txn(&book, &account, "MONTHLY ACCOUNT FEE"))
            .unwrap();
        assert_eq!(txn.merchant_normalized, None);
        assert_eq!(txn.category_id, None);
        // Categorising it by hand still works, and still writes no mapping.
        let cat = make_category(&svc, &book, "Bank charges");
        let updated = svc.transaction_categorize(&txn.id, &cat.id).unwrap();
        assert_eq!(updated.category_id.as_deref(), Some(cat.id.as_str()));
        assert!(repo::category::get_mapping(
            svc.conn(),
            &book.id,
            &normalize_merchant("MONTHLY ACCOUNT FEE")
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn statement_import_preserves_mapping_source_precedence() {
        register_merchant_classifier(&StubClassifier);
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let suggested = make_category(&svc, &book, "Pack suggestion");
        let learned_cat = make_category(&svc, &book, "Learned");
        let mine = make_category(&svc, &book, "Mine");

        let import = |occurrence: u32| {
            let mut new = statement_txn(&book, &account, "STUB PACK MERCHANT");
            new.dedupe_occurrence = occurrence;
            svc.transaction_create(new).unwrap()
        };

        // A learned (rule-sourced) mapping already outranks the pack.
        repo::category::upsert_mapping(
            svc.conn(),
            &book.id,
            STUB_MERCHANT,
            &learned_cat.id,
            MappingSource::Rule,
            0.8,
        )
        .unwrap();
        let learned = import(0);
        assert_eq!(
            learned.category_id.as_deref(),
            Some(learned_cat.id.as_str())
        );
        assert_ne!(learned.category_id.as_deref(), Some(suggested.id.as_str()));

        // The user's own correction outranks the learned rule, and keeps
        // outranking it on every later import of the same narrative.
        svc.transaction_categorize(&learned.id, &mine.id).unwrap();
        let mapping = repo::category::get_mapping(svc.conn(), &book.id, STUB_MERCHANT)
            .unwrap()
            .unwrap();
        assert_eq!(mapping.source, MappingSource::User);
        assert_eq!(mapping.category_id, mine.id);
        assert_eq!(import(1).category_id.as_deref(), Some(mine.id.as_str()));
    }

    #[test]
    fn derived_merchant_key_never_moves_the_dedupe_hash() {
        // Existing books hold statement rows whose hash was taken with no
        // merchant at all. Deriving a key must not shift the hash, or the
        // next overlapping statement pull re-imports every one of them as a
        // new transaction.
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let narrative = "PNP FAMILY KENILWORTH";
        let txn = svc
            .transaction_create(statement_txn(&book, &account, narrative))
            .unwrap();
        assert_eq!(
            txn.merchant_normalized.as_deref(),
            Some("pnp family kenilworth")
        );
        assert_eq!(
            txn.dedupe_hash,
            transaction_dedupe_hash(
                &account.id,
                "2026-07-01",
                -45_900,
                "ZAR",
                None,
                None, // as every release before the derived key wrote it
                Some(narrative),
                0,
            )
        );
        // And a re-import of that same line is still a duplicate.
        let err = svc
            .transaction_create(statement_txn(&book, &account, narrative))
            .unwrap_err();
        assert!(matches!(err, CoreError::DuplicateTransaction { .. }));
    }

    #[test]
    fn classifier_suggestion_of_a_stale_category_is_dropped() {
        register_merchant_classifier(&StubClassifier);
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        // No "Pack suggestion" category in this book at all: a rule pointing
        // at a category that no longer exists must not fail the import.
        let mut new = make_txn(&svc, &book, &account);
        new.merchant = Some("Stub Pack Merchant".into());
        let txn = svc.transaction_create(new).unwrap();
        assert!(txn.category_id.is_none());
        assert!(
            repo::category::get_mapping(svc.conn(), &book.id, STUB_MERCHANT)
                .unwrap()
                .is_none()
        );
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
                region: None,
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
                region: None,
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

    // -- product catalogue ----------------------------------------------------

    #[test]
    fn product_category_crud() {
        let svc = svc();
        let book = make_book(&svc);

        let cat = svc
            .product_category_create(NewProductCategory {
                book_id: book.id.clone(),
                name: "  Beverages  ".into(),
            })
            .unwrap();
        assert_eq!(cat.name, "Beverages", "name is trimmed");
        assert_eq!(
            svc.product_category_list(&book.id).unwrap(),
            vec![cat.clone()]
        );

        let renamed = svc
            .product_category_rename(&cat.id, "Drinks".into())
            .unwrap();
        assert_eq!(renamed.name, "Drinks");
        assert_eq!(svc.product_category_get(&cat.id).unwrap().name, "Drinks");

        svc.product_category_delete(&cat.id).unwrap();
        assert!(matches!(
            svc.product_category_get(&cat.id),
            Err(CoreError::NotFound { .. })
        ));

        let audits = svc.audit_list(Some(&book.id), 50).unwrap();
        for action in ["create", "update", "delete"] {
            assert!(
                audits
                    .iter()
                    .any(|a| a.entity_type == "product_category" && a.action == action),
                "missing product_category audit {action}"
            );
        }
    }

    #[test]
    fn product_category_create_rejects_empty_name() {
        let svc = svc();
        let book = make_book(&svc);
        assert!(matches!(
            svc.product_category_create(NewProductCategory {
                book_id: book.id,
                name: "   ".into(),
            }),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn product_crud_with_category_scoping_and_deleting_a_category_detaches_products() {
        let svc = svc();
        let book = make_book(&svc);
        let other_book = svc
            .book_create(NewBook {
                name: "Other".into(),
                kind: BookKind::Business,
                currency: None,
                country: None,
                region: None,
            })
            .unwrap();
        let category = svc
            .product_category_create(NewProductCategory {
                book_id: book.id.clone(),
                name: "Beverages".into(),
            })
            .unwrap();
        let foreign_category = svc
            .product_category_create(NewProductCategory {
                book_id: other_book.id.clone(),
                name: "Foreign".into(),
            })
            .unwrap();

        // Cross-book category is refused.
        assert!(matches!(
            svc.product_create(NewProduct {
                book_id: book.id.clone(),
                product_category_id: Some(foreign_category.id.clone()),
                name: "Cola".into(),
                description: None,
            }),
            Err(CoreError::Validation(_))
        ));

        let product = svc
            .product_create(NewProduct {
                book_id: book.id.clone(),
                product_category_id: Some(category.id.clone()),
                name: "  Cola  ".into(),
                description: Some("Fizzy drink".into()),
            })
            .unwrap();
        assert_eq!(product.name, "Cola", "name is trimmed");
        assert_eq!(svc.product_list(&book.id).unwrap(), vec![product.clone()]);

        let updated = svc
            .product_update(
                &product.id,
                ProductPatch {
                    name: Some("Cola Classic".into()),
                    description: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.name, "Cola Classic");
        assert_eq!(updated.description, None, "explicit clear");
        assert_eq!(
            updated.product_category_id.as_deref(),
            Some(category.id.as_str()),
            "untouched field stays as-is"
        );

        // Deleting the category detaches the product rather than deleting it.
        svc.product_category_delete(&category.id).unwrap();
        let detached = svc.product_get(&product.id).unwrap();
        assert_eq!(detached.product_category_id, None);

        svc.product_delete(&product.id).unwrap();
        assert!(matches!(
            svc.product_get(&product.id),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    fn product_variant_crud_normalizes_and_validates() {
        let svc = svc();
        let book = make_book(&svc);
        let product = svc
            .product_create(NewProduct {
                book_id: book.id.clone(),
                product_category_id: None,
                name: "Cola".into(),
                description: None,
            })
            .unwrap();

        let variant = svc
            .product_variant_add(NewProductVariant {
                product_id: product.id.clone(),
                sku: "  cola-330  ".into(),
                name: "  330ml can  ".into(),
                price_minor: Some(1500),
                cost_price_minor: Some(900),
                currency: "zar".into(),
                reorder_point: Some(24),
                attributes: Some(r#"{"size":"330ml"}"#.into()),
            })
            .unwrap();
        assert_eq!(variant.sku, "cola-330", "sku is trimmed");
        assert_eq!(variant.name, "330ml can", "name is trimmed");
        assert_eq!(variant.currency, "ZAR", "currency is normalized");
        assert_eq!(
            variant.book_id, book.id,
            "book id denormalized from product"
        );
        assert_eq!(
            svc.product_variant_list(&product.id).unwrap(),
            vec![variant.clone()]
        );
        assert_eq!(
            svc.product_variant_list_for_book(&book.id).unwrap(),
            vec![variant.clone()]
        );

        // Defaults: an omitted price/cost/reorder point is zero, not an error.
        let bare = svc
            .product_variant_add(NewProductVariant {
                product_id: product.id.clone(),
                sku: "cola-500".into(),
                name: "500ml bottle".into(),
                price_minor: None,
                cost_price_minor: None,
                currency: "ZAR".into(),
                reorder_point: None,
                attributes: None,
            })
            .unwrap();
        assert_eq!(bare.price_minor, 0);
        assert_eq!(bare.cost_price_minor, 0);
        assert_eq!(bare.reorder_point, 0);
        assert_eq!(bare.attributes, None);

        // Duplicate SKU within the same book is refused by the schema.
        assert!(svc
            .product_variant_add(NewProductVariant {
                product_id: product.id.clone(),
                sku: "cola-330".into(),
                name: "Duplicate".into(),
                price_minor: None,
                cost_price_minor: None,
                currency: "ZAR".into(),
                reorder_point: None,
                attributes: None,
            })
            .is_err());

        // Negative money and a non-object attributes payload are refused.
        for bad in [
            NewProductVariant {
                product_id: product.id.clone(),
                sku: "neg-price".into(),
                name: "Bad".into(),
                price_minor: Some(-1),
                cost_price_minor: None,
                currency: "ZAR".into(),
                reorder_point: None,
                attributes: None,
            },
            NewProductVariant {
                product_id: product.id.clone(),
                sku: "bad-attrs".into(),
                name: "Bad".into(),
                price_minor: None,
                cost_price_minor: None,
                currency: "ZAR".into(),
                reorder_point: None,
                attributes: Some("[1,2,3]".into()),
            },
        ] {
            assert!(matches!(
                svc.product_variant_add(bad),
                Err(CoreError::Validation(_))
            ));
        }

        let patched = svc
            .product_variant_update(
                &variant.id,
                ProductVariantPatch {
                    price_minor: Some(1600),
                    attributes: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(patched.price_minor, 1600);
        assert_eq!(patched.attributes, None, "explicit clear");
        assert_eq!(patched.sku, "cola-330", "untouched field stays as-is");

        svc.product_variant_delete(&variant.id).unwrap();
        assert!(matches!(
            svc.product_variant_get(&variant.id),
            Err(CoreError::NotFound { .. })
        ));

        let audits = svc.audit_list(Some(&book.id), 50).unwrap();
        for action in ["create", "update", "delete"] {
            assert!(
                audits
                    .iter()
                    .any(|a| a.entity_type == "product_variant" && a.action == action),
                "missing product_variant audit {action}"
            );
        }
    }

    #[test]
    fn product_variant_cascade_deletes_with_its_product() {
        let svc = svc();
        let book = make_book(&svc);
        let product = svc
            .product_create(NewProduct {
                book_id: book.id.clone(),
                product_category_id: None,
                name: "Cola".into(),
                description: None,
            })
            .unwrap();
        let variant = svc
            .product_variant_add(NewProductVariant {
                product_id: product.id.clone(),
                sku: "cola-330".into(),
                name: "330ml can".into(),
                price_minor: None,
                cost_price_minor: None,
                currency: "ZAR".into(),
                reorder_point: None,
                attributes: None,
            })
            .unwrap();

        svc.product_delete(&product.id).unwrap();
        // The variant row is gone via ON DELETE CASCADE, not merely
        // unreachable — check the raw table, since `product_variant_get`
        // returning NotFound is consistent with either.
        let remaining: i64 = svc
            .conn_for_test()
            .query_row(
                "SELECT COUNT(*) FROM product_variants WHERE id = ?1",
                rusqlite::params![variant.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0, "cascade delete did not reach the variant");
    }

    // -- stock movements (migration 0012, ROADMAP.md Phase 6.3b) ------------

    fn make_location(svc: &CoreService, book: &Book, name: &str) -> Location {
        svc.location_create(NewLocation {
            book_id: book.id.clone(),
            name: name.into(),
            kind: None,
            code: None,
            address: None,
        })
        .unwrap()
    }

    fn make_variant(svc: &CoreService, book: &Book, sku: &str) -> ProductVariant {
        let product = svc
            .product_create(NewProduct {
                book_id: book.id.clone(),
                product_category_id: None,
                name: "Cola".into(),
                description: None,
            })
            .unwrap();
        svc.product_variant_add(NewProductVariant {
            product_id: product.id,
            sku: sku.into(),
            name: "330ml can".into(),
            price_minor: Some(1500),
            cost_price_minor: Some(900),
            currency: "ZAR".into(),
            reorder_point: Some(10),
            attributes: None,
        })
        .unwrap()
    }

    fn new_movement(
        variant_id: &str,
        location_id: &str,
        qty_delta: i64,
        kind: StockMovementKind,
    ) -> NewStockMovement {
        NewStockMovement {
            variant_id: variant_id.into(),
            location_id: location_id.into(),
            qty_delta,
            kind,
            ref_kind: None,
            ref_id: None,
            note: None,
            created_by: None,
        }
    }

    /// **The core invariant, proven rather than assumed.** On-hand is never a
    /// stored figure anywhere in this crate — every read here is
    /// `SUM(qty_delta)` computed at query time by `repo::stock`. A receipt, a
    /// sale and an adjustment at one location sum to the hand-computed
    /// answer, and a second location's movements are invisible to the first
    /// location's on-hand until summed across both.
    #[test]
    fn on_hand_is_always_the_sum_of_movements_never_a_stored_counter() {
        let svc = svc();
        let book = make_book(&svc);
        let variant = make_variant(&svc, &book, "COLA-330");
        let branch = make_location(&svc, &book, "Branch");
        let warehouse = make_location(&svc, &book, "Warehouse");

        svc.stock_movement_record(new_movement(
            &variant.id,
            &branch.id,
            50,
            StockMovementKind::Receipt,
        ))
        .unwrap();
        svc.stock_movement_record(new_movement(
            &variant.id,
            &branch.id,
            -12,
            StockMovementKind::Sale,
        ))
        .unwrap();
        svc.stock_movement_record(new_movement(
            &variant.id,
            &branch.id,
            -3,
            StockMovementKind::Adjustment,
        ))
        .unwrap();
        // 50 - 12 - 3 = 35 at the branch; nothing at the warehouse yet.
        assert_eq!(svc.stock_on_hand(&variant.id, &branch.id).unwrap(), 35);
        assert_eq!(svc.stock_on_hand(&variant.id, &warehouse.id).unwrap(), 0);
        assert_eq!(svc.stock_on_hand_total(&variant.id).unwrap(), 35);

        svc.stock_movement_record(new_movement(
            &variant.id,
            &warehouse.id,
            100,
            StockMovementKind::Receipt,
        ))
        .unwrap();
        // The branch is untouched by a movement recorded elsewhere...
        assert_eq!(svc.stock_on_hand(&variant.id, &branch.id).unwrap(), 35);
        // ...but the across-every-location total picks it up.
        assert_eq!(svc.stock_on_hand_total(&variant.id).unwrap(), 135);

        let by_location = svc.stock_on_hand_by_location(&variant.id).unwrap();
        assert_eq!(by_location.len(), 2);
        assert!(by_location.contains(&(branch.id.clone(), 35)));
        assert!(by_location.contains(&(warehouse.id.clone(), 100)));

        let history = svc.stock_movements_for_variant(&variant.id).unwrap();
        assert_eq!(
            history.len(),
            4,
            "every movement is retained, not collapsed"
        );
    }

    #[test]
    fn stock_movement_record_validates_book_scoping_and_zero_delta() {
        let svc = svc();
        let book = make_book(&svc);
        let other_book = svc
            .book_create(NewBook {
                name: "Other".into(),
                kind: BookKind::Business,
                currency: None,
                country: None,
                region: None,
            })
            .unwrap();
        let variant = make_variant(&svc, &book, "COLA-330");
        let foreign_location = make_location(&svc, &other_book, "Foreign Branch");

        assert!(matches!(
            svc.stock_movement_record(new_movement(
                &variant.id,
                &foreign_location.id,
                5,
                StockMovementKind::Receipt,
            )),
            Err(CoreError::Validation(_))
        ));

        let branch = make_location(&svc, &book, "Branch");
        assert!(matches!(
            svc.stock_movement_record(new_movement(
                &variant.id,
                &branch.id,
                0,
                StockMovementKind::Adjustment,
            )),
            Err(CoreError::Validation(_))
        ));

        // A ref_id naming nothing (no ref_kind alongside it) is refused —
        // half of "what caused this" is not a fact worth recording.
        let mut orphaned_ref = new_movement(&variant.id, &branch.id, 1, StockMovementKind::Receipt);
        orphaned_ref.ref_id = Some("po-1".into());
        assert!(matches!(
            svc.stock_movement_record(orphaned_ref),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn stock_movement_record_rejects_an_unknown_variant_or_location() {
        let svc = svc();
        let book = make_book(&svc);
        let variant = make_variant(&svc, &book, "COLA-330");
        let branch = make_location(&svc, &book, "Branch");

        assert!(matches!(
            svc.stock_movement_record(new_movement(
                "missing-variant",
                &branch.id,
                1,
                StockMovementKind::Receipt,
            )),
            Err(CoreError::NotFound { .. })
        ));
        assert!(matches!(
            svc.stock_movement_record(new_movement(
                &variant.id,
                "missing-location",
                1,
                StockMovementKind::Receipt,
            )),
            Err(CoreError::NotFound { .. })
        ));
    }

    /// **The transfer invariant ROADMAP.md 6.3b names explicitly.** A
    /// transfer is two movements, and they must sum to exactly zero — proven
    /// by summing the two rows this call actually wrote, not merely by
    /// trusting the function that wrote them.
    #[test]
    fn stock_transfer_writes_two_movements_that_sum_to_zero() {
        let svc = svc();
        let book = make_book(&svc);
        let variant = make_variant(&svc, &book, "COLA-330");
        let branch = make_location(&svc, &book, "Branch");
        let warehouse = make_location(&svc, &book, "Warehouse");

        svc.stock_movement_record(new_movement(
            &variant.id,
            &warehouse.id,
            100,
            StockMovementKind::Receipt,
        ))
        .unwrap();

        let result = svc
            .stock_transfer(
                &variant.id,
                &warehouse.id,
                &branch.id,
                30,
                Some("restocking".into()),
                Some("alice".into()),
            )
            .unwrap();

        assert_eq!(result.out.qty_delta, -30);
        assert_eq!(result.in_.qty_delta, 30);
        assert_eq!(
            result.out.qty_delta + result.in_.qty_delta,
            0,
            "a transfer's two legs must sum to zero"
        );
        assert_eq!(result.out.location_id, warehouse.id);
        assert_eq!(result.in_.location_id, branch.id);
        assert_eq!(result.out.kind, StockMovementKind::Transfer);
        assert_eq!(result.in_.kind, StockMovementKind::Transfer);
        assert_eq!(result.out.ref_kind.as_deref(), Some("transfer"));
        assert_eq!(result.out.ref_id, result.in_.ref_id, "one shared ref_id");

        assert_eq!(svc.stock_on_hand(&variant.id, &warehouse.id).unwrap(), 70);
        assert_eq!(svc.stock_on_hand(&variant.id, &branch.id).unwrap(), 30);
        // The transfer changed WHERE the stock is, never how much exists.
        assert_eq!(svc.stock_on_hand_total(&variant.id).unwrap(), 100);

        let pair = svc
            .stock_movements_for_ref("transfer", result.out.ref_id.as_deref().unwrap())
            .unwrap();
        assert_eq!(pair.len(), 2, "both legs are findable by their shared ref");
    }

    #[test]
    fn stock_transfer_validates_quantity_locations_and_book_scoping() {
        let svc = svc();
        let book = make_book(&svc);
        let variant = make_variant(&svc, &book, "COLA-330");
        let branch = make_location(&svc, &book, "Branch");
        let warehouse = make_location(&svc, &book, "Warehouse");

        assert!(matches!(
            svc.stock_transfer(&variant.id, &warehouse.id, &branch.id, 0, None, None),
            Err(CoreError::Validation(_))
        ));
        assert!(matches!(
            svc.stock_transfer(&variant.id, &warehouse.id, &branch.id, -5, None, None),
            Err(CoreError::Validation(_))
        ));
        assert!(matches!(
            svc.stock_transfer(&variant.id, &branch.id, &branch.id, 5, None, None),
            Err(CoreError::Validation(_)),
        ));

        let other_book = svc
            .book_create(NewBook {
                name: "Other".into(),
                kind: BookKind::Business,
                currency: None,
                country: None,
                region: None,
            })
            .unwrap();
        let foreign_location = make_location(&svc, &other_book, "Foreign Branch");
        assert!(matches!(
            svc.stock_transfer(
                &variant.id,
                &warehouse.id,
                &foreign_location.id,
                5,
                None,
                None
            ),
            Err(CoreError::Validation(_))
        ));
    }

    /// **Convergence by union, proven directly.** Two locations record their
    /// own movements for the same variant while disconnected — this device
    /// never sees them arrive "in order", it sees whatever order a sync pull
    /// happens to apply them in. `SUM(qty_delta)` must land on the same
    /// answer regardless, because a ledger union has no such thing as replay
    /// order affecting the total; that is precisely the property a cached
    /// counter (last-write-wins) would NOT have.
    #[test]
    fn on_hand_converges_to_the_same_total_regardless_of_the_order_movements_are_applied_in() {
        let forward = svc();
        let book = make_book(&forward);
        let variant = make_variant(&forward, &book, "COLA-330");
        let branch = make_location(&forward, &book, "Branch");

        // Six independent facts, as if two disconnected devices each
        // recorded three of them locally before ever syncing.
        let facts: Vec<(i64, StockMovementKind)> = vec![
            (50, StockMovementKind::Receipt),
            (-5, StockMovementKind::Sale),
            (-2, StockMovementKind::Sale),
            (20, StockMovementKind::Receipt),
            (-8, StockMovementKind::Sale),
            (1, StockMovementKind::Adjustment),
        ];
        let expected_total: i64 = facts.iter().map(|(qty, _)| qty).sum();

        for (qty, kind) in &facts {
            forward
                .stock_movement_record(new_movement(&variant.id, &branch.id, *qty, *kind))
                .unwrap();
        }
        assert_eq!(
            forward.stock_on_hand(&variant.id, &branch.id).unwrap(),
            expected_total
        );

        // A second, independent database applies the identical set of facts
        // in reverse order — standing in for a peer whose sync pull happened
        // to deliver them differently. Same rows, same book/variant/location
        // ids so the comparison is meaningful, different apply order.
        let reversed = svc();
        reversed
            .db
            .conn()
            .execute_batch(&format!(
                "INSERT INTO books (id, kind, name, currency, locale, timezone, created_at, updated_at, region)
                 VALUES ('{book_id}', 'personal', 'Household', 'ZAR', 'en', 'UTC', 't', 't', 'za');
                 INSERT INTO products (id, book_id, name, created_at, updated_at)
                 VALUES ('prod-1', '{book_id}', 'Cola', 't', 't');
                 INSERT INTO product_variants (id, product_id, book_id, sku, name, price_minor,
                     cost_price_minor, currency, reorder_point, created_at, updated_at)
                 VALUES ('{variant_id}', 'prod-1', '{book_id}', 'COLA-330', '330ml can', 1500, 900,
                     'ZAR', 10, 't', 't');
                 INSERT INTO locations (id, book_id, name, kind, created_at, updated_at)
                 VALUES ('{location_id}', '{book_id}', 'Branch', 'branch', 't', 't');",
                book_id = book.id,
                variant_id = variant.id,
                location_id = branch.id,
            ))
            .unwrap();
        for (qty, kind) in facts.iter().rev() {
            reversed
                .stock_movement_record(new_movement(&variant.id, &branch.id, *qty, *kind))
                .unwrap();
        }
        assert_eq!(
            reversed.stock_on_hand(&variant.id, &branch.id).unwrap(),
            expected_total,
            "the same facts applied in the opposite order must converge on the same total"
        );
        assert_eq!(
            forward.stock_on_hand(&variant.id, &branch.id).unwrap(),
            reversed.stock_on_hand(&variant.id, &branch.id).unwrap(),
        );
    }

    #[test]
    fn stock_movements_are_insert_only_at_the_database_level() {
        let svc = svc();
        let book = make_book(&svc);
        let variant = make_variant(&svc, &book, "COLA-330");
        let branch = make_location(&svc, &book, "Branch");
        let movement = svc
            .stock_movement_record(new_movement(
                &variant.id,
                &branch.id,
                5,
                StockMovementKind::Receipt,
            ))
            .unwrap();

        let err = svc
            .conn_for_test()
            .execute(
                "UPDATE stock_movements SET qty_delta = 1 WHERE id = ?1",
                rusqlite::params![movement.id],
            )
            .unwrap_err();
        assert!(err.to_string().contains("immutable"));

        let err = svc
            .conn_for_test()
            .execute(
                "DELETE FROM stock_movements WHERE id = ?1",
                rusqlite::params![movement.id],
            )
            .unwrap_err();
        assert!(err.to_string().contains("immutable"));

        // Still there, unchanged — the attempted UPDATE/DELETE did nothing.
        assert_eq!(
            svc.stock_on_hand(&variant.id, &branch.id).unwrap(),
            5,
            "the rejected statements must not have partially applied"
        );
    }

    /// A variant or location with movement history cannot be deleted out from
    /// under its own ledger — the `ON DELETE RESTRICT` migration 0012 adds,
    /// proven against the database rather than assumed from the SQL text.
    #[test]
    fn deleting_a_variant_or_location_with_movement_history_is_blocked() {
        let svc = svc();
        let book = make_book(&svc);
        let variant = make_variant(&svc, &book, "COLA-330");
        let branch = make_location(&svc, &book, "Branch");
        svc.stock_movement_record(new_movement(
            &variant.id,
            &branch.id,
            5,
            StockMovementKind::Receipt,
        ))
        .unwrap();

        assert!(
            svc.product_variant_delete(&variant.id).is_err(),
            "a variant with movement history must not be deletable"
        );
        assert!(
            svc.location_delete(&branch.id).is_err(),
            "a location with movement history must not be deletable"
        );
    }

    #[test]
    fn stock_low_variants_lists_variants_at_or_below_their_reorder_point() {
        let svc = svc();
        let book = make_book(&svc);
        let branch = make_location(&svc, &book, "Branch");

        // reorder_point defaults to 10 in `make_variant`.
        let low = make_variant(&svc, &book, "LOW-1");
        svc.stock_movement_record(new_movement(
            &low.id,
            &branch.id,
            10,
            StockMovementKind::Receipt,
        ))
        .unwrap();
        // At the reorder point exactly — "at or below" includes this.

        let plenty = make_variant(&svc, &book, "PLENTY-1");
        svc.stock_movement_record(new_movement(
            &plenty.id,
            &branch.id,
            11,
            StockMovementKind::Receipt,
        ))
        .unwrap();

        let never_stocked = make_variant(&svc, &book, "NEVER-1");
        // No movements at all: on-hand is 0, at or below its reorder point
        // of 10 — a variant nobody has ever received is a live "reorder"
        // candidate, not an absence from the report.

        let low_variants = svc.stock_low_variants(&book.id).unwrap();
        let ids: Vec<&str> = low_variants.iter().map(|l| l.variant.id.as_str()).collect();
        assert!(ids.contains(&low.id.as_str()));
        assert!(ids.contains(&never_stocked.id.as_str()));
        assert!(
            !ids.contains(&plenty.id.as_str()),
            "a variant well above its reorder point must not be listed"
        );

        let low_entry = low_variants
            .iter()
            .find(|l| l.variant.id == low.id)
            .unwrap();
        assert_eq!(low_entry.on_hand, 10);
    }

    // -- sales orders & invoicing (migration 0014, ROADMAP.md Phase 6.5) ----

    fn make_contact(svc: &CoreService, book: &Book, name: &str) -> Contact {
        svc.contact_add(NewContact {
            book_id: book.id.clone(),
            role: ContactRole::Customer,
            name: name.into(),
            company_name: None,
            email: None,
            phone: None,
            billing_address: None,
            shipping_address: None,
            tax_number: None,
            payment_terms_days: None,
            credit_limit_minor: None,
            notes: None,
        })
        .unwrap()
    }

    /// **The core invariant of the whole stage, proven rather than assumed.**
    /// Confirming an order deducts stock; cancelling a confirmed one puts it
    /// back — as a compensating movement, never by touching the original
    /// rows, which `stock_movements_for_ref` proves directly by showing both
    /// still exist.
    #[test]
    fn sales_order_confirm_deducts_stock_and_cancel_reverses_it() {
        let svc = svc();
        let book = make_book(&svc);
        let location = make_location(&svc, &book, "Main Branch");
        let variant = make_variant(&svc, &book, "COLA-330");
        let contact = make_contact(&svc, &book, "Acme Wholesale");

        svc.stock_movement_record(new_movement(
            &variant.id,
            &location.id,
            50,
            StockMovementKind::Receipt,
        ))
        .unwrap();
        assert_eq!(svc.stock_on_hand(&variant.id, &location.id).unwrap(), 50);

        let order = svc
            .sales_order_create(NewSalesOrder {
                book_id: book.id.clone(),
                contact_id: contact.id.clone(),
                location_id: Some(location.id.clone()),
                order_date: None,
                currency: None,
                notes: None,
            })
            .unwrap();
        assert_eq!(order.status, SalesOrderStatus::Draft);
        assert_eq!(order.currency, book.currency, "defaults from the book");

        svc.sales_order_item_add(NewSalesOrderItem {
            sales_order_id: order.id.clone(),
            variant_id: Some(variant.id.clone()),
            description: None,
            quantity: 8,
            unit_price_minor: None,
            tax_rate_bps: None,
        })
        .unwrap();

        let confirmed = svc.sales_order_confirm(&order.id).unwrap();
        assert_eq!(confirmed.status, SalesOrderStatus::Confirmed);
        assert!(confirmed.confirmed_at.is_some());
        assert_eq!(svc.stock_on_hand(&variant.id, &location.id).unwrap(), 42);

        let cancelled = svc.sales_order_cancel(&order.id).unwrap();
        assert_eq!(cancelled.status, SalesOrderStatus::Cancelled);
        assert_eq!(
            svc.stock_on_hand(&variant.id, &location.id).unwrap(),
            50,
            "cancelling a confirmed order must put every unit it took back"
        );

        let history = svc
            .stock_movements_for_ref("sales_order", &order.id)
            .unwrap();
        assert_eq!(
            history.len(),
            2,
            "one deduction on confirm, one compensating reversal on cancel — never an edit"
        );
        assert_eq!(history.iter().map(|m| m.qty_delta).sum::<i64>(), 0);
    }

    #[test]
    fn sales_order_confirm_requires_a_location_for_stock_lines() {
        let svc = svc();
        let book = make_book(&svc);
        let variant = make_variant(&svc, &book, "COLA-330");
        let contact = make_contact(&svc, &book, "Acme Wholesale");

        let order = svc
            .sales_order_create(NewSalesOrder {
                book_id: book.id.clone(),
                contact_id: contact.id.clone(),
                location_id: None,
                order_date: None,
                currency: None,
                notes: None,
            })
            .unwrap();
        svc.sales_order_item_add(NewSalesOrderItem {
            sales_order_id: order.id.clone(),
            variant_id: Some(variant.id.clone()),
            description: None,
            quantity: 1,
            unit_price_minor: None,
            tax_rate_bps: None,
        })
        .unwrap();

        let err = svc.sales_order_confirm(&order.id).unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)), "{err}");

        // A purely free-text order needs no location at all.
        let service_order = svc
            .sales_order_create(NewSalesOrder {
                book_id: book.id.clone(),
                contact_id: contact.id.clone(),
                location_id: None,
                order_date: None,
                currency: None,
                notes: None,
            })
            .unwrap();
        svc.sales_order_item_add(NewSalesOrderItem {
            sales_order_id: service_order.id.clone(),
            variant_id: None,
            description: Some("Consulting".into()),
            quantity: 1,
            unit_price_minor: Some(50_000),
            tax_rate_bps: None,
        })
        .unwrap();
        let confirmed = svc.sales_order_confirm(&service_order.id).unwrap();
        assert_eq!(confirmed.status, SalesOrderStatus::Confirmed);
    }

    #[test]
    fn sales_order_status_transitions_are_validated() {
        let svc = svc();
        let book = make_book(&svc);
        let contact = make_contact(&svc, &book, "Acme Wholesale");
        let order = svc
            .sales_order_create(NewSalesOrder {
                book_id: book.id.clone(),
                contact_id: contact.id.clone(),
                location_id: None,
                order_date: None,
                currency: None,
                notes: None,
            })
            .unwrap();

        // Can't confirm an order with no lines.
        assert!(matches!(
            svc.sales_order_confirm(&order.id),
            Err(CoreError::Validation(_))
        ));
        // Can't mark a draft order paid — it has to be confirmed first.
        assert!(matches!(
            svc.sales_order_mark_paid(&order.id),
            Err(CoreError::InvalidStatusTransition { .. })
        ));

        svc.sales_order_item_add(NewSalesOrderItem {
            sales_order_id: order.id.clone(),
            variant_id: None,
            description: Some("Consulting".into()),
            quantity: 1,
            unit_price_minor: Some(1000),
            tax_rate_bps: None,
        })
        .unwrap();
        svc.sales_order_confirm(&order.id).unwrap();

        // Can't confirm twice.
        assert!(matches!(
            svc.sales_order_confirm(&order.id),
            Err(CoreError::InvalidStatusTransition { .. })
        ));

        let paid = svc.sales_order_mark_paid(&order.id).unwrap();
        assert_eq!(paid.status, SalesOrderStatus::Paid);
        assert!(paid.paid_at.is_some());

        // A paid order can no longer be cancelled.
        assert!(matches!(
            svc.sales_order_cancel(&order.id),
            Err(CoreError::InvalidStatusTransition { .. })
        ));

        // Only a draft order can be deleted.
        assert!(matches!(
            svc.sales_order_delete(&order.id),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn sales_order_item_management_is_restricted_to_draft() {
        let svc = svc();
        let book = make_book(&svc);
        let contact = make_contact(&svc, &book, "Acme Wholesale");
        let order = svc
            .sales_order_create(NewSalesOrder {
                book_id: book.id.clone(),
                contact_id: contact.id.clone(),
                location_id: None,
                order_date: None,
                currency: None,
                notes: None,
            })
            .unwrap();

        // A free-text line needs both a description and a price.
        assert!(matches!(
            svc.sales_order_item_add(NewSalesOrderItem {
                sales_order_id: order.id.clone(),
                variant_id: None,
                description: None,
                quantity: 1,
                unit_price_minor: None,
                tax_rate_bps: None,
            }),
            Err(CoreError::Validation(_))
        ));

        let item = svc
            .sales_order_item_add(NewSalesOrderItem {
                sales_order_id: order.id.clone(),
                variant_id: None,
                description: Some("Consulting".into()),
                quantity: 2,
                unit_price_minor: Some(5_000),
                tax_rate_bps: Some(1500),
            })
            .unwrap();

        let updated = svc
            .sales_order_item_update(
                &item.id,
                SalesOrderItemPatch {
                    quantity: Some(3),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.quantity, 3);

        let totals = svc.sales_order_totals(&order.id).unwrap();
        assert_eq!(totals.subtotal_minor, 15_000);
        assert_eq!(totals.tax_minor, 2_250); // 15% of 15 000
        assert_eq!(totals.total_minor, 17_250);

        svc.sales_order_confirm(&order.id).unwrap();

        // Once confirmed, the line is frozen.
        assert!(matches!(
            svc.sales_order_item_update(&item.id, SalesOrderItemPatch::default()),
            Err(CoreError::Validation(_))
        ));
        assert!(matches!(
            svc.sales_order_item_remove(&item.id),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn invoice_issue_from_order_copies_items_and_requires_confirmed_or_paid() {
        let svc = svc();
        let book = make_book(&svc);
        let contact = make_contact(&svc, &book, "Acme Wholesale");
        let order = svc
            .sales_order_create(NewSalesOrder {
                book_id: book.id.clone(),
                contact_id: contact.id.clone(),
                location_id: None,
                order_date: None,
                currency: None,
                notes: None,
            })
            .unwrap();
        svc.sales_order_item_add(NewSalesOrderItem {
            sales_order_id: order.id.clone(),
            variant_id: None,
            description: Some("Consulting".into()),
            quantity: 2,
            unit_price_minor: Some(10_000),
            tax_rate_bps: Some(1500),
        })
        .unwrap();

        // Can't invoice a draft order.
        assert!(matches!(
            svc.invoice_issue(NewInvoice {
                book_id: book.id.clone(),
                contact_id: None,
                sales_order_id: Some(order.id.clone()),
                series: None,
                issue_date: None,
                due_date: "2026-12-31".into(),
                currency: None,
                notes: None,
                items: vec![],
            }),
            Err(CoreError::Validation(_))
        ));

        svc.sales_order_confirm(&order.id).unwrap();

        let invoice = svc
            .invoice_issue(NewInvoice {
                book_id: book.id.clone(),
                contact_id: None,
                sales_order_id: Some(order.id.clone()),
                series: None,
                issue_date: None,
                due_date: "2026-12-31".into(),
                currency: None,
                notes: None,
                items: vec![],
            })
            .unwrap();
        assert_eq!(invoice.contact_id, contact.id, "derived from the order");
        assert_eq!(invoice.series, "invoice");
        assert_eq!(invoice.number, 1);

        let items = svc.invoice_items_list(&invoice.id).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].description, "Consulting");
        assert_eq!(items[0].quantity, 2);

        let totals = svc.invoice_totals(&invoice.id).unwrap();
        assert_eq!(totals.subtotal_minor, 20_000);
        assert_eq!(totals.tax_minor, 3_000);
        assert_eq!(totals.total_minor, 23_000);
        assert_eq!(totals.status, InvoicePaymentStatus::Unpaid);
    }

    #[test]
    fn invoice_issue_standalone_validates_contact_and_items() {
        let svc = svc();
        let book = make_book(&svc);
        let contact = make_contact(&svc, &book, "Acme Wholesale");

        assert!(matches!(
            svc.invoice_issue(NewInvoice {
                book_id: book.id.clone(),
                contact_id: None,
                sales_order_id: None,
                series: None,
                issue_date: None,
                due_date: "2026-12-31".into(),
                currency: Some("ZAR".into()),
                notes: None,
                items: vec![NewInvoiceItemInput {
                    variant_id: None,
                    description: "Retainer".into(),
                    quantity: 1,
                    unit_price_minor: 100_000,
                    tax_rate_bps: None,
                }],
            }),
            Err(CoreError::Validation(_)),
        ), "a standalone invoice needs a contact_id");

        let invoice = svc
            .invoice_issue(NewInvoice {
                book_id: book.id.clone(),
                contact_id: Some(contact.id.clone()),
                sales_order_id: None,
                series: None,
                issue_date: Some("2026-01-01".into()),
                due_date: "2025-12-31".into(),
                currency: Some("ZAR".into()),
                notes: None,
                items: vec![NewInvoiceItemInput {
                    variant_id: None,
                    description: "Retainer".into(),
                    quantity: 1,
                    unit_price_minor: 100_000,
                    tax_rate_bps: None,
                }],
            })
            .unwrap_err();
        assert!(
            matches!(invoice, CoreError::Validation(_)),
            "due date before issue date must be refused"
        );

        let ok = svc
            .invoice_issue(NewInvoice {
                book_id: book.id.clone(),
                contact_id: Some(contact.id.clone()),
                sales_order_id: None,
                series: None,
                issue_date: Some("2026-01-01".into()),
                due_date: "2026-01-31".into(),
                currency: Some("ZAR".into()),
                notes: None,
                items: vec![NewInvoiceItemInput {
                    variant_id: None,
                    description: "Retainer".into(),
                    quantity: 1,
                    unit_price_minor: 100_000,
                    tax_rate_bps: None,
                }],
            })
            .unwrap();
        assert_eq!(ok.sales_order_id, None);
        assert_eq!(ok.number, 1);
    }

    #[test]
    fn invoice_payment_status_moves_through_unpaid_partly_paid_paid() {
        let svc = svc();
        let book = make_book(&svc);
        let contact = make_contact(&svc, &book, "Acme Wholesale");
        let invoice = svc
            .invoice_issue(NewInvoice {
                book_id: book.id.clone(),
                contact_id: Some(contact.id.clone()),
                sales_order_id: None,
                series: None,
                issue_date: None,
                due_date: "2026-12-31".into(),
                currency: Some("ZAR".into()),
                notes: None,
                items: vec![NewInvoiceItemInput {
                    variant_id: None,
                    description: "Retainer".into(),
                    quantity: 1,
                    unit_price_minor: 10_000,
                    tax_rate_bps: None,
                }],
            })
            .unwrap();

        assert_eq!(
            svc.invoice_totals(&invoice.id).unwrap().status,
            InvoicePaymentStatus::Unpaid
        );

        svc.invoice_payment_record(NewInvoicePayment {
            invoice_id: invoice.id.clone(),
            amount_minor: 4_000,
            paid_at: None,
            method: Some("eft".into()),
            note: None,
        })
        .unwrap();
        let partly = svc.invoice_totals(&invoice.id).unwrap();
        assert_eq!(partly.status, InvoicePaymentStatus::PartlyPaid);
        assert_eq!(partly.paid_minor, 4_000);
        assert_eq!(partly.due_minor, 6_000);

        svc.invoice_payment_record(NewInvoicePayment {
            invoice_id: invoice.id.clone(),
            amount_minor: 6_000,
            paid_at: None,
            method: Some("eft".into()),
            note: None,
        })
        .unwrap();
        let paid = svc.invoice_totals(&invoice.id).unwrap();
        assert_eq!(paid.status, InvoicePaymentStatus::Paid);
        assert_eq!(paid.due_minor, 0);

        assert_eq!(svc.invoice_payments_list(&invoice.id).unwrap().len(), 2);
    }

    #[test]
    fn invoice_numbering_is_sequential_and_scoped_per_book() {
        let svc = svc();
        let book_a = make_book(&svc);
        let contact_a = make_contact(&svc, &book_a, "Book A Customer");
        let book_b = svc
            .book_create(NewBook {
                name: "Side business".into(),
                kind: BookKind::Business,
                currency: None,
                country: Some("ZA".into()),
                region: None,
            })
            .unwrap();
        let contact_b = make_contact(&svc, &book_b, "Book B Customer");

        let issue = |book_id: &str, contact_id: &str| {
            svc.invoice_issue(NewInvoice {
                book_id: book_id.to_string(),
                contact_id: Some(contact_id.to_string()),
                sales_order_id: None,
                series: None,
                issue_date: None,
                due_date: "2026-12-31".into(),
                currency: Some("ZAR".into()),
                notes: None,
                items: vec![NewInvoiceItemInput {
                    variant_id: None,
                    description: "Line".into(),
                    quantity: 1,
                    unit_price_minor: 100,
                    tax_rate_bps: None,
                }],
            })
            .unwrap()
            .number
        };

        assert_eq!(issue(&book_a.id, &contact_a.id), 1);
        assert_eq!(issue(&book_a.id, &contact_a.id), 2);
        // A second book's numbering starts at 1 independently — this is a
        // *per-book* sequence, not a global one.
        assert_eq!(issue(&book_b.id, &contact_b.id), 1);
        assert_eq!(issue(&book_a.id, &contact_a.id), 3);
    }

    /// **The belt-and-suspenders half of the numbering guarantee, proven on
    /// its own rather than trusted because `allocate_number` happens to
    /// behave.** `UNIQUE (book_id, series, number)` is a second, independent
    /// mechanism from the atomic counter — this inserts two invoices sharing
    /// a number directly through raw SQL, bypassing `repo::sales::
    /// allocate_number` entirely, so a bug in the allocator would not hide a
    /// bug here too.
    #[test]
    fn invoice_number_uniqueness_is_enforced_at_the_database_level() {
        let svc = svc();
        let book = make_book(&svc);
        let contact = make_contact(&svc, &book, "Acme Wholesale");
        let conn = svc.conn_for_test();

        conn.execute(
            "INSERT INTO invoices
                 (id, book_id, contact_id, series, number, issue_date, due_date, currency, created_at)
             VALUES ('inv-a', ?1, ?2, 'invoice', 1, '2026-01-01', '2026-01-31', 'ZAR', 't')",
            rusqlite::params![book.id, contact.id],
        )
        .unwrap();

        let err = conn
            .execute(
                "INSERT INTO invoices
                     (id, book_id, contact_id, series, number, issue_date, due_date, currency, created_at)
                 VALUES ('inv-b', ?1, ?2, 'invoice', 1, '2026-01-01', '2026-01-31', 'ZAR', 't')",
                rusqlite::params![book.id, contact.id],
            )
            .unwrap_err();
        assert!(
            err.to_string().to_lowercase().contains("unique"),
            "a duplicate (book_id, series, number) must be refused by the database itself, got {err}"
        );
    }

    /// **The concurrency guarantee this whole migration exists to deliver,
    /// proven under real contention rather than asserted.** Several threads,
    /// each with its own `CoreService` and its own `rusqlite::Connection` to
    /// the *same file* (an in-memory database cannot be shared this way, so
    /// this is the one test in this module that needs a real one), race
    /// `invoice_issue` against the same book. If the numbering had a race —
    /// two callers reading the counter before either writes it back — this
    /// test would observe a duplicate number or a gap in the result set.
    #[test]
    fn invoice_numbering_has_no_gap_or_duplicate_under_concurrent_issue() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("race.sqlite");

        let (book_id, contact_id) = {
            let svc = CoreService::open(&db_path).unwrap();
            let book = make_book(&svc);
            let contact = make_contact(&svc, &book, "Race Customer");
            (book.id, contact.id)
        };

        const THREADS: usize = 8;
        const PER_THREAD: usize = 5;
        let handles: Vec<_> = (0..THREADS)
            .map(|_| {
                let db_path = db_path.clone();
                let book_id = book_id.clone();
                let contact_id = contact_id.clone();
                std::thread::spawn(move || {
                    let svc = CoreService::open(&db_path).expect("open a fresh connection");
                    (0..PER_THREAD)
                        .map(|_| {
                            svc.invoice_issue(NewInvoice {
                                book_id: book_id.clone(),
                                contact_id: Some(contact_id.clone()),
                                sales_order_id: None,
                                series: None,
                                issue_date: None,
                                due_date: "2026-12-31".into(),
                                currency: Some("ZAR".into()),
                                notes: None,
                                items: vec![NewInvoiceItemInput {
                                    variant_id: None,
                                    description: "Race line".into(),
                                    quantity: 1,
                                    unit_price_minor: 1_000,
                                    tax_rate_bps: None,
                                }],
                            })
                            .expect("invoice_issue under contention")
                            .number
                        })
                        .collect::<Vec<i64>>()
                })
            })
            .collect();

        let mut numbers: Vec<i64> = handles
            .into_iter()
            .flat_map(|h| h.join().expect("issuing thread panicked"))
            .collect();
        numbers.sort_unstable();

        let expected: Vec<i64> = (1..=(THREADS * PER_THREAD) as i64).collect();
        assert_eq!(
            numbers, expected,
            "concurrent invoice_issue calls must hand out exactly 1..=N — no gap, no duplicate"
        );
    }

    #[test]
    fn report_aged_receivables_buckets_by_age() {
        let svc = svc();
        let book = make_book(&svc);
        let current_customer = make_contact(&svc, &book, "Not Yet Due");
        let overdue_customer = make_contact(&svc, &book, "Overdue Customer");

        let issue_with_due_date = |contact_id: &str, due_date: &str| {
            svc.invoice_issue(NewInvoice {
                book_id: book.id.clone(),
                contact_id: Some(contact_id.to_string()),
                sales_order_id: None,
                series: None,
                issue_date: Some("2026-01-01".into()),
                due_date: due_date.to_string(),
                currency: Some("ZAR".into()),
                notes: None,
                items: vec![NewInvoiceItemInput {
                    variant_id: None,
                    description: "Line".into(),
                    quantity: 1,
                    unit_price_minor: 10_000,
                    tax_rate_bps: None,
                }],
            })
            .unwrap()
        };

        let not_yet_due = issue_with_due_date(&current_customer.id, "2026-12-31");
        let overdue = issue_with_due_date(&overdue_customer.id, "2026-01-01");
        // Paid in full: must not appear as outstanding at all.
        let paid_invoice = issue_with_due_date(&overdue_customer.id, "2026-01-01");
        svc.invoice_payment_record(NewInvoicePayment {
            invoice_id: paid_invoice.id.clone(),
            amount_minor: 10_000,
            paid_at: None,
            method: None,
            note: None,
        })
        .unwrap();

        // "as of" 45 days after the overdue invoice's due date: the 31-60
        // bucket, not yet 61-90.
        let report = svc
            .report_aged_receivables(&book.id, Some("2026-02-15"))
            .unwrap();

        let not_yet_due_row = report
            .rows
            .iter()
            .find(|r| r.contact_id == current_customer.id)
            .unwrap();
        assert_eq!(not_yet_due_row.buckets.current_minor, 10_000);
        assert_eq!(not_yet_due_row.buckets.total_minor, 10_000);

        let overdue_row = report
            .rows
            .iter()
            .find(|r| r.contact_id == overdue_customer.id)
            .unwrap();
        assert_eq!(overdue_row.buckets.overdue_31_60_minor, 10_000);
        assert_eq!(
            overdue_row.buckets.total_minor, 10_000,
            "the paid invoice must not double this contact's balance"
        );

        assert_eq!(report.totals.total_minor, 20_000);
        let _ = not_yet_due.id;
        let _ = overdue.id;
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
                region: None,
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
            region: None,
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
            .report_tax_summary(&book.id, "2026-02-01", "2026-02-28")
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
            .report_tax_summary(&book.id, "2026-07-01", "2026-07-31")
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
            .report_tax_summary(&book.id, "2026-07-01", "2026-07-31")
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
            .report_tax_summary(&book.id, "2026-07-01", "2026-07-31")
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
            .report_tax_summary(&book.id, "2026-07-01", "2026-07-31")
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
    fn tax_summary_on_fixture_with_za_labels() {
        let svc = svc();
        let (book, _, _) = fixture_book(&svc);
        let vat = svc
            .report_tax_summary(&book.id, "2026-01-01", "2026-03-31")
            .unwrap();
        // The za book labels its tax-period summary from the za profile.
        assert_eq!(vat.report_name, "VAT201");
        assert_eq!(vat.labels.output_tax, "Output VAT");
        assert_eq!(
            vat.labels.standard_rated_supplies,
            "Standard-rated supplies"
        );
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
            .report_tax_summary(&book.id, "2026-05-01", "2026-05-31")
            .unwrap();
        assert_eq!(empty.output_vat_minor, 0);
        assert_eq!(empty.input_vat_minor, 0);
        assert_eq!(empty.net_vat_minor, 0);

        // Deprecated alias still answers, identically.
        #[allow(deprecated)]
        let via_alias = svc
            .report_vat201(&book.id, "2026-01-01", "2026-03-31")
            .unwrap();
        assert_eq!(via_alias, vat);
    }

    #[test]
    fn generic_book_end_to_end_with_generic_labels() {
        // A book in a country without a dedicated profile: neutral chart,
        // one standard-rate placeholder configured at init, tax summary
        // labeled from the generic profile.
        let svc = svc();
        let book = svc
            .book_create(NewBook {
                name: "Anywhere Trading".into(),
                kind: BookKind::Business,
                currency: None,
                country: None,
                region: None,
            })
            .unwrap();
        assert_eq!(book.region, "generic");
        assert_eq!(book.currency, "USD");

        let coa = svc.coa_seed(&book.id).unwrap();
        // Neutral account names — no jurisdiction leaks into the chart.
        assert_eq!(by_code(&coa, "1400").name, "Tax Input Control");
        assert_eq!(by_code(&coa, "2100").name, "Tax Output Control");
        for c in &coa {
            for term in ["VAT", "SARS", "PAYE", "UIF"] {
                assert!(!c.name.contains(term), "{:?} leaks {term}", c.name);
            }
        }

        // Single standard-rate placeholder, configured at book init.
        let rates = svc.vat_rate_list(&book.id).unwrap();
        assert_eq!(rates.len(), 1);
        assert_eq!(rates[0].code, "STD");
        assert_eq!(rates[0].rate_bps, 0);
        assert_eq!(rates[0].country, None);
        let std = svc.vat_rate_set_bps(&book.id, "STD", 2_000).unwrap();
        assert_eq!(std.rate_bps, 2_000);
        assert_eq!(
            rate(&svc.vat_rate_list(&book.id).unwrap(), "STD").rate_bps,
            2_000
        );

        // Post a standard-rated sale end-to-end: $120.00 in at 20%.
        let account = svc
            .account_create(NewAccount {
                book_id: book.id.clone(),
                name: "Checking".into(),
                kind: AccountKind::Bank,
                currency: "USD".into(),
                institution: None,
                account_number_masked: None,
                opening_balance_minor: Some(0),
            })
            .unwrap();
        let mut sale = make_txn(&svc, &book, &account);
        sale.amount_minor = 12_000;
        sale.currency = "USD".into();
        sale.merchant = Some("Client".into());
        let sale = svc.transaction_create(sale).unwrap();
        let posted = svc
            .journal_generate_for_transaction(&sale.id, Some(&std.id))
            .unwrap();
        assert_eq!(posted.lines.len(), 3);
        assert_eq!(posted.lines[1].credit_minor, 10_000); // net sale
        assert_eq!(posted.lines[2].credit_minor, 2_000); // tax at 20%
        assert_eq!(posted.lines[2].coa_id, by_code(&coa, "2100").id);

        // The tax-period summary carries the generic profile's labels.
        let summary = svc
            .report_tax_summary(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        assert_eq!(summary.report_name, "Tax summary");
        assert_eq!(summary.labels.output_tax, "Output tax");
        assert_eq!(
            summary.labels.standard_rated_supplies,
            "Standard-rated sales"
        );
        assert_eq!(summary.currency, "USD");
        assert_eq!(summary.output_vat_minor, 2_000);
        assert_eq!(summary.standard_rated_supplies_minor, 10_000);
        assert_eq!(summary.net_vat_minor, 2_000);

        // And the CSV export wears the same labels.
        let csv = crate::csv::tax_summary_csv(&summary);
        assert!(csv.contains("Total Output tax"));
        assert!(csv.contains("Net tax payable (refundable if negative)"));
    }

    #[test]
    fn vat_rate_set_bps_validates_and_audits() {
        let svc = svc();
        let book = make_business(&svc);
        svc.coa_seed(&book.id).unwrap();

        assert!(matches!(
            svc.vat_rate_set_bps(&book.id, "STD", 10_001),
            Err(CoreError::Validation(_))
        ));
        assert!(matches!(
            svc.vat_rate_set_bps(&book.id, "STD", -1),
            Err(CoreError::Validation(_))
        ));
        assert!(matches!(
            svc.vat_rate_set_bps(&book.id, "NOPE", 1_500),
            Err(CoreError::NotFound { .. })
        ));

        let updated = svc.vat_rate_set_bps(&book.id, "STD", 1_550).unwrap();
        assert_eq!(updated.rate_bps, 1_550);
        let audit = svc.audit_list(Some(&book.id), 50).unwrap();
        assert!(audit
            .iter()
            .any(|a| a.entity_type == "vat_rate" && a.action == "set_rate"));
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

    // -- round-3 regressions ------------------------------------------------

    #[test]
    fn recon_suggests_journal_reinstated_by_double_reversal() {
        // Regression: excluding every journal that has ever been reversed
        // hid J after J → reverse (R) → reverse R (R2), even though J's
        // ledger effect is net-live again — the bank movement could never be
        // reconciled against its journal.
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
        let reversal = svc.journal_reverse(&posted.journal.id, None, None).unwrap();
        // Undo the mistaken reversal — the only undo path under
        // reversal-not-edit.
        svc.journal_reverse(&reversal.journal.id, None, None)
            .unwrap();

        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = -12_345;
        new.posted_date = "2026-07-02".into();
        let txn = svc.transaction_create(new).unwrap();

        let matches = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(
            matches.len(),
            1,
            "a net-live (doubly reversed) journal must be matchable again"
        );
        assert_eq!(matches[0].transaction_id, txn.id);
        assert_eq!(
            matches[0].journal_id.as_deref(),
            Some(posted.journal.id.as_str()),
            "the original journal (not a reversal) is the candidate"
        );
    }

    #[test]
    fn regenerate_journal_after_reversing_the_generated_one() {
        // Regression: the source-dedupe guard counted reversed (net-dead)
        // journals, so reverse → regenerate — the documented correction
        // path — failed with DuplicateJournal forever.
        let svc = svc();
        let book = make_business(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let account = make_account(&svc, &book);
        let cat = make_category(&svc, &book, "Supplies");
        svc.coa_map_set(
            &book.id,
            CoaMapEntity::Category,
            &cat.id,
            &by_code(&coa, "6450").id,
        )
        .unwrap();

        let mut new = make_txn(&svc, &book, &account);
        new.category_id = Some(cat.id.clone());
        let txn = svc.transaction_create(new).unwrap();

        let wrong = svc.journal_generate_for_transaction(&txn.id, None).unwrap();
        svc.journal_reverse(&wrong.journal.id, None, None).unwrap();

        // Correct the classification and regenerate.
        let corrected = svc
            .journal_generate_for_transaction(&txn.id, None)
            .expect("a reversed generated journal must not block regeneration");
        assert_ne!(corrected.journal.id, wrong.journal.id);
        assert_eq!(
            corrected.journal.source_id.as_deref(),
            Some(txn.id.as_str())
        );

        // The regenerated journal is net-live, so a third generation is
        // still a duplicate.
        match svc.journal_generate_for_transaction(&txn.id, None) {
            Err(CoreError::DuplicateJournal { source_id, .. }) => {
                assert_eq!(source_id, corrected.journal.id)
            }
            other => panic!("expected DuplicateJournal, got {other:?}"),
        }

        // And the ledger nets to exactly one live journal's effect: the
        // bank column carries one 12_345 credit overall.
        let tb = svc.report_trial_balance(&book.id).unwrap();
        let bank_row = tb.iter().find(|r| r.code == "1000").unwrap();
        assert_eq!(bank_row.credit_minor - bank_row.debit_minor, 12_345);
    }

    #[test]
    fn reinstated_generated_journal_blocks_regeneration() {
        // J → reverse (R) → reverse R: J is net-live again, so the source
        // slot is occupied and regeneration must be rejected.
        let svc = svc();
        let book = make_business(&svc);
        svc.coa_seed(&book.id).unwrap();
        let account = make_account(&svc, &book);
        let txn = svc
            .transaction_create(make_txn(&svc, &book, &account))
            .unwrap();
        let generated = svc.journal_generate_for_transaction(&txn.id, None).unwrap();
        let reversal = svc
            .journal_reverse(&generated.journal.id, None, None)
            .unwrap();
        svc.journal_reverse(&reversal.journal.id, None, None)
            .unwrap();
        assert!(matches!(
            svc.journal_generate_for_transaction(&txn.id, None),
            Err(CoreError::DuplicateJournal { .. })
        ));
    }

    #[test]
    fn transaction_create_rejects_malformed_posted_date() {
        // Regression: a malformed date was stored silently and the money
        // vanished from every date-ranged report and budget month bucket.
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        for bad in ["01/07/2026", "2026-7-1", "2026-02-30", "yesterday", ""] {
            let mut new = make_txn(&svc, &book, &account);
            new.posted_date = bad.into();
            assert!(
                matches!(svc.transaction_create(new), Err(CoreError::Validation(_))),
                "posted_date {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn customer_refund_on_unmapped_income_category_reduces_output_vat() {
        // Regression: the counter fallback was picked by cash direction
        // alone, so a customer refund (outflow) on an *unmapped* income
        // category landed on the expense fallback and inflated the VAT201
        // input box instead of reducing output VAT.
        let svc = svc();
        let book = make_business(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let rates = svc.vat_rate_list(&book.id).unwrap();
        let std = rate(&rates, "STD");
        let account = make_account(&svc, &book);
        let sales_cat = svc
            .category_create(NewCategory {
                book_id: book.id.clone(),
                parent_id: None,
                name: "Sales".into(),
                kind: CategoryKind::Income,
                icon: None,
                color: None,
            })
            .unwrap();
        // Deliberately NO coa_map entry for the category.

        let mut refund = make_txn(&svc, &book, &account);
        refund.amount_minor = -11_500;
        refund.category_id = Some(sales_cat.id.clone());
        let refund = svc.transaction_create(refund).unwrap();
        let posted = svc
            .journal_generate_for_transaction(&refund.id, Some(&std.id))
            .unwrap();

        // Debit income fallback (output base), debit VAT *output* control,
        // credit bank — an output-VAT reduction, never an input claim.
        assert_eq!(posted.lines.len(), 3);
        let base = &posted.lines[0];
        assert_eq!(base.coa_id, by_code(&coa, "4200").id); // income fallback
        assert_eq!(base.debit_minor, 10_000);
        assert_eq!(base.vat_role, Some(VatRole::OutputBase));
        let vat = &posted.lines[1];
        assert_eq!(vat.coa_id, by_code(&coa, "2100").id); // VAT Output Control
        assert_eq!(vat.debit_minor, 1_500);
        assert_eq!(vat.vat_role, Some(VatRole::OutputVat));

        let vat201 = svc
            .report_tax_summary(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        assert_eq!(vat201.input_vat_minor, 0, "input box must not be inflated");
        assert_eq!(vat201.output_vat_minor, -1_500);
        assert_eq!(vat201.standard_rated_supplies_minor, -10_000);
    }

    #[test]
    fn vat_rate_rejected_on_transfer_like_counter_account() {
        // A category mapped to an asset account (transfer between own
        // accounts) with a VAT rate would book phantom supplies into the
        // VAT201 — reject instead.
        let svc = svc();
        let book = make_business(&svc);
        let coa = svc.coa_seed(&book.id).unwrap();
        let rates = svc.vat_rate_list(&book.id).unwrap();
        let std = rate(&rates, "STD");
        let account = make_account(&svc, &book);
        let cat = make_category(&svc, &book, "Transfers");
        svc.coa_map_set(
            &book.id,
            CoaMapEntity::Category,
            &cat.id,
            &by_code(&coa, "1100").id, // Accounts Receivable / asset
        )
        .unwrap();

        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = 11_500;
        new.category_id = Some(cat.id.clone());
        let txn = svc.transaction_create(new).unwrap();
        assert!(matches!(
            svc.journal_generate_for_transaction(&txn.id, Some(&std.id)),
            Err(CoreError::Validation(_))
        ));
        // Without a VAT rate the transfer journal is fine.
        svc.journal_generate_for_transaction(&txn.id, None).unwrap();
        let vat201 = svc
            .report_tax_summary(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        assert_eq!(vat201.standard_rated_supplies_minor, 0);
        assert_eq!(vat201.output_vat_minor, 0);
    }

    #[test]
    fn transaction_uncategorize_already_uncategorized_is_a_noop() {
        // Regression: every repeat call appended a None→None correction row
        // plus an audit entry.
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let txn = svc
            .transaction_create(make_txn(&svc, &book, &account))
            .unwrap();
        assert!(txn.category_id.is_none());

        let corrections_count = |svc: &CoreService| -> i64 {
            svc.conn()
                .query_row(
                    "SELECT COUNT(*) FROM classification_corrections",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        };
        let audit_before = svc.audit_list(Some(&book.id), 100).unwrap().len();
        assert_eq!(corrections_count(&svc), 0);

        let after = svc.transaction_uncategorize(&txn.id).unwrap();
        assert_eq!(after.category_id, None);
        assert_eq!(corrections_count(&svc), 0, "no None→None correction row");
        assert_eq!(
            svc.audit_list(Some(&book.id), 100).unwrap().len(),
            audit_before,
            "no audit noise for a no-op"
        );
    }

    #[test]
    fn recon_rejected_match_cannot_be_confirmed() {
        // Rejecting frees both sides to match other counterparts; confirming
        // the stale rejected match later could create two active confirmed
        // matches for the same transaction/document.
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let doc = svc
            .document_import(NewDocument {
                book_id: book.id.clone(),
                source: DocumentSource::Upload,
                kind: DocumentKind::Slip,
                file_path: "/tmp/slip.jpg".into(),
                mime_type: Some("image/jpeg".into()),
                size_bytes: Some(1),
                original_name: Some("slip.jpg".into()),
                sha256: Some("s1".into()),
            })
            .unwrap();
        let mut new = make_txn(&svc, &book, &account);
        new.document_id = Some(doc.id.clone());
        svc.transaction_create(new).unwrap();

        let matches = svc.recon_suggest(&book.id).unwrap();
        assert_eq!(matches.len(), 1);
        let rejected = svc.recon_reject(&matches[0].id).unwrap();
        assert_eq!(rejected.state, ReconState::Rejected);
        assert!(matches!(
            svc.recon_confirm(&rejected.id),
            Err(CoreError::InvalidStatusTransition { .. })
        ));
    }

    #[test]
    fn budget_upsert_rejects_impossible_month_numbers() {
        // Regression: "2026-13" / "2026-00" passed the shape check, got
        // stored, and could never match any transaction month.
        let svc = svc();
        let book = make_book(&svc);
        let cat = make_category(&svc, &book, "Groceries");
        for bad in ["2026-13", "2026-00", "2026-99", "20a6-01", "2026-1a"] {
            assert!(
                matches!(
                    svc.budget_upsert(BudgetUpsert {
                        book_id: book.id.clone(),
                        category_id: cat.id.clone(),
                        month: bad.into(),
                        amount_minor: 100_000,
                        currency: "ZAR".into(),
                        rollover: false,
                    }),
                    Err(CoreError::Validation(_))
                ),
                "month {bad:?} must be rejected"
            );
        }
        for good in ["2026-01", "2026-12"] {
            svc.budget_upsert(BudgetUpsert {
                book_id: book.id.clone(),
                category_id: cat.id.clone(),
                month: good.into(),
                amount_minor: 100_000,
                currency: "ZAR".into(),
                rollover: false,
            })
            .unwrap();
        }
    }

    #[test]
    fn budget_list_returns_stored_rollover_flag() {
        let svc = svc();
        let book = make_book(&svc);
        let cat = make_category(&svc, &book, "Groceries");
        svc.budget_upsert(BudgetUpsert {
            book_id: book.id.clone(),
            category_id: cat.id.clone(),
            month: "2026-07".into(),
            amount_minor: 100_000,
            currency: "ZAR".into(),
            rollover: true,
        })
        .unwrap();
        let budgets = svc.budget_list(&book.id, "2026-07").unwrap();
        assert_eq!(budgets.len(), 1);
        assert!(budgets[0].rollover);
        assert!(!budgets[0].created_at.is_empty());
    }

    // -- pay delivery resilience --------------------------------------------
    // (The main payments service tests live in `crate::pay::tests`; this one
    // needs the private `vault()` handle to simulate a revoked secret.)

    #[tokio::test]
    async fn pay_deliver_due_isolates_a_delivery_whose_secret_is_gone() {
        // Regression: a vault `use_with` failure for ONE delivery (e.g. the
        // user ran `slipscan vault revoke pay.endpoint.<id>`) aborted the
        // whole pass with `?` — healthy endpoints were never POSTed and the
        // broken delivery sat at 0 attempts forever. Signing failures must
        // behave like transport failures: recorded on that delivery, retried
        // with backoff, abandoned at the cap, pass continues.
        use crate::pay::testutil::MockWebhookTransport;

        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        svc.pay_watch_add(NewPayWatch {
            book_id: book.id.clone(),
            code: "INV-1".into(),
            label: None,
            expected_amount_minor: None,
            expected_currency: None,
        })
        .unwrap();
        let broken = svc
            .pay_endpoint_add(NewPayEndpoint {
                book_id: book.id.clone(),
                label: "Broken".into(),
                url: "https://broken.example.org/hook".into(),
            })
            .unwrap();
        let healthy = svc
            .pay_endpoint_add(NewPayEndpoint {
                book_id: book.id.clone(),
                label: "Healthy".into(),
                url: "https://healthy.example.org/hook".into(),
            })
            .unwrap();
        svc.transaction_create(NewTransaction {
            book_id: book.id.clone(),
            account_id: account.id.clone(),
            source: TransactionSource::Email,
            provider_txn_id: None,
            posted_date: "2026-07-01".into(),
            amount_minor: 50_000,
            currency: "ZAR".into(),
            merchant: None,
            description: Some("EFT REF INV-1".into()),
            notes: None,
            category_id: None,
            document_id: None,
            dedupe_occurrence: 0,
        })
        .unwrap();
        // Revoke ONE endpoint's signing secret out from under its pending
        // delivery — the endpoint row (and its queue) remains.
        svc.vault()
            .revoke(&crate::pay::endpoint_secret_name(&broken.endpoint.id))
            .unwrap();

        // One scripted 200: only the healthy endpoint may POST.
        let transport = MockWebhookTransport::new().respond(200);
        let updated = svc
            .pay_deliver_due(&transport, "2027-01-01T12:00:00Z")
            .await
            .unwrap();
        assert_eq!(updated.len(), 2, "both due deliveries are acted on");
        assert_eq!(transport.sent_count(), 1, "no POST for the unsigned one");
        assert_eq!(
            transport.sent.borrow()[0].url,
            "https://healthy.example.org/hook"
        );
        let delivered = updated
            .iter()
            .find(|d| d.endpoint_id == healthy.endpoint.id)
            .unwrap();
        assert_eq!(delivered.state, PayDeliveryState::Delivered);
        assert_eq!(delivered.attempts, 1);
        let stalled = updated
            .iter()
            .find(|d| d.endpoint_id == broken.endpoint.id)
            .unwrap();
        assert_eq!(stalled.state, PayDeliveryState::Pending);
        assert_eq!(stalled.attempts, 1, "the signing failure counts");
        assert_eq!(stalled.last_status, None);
        assert!(
            stalled.last_error.as_deref().unwrap().contains("not found"),
            "last_error records the vault failure: {:?}",
            stalled.last_error
        );
        assert_eq!(
            stalled.next_attempt_at, "2027-01-01T12:01:00Z",
            "normal backoff applies"
        );

        // Persistent signing failure ages out at the attempt cap instead of
        // stalling forever — and never attempts a POST.
        let mut now = time::macros::datetime!(2027-01-01 12:01:00 UTC);
        let mut last = Vec::new();
        for _ in 1..crate::pay::MAX_DELIVERY_ATTEMPTS {
            let now_s = now
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap();
            let idle = MockWebhookTransport::new(); // unscripted: POST would error
            last = svc.pay_deliver_due(&idle, &now_s).await.unwrap();
            assert_eq!(last.len(), 1);
            assert_eq!(idle.sent_count(), 0);
            now += time::Duration::days(2);
        }
        assert_eq!(last[0].attempts, crate::pay::MAX_DELIVERY_ATTEMPTS);
        assert_eq!(last[0].state, PayDeliveryState::Failed);

        // Every outcome carries its audit record (metadata only).
        let audits = svc.audit_list(Some(&book.id), 100).unwrap();
        for action in ["delivered", "retry_scheduled", "failed"] {
            assert!(
                audits
                    .iter()
                    .any(|a| a.entity_type == "pay_delivery" && a.action == action),
                "missing pay_delivery audit {action}"
            );
        }
    }

    // -------------------------------------------------------------------
    // Household members & per-person attribution
    // -------------------------------------------------------------------

    fn make_member(svc: &CoreService, book: &Book, label: &str) -> Member {
        svc.member_add(NewMember {
            book_id: book.id.clone(),
            label: label.into(),
            initial: None,
            colour: None,
            default_account_id: None,
        })
        .unwrap()
    }

    #[test]
    fn member_crud_and_a_zero_members_book_still_works() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);

        // A book with zero members behaves exactly as before: transactions
        // create fine and simply come out unattributed.
        assert!(svc.member_list(&book.id).unwrap().is_empty());
        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = -1_000;
        let txn = svc.transaction_create(new).unwrap();
        assert_eq!(txn.attributed_member_id, None);

        // Add, with defaults derived (no explicit initial/colour given).
        let alex = svc
            .member_add(NewMember {
                book_id: book.id.clone(),
                label: "  alex  ".into(),
                initial: None,
                colour: None,
                default_account_id: Some(account.id.clone()),
            })
            .unwrap();
        assert_eq!(alex.label, "alex", "label is trimmed");
        assert_eq!(alex.initial, "A", "derived from the label, uppercased");
        assert_eq!(alex.colour, "#C8FF00", "first default swatch");
        assert_eq!(
            alex.default_account_id.as_deref(),
            Some(account.id.as_str())
        );

        // A second member without an explicit colour cycles to the next
        // swatch instead of colliding.
        let bailey = svc
            .member_add(NewMember {
                book_id: book.id.clone(),
                label: "Bailey".into(),
                initial: Some("BB".into()),
                colour: None,
                default_account_id: None,
            })
            .unwrap();
        assert_eq!(bailey.initial, "BB", "explicit initial wins");
        assert_eq!(bailey.colour, "#16A34A", "second default swatch");

        assert_eq!(
            svc.member_list(&book.id).unwrap(),
            vec![alex.clone(), bailey.clone()]
        );

        // Update: label, colour, and clearing the default account.
        let updated = svc
            .member_update(
                &alex.id,
                MemberPatch {
                    label: Some("Alexis".into()),
                    colour: Some("#000000".into()),
                    default_account_id: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.label, "Alexis");
        assert_eq!(updated.colour, "#000000");
        assert_eq!(updated.default_account_id, None);
        assert_eq!(updated.initial, "A", "untouched field stays as-is");

        // Remove: no attributions yet, so it just goes.
        svc.member_remove(&bailey.id, None).unwrap();
        assert_eq!(svc.member_list(&book.id).unwrap(), vec![updated]);
        assert!(matches!(
            svc.member_get(&bailey.id),
            Err(CoreError::NotFound { .. })
        ));

        // Audited (create, update, remove).
        let audits = svc.audit_list(Some(&book.id), 50).unwrap();
        for action in ["create", "update", "remove"] {
            assert!(
                audits
                    .iter()
                    .any(|a| a.entity_type == "member" && a.action == action),
                "missing member audit {action}"
            );
        }
    }

    #[test]
    fn member_add_validates_label_and_book_and_account_scoping() {
        let svc = svc();
        let book = make_book(&svc);
        let other_book = svc
            .book_create(NewBook {
                name: "Other".into(),
                kind: BookKind::Personal,
                currency: None,
                country: Some("ZA".into()),
                region: None,
            })
            .unwrap();
        let account = make_account(&svc, &book);

        assert!(matches!(
            svc.member_add(NewMember {
                book_id: book.id.clone(),
                label: "   ".into(),
                initial: None,
                colour: None,
                default_account_id: None,
            }),
            Err(CoreError::Validation(_))
        ));
        assert!(matches!(
            svc.member_add(NewMember {
                book_id: "nope".into(),
                label: "Alex".into(),
                initial: None,
                colour: None,
                default_account_id: None,
            }),
            Err(CoreError::NotFound { .. })
        ));
        // An account from a different book cannot be claimed as a default.
        assert!(matches!(
            svc.member_add(NewMember {
                book_id: other_book.id.clone(),
                label: "Alex".into(),
                initial: None,
                colour: None,
                default_account_id: Some(account.id.clone()),
            }),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn default_attribution_follows_the_accounts_owning_member() {
        let svc = svc();
        let book = make_book(&svc);
        let owned_account = make_account(&svc, &book);
        let unowned_account = make_account(&svc, &book);
        let owner = svc
            .member_add(NewMember {
                book_id: book.id.clone(),
                label: "Owner".into(),
                initial: None,
                colour: None,
                default_account_id: Some(owned_account.id.clone()),
            })
            .unwrap();

        let mut owned_txn = make_txn(&svc, &book, &owned_account);
        owned_txn.amount_minor = -400;
        let txn = svc.transaction_create(owned_txn).unwrap();
        assert_eq!(txn.attributed_member_id.as_deref(), Some(owner.id.as_str()));

        // An account nobody claimed stays unattributed by default.
        let mut unowned_txn = make_txn(&svc, &book, &unowned_account);
        unowned_txn.amount_minor = -400;
        let txn2 = svc.transaction_create(unowned_txn).unwrap();
        assert_eq!(txn2.attributed_member_id, None);
    }

    #[test]
    fn transaction_attribute_overrides_default_and_can_clear() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let owner = svc
            .member_add(NewMember {
                book_id: book.id.clone(),
                label: "Owner".into(),
                initial: None,
                colour: None,
                default_account_id: Some(account.id.clone()),
            })
            .unwrap();
        let other = make_member(&svc, &book, "Other");
        let other_book_member = {
            let other_book = svc
                .book_create(NewBook {
                    name: "Other book".into(),
                    kind: BookKind::Personal,
                    currency: None,
                    country: Some("ZA".into()),
                    region: None,
                })
                .unwrap();
            make_member(&svc, &other_book, "Elsewhere")
        };

        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = -900;
        let txn = svc.transaction_create(new).unwrap();
        assert_eq!(txn.attributed_member_id.as_deref(), Some(owner.id.as_str()));

        // Override to another member in the same book.
        let overridden = svc.transaction_attribute(&txn.id, Some(&other.id)).unwrap();
        assert_eq!(
            overridden.attributed_member_id.as_deref(),
            Some(other.id.as_str())
        );
        assert_eq!(
            overridden.amount_minor, txn.amount_minor,
            "attribution never touches the amount"
        );

        // Clear back to unattributed.
        let cleared = svc.transaction_attribute(&txn.id, None).unwrap();
        assert_eq!(cleared.attributed_member_id, None);

        // A member from a different book is rejected.
        assert!(matches!(
            svc.transaction_attribute(&txn.id, Some(&other_book_member.id)),
            Err(CoreError::Validation(_))
        ));

        // Audited.
        let audits = svc.audit_list(Some(&book.id), 50).unwrap();
        assert!(audits
            .iter()
            .any(|a| a.entity_type == "transaction" && a.action == "attribute"));
    }

    #[test]
    fn transaction_split_set_enforces_the_sum_invariant() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let a = make_member(&svc, &book, "A");
        let b = make_member(&svc, &book, "B");

        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = -1_000;
        let txn = svc.transaction_create(new).unwrap();

        // Shares that don't sum to the absolute amount are rejected.
        assert!(matches!(
            svc.transaction_split_set(
                &txn.id,
                vec![
                    SplitShare {
                        member_id: a.id.clone(),
                        share_minor: 400
                    },
                    SplitShare {
                        member_id: b.id.clone(),
                        share_minor: 500
                    },
                ],
            ),
            Err(CoreError::Validation(_))
        ));
        // A duplicate member is rejected.
        assert!(matches!(
            svc.transaction_split_set(
                &txn.id,
                vec![
                    SplitShare {
                        member_id: a.id.clone(),
                        share_minor: 600
                    },
                    SplitShare {
                        member_id: a.id.clone(),
                        share_minor: 400
                    },
                ],
            ),
            Err(CoreError::Validation(_))
        ));
        // A non-positive share is rejected.
        assert!(matches!(
            svc.transaction_split_set(
                &txn.id,
                vec![
                    SplitShare {
                        member_id: a.id.clone(),
                        share_minor: 1_000
                    },
                    SplitShare {
                        member_id: b.id.clone(),
                        share_minor: 0
                    },
                ],
            ),
            Err(CoreError::Validation(_))
        ));
        // Nothing was written by any of the rejected attempts.
        assert!(svc.transaction_splits_list(&txn.id).unwrap().is_empty());

        // An exact split succeeds.
        let splits = svc
            .transaction_split_set(
                &txn.id,
                vec![
                    SplitShare {
                        member_id: a.id.clone(),
                        share_minor: 400,
                    },
                    SplitShare {
                        member_id: b.id.clone(),
                        share_minor: 600,
                    },
                ],
            )
            .unwrap();
        assert_eq!(splits.len(), 2);
        assert_eq!(splits.iter().map(|s| s.share_minor).sum::<i64>(), 1_000);

        // An empty list clears the split.
        let cleared = svc.transaction_split_set(&txn.id, vec![]).unwrap();
        assert!(cleared.is_empty());
        assert!(svc.transaction_splits_list(&txn.id).unwrap().is_empty());
    }

    #[test]
    fn attribution_and_splits_never_touch_the_ledger() {
        let svc = svc();
        let book = make_business(&svc);
        svc.coa_seed(&book.id).unwrap();
        let account = make_account(&svc, &book);
        let a = make_member(&svc, &book, "A");
        let b = make_member(&svc, &book, "B");

        let mut new = make_txn(&svc, &book, &account);
        new.amount_minor = -5_000;
        let txn = svc.transaction_create(new).unwrap();
        let posted = svc.journal_generate_for_transaction(&txn.id, None).unwrap();

        // Attribute after posting: metadata only.
        svc.transaction_attribute(&txn.id, Some(&a.id)).unwrap();
        assert_eq!(svc.journal_get(&posted.journal.id).unwrap(), posted);

        // Split after posting: still metadata only.
        svc.transaction_split_set(
            &txn.id,
            vec![
                SplitShare {
                    member_id: a.id.clone(),
                    share_minor: 2_000,
                },
                SplitShare {
                    member_id: b.id.clone(),
                    share_minor: 3_000,
                },
            ],
        )
        .unwrap();
        assert_eq!(svc.journal_get(&posted.journal.id).unwrap(), posted);

        // And the trial balance is untouched too.
        let tb_before: i64 = svc
            .report_trial_balance(&book.id)
            .unwrap()
            .iter()
            .map(|r| r.debit_minor - r.credit_minor)
            .sum();
        assert_eq!(tb_before, 0, "still balanced");
    }

    #[test]
    fn member_remove_refuses_with_attributions_unless_reassigned() {
        let svc = svc();
        let book = make_book(&svc);
        let account = make_account(&svc, &book);
        let m1 = make_member(&svc, &book, "One");
        let m2 = make_member(&svc, &book, "Two");

        // Single attribution.
        let mut new_a = make_txn(&svc, &book, &account);
        new_a.amount_minor = -500;
        let txn_a = svc.transaction_create(new_a).unwrap();
        svc.transaction_attribute(&txn_a.id, Some(&m1.id)).unwrap();

        // Split where the target member already holds a share on the same
        // transaction — reassignment must merge, not collide.
        let mut new_b = make_txn(&svc, &book, &account);
        new_b.amount_minor = -500;
        new_b.dedupe_occurrence = 1; // distinguish from txn_a: same account/date/amount/text
        let txn_b = svc.transaction_create(new_b).unwrap();
        svc.transaction_split_set(
            &txn_b.id,
            vec![
                SplitShare {
                    member_id: m1.id.clone(),
                    share_minor: 300,
                },
                SplitShare {
                    member_id: m2.id.clone(),
                    share_minor: 200,
                },
            ],
        )
        .unwrap();

        // Split where the target has no existing row for that transaction —
        // reassignment is a plain rename.
        let mut new_c = make_txn(&svc, &book, &account);
        new_c.amount_minor = -400;
        let txn_c = svc.transaction_create(new_c).unwrap();
        svc.transaction_split_set(
            &txn_c.id,
            vec![SplitShare {
                member_id: m1.id.clone(),
                share_minor: 400,
            }],
        )
        .unwrap();

        // Refused without a reassignment target.
        let err = svc.member_remove(&m1.id, None).unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)), "{err}");
        assert!(
            svc.member_get(&m1.id).is_ok(),
            "member survives the refusal"
        );

        // Cannot reassign to itself.
        assert!(matches!(
            svc.member_remove(&m1.id, Some(&m1.id)),
            Err(CoreError::Validation(_))
        ));
        // Cannot reassign to a member of a different book.
        let other_book = svc
            .book_create(NewBook {
                name: "Other".into(),
                kind: BookKind::Personal,
                currency: None,
                country: Some("ZA".into()),
                region: None,
            })
            .unwrap();
        let stranger = make_member(&svc, &other_book, "Stranger");
        assert!(matches!(
            svc.member_remove(&m1.id, Some(&stranger.id)),
            Err(CoreError::Validation(_))
        ));

        // Reassigning to m2 succeeds and moves every attribution.
        svc.member_remove(&m1.id, Some(&m2.id)).unwrap();
        assert!(matches!(
            svc.member_get(&m1.id),
            Err(CoreError::NotFound { .. })
        ));

        let after_a = svc.transaction_get(&txn_a.id).unwrap();
        assert_eq!(
            after_a.attributed_member_id.as_deref(),
            Some(m2.id.as_str())
        );

        let splits_b = svc.transaction_splits_list(&txn_b.id).unwrap();
        assert_eq!(splits_b.len(), 1, "merged into the target's existing row");
        assert_eq!(splits_b[0].member_id, m2.id);
        assert_eq!(splits_b[0].share_minor, 500, "300 + 200");

        let splits_c = svc.transaction_splits_list(&txn_c.id).unwrap();
        assert_eq!(splits_c.len(), 1);
        assert_eq!(splits_c[0].member_id, m2.id);
        assert_eq!(
            splits_c[0].share_minor, 400,
            "plain rename, no target row existed"
        );
    }

    /// Full multi-member fixture exercising every member report: expense,
    /// contribution, category, and settle-up, including the unattributed
    /// bucket and split distribution. Numbers are computed by hand in the
    /// comments below and asserted exactly.
    #[test]
    fn member_reports_on_a_seeded_fixture() {
        let svc = svc();
        let book = make_book(&svc);
        assert_eq!(book.currency, "ZAR");
        let account_a = make_account(&svc, &book);
        let account_b = make_account(&svc, &book);
        let account_unowned = make_account(&svc, &book);
        let groceries = make_category(&svc, &book, "Groceries");
        let rent = make_category(&svc, &book, "Rent");

        let a = svc
            .member_add(NewMember {
                book_id: book.id.clone(),
                label: "A".into(),
                initial: None,
                colour: None,
                default_account_id: Some(account_a.id.clone()),
            })
            .unwrap();
        let b = svc
            .member_add(NewMember {
                book_id: book.id.clone(),
                label: "B".into(),
                initial: None,
                colour: None,
                default_account_id: Some(account_b.id.clone()),
            })
            .unwrap();
        let c = make_member(&svc, &book, "C");

        let mk = |account_id: &str, amount: i64, category_id: Option<&str>| NewTransaction {
            book_id: book.id.clone(),
            account_id: account_id.to_string(),
            source: TransactionSource::Manual,
            provider_txn_id: None,
            posted_date: "2026-07-10".into(),
            amount_minor: amount,
            currency: "ZAR".into(),
            merchant: None,
            description: None,
            notes: None,
            category_id: category_id.map(str::to_string),
            document_id: None,
            dedupe_occurrence: 0,
        };

        // Expenses (all default-attributed, then one overridden, one split).
        svc.transaction_create(mk(&account_a.id, -1_000, Some(&groceries.id)))
            .unwrap(); // -> A / Groceries: 1000
        svc.transaction_create(mk(&account_b.id, -2_000, Some(&rent.id)))
            .unwrap(); // -> B / Rent: 2000
        let overridden = svc
            .transaction_create(mk(&account_a.id, -500, Some(&groceries.id)))
            .unwrap(); // default A, then overridden to C
        svc.transaction_attribute(&overridden.id, Some(&c.id))
            .unwrap(); // -> C / Groceries: 500
        svc.transaction_create(mk(&account_unowned.id, -300, Some(&rent.id)))
            .unwrap(); // -> Unattributed / Rent: 300
        let split_expense = svc
            .transaction_create(mk(&account_a.id, -1_200, Some(&groceries.id)))
            .unwrap();
        svc.transaction_split_set(
            &split_expense.id,
            vec![
                SplitShare {
                    member_id: a.id.clone(),
                    share_minor: 700,
                },
                SplitShare {
                    member_id: b.id.clone(),
                    share_minor: 500,
                },
            ],
        )
        .unwrap(); // -> A / Groceries += 700, B / Groceries += 500

        // Contributions (income).
        svc.transaction_create(mk(&account_a.id, 5_000, None))
            .unwrap(); // -> A contribution: 5000
        svc.transaction_create(mk(&account_b.id, 3_000, None))
            .unwrap(); // -> B contribution: 3000
        let split_income = svc
            .transaction_create(mk(&account_a.id, 1_000, None))
            .unwrap();
        svc.transaction_split_set(
            &split_income.id,
            vec![
                SplitShare {
                    member_id: a.id.clone(),
                    share_minor: 400,
                },
                SplitShare {
                    member_id: c.id.clone(),
                    share_minor: 600,
                },
            ],
        )
        .unwrap(); // -> A contribution += 400, C contribution: 600
        svc.transaction_create(mk(&account_unowned.id, 200, None))
            .unwrap(); // -> Unattributed contribution: 200

        // -- expense report: A=1700, B=2500, C=500, Unattributed=300 --
        let expense = svc
            .report_member_expense(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        let find = |rows: &[MemberAmountRow], id: Option<&str>| {
            rows.iter()
                .find(|r| r.member_id.as_deref() == id)
                .unwrap_or_else(|| panic!("missing row for {id:?} in {rows:?}"))
                .total_minor
        };
        assert_eq!(find(&expense, Some(&a.id)), 1_700);
        assert_eq!(find(&expense, Some(&b.id)), 2_500);
        assert_eq!(find(&expense, Some(&c.id)), 500);
        assert_eq!(find(&expense, None), 300);
        assert_eq!(expense.iter().map(|r| r.total_minor).sum::<i64>(), 5_000);
        for row in &expense {
            assert_eq!(row.currency, "ZAR");
        }

        // -- contribution report: A=5400, B=3000, C=600, Unattributed=200 --
        let contribution = svc
            .report_member_contribution(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        assert_eq!(find(&contribution, Some(&a.id)), 5_400);
        assert_eq!(find(&contribution, Some(&b.id)), 3_000);
        assert_eq!(find(&contribution, Some(&c.id)), 600);
        assert_eq!(find(&contribution, None), 200);
        assert_eq!(
            contribution.iter().map(|r| r.total_minor).sum::<i64>(),
            9_200
        );

        // -- category report --
        let category = svc
            .report_member_category(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        let find_cat = |member_id: Option<&str>, category_id: Option<&str>| {
            category
                .iter()
                .find(|r| {
                    r.member_id.as_deref() == member_id && r.category_id.as_deref() == category_id
                })
                .unwrap_or_else(|| panic!("missing category row for {member_id:?}/{category_id:?}"))
                .total_minor
        };
        assert_eq!(find_cat(Some(&a.id), Some(&groceries.id)), 1_700);
        assert_eq!(find_cat(Some(&b.id), Some(&groceries.id)), 500);
        assert_eq!(find_cat(Some(&b.id), Some(&rent.id)), 2_000);
        assert_eq!(find_cat(Some(&c.id), Some(&groceries.id)), 500);
        assert_eq!(find_cat(None, Some(&rent.id)), 300);
        assert_eq!(category.len(), 5, "no stray rows");

        // -- settle-up: net = contributions - expenses --
        // A: 5400 - 1700 = 3700
        // B: 3000 - 2500 = 500
        // C: 600 - 500 = 100
        // Unattributed: 200 - 300 = -100
        let settle = svc
            .report_settle_up(&book.id, "2026-07-01", "2026-07-31")
            .unwrap();
        assert_eq!(settle.len(), 4, "3 members + the Unattributed bucket");
        let find_settle = |id: Option<&str>| {
            settle
                .iter()
                .find(|r| r.member_id.as_deref() == id)
                .unwrap_or_else(|| panic!("missing settle row for {id:?}"))
        };
        let ra = find_settle(Some(&a.id));
        assert_eq!(ra.contributions_minor, 5_400);
        assert_eq!(ra.expenses_minor, 1_700);
        assert_eq!(ra.net_minor, 3_700);
        let rb = find_settle(Some(&b.id));
        assert_eq!(rb.net_minor, 500);
        let rc = find_settle(Some(&c.id));
        assert_eq!(rc.net_minor, 100);
        let ru = find_settle(None);
        assert_eq!(ru.member_label, "Unattributed");
        assert_eq!(ru.net_minor, -100);
        // Sum of net positions is total contributions minus total expenses
        // for the whole household (9200 − 5000) — it only nets to zero when
        // the household spends exactly what it takes in.
        assert_eq!(settle.iter().map(|r| r.net_minor).sum::<i64>(), 4_200);
    }

    // -------------------------------------------------------------------
    // Locations (Phase 6.1 — the FlowStock fold, foundation)
    // -------------------------------------------------------------------

    #[test]
    fn location_crud_and_a_zero_locations_book_still_works() {
        let svc = svc();
        let book = make_book(&svc);

        // A book with zero locations behaves exactly as before: nothing
        // downstream references this axis yet.
        assert!(svc.location_list(&book.id).unwrap().is_empty());

        // Create, with the kind default applied (branch) and untrimmed input
        // cleaned up.
        let main = svc
            .location_create(NewLocation {
                book_id: book.id.clone(),
                name: "  Main Branch  ".into(),
                kind: None,
                code: Some("  JHB-01  ".into()),
                address: None,
            })
            .unwrap();
        assert_eq!(main.name, "Main Branch", "name is trimmed");
        assert_eq!(main.kind, LocationKind::Branch, "defaults to branch");
        assert_eq!(main.code.as_deref(), Some("JHB-01"), "code is trimmed");
        assert_eq!(main.address, None);
        assert!(!main.is_archived);

        let depot = svc
            .location_create(NewLocation {
                book_id: book.id.clone(),
                name: "Regional Depot".into(),
                kind: Some(LocationKind::Warehouse),
                code: None,
                address: Some("1 Depot Road".into()),
            })
            .unwrap();
        assert_eq!(depot.kind, LocationKind::Warehouse);

        assert_eq!(svc.location_get(&main.id).unwrap(), main);
        let listed = svc.location_list(&book.id).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed, vec![main.clone(), depot.clone()]);

        // Update: rename, archive, and explicitly clear the code.
        let updated = svc
            .location_update(
                &main.id,
                LocationPatch {
                    name: Some("Downtown Branch".into()),
                    code: Some(None),
                    is_archived: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.name, "Downtown Branch");
        assert_eq!(updated.code, None, "explicitly cleared");
        assert!(updated.is_archived);
        // Untouched fields survive.
        assert_eq!(updated.kind, LocationKind::Branch);

        svc.location_delete(&depot.id).unwrap();
        assert!(matches!(
            svc.location_get(&depot.id),
            Err(CoreError::NotFound { .. })
        ));
        assert_eq!(svc.location_list(&book.id).unwrap(), vec![updated]);
    }

    #[test]
    fn location_create_validates_name_and_book_scoping() {
        let svc = svc();
        let book = make_book(&svc);

        let err = svc
            .location_create(NewLocation {
                book_id: "nope".into(),
                name: "x".into(),
                kind: None,
                code: None,
                address: None,
            })
            .unwrap_err();
        assert!(matches!(err, CoreError::NotFound { entity: "book", .. }));

        let err = svc
            .location_create(NewLocation {
                book_id: book.id.clone(),
                name: "   ".into(),
                kind: None,
                code: None,
                address: None,
            })
            .unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)));

        let err = svc
            .location_update(
                &svc.location_create(NewLocation {
                    book_id: book.id.clone(),
                    name: "Real Branch".into(),
                    kind: None,
                    code: None,
                    address: None,
                })
                .unwrap()
                .id,
                LocationPatch {
                    name: Some("   ".into()),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)));
    }

    /// A location code is scoped unique per book only where set — two
    /// locations with no code at all must not collide (mirrors
    /// `categories_root_name_unique`'s NULL handling in migration 0001).
    #[test]
    fn location_code_is_unique_per_book_only_when_set() {
        let svc = svc();
        let book = make_book(&svc);

        svc.location_create(NewLocation {
            book_id: book.id.clone(),
            name: "A".into(),
            kind: None,
            code: None,
            address: None,
        })
        .unwrap();
        // A second location with no code must not collide with the first.
        svc.location_create(NewLocation {
            book_id: book.id.clone(),
            name: "B".into(),
            kind: None,
            code: None,
            address: None,
        })
        .unwrap();

        svc.location_create(NewLocation {
            book_id: book.id.clone(),
            name: "C".into(),
            kind: None,
            code: Some("DUP".into()),
            address: None,
        })
        .unwrap();
        let err = svc
            .location_create(NewLocation {
                book_id: book.id.clone(),
                name: "D".into(),
                kind: None,
                code: Some("DUP".into()),
                address: None,
            })
            .unwrap_err();
        assert!(matches!(err, CoreError::Sqlite(_)), "{err:?}");
    }

    // -------------------------------------------------------------------
    // Book profiles (ROADMAP.md "Phase 6" — 6.0 Book profiles). The
    // pure-function cases (kind × location count × override → capability
    // groups) live in `crate::profile::tests`; these exercise the parts a
    // pure function cannot: that `book_profile` actually counts this
    // book's own `locations` rows, that the setters persist and audit, and
    // — the one explicitly required by that ROADMAP entry — that
    // downgrading a business book to personal hides its screens without
    // touching a single row.
    // -------------------------------------------------------------------

    #[test]
    fn book_profile_wires_the_real_location_count_through_resolve() {
        let svc = svc();
        let book = make_business(&svc);

        // Freshly created: no locations, no override.
        let profile = svc.book_profile(&book.id).unwrap();
        assert_eq!(profile.location_count, 0);
        assert!(!profile.multi_location);
        assert!(profile.show_contacts && profile.show_catalogue);
        assert!(!profile.show_locations);

        svc.location_create(NewLocation {
            book_id: book.id.clone(),
            name: "HQ".into(),
            kind: None,
            code: None,
            address: None,
        })
        .unwrap();
        let profile = svc.book_profile(&book.id).unwrap();
        assert_eq!(profile.location_count, 1);
        assert!(
            !profile.multi_location,
            "one location is not multi-location"
        );

        svc.location_create(NewLocation {
            book_id: book.id.clone(),
            name: "Depot".into(),
            kind: None,
            code: None,
            address: None,
        })
        .unwrap();
        let profile = svc.book_profile(&book.id).unwrap();
        assert_eq!(profile.location_count, 2);
        assert!(profile.multi_location, "a second location derives it on");
        assert!(profile.show_locations);
    }

    #[test]
    fn a_personal_book_never_shows_business_groups_via_book_profile() {
        let svc = svc();
        let book = make_book(&svc);
        let profile = svc.book_profile(&book.id).unwrap();
        assert!(profile.show_accounts && profile.show_transactions);
        assert!(profile.show_budgets && profile.show_members);
        assert!(!profile.show_contacts && !profile.show_catalogue);
        assert!(!profile.show_purchasing && !profile.show_sales);
        assert!(!profile.show_locations);
    }

    #[test]
    fn book_set_kind_flips_in_both_directions_and_is_audited() {
        let svc = svc();
        let book = make_book(&svc);
        assert_eq!(book.kind, BookKind::Personal);
        assert!(!svc.book_profile(&book.id).unwrap().show_contacts);

        let business = svc.book_set_kind(&book.id, BookKind::Business).unwrap();
        assert_eq!(business.kind, BookKind::Business);
        assert!(svc.book_profile(&book.id).unwrap().show_contacts);

        let personal = svc.book_set_kind(&book.id, BookKind::Personal).unwrap();
        assert_eq!(personal.kind, BookKind::Personal);
        assert!(!svc.book_profile(&book.id).unwrap().show_contacts);

        let entries = svc.audit_list(Some(&book.id), 100).unwrap();
        let kind_changes = entries
            .iter()
            .filter(|e| e.entity_type == "book" && e.action == "set_kind")
            .count();
        assert_eq!(kind_changes, 2, "both direction changes are audited");
    }

    #[test]
    fn book_set_multi_location_override_pins_and_clears_back_to_derived() {
        let svc = svc();
        let book = make_business(&svc);
        svc.location_create(NewLocation {
            book_id: book.id.clone(),
            name: "HQ".into(),
            kind: None,
            code: None,
            address: None,
        })
        .unwrap();
        assert!(!svc.book_profile(&book.id).unwrap().multi_location);

        // Pin on early, before a second location exists — the documented
        // escape hatch (decision #3).
        let updated = svc
            .book_set_multi_location_override(&book.id, Some(true))
            .unwrap();
        assert_eq!(updated.multi_location_override, Some(true));
        let profile = svc.book_profile(&book.id).unwrap();
        assert!(profile.multi_location && profile.show_locations);

        // Pin off despite a genuinely multi-location book.
        svc.location_create(NewLocation {
            book_id: book.id.clone(),
            name: "Depot".into(),
            kind: None,
            code: None,
            address: None,
        })
        .unwrap();
        svc.book_set_multi_location_override(&book.id, Some(false))
            .unwrap();
        assert!(!svc.book_profile(&book.id).unwrap().multi_location);

        // Clear back to derived: two locations now, so it goes back on.
        let cleared = svc
            .book_set_multi_location_override(&book.id, None)
            .unwrap();
        assert_eq!(cleared.multi_location_override, None);
        assert!(svc.book_profile(&book.id).unwrap().multi_location);
    }

    /// The requirement ROADMAP.md states outright: "Downgrading hides
    /// screens; it never deletes rows." A business book with a location, a
    /// contact, a product category, a product and a variant loses none of
    /// them when flipped to personal — `book_profile` stops recommending
    /// their screens, and every row is still there, unmodified, the moment
    /// it flips back.
    #[test]
    fn downgrading_a_business_book_to_personal_hides_screens_but_never_deletes_rows() {
        let svc = svc();
        let book = make_business(&svc);

        svc.location_create(NewLocation {
            book_id: book.id.clone(),
            name: "HQ".into(),
            kind: None,
            code: None,
            address: None,
        })
        .unwrap();
        svc.location_create(NewLocation {
            book_id: book.id.clone(),
            name: "Depot".into(),
            kind: None,
            code: None,
            address: None,
        })
        .unwrap();
        let contact = svc
            .contact_add(NewContact {
                book_id: book.id.clone(),
                role: ContactRole::Both,
                name: "Acme".into(),
                company_name: None,
                email: None,
                phone: None,
                billing_address: None,
                shipping_address: None,
                tax_number: None,
                payment_terms_days: None,
                credit_limit_minor: None,
                notes: None,
            })
            .unwrap();
        let category = svc
            .product_category_create(NewProductCategory {
                book_id: book.id.clone(),
                name: "Widgets".into(),
            })
            .unwrap();
        let product = svc
            .product_create(NewProduct {
                book_id: book.id.clone(),
                product_category_id: Some(category.id.clone()),
                name: "Widget".into(),
                description: None,
            })
            .unwrap();
        let variant = svc
            .product_variant_add(NewProductVariant {
                product_id: product.id.clone(),
                sku: "WID-1".into(),
                name: "Widget — Red".into(),
                price_minor: Some(1999),
                cost_price_minor: Some(900),
                currency: book.currency.clone(),
                reorder_point: None,
                attributes: None,
            })
            .unwrap();

        // Before the downgrade: everything visible.
        let before = svc.book_profile(&book.id).unwrap();
        assert!(before.show_contacts && before.show_catalogue);
        assert!(before.show_purchasing && before.show_sales);
        assert!(before.show_locations);

        let downgraded = svc.book_set_kind(&book.id, BookKind::Personal).unwrap();
        assert_eq!(downgraded.kind, BookKind::Personal);

        // After: the resolver hides every business group — including
        // locations, even though the row count alone would still derive
        // multi-location true — because `show_locations` requires
        // `BookKind::Business` too (a personal book has no location axis
        // to show, regardless of how many location rows a prior business
        // life left behind).
        let after = svc.book_profile(&book.id).unwrap();
        assert!(!after.show_contacts && !after.show_catalogue);
        assert!(!after.show_purchasing && !after.show_sales);
        assert!(!after.show_locations);
        assert_eq!(after.location_count, 2, "the rows are still there");

        // Every row survives, byte-for-byte, reachable exactly as before.
        assert_eq!(svc.location_list(&book.id).unwrap().len(), 2);
        assert_eq!(svc.contact_get(&contact.id).unwrap(), contact);
        assert_eq!(
            svc.product_category_list(&book.id).unwrap(),
            vec![category.clone()]
        );
        assert_eq!(svc.product_get(&product.id).unwrap(), product);
        assert_eq!(svc.product_variant_get(&variant.id).unwrap(), variant);

        // And flipping back to business immediately restores every screen
        // recommendation, with the same rows still behind it — nothing was
        // re-created, nothing was re-derived from scratch.
        svc.book_set_kind(&book.id, BookKind::Business).unwrap();
        let restored = svc.book_profile(&book.id).unwrap();
        assert!(restored.show_contacts && restored.show_catalogue);
        assert!(restored.show_locations);
        assert_eq!(svc.contact_list(&book.id).unwrap(), vec![contact]);
    }

    // -------------------------------------------------------------------
    // Contacts (Xero axis — PARITY.md "Contacts (customers & suppliers)")
    // -------------------------------------------------------------------

    #[test]
    fn contact_crud_and_role_defaults() {
        let svc = svc();
        let book = make_book(&svc);

        assert!(svc.contact_list(&book.id).unwrap().is_empty());

        let acme = svc
            .contact_add(NewContact {
                book_id: book.id.clone(),
                role: ContactRole::Supplier,
                name: "  Acme Wholesale  ".into(),
                company_name: Some("Acme (Pty) Ltd".into()),
                email: Some("billing@acme.example".into()),
                phone: None,
                billing_address: None,
                shipping_address: None,
                tax_number: Some("4123456789".into()),
                payment_terms_days: Some(30),
                credit_limit_minor: Some(500_000),
                notes: None,
            })
            .unwrap();
        assert_eq!(acme.name, "Acme Wholesale", "name is trimmed");
        assert_eq!(acme.role, ContactRole::Supplier);
        assert!(acme.is_active, "new contacts default to active");
        assert_eq!(acme.payment_terms_days, Some(30));
        assert_eq!(acme.credit_limit_minor, Some(500_000));

        let jane = svc
            .contact_add(NewContact {
                book_id: book.id.clone(),
                role: ContactRole::Customer,
                name: "Jane Retailer".into(),
                company_name: None,
                email: None,
                phone: None,
                billing_address: None,
                shipping_address: None,
                tax_number: None,
                payment_terms_days: None,
                credit_limit_minor: None,
                notes: None,
            })
            .unwrap();

        // Both-role contacts show up on both sides; single-role contacts on
        // only their own side.
        let both = svc
            .contact_add(NewContact {
                book_id: book.id.clone(),
                role: ContactRole::Both,
                name: "Dual Trader".into(),
                company_name: None,
                email: None,
                phone: None,
                billing_address: None,
                shipping_address: None,
                tax_number: None,
                payment_terms_days: None,
                credit_limit_minor: None,
                notes: None,
            })
            .unwrap();

        assert_eq!(
            svc.contact_list(&book.id).unwrap(),
            vec![acme.clone(), both.clone(), jane.clone()],
            "alphabetical by name"
        );

        let suppliers = svc.contact_list_suppliers(&book.id).unwrap();
        assert_eq!(
            suppliers.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
            vec![acme.id.clone(), both.id.clone()],
            "supplier + both, never the customer-only contact"
        );
        let customers = svc.contact_list_customers(&book.id).unwrap();
        assert_eq!(
            customers.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
            vec![both.id.clone(), jane.id.clone()],
            "customer + both, never the supplier-only contact"
        );

        // Update: change role, set a phone number, then clear it again —
        // `Some(None)` must reach all the way through to a stored NULL.
        let updated = svc
            .contact_update(
                &jane.id,
                ContactPatch {
                    role: Some(ContactRole::Both),
                    phone: Some(Some("+27 11 555 0100".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.role, ContactRole::Both);
        assert_eq!(updated.phone.as_deref(), Some("+27 11 555 0100"));

        let cleared = svc
            .contact_update(
                &jane.id,
                ContactPatch {
                    phone: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cleared.phone, None);
        assert_eq!(cleared.role, ContactRole::Both, "untouched field stays");

        // Deactivate rather than delete — the common "no longer trading with
        // this party but keep the record" path.
        let inactive = svc
            .contact_update(
                &acme.id,
                ContactPatch {
                    is_active: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(!inactive.is_active);

        // Remove.
        svc.contact_remove(&both.id).unwrap();
        assert!(matches!(
            svc.contact_get(&both.id),
            Err(CoreError::NotFound { .. })
        ));
        assert_eq!(svc.contact_list(&book.id).unwrap().len(), 2);

        // Audited (create x3, update x3, remove).
        let audits = svc.audit_list(Some(&book.id), 50).unwrap();
        for action in ["create", "update", "remove"] {
            assert!(
                audits
                    .iter()
                    .any(|a| a.entity_type == "contact" && a.action == action),
                "missing contact audit {action}"
            );
        }
    }

    #[test]
    fn contact_add_validates_name_book_and_amounts() {
        let svc = svc();
        let book = make_book(&svc);

        let base = |name: &str| NewContact {
            book_id: book.id.clone(),
            role: ContactRole::Customer,
            name: name.into(),
            company_name: None,
            email: None,
            phone: None,
            billing_address: None,
            shipping_address: None,
            tax_number: None,
            payment_terms_days: None,
            credit_limit_minor: None,
            notes: None,
        };

        assert!(matches!(
            svc.contact_add(base("   ")),
            Err(CoreError::Validation(_))
        ));

        assert!(matches!(
            svc.contact_add(NewContact {
                payment_terms_days: Some(-1),
                ..base("Negative Terms")
            }),
            Err(CoreError::Validation(_))
        ));

        assert!(matches!(
            svc.contact_add(NewContact {
                credit_limit_minor: Some(-1),
                ..base("Negative Limit")
            }),
            Err(CoreError::Validation(_))
        ));

        assert!(matches!(
            svc.contact_add(NewContact {
                book_id: "missing-book".into(),
                ..base("Nobody")
            }),
            Err(CoreError::NotFound { .. })
        ));

        // Empty optional strings normalize to None rather than stored as "".
        let contact = svc
            .contact_add(NewContact {
                email: Some("   ".into()),
                ..base("Blank Email")
            })
            .unwrap();
        assert_eq!(contact.email, None);
    }

    /// The structural half of the sync obligation, from the service surface:
    /// an ordinary `contact_add` through `CoreService` reaches the outbox
    /// exactly like a hand-written INSERT would (the trigger-level proof is
    /// `sync::capture::tests::contact_writes_are_captured_through_insert_update_delete`).
    #[test]
    fn contact_add_reaches_the_sync_outbox() {
        let svc = svc();
        let book = make_book(&svc);
        let contact = svc
            .contact_add(NewContact {
                book_id: book.id.clone(),
                role: ContactRole::Customer,
                name: "Synced Co".into(),
                company_name: None,
                email: None,
                phone: None,
                billing_address: None,
                shipping_address: None,
                tax_number: None,
                payment_terms_days: None,
                credit_limit_minor: None,
                notes: None,
            })
            .unwrap();

        let mut stmt = svc
            .conn_for_test()
            .prepare("SELECT ns, deleted FROM sync_outbox WHERE table_name = 'contacts' AND row_id = ?1")
            .unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map(rusqlite::params![contact.id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows, vec![(book.id.clone(), 0)]);
    }
}
