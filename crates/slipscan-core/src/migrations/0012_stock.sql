-- =============================================================================
-- Migration 0012: the stock-movement ledger (Phase 6.3b, ROADMAP.md "Inventory
-- & trade").
--
-- Everything in migration 0011 was catalogue facts: a variant's SKU, its
-- price, its reorder point. None of it said how much of anything is on a
-- shelf, on purpose — that is what this migration adds, and it adds it as a
-- ledger, not a counter.
--
-- **The invariant this table exists to protect.** On-hand stock is always
-- `SUM(qty_delta)` over this table's rows, for a `(variant_id, location_id)`
-- pair or for a variant alone. There is no `on_hand` column anywhere in this
-- schema, on `product_variants` or here, and there never will be — a stored
-- total is exactly the thing that cannot survive two locations trading while
-- disconnected. Two branches that both sold from the same variant offline
-- converge the moment their rows union, because a row is a fact ("branch A
-- sold 3 units at 14:02") and facts from two places combine by just being
-- put in the same table together. Two branches that both decremented a
-- shared counter converge on whichever write happened to arrive last,
-- silently discarding the other sale. FlowStock got this right; the mistake
-- ROADMAP.md's Decision 4 refers to is a *sibling* product's, not this one's
-- own — recorded here because the shape (a signed ledger of quantity deltas)
-- is exactly the trap that a cached total looks tempting next to.
--
-- **Insert-only, like `journals`/`journal_lines`, and for the same reason.**
-- A stock count discovers three fewer units than the system believes: the
-- correction is a new `adjustment` row for -3, never an UPDATE to the row
-- that overstated it. `stock_movements_no_update`/`_no_delete` below make
-- SQLite refuse the alternative outright, the same guarantee migration 0001
-- gives `journals`/`journal_lines` — not a service-layer convention that a
-- future raw-SQL caller could quietly skip.
--
-- **Shape, carried over from FlowStock's own table (see ROADMAP.md's Phase 6
-- header — this is a re-derivation, not a port):**
--
--   variant_id / location_id  what moved, and where. Both `ON DELETE
--                             RESTRICT`: a variant or a location with any
--                             movement history is trade history, and
--                             deleting either out from under it would leave
--                             rows that no longer resolve to a real place or
--                             a real product. `repo::catalogue::variant_
--                             delete` and `repo::location::delete` are still
--                             plain hard deletes (neither had a caller that
--                             needed a reassignment guard as of their own
--                             migrations); this FK is what actually stops
--                             the delete once a variant has traded, and it
--                             surfaces as an ordinary SQLite constraint
--                             error rather than a friendly `CoreError` today
--                             — nobody has hit it as a caller yet.
--   qty_delta                 signed. Positive = stock arriving at this
--                             location (a receipt, a transfer in, a count
--                             correcting upward); negative = stock leaving
--                             it (a sale, a transfer out, a count correcting
--                             downward). `!= 0`: a movement that changes
--                             nothing is not a fact, it is a no-op somebody
--                             meant not to record.
--   kind                       receipt / sale / adjustment / transfer /
--                             count — FlowStock's five, unchanged. Not a
--                             sign predictor: `adjustment` and `count` can
--                             go either way, and the database does not try
--                             to guess which sign a kind "should" have —
--                             that would be a second, weaker copy of the
--                             validation the service layer already owns.
--   ref_kind / ref_id          what caused this movement, in whatever
--                             vocabulary the causing stage uses — 'transfer'
--                             is the only value this migration itself ever
--                             writes (see `stock_transfer` in service.rs).
--                             Deliberately not a CHECK-constrained enum and
--                             not a foreign key: migration 0011 already
--                             refused to build purchasing or sales (that is
--                             6.4/6.5), so this table cannot know their
--                             vocabulary or their table names yet. Both
--                             columns are free text on purpose — the fold's
--                             own convention (a new column lands in this
--                             CREATE TABLE in place, no ALTER chain) is
--                             exactly the tool 6.4/6.5 should reach for if
--                             they ever want to tighten this, in this same
--                             file.
--   note                       free text, optional. A person's own words
--                             about why — "damaged in transit", "year-end
--                             count" — never parsed.
--   created_by                 free text, optional, no FK. SlipScan has no
--                             user/staff identity yet — device pairing
--                             (migration 0007) identifies a *machine*, not
--                             the person standing at a till on it, and
--                             ROADMAP.md 6.8 ("Roles... neither codebase had
--                             it") is where that gets built. Until then this
--                             is a label someone types, exactly as
--                             untrusted as `journal_lines.description`.
--
-- **What this migration does not build.** No purchasing (6.4), no sales
-- orders or invoicing (6.5), no posting to the accounting ledger (6.6) — a
-- goods receipt or a confirmed sale does not yet touch `journals`/
-- `journal_lines`, so Phase 6 remains an inventory app sharing a binary with
-- an accounting one until 6.6 lands. This table only answers "how much is
-- where", never "what is it worth on the balance sheet".
-- =============================================================================

CREATE TABLE stock_movements (
    id          TEXT PRIMARY KEY,
    book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    variant_id  TEXT NOT NULL REFERENCES product_variants (id) ON DELETE RESTRICT,
    location_id TEXT NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
    qty_delta   INTEGER NOT NULL CHECK (qty_delta != 0),
    kind        TEXT NOT NULL
        CHECK (kind IN ('receipt', 'sale', 'adjustment', 'transfer', 'count')),
    ref_kind    TEXT,
    ref_id      TEXT,
    note        TEXT,
    created_by  TEXT,
    created_at  TEXT NOT NULL
);

CREATE INDEX stock_movements_book_idx ON stock_movements (book_id);
-- Leftmost-prefix serves both "on hand for variant X at location Y" (both
-- columns bound) and "on hand for variant X everywhere" (variant_id alone) —
-- the two derived on-hand queries ROADMAP.md 6.3b asks for.
CREATE INDEX stock_movements_variant_location_idx
    ON stock_movements (variant_id, location_id);
-- Serves a location-scoped ledger view (every movement that touched this
-- branch, any variant), which the composite index above cannot serve on its
-- own since location_id is not its leftmost column.
CREATE INDEX stock_movements_location_idx ON stock_movements (location_id);
-- Sparse: most movements have no cause yet worth indexing (a manual
-- adjustment or count has none). Backs "every movement this transfer/receipt/
-- sale produced" once 6.4/6.5 start writing a ref_kind.
CREATE INDEX stock_movements_ref_idx
    ON stock_movements (ref_kind, ref_id) WHERE ref_id IS NOT NULL;

-- A movement's content is its identity, the same way a signed op's is
-- (migration 0008) and a posted journal's is (migration 0001): there is no
-- such thing as correcting one in place, only recording a second movement
-- that nets against it.
CREATE TRIGGER stock_movements_no_update
BEFORE UPDATE ON stock_movements
BEGIN
    SELECT RAISE(ABORT, 'stock movements are immutable; record a compensating movement instead');
END;

CREATE TRIGGER stock_movements_no_delete
BEFORE DELETE ON stock_movements
BEGIN
    SELECT RAISE(ABORT, 'stock movements are immutable; record a compensating movement instead');
END;

-- -----------------------------------------------------------------------------
-- Sync capture: INSERT only, for the same reason as `journals` above — the
-- two triggers just installed make an UPDATE/DELETE capture trigger
-- unreachable code. `stock_movements` is added to `slipscan_sync::
-- LEDGER_TABLES` (crates/slipscan-sync/src/lib.rs), not `LWW_TABLES`: it is
-- an immutable fact merged by union (§4.3 OR-Set), exactly like
-- `journals`/`journal_lines`, and for the identical reason — two locations
-- that recorded movements while disconnected must converge by keeping both,
-- never by one overwriting the other. Every row carries its own UUID v7
-- `id`, which is what makes that union safe (see `slipscan-sync`'s module
-- docs on the "two facts that serialize alike" trap it already hit once).
-- `crate::sync::capture::tests::every_mapped_table_has_capture_triggers_and_
-- no_others_do` and `lww_tables_capture_all_three_verbs_and_ledger_tables_
-- only_insert` both assert this table's trigger set agrees with that list.
-- -----------------------------------------------------------------------------

CREATE TRIGGER sync_capture_stock_movements_ins AFTER INSERT ON stock_movements
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('stock_movements', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- No backfill needed: `stock_movements` did not exist before this migration,
-- so there are no pre-existing rows for the outbox to catch up on.
