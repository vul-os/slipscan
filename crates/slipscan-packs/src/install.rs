//! Installation and upgrade of verified packs into a book.
//!
//! The installer only accepts a [`VerifiedPack`] — there is no path from
//! unverified bytes to installed state. On top of the signature it enforces:
//!
//! * **trust** — external packs must be signed by a key in the TOFU store;
//! * **pinning** — a pack id stays bound to its first signer forever;
//! * **versioning** — same version is a no-op error, downgrades are rejected,
//!   upgrades re-map cleanly without touching user data.
//!
//! Taxonomy installs map pack category keys onto local category ids and
//! remember the mapping (`pack_category_map`), so upgrades and user renames
//! are safe: an existing mapped category is never overwritten. Rules land in
//! `pack_rules` (consumed by [`crate::engine`]); exact merchant rules are
//! additionally seeded into core's `merchant_mappings` with `source = 'pack'`,
//! never clobbering a user's own mapping — corrections always win.
//!
//! Benchmark packs install as stored payloads only (stats are read back via
//! [`Installer::benchmark_sets`]); they touch no categories and no rules.
//!
//! Every install/upgrade/uninstall is recorded in core's append-only audit
//! log. Uninstalling removes the pack's rules; categories already created are
//! kept (now local) so history never breaks.

use std::collections::BTreeMap;
use std::str::FromStr;

use rusqlite::{params, Connection, OptionalExtension};

use slipscan_core::domain::{AuditEntry, Category, CategoryKind, MappingSource};
use slipscan_core::repo;
use slipscan_core::util::{new_id, normalize_merchant, now_iso};

use crate::error::{PackError, PackResult};
use crate::model::{BenchmarkSet, MatchKind, PackKind, PackPayload, Semver};
use crate::trust;
use crate::verify::{Provenance, VerifiedPack};

pub(crate) const INSTALL_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS pack_installs (
    book_id      TEXT NOT NULL,
    pack_id      TEXT NOT NULL,
    name         TEXT NOT NULL,
    version      TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('taxonomy', 'benchmark')),
    signer       TEXT NOT NULL,
    payload_json BLOB NOT NULL,
    installed_at TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (book_id, pack_id)
);
CREATE TABLE IF NOT EXISTS pack_category_map (
    book_id      TEXT NOT NULL,
    pack_id      TEXT NOT NULL,
    category_key TEXT NOT NULL,
    category_id  TEXT NOT NULL,
    PRIMARY KEY (book_id, pack_id, category_key)
);
CREATE TABLE IF NOT EXISTS pack_rules (
    id          TEXT PRIMARY KEY,
    book_id     TEXT NOT NULL,
    pack_id     TEXT NOT NULL,
    rule_kind   TEXT NOT NULL CHECK (rule_kind IN ('exact', 'contains', 'regex', 'keyword')),
    pattern     TEXT NOT NULL,
    category_id TEXT NOT NULL,
    confidence  REAL NOT NULL,
    position    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pack_rules_book ON pack_rules (book_id, rule_kind);
";

/// Metadata for one installed pack (never the signer's secret — there is
/// none — and never user data).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledPack {
    pub book_id: String,
    pub pack_id: String,
    pub name: String,
    pub version: String,
    pub kind: PackKind,
    /// Signer identity (hex public key, or a reserved builtin/dev label).
    pub signer: String,
    pub installed_at: String,
    pub updated_at: String,
}

/// What an install did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed,
    Upgraded { from: String },
}

/// Summary returned by [`Installer::install`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallReport {
    pub outcome: InstallOutcome,
    pub pack: InstalledPack,
    pub categories_created: usize,
    pub categories_reused: usize,
    pub rules_installed: usize,
}

/// Pack installer over a book database connection (the same SQLite file
/// slipscan-core manages).
pub struct Installer<'c> {
    conn: &'c Connection,
}

impl<'c> Installer<'c> {
    /// Open the installer, creating the pack tables if needed.
    pub fn open(conn: &'c Connection) -> PackResult<Self> {
        conn.execute_batch(trust::TRUST_SCHEMA)?;
        conn.execute_batch(INSTALL_SCHEMA)?;
        Ok(Self { conn })
    }

    /// Install or upgrade a verified pack into `book_id`.
    pub fn install(&self, book_id: &str, pack: &VerifiedPack) -> PackResult<InstallReport> {
        let payload = pack.payload();
        let offered: Semver = payload.meta.semver()?;

        repo::book::get(self.conn, book_id)?
            .ok_or_else(|| PackError::BookNotFound(book_id.to_string()))?;

        // External packs need a trusted signer; builtin packs are covered by
        // the binary itself; the dev override was an explicit opt-in.
        if pack.provenance() == Provenance::External {
            trust::require_trusted(self.conn, pack.signer())?;
        }

        let tx = self.conn.unchecked_transaction()?;

        // The pack id is bound to its first signer, whoever that was.
        trust::check_and_pin(&tx, &payload.meta.id, pack.signer())?;

        let existing: Option<String> = tx
            .query_row(
                "SELECT version FROM pack_installs WHERE book_id = ?1 AND pack_id = ?2",
                params![book_id, payload.meta.id],
                |row| row.get(0),
            )
            .optional()?;
        let outcome = match &existing {
            None => InstallOutcome::Installed,
            Some(installed) => {
                let installed_v: Semver = installed.parse()?;
                if offered == installed_v {
                    return Err(PackError::AlreadyInstalled {
                        pack_id: payload.meta.id.clone(),
                        version: installed.clone(),
                    });
                }
                if offered < installed_v {
                    return Err(PackError::Downgrade {
                        pack_id: payload.meta.id.clone(),
                        installed: installed.clone(),
                        offered: offered.to_string(),
                    });
                }
                InstallOutcome::Upgraded {
                    from: installed.clone(),
                }
            }
        };

        let now = now_iso();
        let (created, reused, key_to_id) = install_categories(&tx, book_id, payload, &now)?;
        let rules = install_rules(&tx, book_id, payload, &key_to_id, &now)?;

        tx.execute(
            "INSERT INTO pack_installs
                 (book_id, pack_id, name, version, kind, signer, payload_json,
                  installed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT (book_id, pack_id) DO UPDATE SET
                 name = excluded.name,
                 version = excluded.version,
                 kind = excluded.kind,
                 signer = excluded.signer,
                 payload_json = excluded.payload_json,
                 updated_at = excluded.updated_at",
            params![
                book_id,
                payload.meta.id,
                payload.meta.name,
                offered.to_string(),
                payload.kind().as_str(),
                pack.signer(),
                pack.pack().payload_bytes(),
                now,
            ],
        )?;

        let action = match &outcome {
            InstallOutcome::Installed => "pack_install",
            InstallOutcome::Upgraded { .. } => "pack_upgrade",
        };
        audit_pack(
            &tx,
            book_id,
            &payload.meta.id,
            action,
            serde_json::json!({
                "pack_id": payload.meta.id,
                "version": offered.to_string(),
                "kind": payload.kind().as_str(),
                "signer_fingerprint": pack.fingerprint(),
                "categories": payload.categories.len(),
                "merchant_rules": payload.merchant_rules.len(),
                "keyword_rules": payload.keyword_rules.len(),
            }),
        )?;
        tx.commit()?;

        Ok(InstallReport {
            outcome,
            pack: self
                .get(book_id, &payload.meta.id)?
                .expect("pack row just written"),
            categories_created: created,
            categories_reused: reused,
            rules_installed: rules,
        })
    }

    /// Remove an installed pack's rules and registration. Categories the pack
    /// created are kept (now local) so history never breaks; the key→id map
    /// is also kept so a reinstall reuses them instead of duplicating.
    /// Returns whether the pack was installed.
    pub fn uninstall(&self, book_id: &str, pack_id: &str) -> PackResult<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let removed = tx.execute(
            "DELETE FROM pack_installs WHERE book_id = ?1 AND pack_id = ?2",
            params![book_id, pack_id],
        )?;
        if removed == 0 {
            return Ok(false);
        }
        tx.execute(
            "DELETE FROM pack_rules WHERE book_id = ?1 AND pack_id = ?2",
            params![book_id, pack_id],
        )?;
        // Drop pack-seeded merchant mappings that point at this pack's
        // categories. User/llm/rule mappings are untouched.
        tx.execute(
            "DELETE FROM merchant_mappings
             WHERE book_id = ?1 AND source = ?2 AND category_id IN
                 (SELECT category_id FROM pack_category_map
                  WHERE book_id = ?1 AND pack_id = ?3)",
            params![book_id, MappingSource::Pack.as_str(), pack_id],
        )?;
        audit_pack(
            &tx,
            book_id,
            pack_id,
            "pack_uninstall",
            serde_json::json!({ "pack_id": pack_id }),
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Installed packs for a book, by pack id.
    pub fn list(&self, book_id: &str) -> PackResult<Vec<InstalledPack>> {
        let mut stmt = self.conn.prepare(
            "SELECT book_id, pack_id, name, version, kind, signer, installed_at, updated_at
             FROM pack_installs WHERE book_id = ?1 ORDER BY pack_id",
        )?;
        let packs = stmt
            .query_map(params![book_id], map_installed)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(packs)
    }

    /// One installed pack's metadata.
    pub fn get(&self, book_id: &str, pack_id: &str) -> PackResult<Option<InstalledPack>> {
        Ok(self
            .conn
            .query_row(
                "SELECT book_id, pack_id, name, version, kind, signer, installed_at, updated_at
                 FROM pack_installs WHERE book_id = ?1 AND pack_id = ?2",
                params![book_id, pack_id],
                map_installed,
            )
            .optional()?)
    }

    /// Re-parse an installed pack's stored payload.
    pub fn payload(&self, book_id: &str, pack_id: &str) -> PackResult<PackPayload> {
        let bytes: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT payload_json FROM pack_installs WHERE book_id = ?1 AND pack_id = ?2",
                params![book_id, pack_id],
                |row| row.get(0),
            )
            .optional()?;
        let bytes = bytes.ok_or_else(|| PackError::CorruptState {
            pack_id: pack_id.to_string(),
            message: "pack is not installed".into(),
        })?;
        PackPayload::from_json(&bytes).map_err(|e| PackError::CorruptState {
            pack_id: pack_id.to_string(),
            message: e.to_string(),
        })
    }

    /// The pack-key → local-category-id map for one installed pack.
    pub fn category_map(
        &self,
        book_id: &str,
        pack_id: &str,
    ) -> PackResult<BTreeMap<String, String>> {
        category_map(self.conn, book_id, pack_id)
    }

    /// All benchmark sets installed for a book, as `(pack_id, set)` — the
    /// read side of anonymous peer comparison (see [`crate::benchmark`]).
    pub fn benchmark_sets(&self, book_id: &str) -> PackResult<Vec<(String, BenchmarkSet)>> {
        let mut out = Vec::new();
        for pack in self.list(book_id)? {
            if pack.kind != PackKind::Benchmark {
                continue;
            }
            let payload = self.payload(book_id, &pack.pack_id)?;
            let set = payload.benchmarks.ok_or_else(|| PackError::CorruptState {
                pack_id: pack.pack_id.clone(),
                message: "benchmark pack without a benchmark section".into(),
            })?;
            out.push((pack.pack_id, set));
        }
        Ok(out)
    }
}

fn map_installed(row: &rusqlite::Row<'_>) -> rusqlite::Result<InstalledPack> {
    let kind_raw: String = row.get(4)?;
    let kind = PackKind::from_str(&kind_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(InstalledPack {
        book_id: row.get(0)?,
        pack_id: row.get(1)?,
        name: row.get(2)?,
        version: row.get(3)?,
        kind,
        signer: row.get(5)?,
        installed_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn category_map(
    conn: &Connection,
    book_id: &str,
    pack_id: &str,
) -> PackResult<BTreeMap<String, String>> {
    let mut stmt = conn.prepare(
        "SELECT category_key, category_id FROM pack_category_map
         WHERE book_id = ?1 AND pack_id = ?2",
    )?;
    let map = stmt
        .query_map(params![book_id, pack_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    Ok(map)
}

/// Create missing categories (parents first — payload validation guarantees
/// declaration order) and refresh the key→id map. Existing mapped categories
/// are left exactly as the user has them. A same-named sibling that already
/// exists in the book (from another pack or the user) is **adopted** rather
/// than duplicated — packs reusing common names compose onto one tree.
fn install_categories(
    conn: &Connection,
    book_id: &str,
    payload: &PackPayload,
    now: &str,
) -> PackResult<(usize, usize, BTreeMap<String, String>)> {
    let mut map = category_map(conn, book_id, &payload.meta.id)?;
    let (mut created, mut reused) = (0usize, 0usize);

    for spec in &payload.categories {
        let mapped_alive = match map.get(&spec.key) {
            Some(id) => repo::category::get(conn, id)?.is_some(),
            None => false,
        };
        if mapped_alive {
            reused += 1;
            continue;
        }
        let parent_id = match &spec.parent_key {
            Some(parent_key) => {
                Some(
                    map.get(parent_key)
                        .cloned()
                        .ok_or_else(|| PackError::CorruptState {
                            pack_id: payload.meta.id.clone(),
                            message: format!(
                                "parent {parent_key:?} of {:?} has no local mapping",
                                spec.key
                            ),
                        })?,
                )
            }
            None => None,
        };
        // Adopt an existing same-named sibling instead of colliding with the
        // book's per-sibling name uniqueness.
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM categories
                 WHERE book_id = ?1 AND parent_id IS ?2 AND name = ?3",
                params![book_id, parent_id, spec.name],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            conn.execute(
                "INSERT INTO pack_category_map (book_id, pack_id, category_key, category_id)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (book_id, pack_id, category_key)
                     DO UPDATE SET category_id = excluded.category_id",
                params![book_id, payload.meta.id, spec.key, id],
            )?;
            map.insert(spec.key.clone(), id);
            reused += 1;
            continue;
        }

        let kind =
            CategoryKind::from_str(&spec.kind).map_err(|e| PackError::Validation(e.to_string()))?;
        let category = Category {
            id: new_id(),
            book_id: book_id.to_string(),
            parent_id,
            name: spec.name.clone(),
            kind,
            icon: spec.icon.clone(),
            color: spec.color.clone(),
            is_system: false,
            created_at: now.to_string(),
            updated_at: now.to_string(),
        };
        repo::category::insert(conn, &category)?;
        conn.execute(
            "INSERT INTO pack_category_map (book_id, pack_id, category_key, category_id)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (book_id, pack_id, category_key)
                 DO UPDATE SET category_id = excluded.category_id",
            params![book_id, payload.meta.id, spec.key, category.id],
        )?;
        map.insert(spec.key.clone(), category.id);
        created += 1;
    }
    Ok((created, reused, map))
}

/// Replace this pack's rule set for the book and seed exact merchant rules
/// into core's `merchant_mappings` (source `pack`), never overriding a user's
/// own mapping. Returns the number of pack rules written.
fn install_rules(
    conn: &Connection,
    book_id: &str,
    payload: &PackPayload,
    key_to_id: &BTreeMap<String, String>,
    now: &str,
) -> PackResult<usize> {
    conn.execute(
        "DELETE FROM pack_rules WHERE book_id = ?1 AND pack_id = ?2",
        params![book_id, payload.meta.id],
    )?;

    let resolve = |key: &str| -> PackResult<&String> {
        key_to_id.get(key).ok_or_else(|| PackError::CorruptState {
            pack_id: payload.meta.id.clone(),
            message: format!("rule references unmapped category {key:?}"),
        })
    };

    let mut position = 0i64;
    let mut insert_rule =
        |rule_kind: &str, pattern: &str, category_id: &str, confidence: f64| -> PackResult<()> {
            conn.execute(
                "INSERT INTO pack_rules
                     (id, book_id, pack_id, rule_kind, pattern, category_id,
                      confidence, position)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    new_id(),
                    book_id,
                    payload.meta.id,
                    rule_kind,
                    pattern,
                    category_id,
                    confidence,
                    position,
                ],
            )?;
            position += 1;
            Ok(())
        };

    for rule in &payload.merchant_rules {
        let category_id = resolve(&rule.category_key)?.clone();
        let (kind, pattern) = match rule.match_kind {
            MatchKind::Exact => ("exact", normalize_merchant(&rule.pattern)),
            MatchKind::Contains => ("contains", normalize_merchant(&rule.pattern)),
            MatchKind::Regex => ("regex", rule.pattern.clone()),
        };
        insert_rule(kind, &pattern, &category_id, rule.confidence)?;

        if rule.match_kind == MatchKind::Exact {
            // Seed core's live mapping table. Only rows previously seeded by
            // a pack may be replaced — corrections always win.
            conn.execute(
                "INSERT INTO merchant_mappings
                     (id, book_id, merchant_normalized, category_id, source,
                      confidence, applied_count, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)
                 ON CONFLICT (book_id, merchant_normalized) DO UPDATE SET
                     category_id = excluded.category_id,
                     confidence = excluded.confidence,
                     updated_at = excluded.updated_at
                 WHERE merchant_mappings.source = ?5",
                params![
                    new_id(),
                    book_id,
                    pattern,
                    category_id,
                    MappingSource::Pack.as_str(),
                    rule.confidence,
                    now,
                ],
            )?;
        }
    }

    for rule in &payload.keyword_rules {
        let category_id = resolve(&rule.category_key)?.clone();
        for keyword in &rule.keywords {
            insert_rule(
                "keyword",
                &normalize_merchant(keyword),
                &category_id,
                rule.confidence,
            )?;
        }
    }

    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pack_rules WHERE book_id = ?1 AND pack_id = ?2",
        params![book_id, payload.meta.id],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

fn audit_pack(
    conn: &Connection,
    book_id: &str,
    pack_id: &str,
    action: &str,
    after: serde_json::Value,
) -> PackResult<()> {
    repo::audit::insert(
        conn,
        &AuditEntry {
            id: new_id(),
            book_id: Some(book_id.to_string()),
            entity_type: "pack".to_string(),
            entity_id: Some(pack_id.to_string()),
            action: action.to_string(),
            before_json: None,
            after_json: Some(after.to_string()),
            created_at: now_iso(),
        },
    )?;
    Ok(())
}
