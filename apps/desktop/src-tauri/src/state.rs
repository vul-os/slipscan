//! Shared Tauri state: one [`CoreService`] over the SQLite database in the
//! movable data folder (resolved through core's shared
//! [`slipscan_core::datadir::DataDirResolver`] — the same pointer the CLI and
//! server follow), plus two further connections to the same file for the
//! subsystems core keeps private to their own borrowing types: the credential
//! vault (`secrets::Vault`) and device identity ([`DeviceHandle`], which owns
//! a connection and a keychain).
//!
//! All three are closed and reopened around a data-folder move — core's move
//! takes SQLite's exclusive lock and refuses while *any* connection is open,
//! including this process's own.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use slipscan_core::datadir::{self, DataDirResolver};
use slipscan_core::domain::{AuditEntry, Book, CategoryKind, NewCategory};
use slipscan_core::secrets::{KeyringSecretStore, MemorySecretStore};
use slipscan_core::util::{new_id, now_iso};
use slipscan_core::{repo, CoreResult, CoreService, Db};
use slipscan_server::devices::DeviceHandle;

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
    /// Device identity and pairing, over a third connection to the same file.
    ///
    /// This is `slipscan-server`'s handle, not a local re-implementation, and
    /// deliberately: it is where the served/local-only split for device
    /// operations is written down, and the CLI drives the same type. A second
    /// wrapper here would be a second opinion about which operations may
    /// leave the machine.
    devices: Mutex<DeviceHandle>,
    /// OS keychain handle for the vault's key-encryption key.
    pub keychain: KeyringSecretStore,
    /// Shared resolver for the movable data folder — pointer file in the
    /// fixed per-OS config dir. The resolver itself never moves.
    pub resolver: DataDirResolver,
    /// Currently active data folder — swapped when a move completes.
    data_dir: Mutex<PathBuf>,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("resolver", &self.resolver)
            .finish_non_exhaustive()
    }
}

impl AppState {
    /// Resolve the data folder through `resolver` and open (creating if
    /// needed) the database there. It does **not** invent a book: a fresh
    /// database opens with none, and first-run setup, the command palette or
    /// Settings › General create the first one (see `seed_book_contents`).
    pub fn open(resolver: DataDirResolver) -> Result<Self, String> {
        let data_dir = resolver.resolve().map_err(err)?;
        std::fs::create_dir_all(datadir::documents_dir(&data_dir))
            .map_err(|e| format!("cannot create data folder {}: {e}", data_dir.display()))?;
        let db_path = datadir::db_path(&data_dir);

        let service = CoreService::open(&db_path).map_err(err)?;
        let vault_db = open_vault_db(&db_path)?;
        let devices = open_devices(&db_path)?;

        Ok(Self {
            service: Mutex::new(service),
            vault_db: Mutex::new(vault_db),
            devices: Mutex::new(devices),
            keychain: KeyringSecretStore::default(),
            resolver,
            data_dir: Mutex::new(data_dir),
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

    pub fn devices(&self) -> Result<MutexGuard<'_, DeviceHandle>, String> {
        self.devices
            .lock()
            .map_err(|_| "device identity state poisoned".to_string())
    }

    /// The currently active data folder.
    pub fn data_dir(&self) -> Result<PathBuf, String> {
        Ok(self
            .data_dir
            .lock()
            .map_err(|_| "data dir state poisoned".to_string())?
            .clone())
    }

    /// Move the data folder to `target` through core's verified move (source
    /// locked exclusively → copy → per-file checksums → open/migrate +
    /// integrity check → atomic pointer swap → only then remove the old
    /// copy), or with `use_existing` adopt a folder that already contains a
    /// SlipScan database without copying ("open instead" — the current
    /// folder is left untouched).
    ///
    /// Read-only during the move, twice over: every state lock is held for
    /// the whole operation so no other IPC command can run, and — because
    /// core's move takes SQLite's exclusive lock on the source database and
    /// refuses while *any* connection is open, including this process's own
    /// two — our connections are **closed** for the duration (swapped for
    /// throwaway in-memory stand-ins nothing else can observe) and reopened
    /// below at whichever folder the pointer names afterwards: the new one
    /// on success, the untouched old one on failure.
    pub fn move_data_dir(&self, target: &Path, use_existing: bool) -> Result<PathBuf, String> {
        let mut service = self.service()?;
        let mut vault_db = self.vault_db()?;
        let mut devices = self.devices()?;
        let mut data_dir = self
            .data_dir
            .lock()
            .map_err(|_| "data dir state poisoned".to_string())?;

        let moved = if use_existing {
            adopt_existing(&self.resolver, &data_dir, target)
        } else {
            match closed_placeholders() {
                Ok((service_placeholder, vault_placeholder, devices_placeholder)) => {
                    *service = service_placeholder;
                    *vault_db = vault_placeholder;
                    *devices = devices_placeholder;
                    // Single spinner-friendly await on the frontend: no
                    // progress events — the promise resolving is the
                    // completion signal.
                    datadir::move_data_dir(&self.resolver, target, &mut |_| {})
                        .map(|_| ())
                        .map_err(err)
                }
                // Fall through to the reopen below — the real connections
                // stay (or come back) live on the untouched old folder.
                Err(e) => Err(err(e)),
            }
        };

        // Reopen at the location the pointer now names. An adopted database
        // may be fresh (e.g. created by the CLI without books); it stays
        // that way — nothing is written into a folder the user just pointed
        // at, and the empty state is recoverable from the UI.
        match (moved, reopen(&self.resolver)) {
            (moved, Ok((new_service, new_vault_db, new_devices, new_dir))) => {
                *service = new_service;
                *vault_db = new_vault_db;
                *devices = new_devices;
                *data_dir = new_dir.clone();
                moved.map(|()| new_dir)
            }
            (Ok(()), Err(reopen_err)) => Err(format!(
                "the folder switched but reopening the database failed ({reopen_err}) — \
                 restart SlipScan"
            )),
            (Err(move_err), Err(reopen_err)) => Err(format!(
                "{move_err}; reopening the previous folder also failed ({reopen_err}) — \
                 restart SlipScan"
            )),
        }
    }
}

/// Stand-ins installed while core moves the folder: the move's exclusive
/// SQLite lock refuses any open handle on the source database, so the real
/// connections must be closed (not merely `query_only`) for the duration.
/// Every state lock is held throughout, so no IPC command can ever observe
/// the stand-ins.
fn closed_placeholders() -> CoreResult<(CoreService, Db, DeviceHandle)> {
    Ok((
        CoreService::new(Db::open_in_memory()?, Box::new(MemorySecretStore::new())),
        Db::open_in_memory()?,
        // In-memory, and with a *memory* keychain: the stand-in must not be
        // able to touch the real OS keychain even if something reached it.
        DeviceHandle::new(Db::open_in_memory()?, Box::new(MemorySecretStore::new())),
    ))
}

/// Open service + vault + device connections on whichever folder the shared
/// pointer currently names. An adopted folder keeps exactly the books — and
/// exactly the device identity — it already holds, including none.
fn reopen(resolver: &DataDirResolver) -> Result<(CoreService, Db, DeviceHandle, PathBuf), String> {
    let dir = resolver.resolve().map_err(err)?;
    let db = datadir::db_path(&dir);
    let service = CoreService::open(&db)
        .map_err(|e| format!("opening the database at {} failed: {e}", dir.display()))?;
    let vault_db = open_vault_db(&db)?;
    let devices = open_devices(&db)?;
    Ok((service, vault_db, devices, dir))
}

/// "Open instead": switch the pointer to a folder that already contains a
/// SlipScan database. Nothing is copied and nothing is removed — the previous
/// folder keeps its data. The adopted database gets the same open/migrate
/// check as a moved one, and the switch lands in *its* audit log (the log
/// that survives) before the pointer swaps.
fn adopt_existing(
    resolver: &DataDirResolver,
    current_dir: &Path,
    target: &Path,
) -> Result<(), String> {
    let target_db = datadir::db_path(target);
    if !target_db.is_file() {
        return Err(format!(
            "no SlipScan database found in {}",
            target.display()
        ));
    }
    let target_canon = std::fs::canonicalize(target)
        .map_err(|e| format!("cannot resolve {}: {e}", target.display()))?;
    if std::fs::canonicalize(current_dir).ok().as_deref() == Some(target_canon.as_path()) {
        return Err("that is already the current data folder".to_string());
    }

    {
        // Open/migrate check on the adopted database before the pointer moves.
        let db = Db::open(&target_db)
            .map_err(|e| format!("cannot open the database in that folder: {e}"))?;
        repo::audit::insert(
            db.conn(),
            &AuditEntry {
                id: new_id(),
                book_id: None,
                entity_type: "data_dir".to_string(),
                entity_id: None,
                action: "switch".to_string(),
                before_json: serde_json::to_string(&serde_json::json!({
                    "data_dir": current_dir.display().to_string(),
                }))
                .ok(),
                after_json: serde_json::to_string(&serde_json::json!({
                    "data_dir": target_canon.display().to_string(),
                }))
                .ok(),
                created_at: now_iso(),
            },
        )
        .map_err(err)?;
    }

    resolver.write_pointer(&target_canon).map_err(err)?;
    // Read-back verification, same as core's move commit.
    let resolved = resolver.resolve().map_err(err)?;
    if resolved != target_canon {
        return Err(format!(
            "pointer read-back resolved {} instead of {} — the previous folder stays active",
            resolved.display(),
            target_canon.display()
        ));
    }
    Ok(())
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Vault connection: WAL allows a second writer; give it patience so it never
/// races the service connection into SQLITE_BUSY.
fn open_vault_db(db_path: &Path) -> Result<Db, String> {
    let vault_db = Db::open(db_path).map_err(err)?;
    let _ = vault_db.conn().busy_timeout(Duration::from_secs(5));
    Ok(vault_db)
}

/// Device-identity connection: same file, same patience as the vault's, and
/// the real OS keychain — the device's private key lives in the vault, so
/// there is no device identity without it.
fn open_devices(db_path: &Path) -> Result<DeviceHandle, String> {
    let db = Db::open(db_path).map_err(err)?;
    let _ = db.conn().busy_timeout(Duration::from_secs(5));
    Ok(DeviceHandle::new(
        db,
        Box::new(KeyringSecretStore::default()),
    ))
}

/// Fill a just-created book with the two things that make it usable on day
/// one: the chart of accounts its **own region profile** prescribes (core's
/// `coa_seed` reads the book's region and kind — no jurisdiction is decided
/// here) and the starter category set above.
///
/// The `book_create` IPC command is the only caller, because creating a book
/// is the only moment this is correct. The desktop exposes no separate
/// `coa_seed` command, so a bare create would otherwise hand back a book
/// with an empty ledger and no categories to classify into.
///
/// **Opening a database no longer creates a book.** It used to: startup ran
/// an `ensure_seeded` that quietly wrote a "Personal" book on the *generic*
/// profile before the user had said anything. That made the region and
/// currency questions unanswerable rather than merely unasked — `book_list`
/// is `ORDER BY created_at`, every desktop screen reads the first row, and
/// core has no way to re-region a book once `coa_seed` has run against the
/// old profile. A book created afterwards could therefore never become the
/// one on screen, so first-run setup had nothing it could usefully do and
/// was never shown. An empty database is now an honest empty state that
/// first-run setup, the command palette and Settings › General can all
/// resolve — the same posture the CLI has always had (`slipscan init`
/// creates a book only when given `--name`).
pub fn seed_book_contents(service: &CoreService, book: &Book) -> CoreResult<()> {
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // Book creation is a test-only concern in this module now that startup
    // no longer does it; the `book_create` command owns it in commands.rs.
    use slipscan_core::domain::{BookKind, NewBook};
    use slipscan_core::secrets::MemorySecretStore;

    /// The precondition for first-run setup being reachable at all.
    ///
    /// The frontend opens setup only when `book_list` comes back empty
    /// (`shouldRunFirstRun` in src/lib/onboarding.svelte.ts). Startup used to
    /// write a book before anyone asked, so that gate could never be
    /// satisfied and the whole flow was unreachable — wired, tested, and
    /// dead. This asserts the backend leaves the question open.
    #[test]
    fn opening_a_fresh_database_creates_no_book() {
        let root = tmp_root("fresh");
        let state = AppState::open(resolver_in(&root)).unwrap();
        let service = state.service().unwrap();
        assert!(
            service.book_list().unwrap().is_empty(),
            "startup invented a book, which puts first-run setup out of reach"
        );
        drop(service);

        // Re-opening the same folder must not change its mind either.
        drop(state);
        let again = AppState::open(resolver_in(&root)).unwrap();
        assert!(again.service().unwrap().book_list().unwrap().is_empty());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// And the empty state is resolvable through the one command the UI has:
    /// `book_create` + the seed, after which the app has everything a book
    /// needs. This is the path first-run setup, the palette command and
    /// Settings › General all take.
    #[test]
    fn creating_the_first_book_leaves_it_immediately_usable() {
        let root = tmp_root("first-book");
        let state = AppState::open(resolver_in(&root)).unwrap();
        let service = state.service().unwrap();

        let book = service
            .book_create(NewBook {
                name: "Household".to_string(),
                kind: BookKind::Personal,
                currency: Some("ZAR".to_string()),
                country: None,
                region: None, // core resolves this to the generic profile
            })
            .unwrap();
        seed_book_contents(&service, &book).unwrap();

        // Global by default: with no region asked for, the book is generic —
        // never a hardcoded jurisdiction.
        assert_eq!(book.region, "generic");
        assert_eq!(service.book_list().unwrap().len(), 1);
        assert_eq!(
            service.category_tree(&book.id).unwrap().len(),
            DEFAULT_CATEGORIES.len()
        );
        assert!(!service.coa_list(&book.id).unwrap().is_empty());
        drop(service);

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// The seed the `book_create` command runs takes its chart of accounts
    /// from the book's **own** region profile. Driven off the profile data
    /// rather than a literal id, so adding a country cannot quietly leave
    /// first-run setup seeding somebody else's chart.
    #[test]
    fn seeding_a_created_book_follows_its_own_region_profile() {
        let service = CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        for profile in slipscan_core::region::profiles() {
            let book = service
                .book_create(NewBook {
                    name: format!("Book {}", profile.id),
                    kind: BookKind::Personal,
                    currency: Some("ZAR".to_string()),
                    country: None,
                    region: Some(profile.id.to_string()),
                })
                .unwrap();
            assert_eq!(book.region, profile.id);
            seed_book_contents(&service, &book).unwrap();

            let codes: Vec<String> = service
                .coa_list(&book.id)
                .unwrap()
                .into_iter()
                .map(|a| a.code)
                .collect();
            for &(code, _, _) in profile.personal_coa {
                assert!(
                    codes.iter().any(|c| c == code),
                    "{} chart is missing {code}",
                    profile.id
                );
            }
            assert_eq!(
                service.category_tree(&book.id).unwrap().len(),
                DEFAULT_CATEGORIES.len()
            );
        }
    }

    /// A book in `state`'s current database — what startup used to conjure.
    /// The move tests need one to prove the data survived the move.
    fn create_book_in(state: &AppState) -> Book {
        let service = state.service().unwrap();
        let book = service
            .book_create(NewBook {
                name: "Household".to_string(),
                kind: BookKind::Personal,
                currency: Some("ZAR".to_string()),
                country: None,
                region: None,
            })
            .unwrap();
        seed_book_contents(&service, &book).unwrap();
        book
    }

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("slipscan-state-{tag}-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Test resolver with the pointer and default data dir under one
    /// disposable root — same shape core's own datadir tests use.
    fn resolver_in(root: &Path) -> DataDirResolver {
        DataDirResolver::new(root.join("config"), root.join("data"))
    }

    #[test]
    fn move_data_dir_relocates_repoints_and_reopens() {
        let root = tmp_root("move");
        let state = AppState::open(resolver_in(&root)).unwrap();
        create_book_in(&state);
        let old_dir = state.data_dir().unwrap();
        std::fs::write(
            datadir::documents_dir(&old_dir).join("slip.pdf"),
            b"pdf-bytes",
        )
        .unwrap();

        let target = tmp_root("move-target");
        let new_dir = state.move_data_dir(&target, false).unwrap();
        assert_eq!(new_dir, std::fs::canonicalize(&target).unwrap());
        assert_eq!(state.data_dir().unwrap(), new_dir);

        // Data arrived; the old copy is gone; the shared resolver names the
        // new folder for every surface / the next launch.
        assert!(datadir::db_path(&new_dir).is_file());
        assert_eq!(
            std::fs::read(datadir::documents_dir(&new_dir).join("slip.pdf")).unwrap(),
            b"pdf-bytes"
        );
        assert!(!datadir::db_path(&old_dir).exists());
        assert!(!datadir::documents_dir(&old_dir).exists());
        assert_eq!(state.resolver.resolve().unwrap(), new_dir);

        // The live service now runs against the new file (the book made
        // above is still there, writes work again), and the move is in the
        // audit log.
        let service = state.service().unwrap();
        assert!(!service.book_list().unwrap().is_empty());
        assert!(!service.is_read_only());
        let audit = service.audit_list(None, 100).unwrap();
        assert!(audit
            .iter()
            .any(|e| e.entity_type == "data_dir" && e.action == "move"));
        drop(service);

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn move_data_dir_refusal_leaves_everything_writable_in_place() {
        let root = tmp_root("refuse");
        let state = AppState::open(resolver_in(&root)).unwrap();
        create_book_in(&state);
        let old_dir = state.data_dir().unwrap();

        let err = state
            .move_data_dir(&old_dir.join("nested"), false)
            .unwrap_err();
        assert!(err.contains("inside the current data folder"), "{err}");

        // Nothing changed: same folder, database in place, and the read-only
        // guard was lifted so the app keeps working.
        assert_eq!(state.data_dir().unwrap(), old_dir);
        assert!(datadir::db_path(&old_dir).is_file());
        let service = state.service().unwrap();
        assert!(!service.is_read_only());
        let book = service.book_list().unwrap().remove(0);
        service
            .book_set_lock_date(&book.id, Some("2020-01-01"))
            .expect("writes must work after a refused move");
        drop(service);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn move_data_dir_use_existing_adopts_without_copying_or_deleting() {
        let root = tmp_root("adopt");
        let state = AppState::open(resolver_in(&root)).unwrap();
        create_book_in(&state);
        let old_dir = state.data_dir().unwrap();

        // A second, pre-existing SlipScan folder (e.g. restored from the
        // user's own cloud sync).
        let other = tmp_root("adopt-other");
        {
            let svc = CoreService::open(datadir::db_path(&other)).unwrap();
            let book = svc
                .book_create(NewBook {
                    name: "Restored".to_string(),
                    kind: BookKind::Personal,
                    currency: Some("ZAR".to_string()),
                    country: None,
                    region: None,
                })
                .unwrap();
            seed_book_contents(&svc, &book).unwrap();
        }

        // A plain move refuses the occupied folder with the offer-open
        // error…
        let err = state.move_data_dir(&other, false).unwrap_err();
        assert!(
            err.contains("already contains a SlipScan database"),
            "{err}"
        );
        assert_eq!(state.data_dir().unwrap(), old_dir);

        // …and adopting it switches the pointer without copying or removing
        // anything from the previous folder.
        let new_dir = state.move_data_dir(&other, true).unwrap();
        assert_eq!(new_dir, std::fs::canonicalize(&other).unwrap());
        assert!(datadir::db_path(&old_dir).is_file());
        assert_eq!(state.resolver.resolve().unwrap(), new_dir);
        let service = state.service().unwrap();
        assert!(!service.book_list().unwrap().is_empty());
        let audit = service.audit_list(None, 100).unwrap();
        assert!(audit
            .iter()
            .any(|e| e.entity_type == "data_dir" && e.action == "switch"));
        drop(service);

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&other).unwrap();
    }
}
