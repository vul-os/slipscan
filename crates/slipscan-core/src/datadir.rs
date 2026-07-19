//! The movable data folder — resolution and the verified move operation.
//!
//! Binding contract: "Data location & backup — your folder, your cloud, your
//! responsibility" in `docs/ARCHITECTURE.md`. All durable data (the SQLite
//! database and the documents store) lives in **one folder**. A small pointer
//! file in the FIXED per-OS app-config directory names the current folder;
//! when the pointer is absent the folder defaults to the per-OS app-data
//! directory. CLI, server, and desktop all resolve the same pointer, so every
//! surface agrees on where the data is.
//!
//! Moving is: validate target → take SQLite's own exclusive lock on the
//! source database and fold its WAL into the main file → copy database +
//! documents with per-file SHA-256 verification → open/migrate + integrity
//! check on the copy → journal the commit window → atomic pointer swap
//! (write temp + rename + directory fsync, then read back) → only then
//! remove the old copy. Aborting, crashing, or losing power at any point is
//! safe: until the pointer swap is on disk the old location keeps winning,
//! and a re-run resumes — over the partial copy, or (proven by the journal's
//! checksum) over a copy that already reached its final database name.
//!
//! "While a move is in progress the app is read-only" (the contract's safety
//! rail) is enforced *here*, across processes, by SQLite itself: acquiring
//! the exclusive lock fails while any other connection anywhere — a desktop
//! window, `slipscan serve`, a mail-sync watch, even idle — has the database
//! open, and holding it until the pointer has swapped means nothing can
//! commit writes the copy would silently leave behind. Callers that hold
//! their own connections on the folder being moved must therefore **close
//! them** for the duration and reopen at the resolved location afterwards.

use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::Db;
use crate::domain::AuditEntry;
use crate::error::{CoreError, CoreResult};
use crate::repo;
use crate::util::{new_id, now_iso};

/// Per-OS application directory name. Matches the desktop bundle identifier
/// (`apps/desktop/src-tauri/tauri.conf.json`) so the CLI, the server, and the
/// Tauri shell land on the same folders.
pub const APP_DIR_NAME: &str = "org.vulos.slipscan";

/// Name of the pointer file kept in the fixed app-config directory.
pub const POINTER_FILE_NAME: &str = "data_dir.json";

/// Name of the move-commit journal kept next to the pointer file. It exists
/// only from just before the copied database takes its final name until the
/// old copy is removed; a re-run uses its checksum to recognise its own
/// half-committed copy at the target and resume instead of refusing it.
pub const MOVE_JOURNAL_FILE_NAME: &str = "data_move.json";

/// Database file name inside the data folder.
pub const DB_FILE_NAME: &str = "slipscan.db";

/// Documents-store directory name inside the data folder.
pub const DOCUMENTS_DIR_NAME: &str = "documents";

/// The SQLite database path inside a data folder.
pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DB_FILE_NAME)
}

/// The documents store inside a data folder.
pub fn documents_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DOCUMENTS_DIR_NAME)
}

/// On-disk pointer format. Versioned so the shape can evolve without
/// guessing; the path is stored as a UTF-8 string (JSON has no bytes type).
#[derive(Debug, Serialize, Deserialize)]
struct PointerFile {
    version: u32,
    data_dir: String,
}

const POINTER_VERSION: u32 = 1;

/// Resolves the current data folder: the pointer file when present, the
/// platform default otherwise. One resolver shared by CLI, server, and
/// desktop — never resolve these paths anywhere else.
#[derive(Debug, Clone)]
pub struct DataDirResolver {
    /// Fixed per-OS app-config directory holding the pointer file. This one
    /// never moves — it is how every surface finds the (movable) data.
    config_dir: PathBuf,
    /// Data folder used when no pointer file exists.
    default_data_dir: PathBuf,
}

impl DataDirResolver {
    /// The real per-OS locations: pointer in `<config_dir>/org.vulos.slipscan`,
    /// default data in `<data_dir>/org.vulos.slipscan` (the same directory the
    /// desktop shell has always used).
    pub fn system() -> CoreResult<Self> {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| CoreError::DataDir("no per-user config directory on this OS".into()))?
            .join(APP_DIR_NAME);
        let default_data_dir = dirs::data_dir()
            .ok_or_else(|| CoreError::DataDir("no per-user data directory on this OS".into()))?
            .join(APP_DIR_NAME);
        Ok(Self::new(config_dir, default_data_dir))
    }

    /// Explicit locations — tests, containers, and shells that already know
    /// their platform dirs.
    pub fn new(config_dir: PathBuf, default_data_dir: PathBuf) -> Self {
        Self {
            config_dir,
            default_data_dir,
        }
    }

    /// Where the pointer file lives (whether or not it exists yet).
    pub fn pointer_path(&self) -> PathBuf {
        self.config_dir.join(POINTER_FILE_NAME)
    }

    /// The folder used when no pointer is set.
    pub fn default_data_dir(&self) -> &Path {
        &self.default_data_dir
    }

    /// The pointer's target, if a pointer file exists. A malformed pointer is
    /// an error, never a silent fallback — falling back to the default while
    /// the user's data lives elsewhere would fork their books.
    pub fn pointer_target(&self) -> CoreResult<Option<PathBuf>> {
        let raw = match fs::read_to_string(self.pointer_path()) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let pointer: PointerFile = serde_json::from_str(&raw).map_err(|e| {
            CoreError::DataDir(format!(
                "pointer file {} is malformed ({e}); fix or delete it — deleting falls back \
                 to the default folder {}",
                self.pointer_path().display(),
                self.default_data_dir.display()
            ))
        })?;
        let target = PathBuf::from(pointer.data_dir);
        if !target.is_absolute() {
            return Err(CoreError::DataDir(format!(
                "pointer file {} names a relative path {}; the data folder must be absolute",
                self.pointer_path().display(),
                target.display()
            )));
        }
        Ok(Some(target))
    }

    /// The current data folder: pointer target when set, default otherwise.
    /// The folder is not required to exist — callers create it on first use
    /// (and a missing folder on an unplugged drive should fail loudly at
    /// open, not silently resolve elsewhere).
    pub fn resolve(&self) -> CoreResult<PathBuf> {
        Ok(self
            .pointer_target()?
            .unwrap_or_else(|| self.default_data_dir.clone()))
    }

    /// Atomically (write temp + rename + read back by the caller) point at a
    /// new data folder. `target` must be absolute.
    pub fn write_pointer(&self, target: &Path) -> CoreResult<()> {
        if !target.is_absolute() {
            return Err(CoreError::DataDir(format!(
                "data folder must be an absolute path, got {}",
                target.display()
            )));
        }
        fs::create_dir_all(&self.config_dir)?;
        let pointer = PointerFile {
            version: POINTER_VERSION,
            data_dir: target.display().to_string(),
        };
        let tmp = self.config_dir.join(format!("{POINTER_FILE_NAME}.tmp"));
        {
            let mut file = fs::File::create(&tmp)?;
            file.write_all(serde_json::to_string_pretty(&pointer)?.as_bytes())?;
            // The rename below is only atomic-durable if the temp content hit
            // the disk first.
            file.sync_all()?;
        }
        fs::rename(&tmp, self.pointer_path())?;
        // The rename itself must also be durable before callers act on the
        // swap (a move deletes the old copy right after): a power cut that
        // resurrected the pre-swap pointer would resolve to a folder whose
        // database is gone — and every surface would silently seed a fresh
        // empty one there, forking the user's books.
        fsync_dir(&self.config_dir)?;
        Ok(())
    }
}

/// Flush a directory's entries to disk so a rename inside it survives power
/// loss before anything irreversible (deleting the old copy) depends on it.
/// Directory handles can only be fsynced on unix; Windows has no equivalent
/// (rename durability rides on NTFS metadata journaling).
fn fsync_dir(dir: &Path) -> CoreResult<()> {
    #[cfg(unix)]
    fs::File::open(dir)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// Where the data lives right now — shown by `slipscan data status`, the
/// server's `GET /api/v1/data_status`, and desktop Settings (which must show
/// the folder so users can verify it sits inside their own synced tree).
#[derive(Debug, Serialize)]
pub struct DataStatus {
    pub data_dir: String,
    pub db_path: String,
    pub documents_dir: String,
    pub pointer_path: String,
    /// `true` when a pointer file names the folder; `false` when running on
    /// the platform default.
    pub pointer_set: bool,
    pub is_default_location: bool,
    pub db_exists: bool,
    pub db_size_bytes: u64,
    pub document_count: u64,
    pub documents_size_bytes: u64,
}

/// Compute the current [`DataStatus`]. Purely local file inspection.
pub fn status(resolver: &DataDirResolver) -> CoreResult<DataStatus> {
    let pointer = resolver.pointer_target()?;
    let data_dir = pointer
        .clone()
        .unwrap_or_else(|| resolver.default_data_dir().to_path_buf());
    let db = db_path(&data_dir);
    let docs = documents_dir(&data_dir);
    let db_size_bytes = fs::metadata(&db).map(|m| m.len()).unwrap_or(0);
    let (document_count, documents_size_bytes) = dir_stats(&docs)?;
    Ok(DataStatus {
        data_dir: data_dir.display().to_string(),
        db_path: db.display().to_string(),
        documents_dir: docs.display().to_string(),
        pointer_path: resolver.pointer_path().display().to_string(),
        pointer_set: pointer.is_some(),
        is_default_location: data_dir == resolver.default_data_dir(),
        db_exists: db.is_file(),
        db_size_bytes,
        document_count,
        documents_size_bytes,
    })
}

/// Recursive (file count, byte total) of a directory; (0, 0) when absent.
fn dir_stats(dir: &Path) -> CoreResult<(u64, u64)> {
    let mut files = Vec::new();
    if dir.is_dir() {
        walk_files(dir, &mut files)?;
    }
    let mut bytes = 0u64;
    for file in &files {
        bytes += fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    }
    Ok((files.len() as u64, bytes))
}

/// Regular files under `dir`, recursively. Symlinks are skipped — the store
/// is written by SlipScan itself and never contains them; following one out
/// of the folder during a move would copy (and later delete) foreign data.
fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) -> CoreResult<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            walk_files(&entry.path(), out)?;
        } else if file_type.is_file() {
            out.push(entry.path());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

/// Phase of a data-folder move, for progress display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MoveStep {
    Validate,
    CopyDatabase,
    CopyDocuments,
    VerifyCopy,
    SwapPointer,
    RemoveOld,
}

/// Progress event handed to the move's callback.
#[derive(Debug)]
pub struct MoveProgress {
    pub step: MoveStep,
    /// Files completed within the step (documents copy only).
    pub done: u64,
    /// Total files within the step (documents copy only; 0 = not counted).
    pub total: u64,
}

/// Outcome of a completed move.
#[derive(Debug, Serialize)]
pub struct MoveReport {
    pub from: String,
    pub to: String,
    pub files_copied: u64,
    pub bytes_copied: u64,
    /// Stored absolute `documents.file_path` values that pointed inside the
    /// old folder's `documents/` store and were rewritten to the new one.
    /// (Files referenced in place — even inside the old folder but outside
    /// the store — are neither copied nor deleted, so their paths stay.)
    pub documents_rewritten: u64,
    /// Whether the old copy was removed. The move as a whole still succeeded
    /// when this is `false` — the pointer already switched.
    pub old_removed: bool,
    pub old_remove_error: Option<String>,
}

/// Everything copied, verified, and checked — but the pointer not yet
/// swapped. Until [`commit_move`] verifies the pointer swap, the old
/// location keeps winning.
struct PreparedCopy {
    from: PathBuf,
    target: PathBuf,
    partial_db: PathBuf,
    files_copied: u64,
    bytes_copied: u64,
    documents_rewritten: u64,
    /// Exclusive-mode connection on the source database, held from the WAL
    /// checkpoint until the pointer swap is verified: while it lives, no
    /// other connection in any process can read or write the source, so no
    /// committed transaction can land behind the copy's back.
    source_lock: rusqlite::Connection,
}

/// On-disk journal of a move's commit window (final rename → old-copy
/// removal), kept next to the pointer file. A crash inside that window
/// leaves a database at the target's final name while the pointer still
/// names the old folder; the checksum lets the re-run prove that database is
/// its own copy and resume, instead of refusing it as someone else's books.
#[derive(Debug, Serialize, Deserialize)]
struct MoveJournal {
    version: u32,
    from: String,
    to: String,
    /// Lowercase hex SHA-256 of the copied database at final-rename time.
    db_sha256: String,
}

const MOVE_JOURNAL_VERSION: u32 = 1;

fn move_journal_path(resolver: &DataDirResolver) -> PathBuf {
    resolver.config_dir.join(MOVE_JOURNAL_FILE_NAME)
}

/// A missing or malformed journal reads as absent — absence is the safe
/// direction (a database found at the target is then refused, never
/// silently overwritten).
fn read_move_journal(resolver: &DataDirResolver) -> Option<MoveJournal> {
    let raw = fs::read_to_string(move_journal_path(resolver)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_move_journal(resolver: &DataDirResolver, journal: &MoveJournal) -> CoreResult<()> {
    fs::create_dir_all(&resolver.config_dir)?;
    let mut file = fs::File::create(move_journal_path(resolver))?;
    file.write_all(serde_json::to_string_pretty(journal)?.as_bytes())?;
    // The journal must be on disk before the rename it vouches for happens.
    file.sync_all()?;
    fsync_dir(&resolver.config_dir)?;
    Ok(())
}

/// Whether the commit journal proves the database at `target_db` is our own
/// copy from an interrupted `from` → `target` move. Strict on every field:
/// anything short of a full match — no journal, different endpoints, or a
/// checksum mismatch — means the database is treated as someone else's books.
fn journal_matches(
    resolver: &DataDirResolver,
    from: &Path,
    target: &Path,
    target_db: &Path,
) -> bool {
    let Some(journal) = read_move_journal(resolver) else {
        return false;
    };
    journal.from == from.display().to_string()
        && journal.to == target.display().to_string()
        && sha256_file(target_db).ok().map(|h| hex_lower(&h)) == Some(journal.db_sha256)
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Move the data folder to `target` per the contract: copy + per-file
/// checksum verify, open/migrate + integrity check on the copy, atomic
/// pointer swap, then remove the old copy. Any open service on this folder
/// must be flagged read-only first ([`crate::CoreService::set_read_only`])
/// and reopened at the new location afterwards.
pub fn move_data_dir(
    resolver: &DataDirResolver,
    target: &Path,
    on_progress: &mut dyn FnMut(&MoveProgress),
) -> CoreResult<MoveReport> {
    let prepared = prepare_copy(resolver, target, on_progress)?;
    commit_move(resolver, prepared, on_progress)
}

fn step(on_progress: &mut dyn FnMut(&MoveProgress), step: MoveStep, done: u64, total: u64) {
    on_progress(&MoveProgress { step, done, total });
}

/// Validate the target and produce a verified copy there. Aborting after this
/// (before [`commit_move`]) leaves the old folder fully active.
fn prepare_copy(
    resolver: &DataDirResolver,
    target: &Path,
    on_progress: &mut dyn FnMut(&MoveProgress),
) -> CoreResult<PreparedCopy> {
    step(on_progress, MoveStep::Validate, 0, 0);
    let from = resolver.resolve()?;
    let from_db = db_path(&from);
    if !from_db.is_file() {
        return Err(CoreError::DataMove(format!(
            "no database at {} — nothing to move",
            from_db.display()
        )));
    }

    fs::create_dir_all(target)?;
    // Canonicalized forms make the containment check honest across symlinks
    // and `..` segments.
    let from_canon = fs::canonicalize(&from)?;
    let target = fs::canonicalize(target)?;
    if target == from_canon {
        return Err(CoreError::DataMove(
            "the target is the current data folder".into(),
        ));
    }
    if target.starts_with(&from_canon) {
        return Err(CoreError::DataMove(format!(
            "the target {} is inside the current data folder {} — the old copy could not be \
             removed safely; pick a folder outside it",
            target.display(),
            from_canon.display()
        )));
    }
    // Writability probe: creating the directory can succeed on a read-only
    // mount where writing a file does not.
    let probe = target.join(format!(".slipscan-write-probe-{}", new_id()));
    fs::write(&probe, b"probe")
        .and_then(|()| fs::remove_file(&probe))
        .map_err(|e| {
            CoreError::DataMove(format!(
                "the target {} is not writable: {e}",
                target.display()
            ))
        })?;
    // A database already at the final name is either someone's books —
    // distinct error so callers can offer "open that instead" — or our own
    // copy from a move that crashed between its final rename and the pointer
    // swap; the commit journal's checksum proves which (see `begin_commit`).
    let target_db = db_path(&target);
    if target_db.exists() {
        if journal_matches(resolver, &from, &target, &target_db) {
            // Our own half-committed copy. The source folder is still
            // authoritative (the pointer never swapped) and may have changed
            // since, so resume with a fresh copy rather than trusting the
            // stale one.
            for suffix in ["", "-wal", "-shm"] {
                let file = PathBuf::from(format!("{}{suffix}", target_db.display()));
                if file.exists() {
                    fs::remove_file(&file)?;
                }
            }
        } else {
            return Err(CoreError::DataMoveTargetHasDatabase {
                path: target_db.display().to_string(),
            });
        }
    }

    // Quiesce AND lock the source until the pointer has swapped — the
    // cross-process teeth behind "while a move is in progress the app is
    // read-only". Refused while anything else has the database open.
    let source_lock = lock_and_quiesce_source(&from_db)?;

    // Copy the database under a partial name — the foreign-db refusal above
    // is on the final name only, so an aborted run resumes by overwriting.
    step(on_progress, MoveStep::CopyDatabase, 0, 0);
    let partial_db = target.join(format!("{DB_FILE_NAME}.partial"));
    let mut bytes_copied = copy_file_verified(&from_db, &partial_db)?;
    let mut files_copied = 1u64;

    // Documents store, file by file, each checksum-verified.
    let src_docs = documents_dir(&from);
    let mut doc_files = Vec::new();
    if src_docs.is_dir() {
        walk_files(&src_docs, &mut doc_files)?;
    }
    let total = doc_files.len() as u64;
    step(on_progress, MoveStep::CopyDocuments, 0, total);
    let dst_docs = documents_dir(&target);
    fs::create_dir_all(&dst_docs)?;
    for (i, file) in doc_files.iter().enumerate() {
        let rel = file
            .strip_prefix(&src_docs)
            .map_err(|_| CoreError::DataMove("walked file escaped the documents dir".into()))?;
        bytes_copied += copy_file_verified(file, &dst_docs.join(rel))?;
        files_copied += 1;
        step(on_progress, MoveStep::CopyDocuments, i as u64 + 1, total);
    }

    step(on_progress, MoveStep::VerifyCopy, 0, 0);
    let documents_rewritten = check_and_localize_copy(
        &partial_db,
        &from,
        &[documents_dir(&from), documents_dir(&from_canon)],
        &target,
    )?;

    Ok(PreparedCopy {
        from,
        target,
        partial_db,
        files_copied,
        bytes_copied,
        documents_rewritten,
        source_lock,
    })
}

/// Take SQLite's own exclusive lock on the source database and fold the WAL
/// into the main file so a plain file copy is complete.
///
/// Exclusive locking mode is what makes the read-only-during-move rail
/// airtight across processes: acquiring it fails while **any** other
/// connection anywhere (a desktop window, `slipscan serve`, a mail-sync
/// watch — even idle) has the database open, and while the returned
/// connection lives every other open/read/write attempt gets `SQLITE_BUSY`.
/// Committed transactions therefore can neither hide in a WAL the copy
/// skips nor land behind its back.
fn lock_and_quiesce_source(db: &Path) -> CoreResult<rusqlite::Connection> {
    let conn = rusqlite::Connection::open(db)?;
    let _mode: String = conn.query_row("PRAGMA locking_mode = exclusive", [], |row| row.get(0))?;
    let busy_refusal = || {
        CoreError::DataMove(format!(
            "the database at {} is open in another SlipScan process (a desktop window, \
             `slipscan serve`, or another command) — close it and retry; copying while it \
             is open could silently lose its latest transactions",
            db.display()
        ))
    };
    // TRUNCATE both backfills every committed transaction into the main file
    // and empties the WAL. It errors (or reports busy) when another
    // connection holds the database — in which case the main file alone
    // would be missing committed data and the move must not proceed.
    let busy: i64 = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(f, _)
                if matches!(
                    f.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                ) =>
            {
                busy_refusal()
            }
            other => CoreError::from(other),
        })?;
    if busy != 0 {
        return Err(busy_refusal());
    }
    Ok(conn)
}

/// Open + migrate + integrity-check the copied database, rewrite stored
/// absolute document paths from the old `documents/` store to the new one,
/// and record the move in the copy's append-only audit log (the copy is the
/// database that survives). Returns the number of rewritten document paths.
fn check_and_localize_copy(
    partial_db: &Path,
    from: &Path,
    old_docs: &[PathBuf],
    new_base: &Path,
) -> CoreResult<u64> {
    // `Db::open` is the open+migrate check demanded by the contract.
    let db = Db::open(partial_db)?;
    let conn = db.conn();
    if db.applied_migrations()?.is_empty() {
        return Err(CoreError::DataMove(
            "the copied database has no schema — copy is not a SlipScan database".into(),
        ));
    }
    let verdict: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if verdict != "ok" {
        return Err(CoreError::DataMove(format!(
            "integrity check failed on the copy: {verdict}"
        )));
    }

    // Documents imported into the store carry absolute paths under the old
    // folder's `documents/` directory; re-point them at the new store —
    // those are exactly (and only) the files the move copies. Everything
    // else — a CLI import that references a file in place, even one that
    // happens to sit inside the old data folder, or a `--db` run's sibling
    // `slipscan-documents` store — is neither copied nor deleted by the
    // move, so its stored path must keep naming the original file.
    let mut rewritten = 0u64;
    let new_docs = documents_dir(new_base);
    let rows: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, file_path FROM documents")?;
        let mapped = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        mapped.collect::<Result<_, _>>()?
    };
    for (id, file_path) in rows {
        let path = Path::new(&file_path);
        let Some(rel) = old_docs
            .iter()
            .find_map(|base| path.strip_prefix(base).ok())
        else {
            continue;
        };
        conn.execute(
            "UPDATE documents SET file_path = ?1 WHERE id = ?2",
            rusqlite::params![new_docs.join(rel).display().to_string(), id],
        )?;
        rewritten += 1;
    }

    // Every mutation lands in the audit log — including this one, in the
    // database that will be current after the swap.
    repo::audit::insert(
        conn,
        &AuditEntry {
            id: new_id(),
            book_id: None,
            entity_type: "data_dir".to_string(),
            entity_id: None,
            action: "move".to_string(),
            before_json: Some(serde_json::to_string(&serde_json::json!({
                "data_dir": from.display().to_string(),
            }))?),
            after_json: Some(serde_json::to_string(&serde_json::json!({
                "data_dir": new_base.display().to_string(),
                "documents_rewritten": rewritten,
            }))?),
            created_at: now_iso(),
        },
    )?;
    Ok(rewritten)
}

/// The commit window's first half: journal it, then give the verified copy
/// its final database name (durably). Split from [`commit_move`] so tests
/// can simulate a crash between the rename and the pointer swap.
fn begin_commit(resolver: &DataDirResolver, prepared: &PreparedCopy) -> CoreResult<()> {
    // Journal before the rename: if we die between it and the pointer swap,
    // the next run finds a database at the final name while the pointer
    // still names the old folder — the journal's checksum lets it prove
    // that database is this very copy and resume (see `prepare_copy`).
    write_move_journal(
        resolver,
        &MoveJournal {
            version: MOVE_JOURNAL_VERSION,
            from: prepared.from.display().to_string(),
            to: prepared.target.display().to_string(),
            db_sha256: hex_lower(&sha256_file(&prepared.partial_db)?),
        },
    )?;
    fs::rename(&prepared.partial_db, db_path(&prepared.target))?;
    // Durable before the old copy can be deleted: a power cut must not be
    // able to resurrect the partial name once the old database is gone.
    fsync_dir(&prepared.target)?;
    Ok(())
}

/// Finalize the copy, swap the pointer, verify the swap by reading it back,
/// and only then remove the old copy. Old data is never touched before the
/// read-back confirms the new folder won.
fn commit_move(
    resolver: &DataDirResolver,
    prepared: PreparedCopy,
    on_progress: &mut dyn FnMut(&MoveProgress),
) -> CoreResult<MoveReport> {
    begin_commit(resolver, &prepared)?;

    step(on_progress, MoveStep::SwapPointer, 0, 0);
    resolver.write_pointer(&prepared.target)?;
    // Read-back verification: deletion below only happens once resolution
    // provably lands on the new folder.
    let resolved = resolver.resolve()?;
    if resolved != prepared.target {
        return Err(CoreError::DataMove(format!(
            "pointer read-back resolved {} instead of {} — the old folder stays active and \
             nothing was deleted",
            resolved.display(),
            prepared.target.display()
        )));
    }

    // The exclusive source lock deliberately outlived the swap: nothing can
    // have committed to the old database since the WAL checkpoint. Release
    // it only now — a connection's open files cannot be deleted on Windows.
    drop(prepared.source_lock);

    step(on_progress, MoveStep::RemoveOld, 0, 0);
    let mut old_remove_error: Option<String> = None;
    let from_db = db_path(&prepared.from);
    for suffix in ["", "-wal", "-shm"] {
        let file = PathBuf::from(format!("{}{suffix}", from_db.display()));
        if file.exists() {
            if let Err(e) = fs::remove_file(&file) {
                old_remove_error = Some(format!("{}: {e}", file.display()));
            }
        }
    }
    let old_docs = documents_dir(&prepared.from);
    if old_docs.is_dir() {
        if let Err(e) = fs::remove_dir_all(&old_docs) {
            old_remove_error = Some(format!("{}: {e}", old_docs.display()));
        }
    }

    // Commit window over. Best-effort: a lingering journal is inert (it only
    // ever matches this exact from→to copy, whose move just completed).
    let _ = fs::remove_file(move_journal_path(resolver));

    Ok(MoveReport {
        from: prepared.from.display().to_string(),
        to: prepared.target.display().to_string(),
        files_copied: prepared.files_copied,
        bytes_copied: prepared.bytes_copied,
        documents_rewritten: prepared.documents_rewritten,
        old_removed: old_remove_error.is_none(),
        old_remove_error,
    })
}

/// Copy `src` to `dst` and verify the copy byte-for-byte via SHA-256; a
/// mismatch removes the bad copy and errors. The copy is fsynced so it is
/// durable before the pointer ever swaps.
fn copy_file_verified(src: &Path, dst: &Path) -> CoreResult<u64> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = fs::copy(src, dst)?;
    let src_hash = sha256_file(src)?;
    let dst_hash = sha256_file(dst)?;
    if src_hash != dst_hash {
        let _ = fs::remove_file(dst);
        return Err(CoreError::DataMove(format!(
            "checksum mismatch copying {} — is something still writing to the data folder?",
            src.display()
        )));
    }
    // Write-mode open: fsync needs write access on some platforms (Windows).
    fs::OpenOptions::new().write(true).open(dst)?.sync_all()?;
    Ok(bytes)
}

fn sha256_file(path: &Path) -> CoreResult<[u8; 32]> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{BookKind, DocumentKind, DocumentSource, NewBook, NewDocument};
    use crate::secrets::MemorySecretStore;
    use crate::CoreService;

    fn resolver_in(root: &Path) -> DataDirResolver {
        DataDirResolver::new(root.join("config"), root.join("data"))
    }

    fn no_progress() -> impl FnMut(&MoveProgress) {
        |_: &MoveProgress| {}
    }

    /// A populated data folder at the resolver's current location: one book,
    /// one document row pointing into the documents store, two store files.
    fn seed_data_dir(resolver: &DataDirResolver) -> (PathBuf, String) {
        let dir = resolver.resolve().unwrap();
        let docs = documents_dir(&dir);
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("slip-1.jpg"), b"jpeg bytes one").unwrap();
        fs::create_dir_all(docs.join("2026")).unwrap();
        fs::write(docs.join("2026").join("slip-2.pdf"), b"pdf bytes two").unwrap();

        let svc = CoreService::new(
            Db::open(db_path(&dir)).unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let book = svc
            .book_create(NewBook {
                name: "Movable".into(),
                kind: BookKind::Personal,
                currency: Some("EUR".into()),
                country: None,
                region: None,
            })
            .unwrap();
        svc.document_import(NewDocument {
            book_id: book.id.clone(),
            source: DocumentSource::Upload,
            kind: DocumentKind::Slip,
            file_path: docs.join("slip-1.jpg").display().to_string(),
            mime_type: Some("image/jpeg".into()),
            size_bytes: Some(14),
            original_name: Some("slip-1.jpg".into()),
            sha256: Some("aa".into()),
        })
        .unwrap();
        (dir, book.id)
    }

    #[test]
    fn resolver_defaults_then_pointer_override() {
        let tmp = tempfile::tempdir().unwrap();
        let resolver = resolver_in(tmp.path());

        // No pointer: the platform default wins.
        assert_eq!(resolver.pointer_target().unwrap(), None);
        assert_eq!(resolver.resolve().unwrap(), tmp.path().join("data"));

        // Pointer set: it wins; the file lives in the fixed config dir.
        let elsewhere = tmp.path().join("elsewhere");
        resolver.write_pointer(&elsewhere).unwrap();
        assert_eq!(resolver.resolve().unwrap(), elsewhere);
        assert_eq!(
            resolver.pointer_path(),
            tmp.path().join("config").join(POINTER_FILE_NAME)
        );
        assert!(resolver.pointer_path().is_file());

        // Relative targets are rejected outright.
        let err = resolver
            .write_pointer(Path::new("relative/dir"))
            .unwrap_err();
        assert!(matches!(err, CoreError::DataDir(_)), "{err}");

        // A malformed pointer errors loudly instead of silently forking data.
        fs::write(resolver.pointer_path(), b"{not json").unwrap();
        let err = resolver.resolve().unwrap_err();
        assert!(matches!(err, CoreError::DataDir(_)), "{err}");
    }

    #[test]
    fn status_reports_location_pointer_and_sizes() {
        let tmp = tempfile::tempdir().unwrap();
        let resolver = resolver_in(tmp.path());

        // Fresh install: default location, nothing on disk yet.
        let fresh = status(&resolver).unwrap();
        assert!(fresh.is_default_location);
        assert!(!fresh.pointer_set);
        assert!(!fresh.db_exists);
        assert_eq!(fresh.document_count, 0);

        let (dir, _) = seed_data_dir(&resolver);
        let seeded = status(&resolver).unwrap();
        assert_eq!(seeded.data_dir, dir.display().to_string());
        assert!(seeded.db_exists);
        assert!(seeded.db_size_bytes > 0);
        assert_eq!(seeded.document_count, 2);
        assert_eq!(
            seeded.documents_size_bytes,
            b"jpeg bytes one".len() as u64 + b"pdf bytes two".len() as u64
        );
    }

    #[test]
    fn move_roundtrip_verifies_reopens_and_rewrites_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let resolver = resolver_in(tmp.path());
        let (old_dir, book_id) = seed_data_dir(&resolver);
        let target = tmp.path().join("synced").join("slipscan");

        let mut steps = Vec::new();
        let report = move_data_dir(&resolver, &target, &mut |p| steps.push(p.step)).unwrap();

        // Every phase ran, in order.
        for expected in [
            MoveStep::Validate,
            MoveStep::CopyDatabase,
            MoveStep::CopyDocuments,
            MoveStep::VerifyCopy,
            MoveStep::SwapPointer,
            MoveStep::RemoveOld,
        ] {
            assert!(steps.contains(&expected), "missing step {expected:?}");
        }
        assert_eq!(report.files_copied, 3, "db + 2 store files");
        assert_eq!(report.documents_rewritten, 1);
        assert!(report.old_removed, "{:?}", report.old_remove_error);

        // The resolver — the single source of truth — now names the target.
        let target = fs::canonicalize(&target).unwrap();
        assert_eq!(resolver.resolve().unwrap(), target);

        // The database reopens at the new location with the same data, and
        // the stored document path now lives under the new folder.
        let svc = CoreService::new(
            Db::open(db_path(&target)).unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let book = svc.book_get(&book_id).unwrap();
        assert_eq!(book.name, "Movable");
        let doc = svc.document_list(&book_id, None).unwrap().remove(0);
        assert!(
            Path::new(&doc.file_path).starts_with(&target),
            "path {} not under {}",
            doc.file_path,
            target.display()
        );
        assert!(Path::new(&doc.file_path).is_file());

        // Store files arrived byte-identical; old copies are gone.
        assert_eq!(
            fs::read(documents_dir(&target).join("2026").join("slip-2.pdf")).unwrap(),
            b"pdf bytes two"
        );
        assert!(!db_path(&old_dir).exists());
        assert!(!documents_dir(&old_dir).exists());

        // The move itself is in the surviving audit log.
        let audit = svc.audit_list(None, 50).unwrap();
        assert!(audit
            .iter()
            .any(|e| e.entity_type == "data_dir" && e.action == "move"));
    }

    #[test]
    fn move_refuses_nested_target_existing_db_and_unwritable() {
        let tmp = tempfile::tempdir().unwrap();
        let resolver = resolver_in(tmp.path());
        let (old_dir, _) = seed_data_dir(&resolver);

        // Inside the current folder.
        let err = move_data_dir(&resolver, &old_dir.join("sub"), &mut no_progress()).unwrap_err();
        assert!(matches!(err, CoreError::DataMove(_)), "{err}");
        // The current folder itself.
        let err = move_data_dir(&resolver, &old_dir, &mut no_progress()).unwrap_err();
        assert!(matches!(err, CoreError::DataMove(_)), "{err}");

        // A target that already holds a SlipScan database: the distinct
        // offer-open error, and the foreign database is left untouched.
        let occupied = tmp.path().join("occupied");
        fs::create_dir_all(&occupied).unwrap();
        fs::write(db_path(&occupied), b"someone else's books").unwrap();
        let err = move_data_dir(&resolver, &occupied, &mut no_progress()).unwrap_err();
        assert!(
            matches!(err, CoreError::DataMoveTargetHasDatabase { .. }),
            "{err}"
        );
        assert_eq!(
            fs::read(db_path(&occupied)).unwrap(),
            b"someone else's books"
        );

        // An unwritable target (unix permissions).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let frozen = tmp.path().join("frozen");
            fs::create_dir_all(&frozen).unwrap();
            fs::set_permissions(&frozen, fs::Permissions::from_mode(0o555)).unwrap();
            let err = move_data_dir(&resolver, &frozen, &mut no_progress()).unwrap_err();
            assert!(matches!(err, CoreError::DataMove(_)), "{err}");
            fs::set_permissions(&frozen, fs::Permissions::from_mode(0o755)).unwrap();
        }

        // None of the refusals moved the pointer.
        assert_eq!(resolver.resolve().unwrap(), old_dir);
    }

    /// Simulated failure between copy and pointer swap: the copy exists at
    /// the target, but resolution still lands on the old folder with all its
    /// data — and a re-run of the full move completes (resumable).
    #[test]
    fn old_location_wins_until_the_pointer_swap() {
        let tmp = tempfile::tempdir().unwrap();
        let resolver = resolver_in(tmp.path());
        let (old_dir, book_id) = seed_data_dir(&resolver);
        let target = tmp.path().join("target");

        // Run everything up to (but not including) the swap, then "crash".
        let prepared = prepare_copy(&resolver, &target, &mut no_progress()).unwrap();
        assert!(prepared.partial_db.is_file(), "partial copy exists");
        drop(prepared);

        // Old location still wins; the old data is fully intact.
        assert_eq!(resolver.resolve().unwrap(), old_dir);
        assert!(db_path(&old_dir).is_file());
        let svc = CoreService::new(
            Db::open(db_path(&old_dir)).unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        svc.book_get(&book_id).unwrap();
        drop(svc);

        // Re-running resumes over the partial copy and completes.
        let report = move_data_dir(&resolver, &target, &mut no_progress()).unwrap();
        assert!(report.old_removed);
        assert_eq!(
            resolver.resolve().unwrap(),
            fs::canonicalize(&target).unwrap()
        );
    }

    /// Regression (silent WAL loss): the move used to ignore the checkpoint's
    /// busy flag, so with any other connection open the copy silently missed
    /// committed transactions — and the old copy (with the only complete
    /// data) was then deleted. The move must refuse while ANY other
    /// connection has the source database open, and, once it can run, carry
    /// every committed transaction.
    #[test]
    fn move_refuses_while_any_other_connection_is_open() {
        let tmp = tempfile::tempdir().unwrap();
        let resolver = resolver_in(tmp.path());
        let (old_dir, _) = seed_data_dir(&resolver);
        let target = tmp.path().join("target");

        // Another surface (desktop window, server, mail-sync watch) with the
        // database open — idle is enough to make a WAL copy unfaithful.
        let other = rusqlite::Connection::open(db_path(&old_dir)).unwrap();
        let books: i64 = other
            .query_row("SELECT count(*) FROM books", [], |row| row.get(0))
            .unwrap();
        assert_eq!(books, 1);

        let err = move_data_dir(&resolver, &target, &mut no_progress()).unwrap_err();
        assert!(matches!(err, CoreError::DataMove(_)), "{err}");
        assert!(
            err.to_string().contains("another SlipScan process"),
            "{err}"
        );

        // Refused cleanly: pointer unchanged, nothing deleted.
        assert_eq!(resolver.resolve().unwrap(), old_dir);
        assert!(db_path(&old_dir).is_file());
        drop(other);

        // A transaction committed just before the move (the WAL-resident kind
        // the ignored checkpoint used to drop) survives the move.
        let svc = CoreService::new(
            Db::open(db_path(&old_dir)).unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        svc.book_create(NewBook {
            name: "Second".into(),
            kind: BookKind::Personal,
            currency: Some("EUR".into()),
            country: None,
            region: None,
        })
        .unwrap();
        drop(svc);

        move_data_dir(&resolver, &target, &mut no_progress()).unwrap();
        let svc = CoreService::new(
            Db::open(db_path(&fs::canonicalize(&target).unwrap())).unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        assert_eq!(svc.book_list().unwrap().len(), 2, "no committed book lost");
    }

    /// Regression (dangling paths): every stored path under the old folder
    /// used to be rewritten, but only the `documents/` store is copied — a
    /// file referenced in place inside the data folder (plain `slipscan
    /// import`, or a `--db` run's sibling `slipscan-documents` store) ended
    /// up pointing at a file that does not exist at the new location. Only
    /// store paths are rewritten now; in-place files keep their real,
    /// surviving location.
    #[test]
    fn move_rewrites_store_paths_only_and_keeps_in_place_files_reachable() {
        let tmp = tempfile::tempdir().unwrap();
        let resolver = resolver_in(tmp.path());
        let (old_dir, book_id) = seed_data_dir(&resolver);

        let loose = old_dir.join("receipt.jpg");
        fs::write(&loose, b"loose receipt bytes").unwrap();
        let sibling = old_dir.join("slipscan-documents").join("statement.pdf");
        fs::create_dir_all(sibling.parent().unwrap()).unwrap();
        fs::write(&sibling, b"sibling store bytes").unwrap();
        {
            let svc = CoreService::new(
                Db::open(db_path(&old_dir)).unwrap(),
                Box::new(MemorySecretStore::new()),
            );
            for (path, sha) in [(&loose, "bb"), (&sibling, "cc")] {
                svc.document_import(NewDocument {
                    book_id: book_id.clone(),
                    source: DocumentSource::Import,
                    kind: DocumentKind::Slip,
                    file_path: path.display().to_string(),
                    mime_type: None,
                    size_bytes: None,
                    original_name: None,
                    sha256: Some(sha.into()),
                })
                .unwrap();
            }
        }

        let target = tmp.path().join("target");
        let report = move_data_dir(&resolver, &target, &mut no_progress()).unwrap();
        assert_eq!(report.documents_rewritten, 1, "only the store path");
        let target = fs::canonicalize(&target).unwrap();

        let svc = CoreService::new(
            Db::open(db_path(&target)).unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let docs = svc.document_list(&book_id, None).unwrap();
        assert_eq!(docs.len(), 3);
        // Every stored path names a file that actually exists after the move.
        for doc in &docs {
            assert!(
                Path::new(&doc.file_path).is_file(),
                "dangling path {}",
                doc.file_path
            );
        }
        // The store file was re-pointed; the in-place ones were not — and
        // the move deleted neither of them.
        assert!(docs
            .iter()
            .any(|d| Path::new(&d.file_path).starts_with(documents_dir(&target))));
        assert!(docs
            .iter()
            .any(|d| d.file_path == loose.display().to_string()));
        assert!(docs
            .iter()
            .any(|d| d.file_path == sibling.display().to_string()));
        assert!(loose.is_file());
        assert!(sibling.is_file());
    }

    /// Regression (broken resume): a crash between the copy's final rename
    /// and the pointer swap used to make the re-run refuse the user's own
    /// half-moved copy as "someone else's books". The commit journal's
    /// checksum now proves it is ours and the re-run resumes — while a
    /// database the journal does NOT vouch for is still refused.
    #[test]
    fn interrupted_commit_window_resumes_instead_of_refusing() {
        let tmp = tempfile::tempdir().unwrap();
        let resolver = resolver_in(tmp.path());
        let (old_dir, book_id) = seed_data_dir(&resolver);
        let target = tmp.path().join("target");

        // Run the move up to the crash point: copy verified, journal
        // written, database at its FINAL name — pointer never swapped.
        let prepared = prepare_copy(&resolver, &target, &mut no_progress()).unwrap();
        begin_commit(&resolver, &prepared).unwrap();
        drop(prepared); // the crash — releases the exclusive source lock
        let target_canon = fs::canonicalize(&target).unwrap();
        assert!(db_path(&target_canon).is_file(), "final name reached");
        assert_eq!(resolver.resolve().unwrap(), old_dir, "old folder active");

        // The old folder stayed authoritative and keeps changing.
        {
            let svc = CoreService::new(
                Db::open(db_path(&old_dir)).unwrap(),
                Box::new(MemorySecretStore::new()),
            );
            svc.book_create(NewBook {
                name: "After the crash".into(),
                kind: BookKind::Personal,
                currency: Some("EUR".into()),
                country: None,
                region: None,
            })
            .unwrap();
        }

        // The re-run recognises its own copy through the journal, redoes the
        // copy fresh (post-crash data included), and completes.
        let report = move_data_dir(&resolver, &target, &mut no_progress()).unwrap();
        assert!(report.old_removed, "{:?}", report.old_remove_error);
        assert_eq!(resolver.resolve().unwrap(), target_canon);
        {
            let svc = CoreService::new(
                Db::open(db_path(&target_canon)).unwrap(),
                Box::new(MemorySecretStore::new()),
            );
            assert_eq!(svc.book_list().unwrap().len(), 2, "post-crash data moved");
            svc.book_get(&book_id).unwrap();
        }
        assert!(!db_path(&old_dir).exists());
        assert!(
            !move_journal_path(&resolver).exists(),
            "journal cleared after a completed move"
        );

        // Strictness: crash again moving onward, then let the target
        // database change out from under the journal — the checksum no
        // longer vouches for it, so it is refused as someone else's books.
        let target2 = tmp.path().join("target2");
        let prepared = prepare_copy(&resolver, &target2, &mut no_progress()).unwrap();
        begin_commit(&resolver, &prepared).unwrap();
        drop(prepared);
        let target2_db = db_path(&fs::canonicalize(&target2).unwrap());
        let mut tampered = fs::read(&target2_db).unwrap();
        tampered.extend_from_slice(b"someone else's trailing bytes");
        fs::write(&target2_db, tampered).unwrap();
        let err = move_data_dir(&resolver, &target2, &mut no_progress()).unwrap_err();
        assert!(
            matches!(err, CoreError::DataMoveTargetHasDatabase { .. }),
            "{err}"
        );
        assert_eq!(resolver.resolve().unwrap(), target_canon, "nothing swapped");
    }

    #[test]
    fn read_only_guard_blocks_mutations_until_lifted() {
        let svc = CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let new_book = || NewBook {
            name: "Guarded".into(),
            kind: BookKind::Personal,
            currency: Some("EUR".into()),
            country: None,
            region: None,
        };
        assert!(!svc.is_read_only());
        svc.set_read_only(true).unwrap();
        assert!(svc.is_read_only());
        // SQLite itself refuses the write — no mutation path can slip by.
        assert!(svc.book_create(new_book()).is_err());
        svc.set_read_only(false).unwrap();
        assert!(!svc.is_read_only());
        svc.book_create(new_book()).unwrap();
    }
}
