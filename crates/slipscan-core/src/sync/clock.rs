//! The persisted hybrid logical clock, and the drift bound that sits **above**
//! the engine.
//!
//! # Why the clock is persisted
//!
//! An HLC's entire job is to be monotonic per author. A clock that started at
//! zero on every process start would mint stamps sorting *before* ops this
//! device had already published and signed, so the same row's newer write
//! would lose to its own predecessor — and lose silently, because both writes
//! are valid and the merge is doing exactly what it was told.
//!
//! # Why the drift bound is here and not in the engine
//!
//! The engine bounds skew where it can: `SyncState::ingest` refuses an op
//! whose `hlc.wall` is more than [`dmtap_sync::HLC_SKEW_MS`] ahead of the
//! receiver's clock. But `Hlc::observe` — the call that folds a *remote* stamp
//! into the local clock — takes no receiver clock and therefore *structurally
//! cannot* check anything. That asymmetry is a known trap in this programme: a
//! single far-future stamp folded in poisons the local clock permanently,
//! because the ratchet only ever moves forward.
//!
//! So the bound lives above the engine, in [`SyncClock::tick_bounded`], and it
//! is checked on the path this phase actually has: minting a local stamp. A
//! poisoned ratchet makes every op this device signs unacceptable to every
//! peer — permanently, since an op's stamp is inside its signature and cannot
//! be corrected — so sealing **refuses** rather than producing signed garbage.
//!
//! The remote half of the same bound belongs with the ingest path, which does
//! not exist yet (there is no transport). `docs/NODES.md` records it as an
//! obligation of that phase rather than pretending it is discharged here.

use rusqlite::{Connection, OptionalExtension};

use crate::error::{CoreError, CoreResult};
use crate::util::now_iso;

pub use dmtap_sync::Hlc;

/// How far ahead of this machine's wall clock the persisted clock may sit
/// before sealing refuses.
///
/// **Deliberately much looser than the engine's [`dmtap_sync::HLC_SKEW_MS`]**,
/// because the two bounds answer different questions and copying the tighter
/// one here would be a bug rather than caution.
///
/// The engine's bound is a *receiver's*: "is this op plausibly from now?" It
/// has to be tight, because a receiver has nothing else to go on.
///
/// This one is a *minter's*: "is my clock so wrong that the ops I sign will be
/// unusable for a long time?" A stamp `D` ahead of true time is rejected by
/// peers only until real time catches up — for `D − HLC_SKEW_MS`. At two
/// minutes of drift that is no time at all, and refusing to seal would block a
/// user from recording work over an NTP correction. At a year it never
/// practically resolves, and every op signed meanwhile is dead on arrival with
/// no way to fix it, because the stamp is inside the signature.
///
/// A day is the line between "this will sort itself out" and "this will not".
/// Drift under it still delays a peer's acceptance by roughly the drift, which
/// is a visible, self-healing nuisance rather than silent loss.
pub const MAX_CLOCK_DRIFT_MS: u64 = 24 * 60 * 60 * 1000;

/// Sanity: the mint guard must never be *tighter* than the receiver's bound,
/// or a device could refuse to seal an op that every peer would have accepted.
const _: () = assert!(MAX_CLOCK_DRIFT_MS > dmtap_sync::HLC_SKEW_MS);

/// This device's clock, loaded from `sync_clock`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncClock {
    hlc: Hlc,
}

impl SyncClock {
    /// Load the clock, or start a fresh one at zero.
    ///
    /// Zero is safe as a starting point precisely because [`Hlc::tick`] takes
    /// the larger of the stored wall and the system clock: the first tick on a
    /// fresh device jumps straight to real time.
    pub fn load(conn: &Connection, author: &[u8]) -> CoreResult<Self> {
        let stored: Option<(i64, i64)> = conn
            .query_row(
                "SELECT wall, counter FROM sync_clock WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (wall, counter) = stored.unwrap_or((0, 0));
        Ok(Self {
            hlc: Hlc {
                // Stored as INTEGER because SQLite has no unsigned type. A
                // negative value can only come from a hand-edited row; clamp
                // rather than wrap, so a nonsense clock reads as "behind" and
                // the next tick corrects it, instead of becoming a huge
                // far-future stamp.
                wall: wall.max(0) as u64,
                counter: counter.max(0) as u32,
                author: author.to_vec(),
            },
        })
    }

    /// The current stamp, without advancing.
    pub fn hlc(&self) -> &Hlc {
        &self.hlc
    }

    /// Mint the next stamp, refusing if the persisted clock has drifted more
    /// than [`MAX_CLOCK_DRIFT_MS`] ahead of `now_ms`.
    ///
    /// A clock *behind* `now_ms` is ordinary and needs no check — the tick
    /// simply jumps forward to real time. A clock **ahead** of it by more than
    /// the bound is the poisoned ratchet: something folded a far-future stamp
    /// in, and every op minted from here would carry a wall no peer will
    /// accept. Refusing loses nothing (the writes are still in the outbox, and
    /// still seal once the clock is sound); minting would lose the writes
    /// permanently, because the bad stamp is inside the signature.
    pub fn tick_bounded(&mut self, now_ms: u64) -> CoreResult<Hlc> {
        let drift = self.hlc.wall.saturating_sub(now_ms);
        if drift > MAX_CLOCK_DRIFT_MS {
            return Err(CoreError::SyncClockDrift {
                ahead_ms: drift,
                bound_ms: MAX_CLOCK_DRIFT_MS,
            });
        }
        Ok(self.hlc.tick(now_ms))
    }

    /// Persist the clock, **monotonically**: a store that would move it
    /// backwards is a no-op.
    ///
    /// Not defensive dressing. The stamps this clock has already minted are
    /// signed and, once carried anywhere, unrecallable; letting the persisted
    /// value regress would hand the next tick a stamp that sorts before them.
    /// Making the guard part of the write means no caller can forget it.
    pub fn store(&self, conn: &Connection) -> CoreResult<()> {
        conn.execute(
            "INSERT INTO sync_clock (id, wall, counter, updated_at)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT (id) DO UPDATE SET
                 wall       = excluded.wall,
                 counter    = excluded.counter,
                 updated_at = excluded.updated_at
             WHERE (excluded.wall, excluded.counter) > (sync_clock.wall, sync_clock.counter)",
            rusqlite::params![self.hlc.wall as i64, self.hlc.counter as i64, now_iso()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn author() -> Vec<u8> {
        vec![7u8; 32]
    }

    #[test]
    fn a_fresh_clock_starts_at_zero_and_the_first_tick_jumps_to_real_time() {
        let db = Db::open_in_memory().unwrap();
        let mut clock = SyncClock::load(db.conn(), &author()).unwrap();
        assert_eq!(clock.hlc().wall, 0);

        let now = 1_760_000_000_000;
        let stamp = clock.tick_bounded(now).unwrap();
        assert_eq!(stamp.wall, now);
        assert_eq!(stamp.counter, 0);
        assert_eq!(stamp.author, author());
    }

    #[test]
    fn a_stalled_wall_clock_advances_the_counter_instead() {
        let db = Db::open_in_memory().unwrap();
        let mut clock = SyncClock::load(db.conn(), &author()).unwrap();
        let now = 1_760_000_000_000;
        let a = clock.tick_bounded(now).unwrap();
        let b = clock.tick_bounded(now).unwrap();
        let c = clock.tick_bounded(now).unwrap();
        assert!(a < b && b < c, "strictly monotonic under a stalled clock");
        assert_eq!((b.wall, b.counter), (now, 1));
        assert_eq!((c.wall, c.counter), (now, 2));
    }

    /// A system clock corrected backwards — an ordinary NTP step — must not
    /// drag the log backwards with it, and must not stop the device writing:
    /// the stamp after the correction still sorts after the one before it.
    #[test]
    fn a_backwards_system_clock_cannot_mint_a_stale_ordering_stamp() {
        let db = Db::open_in_memory().unwrap();
        let mut clock = SyncClock::load(db.conn(), &author()).unwrap();
        let now = 1_760_000_000_000;
        let before = clock.tick_bounded(now).unwrap();
        // Ten minutes backwards: well past the engine's 120s ingest bound, and
        // well inside the mint guard, which is exactly the gap the two
        // different numbers exist to leave open.
        let after = clock.tick_bounded(now - 10 * 60 * 1000).unwrap();
        assert!(after > before, "the ratchet only ever moves forward");
        assert_eq!(after.wall, before.wall);
    }

    #[test]
    fn the_clock_survives_a_restart() {
        let db = Db::open_in_memory().unwrap();
        let now = 1_760_000_000_000;
        {
            let mut clock = SyncClock::load(db.conn(), &author()).unwrap();
            clock.tick_bounded(now).unwrap();
            clock.tick_bounded(now).unwrap();
            clock.store(db.conn()).unwrap();
        }
        // A "restart": the same database, a new clock handle.
        let mut reloaded = SyncClock::load(db.conn(), &author()).unwrap();
        let next = reloaded.tick_bounded(now).unwrap();
        assert_eq!(
            (next.wall, next.counter),
            (now, 2),
            "a restarted clock must not re-mint a stamp it already used"
        );
    }

    #[test]
    fn storing_the_clock_never_moves_it_backwards() {
        let db = Db::open_in_memory().unwrap();
        let mut ahead = SyncClock::load(db.conn(), &author()).unwrap();
        ahead.tick_bounded(1_760_000_000_000).unwrap();
        ahead.store(db.conn()).unwrap();

        // A stale handle that has only ticked to an earlier time tries to
        // write itself over the top.
        let mut stale = SyncClock {
            hlc: Hlc {
                wall: 1_600_000_000_000,
                counter: 0,
                author: author(),
            },
        };
        stale.store(db.conn()).unwrap();

        let reloaded = SyncClock::load(db.conn(), &author()).unwrap();
        assert_eq!(reloaded.hlc().wall, 1_760_000_000_000);

        // And the counter dimension is guarded too, not just the wall.
        stale.hlc.wall = 1_760_000_000_000;
        stale.hlc.counter = 0;
        ahead.hlc.counter = 5;
        ahead.store(db.conn()).unwrap();
        stale.store(db.conn()).unwrap();
        assert_eq!(
            SyncClock::load(db.conn(), &author()).unwrap().hlc().counter,
            5
        );
    }

    /// **The trap, stated as a test.** A clock ratcheted far into the future
    /// refuses to mint — and the property asserted is the ORDERING that
    /// survives the refusal, not merely that an error came back.
    #[test]
    fn a_poisoned_clock_refuses_to_mint_and_leaves_the_ordering_intact() {
        let db = Db::open_in_memory().unwrap();
        let now = 1_760_000_000_000;

        let mut clock = SyncClock::load(db.conn(), &author()).unwrap();
        let good = clock.tick_bounded(now).unwrap();
        clock.store(db.conn()).unwrap();

        // Something folds in a stamp a year ahead — the failure mode
        // `Hlc::observe` structurally cannot catch, simulated by writing the
        // ratchet directly.
        let poisoned_wall = now + 365 * 24 * 60 * 60 * 1000;
        let poisoned = SyncClock {
            hlc: Hlc {
                wall: poisoned_wall,
                counter: 0,
                author: author(),
            },
        };
        poisoned.store(db.conn()).unwrap();

        let mut clock = SyncClock::load(db.conn(), &author()).unwrap();
        let err = clock.tick_bounded(now).unwrap_err();
        assert!(
            matches!(err, CoreError::SyncClockDrift { .. }),
            "got {err:?}"
        );

        // The ordering property: nothing was minted, so the last stamp this
        // device published is still the last one, and it is still `good`.
        assert_eq!(
            SyncClock::load(db.conn(), &author()).unwrap().hlc().wall,
            poisoned_wall,
            "the refusal does not silently rewind the ratchet either"
        );

        // Once the clock is sound again — real time caught up, or the operator
        // reset it — the next stamp still sorts after everything already
        // logged. That is the invariant a poisoned clock threatens.
        let mut recovered = SyncClock::load(db.conn(), &author()).unwrap();
        let next = recovered.tick_bounded(poisoned_wall).unwrap();
        assert!(next > good, "ordering with the pre-poison log is preserved");
    }

    /// The bound is a bound, not a hair trigger. Ordinary clock wander — and
    /// anything else that resolves itself within a day — must not stop a
    /// device from recording its own work.
    #[test]
    fn drift_within_the_bound_is_not_refused() {
        let now = 1_760_000_000_000;
        for ahead in [
            0,
            dmtap_sync::HLC_SKEW_MS,
            // Past the receiver's bound: these ops are early, not wrong, and
            // peers accept them once real time catches up.
            10 * 60 * 1000,
            MAX_CLOCK_DRIFT_MS,
        ] {
            let mut clock = SyncClock {
                hlc: Hlc {
                    wall: now + ahead,
                    counter: 0,
                    author: author(),
                },
            };
            assert!(
                clock.tick_bounded(now).is_ok(),
                "{ahead}ms of drift must not block writing"
            );
        }
    }

    /// A hand-edited negative row must read as "behind", never as a huge
    /// far-future stamp via a wrapping cast.
    #[test]
    fn a_negative_stored_clock_clamps_instead_of_wrapping() {
        let db = Db::open_in_memory().unwrap();
        db.conn()
            .execute(
                "INSERT INTO sync_clock (id, wall, counter, updated_at)
                 VALUES (1, -5, -5, 't')",
                [],
            )
            .unwrap();
        let clock = SyncClock::load(db.conn(), &author()).unwrap();
        assert_eq!((clock.hlc().wall, clock.hlc().counter), (0, 0));
    }
}
