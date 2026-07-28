//! Where packs may be fetched from — a list the **user** writes, and nobody
//! else.
//!
//! # The binding part
//!
//! This table starts empty and there is no code path anywhere in SlipScan
//! that puts a row in it except a user asking for one. No seed, no
//! "recommended" source, no fallback, no discovery of any kind. A fresh
//! install therefore makes **zero network calls** about packs, forever, until
//! somebody types a URL — and [`SourceStore::network_sources`] exists so that
//! claim is something a test can assert rather than something a comment can
//! assure you of.
//!
//! This is the same posture as core's FX endpoint (no rate provider until you
//! configure one) and the mail connectors (no mailbox until you name one).
//! Packs are not the exception.
//!
//! Only the source itself is stored — a name and a URI. No credentials: `git:`
//! sources use the user's own git credential setup, and `https:` sources are
//! plain GETs. There is nothing here for a secret to leak out of.

use rusqlite::{params, Connection, OptionalExtension};

use slipscan_core::util::now_iso;

use crate::error::{PackError, PackResult};

use super::{PackSource, SourceKind};

pub(crate) const SOURCE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS pack_sources (
    name           TEXT PRIMARY KEY,
    uri            TEXT NOT NULL,
    kind           TEXT NOT NULL,
    added_at       TEXT NOT NULL,
    last_synced_at TEXT
);
";

/// One configured source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackSourceRow {
    /// The short name the user refers to it by.
    pub name: String,
    pub source: PackSource,
    pub added_at: String,
    pub last_synced_at: Option<String>,
}

/// The user's pack sources, over a book database connection.
pub struct SourceStore<'c> {
    conn: &'c Connection,
}

impl<'c> SourceStore<'c> {
    /// Open the store, creating its table if needed.
    pub fn open(conn: &'c Connection) -> PackResult<Self> {
        conn.execute_batch(SOURCE_SCHEMA)?;
        Ok(Self { conn })
    }

    /// Open for reading only: nothing is created. `None` means no source has
    /// ever been added on this database — which is the state every fresh
    /// install is in, and the reason nothing reaches out on first run.
    pub fn open_readonly(conn: &'c Connection) -> PackResult<Option<Self>> {
        let tables: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'pack_sources'",
            [],
            |row| row.get(0),
        )?;
        Ok((tables > 0).then_some(Self { conn }))
    }

    /// Add a source under a name. Refuses to silently replace an existing one
    /// — repointing a name is [`SourceStore::remove`] then add, so it is
    /// never something a stray call can do behind the user's back.
    pub fn add(&self, name: &str, source: &PackSource) -> PackResult<PackSourceRow> {
        let name = normalize_name(name)?;
        if self.get(&name)?.is_some() {
            return Err(PackError::SourceExists(name));
        }
        let now = now_iso();
        self.conn.execute(
            "INSERT INTO pack_sources (name, uri, kind, added_at, last_synced_at)
             VALUES (?1, ?2, ?3, ?4, NULL)",
            params![name, source.uri(), source.kind().as_str(), now],
        )?;
        self.get(&name)?.ok_or_else(|| PackError::CorruptState {
            pack_id: String::new(),
            message: "pack source vanished after insert".into(),
        })
    }

    /// Remove a source. Returns whether a row was removed. Nothing installed
    /// is affected: an installed pack is installed, and where it came from is
    /// history, not a dependency.
    pub fn remove(&self, name: &str) -> PackResult<bool> {
        let name = normalize_name(name)?;
        let removed = self
            .conn
            .execute("DELETE FROM pack_sources WHERE name = ?1", params![name])?;
        Ok(removed > 0)
    }

    /// Every configured source, oldest first.
    pub fn list(&self) -> PackResult<Vec<PackSourceRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT name, uri, added_at, last_synced_at
             FROM pack_sources ORDER BY added_at, name",
        )?;
        let rows = stmt
            .query_map([], map_row)?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .collect::<PackResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// One source by name.
    pub fn get(&self, name: &str) -> PackResult<Option<PackSourceRow>> {
        let name = normalize_name(name)?;
        let row = self
            .conn
            .query_row(
                "SELECT name, uri, added_at, last_synced_at
                 FROM pack_sources WHERE name = ?1",
                params![name],
                map_row,
            )
            .optional()?;
        row.transpose()
    }

    /// One source by name, or [`PackError::NoSuchSource`].
    pub fn require(&self, name: &str) -> PackResult<PackSourceRow> {
        self.get(name)?
            .ok_or_else(|| PackError::NoSuchSource(name.to_string()))
    }

    /// The configured sources whose transport can put packets on a network.
    ///
    /// The privacy contract in one function: if this is empty, nothing
    /// SlipScan does about packs can reach a network, because the only
    /// network transports are opened from these rows.
    pub fn network_sources(&self) -> PackResult<Vec<PackSourceRow>> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|row| row.source.is_network())
            .collect())
    }

    /// Record that a source was read. Metadata only — never what was found.
    pub fn touch(&self, name: &str) -> PackResult<()> {
        let name = normalize_name(name)?;
        self.conn.execute(
            "UPDATE pack_sources SET last_synced_at = ?2 WHERE name = ?1",
            params![name, now_iso()],
        )?;
        Ok(())
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PackResult<PackSourceRow>> {
    let name: String = row.get(0)?;
    let uri: String = row.get(1)?;
    let added_at: String = row.get(2)?;
    let last_synced_at: Option<String> = row.get(3)?;
    Ok(PackSource::parse(&uri).map(|source| PackSourceRow {
        name,
        source,
        added_at,
        last_synced_at,
    }))
}

/// Source names are short handles the user types: lowercase, no separators
/// that could be mistaken for a path or a scheme.
fn normalize_name(name: &str) -> PackResult<String> {
    let lower = name.trim().to_ascii_lowercase();
    let ok = !lower.is_empty()
        && lower.len() <= 64
        && lower
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        && !lower.starts_with('.')
        && SourceKind::from_name(&lower).is_none();
    if ok {
        Ok(lower)
    } else {
        Err(PackError::InvalidSourceName(name.to_string()))
    }
}

impl SourceKind {
    /// A source may not be *named* after a scheme — `folder`, `https` and
    /// friends read as URIs at a glance and would make a command line
    /// ambiguous to a human even where it is not to a parser.
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "file" => Some(SourceKind::File),
            "folder" => Some(SourceKind::Folder),
            "git" => Some(SourceKind::Git),
            "https" | "http" => Some(SourceKind::Https),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    /// The privacy contract, asserted rather than asserted-about: a database
    /// nobody has configured offers no source at all, and in particular no
    /// network source. Nothing seeds this table.
    #[test]
    fn a_fresh_install_has_no_sources_and_therefore_no_endpoint() {
        let conn = conn();
        // Before anything creates the table at all.
        assert!(SourceStore::open_readonly(&conn).unwrap().is_none());

        let store = SourceStore::open(&conn).unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(
            store.network_sources().unwrap().is_empty(),
            "no default endpoint exists to be found"
        );
    }

    #[test]
    fn sources_round_trip_and_names_are_taken_once() {
        let conn = conn();
        let store = SourceStore::open(&conn).unwrap();
        let usb = PackSource::parse("folder:/Volumes/USB/packs").unwrap();
        let row = store.add("USB", &usb).unwrap();
        assert_eq!(row.name, "usb", "names normalize to lowercase");
        assert_eq!(row.source, usb);
        assert!(row.last_synced_at.is_none());

        assert!(matches!(
            store.add("usb", &usb),
            Err(PackError::SourceExists(_))
        ));
        assert_eq!(store.require("usb").unwrap().source, usb);
        store.touch("usb").unwrap();
        assert!(store.get("usb").unwrap().unwrap().last_synced_at.is_some());

        assert!(store.remove("usb").unwrap());
        assert!(!store.remove("usb").unwrap());
        assert!(matches!(
            store.require("usb"),
            Err(PackError::NoSuchSource(_))
        ));
    }

    #[test]
    fn network_sources_are_exactly_the_ones_that_can_reach_out() {
        let conn = conn();
        let store = SourceStore::open(&conn).unwrap();
        store
            .add("stick", &PackSource::parse("folder:/mnt/stick").unwrap())
            .unwrap();
        store
            .add(
                "onefile",
                &PackSource::parse("file:/tmp/a.pack.json").unwrap(),
            )
            .unwrap();
        assert!(store.network_sources().unwrap().is_empty());

        store
            .add(
                "team",
                &PackSource::parse("git:https://example.org/packs.git").unwrap(),
            )
            .unwrap();
        store
            .add("web", &PackSource::parse("https://example.org/p").unwrap())
            .unwrap();
        let mut names: Vec<String> = store
            .network_sources()
            .unwrap()
            .into_iter()
            .map(|r| r.name)
            .collect();
        names.sort();
        assert_eq!(names, ["team", "web"]);
    }

    #[test]
    fn scheme_shaped_and_malformed_names_are_refused() {
        let conn = conn();
        let store = SourceStore::open(&conn).unwrap();
        let src = PackSource::parse("folder:/x").unwrap();
        for bad in [
            "",
            "  ",
            "https",
            "folder",
            "git",
            "file",
            "a/b",
            "a:b",
            ".hidden",
            &"x".repeat(65),
        ] {
            assert!(
                matches!(store.add(bad, &src), Err(PackError::InvalidSourceName(_))),
                "{bad:?} must not be a source name"
            );
        }
    }
}
