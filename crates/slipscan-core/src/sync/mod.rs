//! The signed operation log — **the record half of device sync, with no
//! transport** (docs/NODES.md phase 2).
//!
//! # What this is
//!
//! Every replicable write this device makes is recorded as one DMTAP Sync
//! operation (`substrate/SYNC.md` §4), individually signed with the device key
//! that migration 0600 minted, stored in the same SQLite file as the books, and
//! ordered by a persisted hybrid logical clock.
//!
//! Three properties are worth naming because they are the ones a replication
//! layer is usually wrong about:
//!
//! * **Each op is verified on its own.** The signature is an RFC 9052
//!   `COSE_Sign1` over the op's own deterministic CBOR, made by the author's
//!   key, with the substrate's DS-tag in `external_aad`. Nothing is ever
//!   trusted for having arrived over an authenticated connection, because an
//!   op's authenticity does not depend on how it travelled.
//! * **An op has exactly one identity.** The primary key of `sync_oplog` is
//!   the §4.1 content address, the same identity the engine deduplicates on.
//!   A sibling product carried a content address *and* a UUID primary key and
//!   got two disagreeing identities — one op to the engine, two rows in the
//!   database.
//! * **Money is `i64` minor units and stays an integer.** It reaches the wire
//!   as a JSON integer inside the row payload; there is no float on the path
//!   and no rounding step to get wrong.
//!
//! # What this is not
//!
//! **There is no transport, and no apply path.** Nothing here opens a socket,
//! resolves a name, or reads an op from anywhere but this device's own
//! database. A fresh install makes no outbound call — not because a default
//! endpoint is unset, but because no code exists that could make one.
//!
//! Two paired devices today can each *show* a verifiable log of their own
//! changes. Carrying one device's ops to the other, admitting them against the
//! pinned peer key, and materialising them back into rows is phase 3;
//! `docs/NODES.md` lists what that phase owes, including the remote half of
//! the clock-drift bound (see [`clock`]).
//!
//! This module is deliberately the whole of that half and none of the next.
//! A partly-built replication path is worse than an absent one: it looks like
//! it works.
//!
//! # The shape of a cycle
//!
//! ```text
//!   a write                    seal                       the log
//!   ───────                    ────                       ───────
//!   INSERT/UPDATE/DELETE
//!         │
//!         │  SQLite trigger (migration 0700)
//!         ▼
//!    sync_outbox  ──────►  read the row whole
//!    (which row)           tick the HLC
//!                          mint the §4.4 / §4.3 op
//!                          COSE-sign it  ──────────►  sync_oplog
//!                                                     (op-id = content address)
//! ```
//!
//! Capture is a trigger rather than a call from the repo layer for the reason
//! given in migration 0700's header: a trigger is not a completeness claim
//! resting on nobody adding a fortieth write function. A cascade, a migration
//! and an importer nobody has written yet all reach the trigger.

pub mod capture;
pub mod clock;

use rusqlite::{Connection, OptionalExtension};

use crate::device::{keys, Devices};
use crate::error::{CoreError, CoreResult};
use crate::secrets::SecretStore;
use crate::util::now_iso;

use clock::SyncClock;
use dmtap_sync::{cose::CoseSign1, verify_op_bytes, Hlc, SyncOp};

/// The op-kind discriminators SlipScan's mapping emits, re-exported from the
/// engine.
///
/// Surfaces need these to label an op for a human. Re-exporting rather than
/// letting each surface `match 1 => …, 3 => …` keeps the substrate's own rule
/// — never hard-code the discriminators — true in the places most likely to
/// break it quietly, which are the display helpers nobody tests.
pub mod op_kinds {
    /// §4.3 OR-Set add: an immutable ledger fact.
    pub const SET_ADD: u8 = dmtap_sync::OP_SET_ADD;
    /// §4.4 last-writer-wins register: an editable row.
    pub const LWW_SET: u8 = dmtap_sync::OP_LWW_SET;
}

/// Where an op came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpOrigin {
    /// Authored by this device.
    Local,
    /// Received from a peer. **Never written today** — there is no transport,
    /// so nothing arrives from anywhere. The column and this variant exist
    /// because the log's schema should not have to change to hold the first
    /// op that does.
    Remote,
}

impl OpOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            OpOrigin::Local => "local",
            OpOrigin::Remote => "remote",
        }
    }

    fn parse(raw: &str) -> CoreResult<Self> {
        match raw {
            "local" => Ok(OpOrigin::Local),
            "remote" => Ok(OpOrigin::Remote),
            other => Err(CoreError::InvalidEnum {
                ty: "op origin",
                value: other.to_string(),
            }),
        }
    }
}

/// One op as it sits in the log.
///
/// Everything except `cose` is a decoded index over it, never a substitute:
/// [`StoredOp::verify`] re-derives every field from the signed envelope and
/// refuses on any disagreement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredOp {
    /// Lowercase hex of the §4.1 content address. The row's primary key, and
    /// the only identity this op has.
    pub op_id: String,
    /// The book id (§7 namespace).
    pub ns: String,
    /// The engine's op-kind discriminator.
    pub kind: u8,
    pub target: String,
    /// The author's device id: lowercase hex ed25519 public key.
    pub author: String,
    pub hlc_wall: u64,
    pub hlc_counter: u32,
    /// The signed `COSE_Sign1` envelope — the authoritative record.
    pub cose: Vec<u8>,
    pub origin: OpOrigin,
    pub recorded_at: String,
}

impl StoredOp {
    /// Verify this op **on its own** and return the authentic operation.
    ///
    /// Two checks, both fail-closed:
    ///
    /// 1. The COSE envelope verifies under the author key it names, over the
    ///    exact `Sig_structure` including the substrate's DS-tag. The engine
    ///    also re-encodes the payload and refuses if it is not byte-identical,
    ///    so a signature over non-canonical bytes cannot be laundered into an
    ///    op that re-encodes differently on another replica.
    /// 2. Every indexed column agrees with the signed payload, and `op_id` is
    ///    the content address of the payload rather than a value someone
    ///    chose. Without this, a hand-edited row could make the log *say*
    ///    something the signature does not cover — the op would still verify,
    ///    and every query that reads the columns instead of the envelope would
    ///    believe the edit.
    pub fn verify(&self) -> CoreResult<SyncOp> {
        let op = verify_op_bytes(&self.cose).map_err(|err| CoreError::SyncOpUnverified {
            op_id: self.op_id.clone(),
            reason: format!("signature: {err:?}"),
        })?;
        let refuse = |reason: String| CoreError::SyncOpUnverified {
            op_id: self.op_id.clone(),
            reason,
        };

        let derived = keys::encode_hex(op.op_id().as_bytes());
        if derived != self.op_id {
            return Err(refuse(format!(
                "op-id is {}, but this op's content addresses to {derived}",
                self.op_id
            )));
        }
        let author = keys::encode_hex(&op.hlc.author);
        for (field, stored, signed) in [
            ("ns", self.ns.as_str(), op.ns.as_str()),
            ("target", self.target.as_str(), op.target.as_str()),
            ("author", self.author.as_str(), author.as_str()),
        ] {
            if stored != signed {
                return Err(refuse(format!(
                    "{field} column says {stored:?}, the signed op says {signed:?}"
                )));
            }
        }
        for (field, stored, signed) in [
            ("kind", u64::from(self.kind), u64::from(op.kind)),
            ("hlc_wall", self.hlc_wall, op.hlc.wall),
            (
                "hlc_counter",
                u64::from(self.hlc_counter),
                u64::from(op.hlc.counter),
            ),
        ] {
            if stored != signed {
                return Err(refuse(format!(
                    "{field} column says {stored}, the signed op says {signed}"
                )));
            }
        }
        Ok(op)
    }

    /// This op's stamp.
    pub fn hlc(&self) -> CoreResult<Hlc> {
        Ok(Hlc {
            wall: self.hlc_wall,
            counter: self.hlc_counter,
            author: keys::decode_hex(&self.author).ok_or_else(|| CoreError::SyncOpUnverified {
                op_id: self.op_id.clone(),
                reason: "author column is not hex".into(),
            })?,
        })
    }
}

/// What one [`Oplog::seal`] did.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
pub struct SealReport {
    /// Outbox entries drained.
    pub captured: usize,
    /// Ops written to the log. Fewer than `captured` when several writes to
    /// one row collapsed into a single register write.
    pub sealed: usize,
    /// Ops that were already in the log under the same content address — a
    /// re-seal of an identical write, which is a no-op rather than a duplicate.
    pub already_present: usize,
}

/// One namespace's presence in the log.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NamespaceStat {
    pub ns: String,
    pub ops: usize,
}

/// A summary for the CLI and the desktop.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SyncStatus {
    /// This device's id, or `None` if it has no identity yet.
    pub device: Option<String>,
    pub keyname: Option<String>,
    /// Ops in the log.
    pub ops: usize,
    /// Writes captured but not yet sealed.
    pub pending: usize,
    pub namespaces: Vec<NamespaceStat>,
    /// The §5.1 version vector: each author's high-water stamp.
    pub version_vector: Vec<(String, u64, u32)>,
    /// Pinned peers that are not revoked. They can be *identified*; nothing
    /// can be sent to or received from them.
    pub live_peers: usize,
    /// The persisted clock, if it has ever ticked.
    pub clock: Option<(u64, u32)>,
}

/// What [`Oplog::verify_all`] found.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
pub struct VerifyReport {
    pub checked: usize,
    /// `(op-id, why)`. Empty is the only passing result.
    pub failures: Vec<(String, String)>,
}

impl VerifyReport {
    pub fn is_sound(&self) -> bool {
        self.failures.is_empty()
    }
}

/// The oplog over one SQLite connection plus the keychain the device key lives
/// behind. Cheap to construct; borrows both, exactly like [`Devices`].
pub struct Oplog<'a> {
    conn: &'a Connection,
    keychain: &'a dyn SecretStore,
}

impl std::fmt::Debug for Oplog<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Oplog").finish_non_exhaustive()
    }
}

impl<'a> Oplog<'a> {
    pub fn new(conn: &'a Connection, keychain: &'a dyn SecretStore) -> Self {
        Self { conn, keychain }
    }

    fn devices(&self) -> Devices<'a> {
        Devices::new(self.conn, self.keychain)
    }

    // -- Sealing ----------------------------------------------------------

    /// Turn every captured write into a signed op.
    ///
    /// Requires a device identity: an op is attributed by its signature, so
    /// there is nothing to record a write *as* until this device has a key.
    /// The writes are not lost in the meantime — they sit in the outbox and
    /// seal after `slipscan device init`.
    ///
    /// Single-writer: SlipScan opens one connection per data folder, and two
    /// concurrent seals would tick the same clock twice. The clock's store is
    /// monotonic and op ids are content addresses, so the failure mode is
    /// wasted work rather than a corrupt log — but it is not a supported way
    /// to run.
    pub fn seal(&self) -> CoreResult<SealReport> {
        self.seal_at(now_ms())
    }

    /// [`Oplog::seal`] with the wall-clock reading supplied, so tests can
    /// exercise the clock rather than race it.
    pub fn seal_at(&self, now_ms: u64) -> CoreResult<SealReport> {
        // Fail before doing any work if there is no identity, so the message
        // names `slipscan device init` rather than surfacing from the vault.
        self.devices().require_identity()?;
        let entries = capture::drain_list(self.conn)?;
        if entries.is_empty() {
            return Ok(SealReport::default());
        }
        let captured = entries.len();
        let high_water = entries.iter().map(|e| e.seq).max().unwrap_or(0);
        let coalesced = capture::coalesce(entries);

        // The key is unwrapped once for the whole seal, not once per op: the
        // vault stamps an audit entry on every use, and a hundred-row import
        // must not write a hundred "vault.use" rows. The material stays inside
        // the closure, and the write transaction opens inside it — `use_with`
        // has already committed its own by the time this runs.
        self.devices().with_identity_key(|signing| {
            let tx = self.conn.unchecked_transaction()?;
            let mut clock = SyncClock::load(&tx, &signing.public())?;
            let mut report = SealReport {
                captured,
                ..Default::default()
            };

            for entry in &coalesced {
                // A row that is absent when sealed is a delete, whatever the
                // capture said — the only way to reach this with `deleted`
                // false is a delete that happened after the capture and was
                // not itself captured. Recording the tombstone is the honest
                // answer; recording a live write would replicate a row that
                // does not exist.
                let (payload, deleted) = if entry.deleted {
                    (capture::tombstone(&entry.row_id), true)
                } else {
                    match capture::read_row(&tx, &entry.table, &entry.row_id)? {
                        Some(row) => (row, false),
                        None => (capture::tombstone(&entry.row_id), true),
                    }
                };

                let hlc = clock.tick_bounded(now_ms)?;
                let op = slipscan_sync::op_for_write(
                    &entry.ns,
                    &entry.table,
                    &entry.row_id,
                    &payload,
                    deleted,
                    hlc,
                )
                .map_err(|err| CoreError::SyncMapping(err.to_string()))?;

                let envelope = dmtap_sync::sign_op(signing, &op)
                    .map_err(|err| CoreError::SyncMapping(format!("signing failed: {err:?}")))?;

                if insert_op(&tx, &op, &envelope, OpOrigin::Local)? {
                    report.sealed += 1;
                } else {
                    report.already_present += 1;
                }
            }

            clock.store(&tx)?;
            // Only the entries actually read are cleared. Anything a
            // concurrent write added while this seal ran has a higher `seq`
            // and survives for the next one.
            tx.execute(
                "DELETE FROM sync_outbox WHERE seq <= ?1",
                rusqlite::params![high_water],
            )?;
            tx.commit()?;
            Ok(report)
        })
    }

    // -- Reading ----------------------------------------------------------

    /// Ops in total order — stamp first, content address to break ties.
    ///
    /// `ns` scopes to one book (§7 sparse sync). `limit` is applied after the
    /// ordering, so it always yields the *oldest* ops rather than an arbitrary
    /// window.
    pub fn ops(&self, ns: Option<&str>, limit: Option<usize>) -> CoreResult<Vec<StoredOp>> {
        let mut sql = String::from(
            "SELECT op_id, ns, kind, target, author, hlc_wall, hlc_counter, cose, origin,
                    recorded_at
             FROM sync_oplog",
        );
        if ns.is_some() {
            sql.push_str(" WHERE ns = ?1");
        }
        sql.push_str(" ORDER BY hlc_wall, hlc_counter, op_id");
        if let Some(limit) = limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = match ns {
            Some(ns) => stmt.query_map(rusqlite::params![ns], map_op)?,
            None => stmt.query_map([], map_op)?,
        };
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(CoreError::from)?
            .into_iter()
            .collect::<CoreResult<Vec<_>>>()
    }

    /// How many ops the log holds.
    pub fn len(&self) -> CoreResult<usize> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM sync_oplog", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    pub fn is_empty(&self) -> CoreResult<bool> {
        Ok(self.len()? == 0)
    }

    /// Writes captured but not yet sealed.
    pub fn pending(&self) -> CoreResult<usize> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    /// Verify **every** op in the log independently.
    ///
    /// Collects failures rather than stopping at the first: an operator asking
    /// whether the log is sound needs the extent of the damage, not its
    /// earliest instance.
    pub fn verify_all(&self) -> CoreResult<VerifyReport> {
        let mut report = VerifyReport::default();
        for op in self.ops(None, None)? {
            report.checked += 1;
            if let Err(CoreError::SyncOpUnverified { op_id, reason }) = op.verify() {
                report.failures.push((op_id, reason));
            }
        }
        Ok(report)
    }

    /// Replay the log through the shared engine and return the converged
    /// state.
    ///
    /// Every op is verified before it is applied — the log is on disk, and
    /// disk is not an authority. `receiver_now_ms` is the skew reference the
    /// engine validates stamps against.
    pub fn replay(&self, receiver_now_ms: u64) -> CoreResult<dmtap_sync::SyncState> {
        let mut state = dmtap_sync::SyncState::new();
        for stored in self.ops(None, None)? {
            let op = stored.verify()?;
            state
                .ingest(&op, receiver_now_ms)
                .map_err(|err| CoreError::SyncOpUnverified {
                    op_id: stored.op_id.clone(),
                    reason: format!("engine refused it: {err:?}"),
                })?;
        }
        Ok(state)
    }

    /// A summary for the CLI and the desktop.
    pub fn status(&self) -> CoreResult<SyncStatus> {
        let identity = self.devices().identity()?;
        let mut namespaces = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT ns, COUNT(*) FROM sync_oplog GROUP BY ns ORDER BY ns")?;
            let rows = stmt.query_map([], |row| {
                Ok(NamespaceStat {
                    ns: row.get(0)?,
                    ops: row.get::<_, i64>(1)? as usize,
                })
            })?;
            for row in rows {
                namespaces.push(row?);
            }
        }
        let mut version_vector = Vec::new();
        {
            // The §5.1 high-water mark per author, straight out of the index.
            let mut stmt = self.conn.prepare(
                "SELECT author, MAX(hlc_wall), MAX(hlc_counter) FROM sync_oplog
                 GROUP BY author ORDER BY author",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)? as u64,
                    row.get::<_, i64>(2)? as u32,
                ))
            })?;
            for row in rows {
                version_vector.push(row?);
            }
        }
        let live_peers = self
            .devices()
            .peer_list()?
            .into_iter()
            .filter(|peer| !peer.is_revoked())
            .count();
        let clock: Option<(i64, i64)> = self
            .conn
            .query_row(
                "SELECT wall, counter FROM sync_clock WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        Ok(SyncStatus {
            device: identity.as_ref().map(|i| i.public_key.clone()),
            keyname: identity.map(|i| i.keyname),
            ops: self.len()?,
            pending: self.pending()?,
            namespaces,
            version_vector,
            live_peers,
            clock: clock.map(|(w, c)| (w.max(0) as u64, c.max(0) as u32)),
        })
    }
}

/// Insert an op, returning whether it was new.
///
/// `ON CONFLICT DO NOTHING` on the content address: recording the same op
/// twice is a no-op, which is what "the op id is the only identity" means in
/// practice.
fn insert_op(
    conn: &Connection,
    op: &SyncOp,
    envelope: &CoseSign1,
    origin: OpOrigin,
) -> CoreResult<bool> {
    let changed = conn.execute(
        "INSERT INTO sync_oplog
             (op_id, ns, kind, target, author, hlc_wall, hlc_counter, cose, origin, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (op_id) DO NOTHING",
        rusqlite::params![
            keys::encode_hex(op.op_id().as_bytes()),
            op.ns,
            i64::from(op.kind),
            op.target,
            keys::encode_hex(&op.hlc.author),
            op.hlc.wall as i64,
            op.hlc.counter as i64,
            envelope.to_bytes(),
            origin.as_str(),
            now_iso(),
        ],
    )?;
    Ok(changed > 0)
}

fn map_op(row: &rusqlite::Row<'_>) -> rusqlite::Result<CoreResult<StoredOp>> {
    let origin: String = row.get(8)?;
    let kind: i64 = row.get(2)?;
    Ok((|| {
        Ok(StoredOp {
            op_id: row.get(0)?,
            ns: row.get(1)?,
            kind: u8::try_from(kind).map_err(|_| CoreError::InvalidEnum {
                ty: "op kind",
                value: kind.to_string(),
            })?,
            target: row.get(3)?,
            author: row.get(4)?,
            hlc_wall: row.get::<_, i64>(5)?.max(0) as u64,
            hlc_counter: row.get::<_, i64>(6)?.max(0) as u32,
            cose: row.get(7)?,
            origin: OpOrigin::parse(&origin)?,
            recorded_at: row.get(9)?,
        })
    })())
}

/// This machine's wall clock in milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    let nanos = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    // Before 1970 is not a time SlipScan runs at; clamp rather than wrap.
    u64::try_from(nanos.max(0) / 1_000_000).unwrap_or(0)
}

#[cfg(test)]
pub(crate) mod tests;
