//! Shared Tauri state: one [`CoreService`] over the app-data SQLite database,
//! plus a second connection reserved for the credential vault (core keeps the
//! vault tables private to `secrets::Vault`, which borrows a raw connection).

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use slipscan_core::domain::{Book, BookKind, CategoryKind, NewBook, NewCategory};
use slipscan_core::secrets::KeyringSecretStore;
use slipscan_core::{CoreResult, CoreService, Db};

/// Starter category taxonomy for a fresh book: (name, kind, icon).
/// Packs can extend this later; these make categorise/budgets usable on day 1.
const DEFAULT_CATEGORIES: &[(&str, CategoryKind, &str)] = &[
    ("Groceries", CategoryKind::Expense, "🛒"),
    ("Eating out", CategoryKind::Expense, "☕"),
    ("Transport & fuel", CategoryKind::Expense, "⛽"),
    ("Utilities", CategoryKind::Expense, "💡"),
    ("Subscriptions", CategoryKind::Expense, "📺"),
    ("Health", CategoryKind::Expense, "🩺"),
    ("Household", CategoryKind::Expense, "🏠"),
    ("Salary", CategoryKind::Income, "💼"),
    ("Interest", CategoryKind::Income, "🏦"),
    ("Transfers", CategoryKind::Transfer, "🔁"),
];

pub struct AppState {
    service: Mutex<CoreService>,
    /// Second connection to the same file, used only by vault commands.
    vault_db: Mutex<Db>,
    /// OS keychain handle for the vault's key-encryption key.
    pub keychain: KeyringSecretStore,
    /// User-visible path of the SQLite file backing the current book.
    pub db_path: PathBuf,
    /// Where imported documents (receipts/slips) are stored.
    pub docs_dir: PathBuf,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("db_path", &self.db_path)
            .finish_non_exhaustive()
    }
}

impl AppState {
    /// Open (creating if needed) the database in `data_dir` and seed the
    /// default book on first run.
    pub fn open(data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("cannot create app data dir: {e}"))?;
        let docs_dir = data_dir.join("documents");
        std::fs::create_dir_all(&docs_dir)
            .map_err(|e| format!("cannot create documents dir: {e}"))?;
        let db_path = data_dir.join("slipscan.db");

        let service = CoreService::open(&db_path).map_err(|e| e.to_string())?;
        ensure_seeded(&service).map_err(|e| e.to_string())?;

        // Vault connection: WAL allows a second writer; give it patience so
        // it never races the service connection into SQLITE_BUSY.
        let vault_db = Db::open(&db_path).map_err(|e| e.to_string())?;
        let _ = vault_db.conn().busy_timeout(Duration::from_secs(5));

        Ok(Self {
            service: Mutex::new(service),
            vault_db: Mutex::new(vault_db),
            keychain: KeyringSecretStore::default(),
            db_path,
            docs_dir,
        })
    }

    pub fn service(&self) -> Result<MutexGuard<'_, CoreService>, String> {
        self.service
            .lock()
            .map_err(|_| "core service state poisoned".to_string())
    }

    pub fn vault_db(&self) -> Result<MutexGuard<'_, Db>, String> {
        self.vault_db
            .lock()
            .map_err(|_| "vault state poisoned".to_string())
    }
}

/// First-run seed: a Personal (ZA) book, the SA chart of accounts + VAT
/// rates, and a starter category set. Idempotent — a populated database is
/// left untouched.
pub fn ensure_seeded(service: &CoreService) -> CoreResult<Book> {
    if let Some(book) = service.book_list()?.into_iter().next() {
        return Ok(book);
    }
    let book = service.book_create(NewBook {
        name: "Personal".to_string(),
        kind: BookKind::Personal,
        currency: None,
        country: Some("ZA".to_string()),
    })?;
    service.coa_seed(&book.id)?;
    for &(name, kind, icon) in DEFAULT_CATEGORIES {
        service.category_create(NewCategory {
            book_id: book.id.clone(),
            parent_id: None,
            name: name.to_string(),
            kind,
            icon: Some(icon.to_string()),
            color: None,
        })?;
    }
    Ok(book)
}

#[cfg(test)]
mod tests {
    use super::*;
    use slipscan_core::secrets::MemorySecretStore;

    #[test]
    fn seed_creates_book_categories_and_coa_once() {
        let service = CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let book = ensure_seeded(&service).unwrap();
        assert_eq!(book.kind, BookKind::Personal);
        let tree = service.category_tree(&book.id).unwrap();
        assert_eq!(tree.len(), DEFAULT_CATEGORIES.len());
        assert!(!service.coa_list(&book.id).unwrap().is_empty());

        // Second call is a no-op returning the same book.
        let again = ensure_seeded(&service).unwrap();
        assert_eq!(again.id, book.id);
        assert_eq!(
            service.category_tree(&book.id).unwrap().len(),
            DEFAULT_CATEGORIES.len()
        );
    }
}
