-- =============================================================================
-- Migration 0009: locations (Phase 6.1 — the FlowStock fold, foundation).
--
-- FlowStock was a retired, offline-first multi-branch inventory product. Its
-- domain is being re-derived here in Rust rather than ported from Go, and this
-- migration is the foundation everything else in Phase 6 sits on: a per-book
-- axis of physical places — branches, sites, warehouses — that later stock
-- movements, counts and transfers will reference.
--
-- Backward compatible, the same way migration 0006 made members additive: a
-- location is a brand new, wholly optional table with nothing pointing at it
-- yet. A book with zero locations keeps working exactly as it does today —
-- every existing screen, report and CLI command is untouched by this file.
--
-- No inventory model exists yet (no items, no stock movements, no counts), so
-- there is nothing for a location to be referenced by. That is deliberate
-- scope: this migration lands the axis, not the inventory it will eventually
-- carry. A location can therefore be hard-deleted with no reassignment guard,
-- unlike a member (`0006_members.sql`) whose removal must consider attributed
-- transactions — there is nothing yet for a location's removal to orphan.
--
-- `kind` names the sense in which FlowStock used the word: a branch (a
-- storefront or office), a warehouse (bulk storage, not customer-facing) or a
-- site (anything else — a job site, a pop-up, a single generic place). It is
-- data a person sets, not a behavioural switch; nothing in core branches on it
-- yet.
--
-- -----------------------------------------------------------------------------
-- Sync capture
-- -----------------------------------------------------------------------------
--
-- Every replicated table in this schema creates its own capture triggers in
-- the same migration that creates the table — `locations` is no exception,
-- and neither is anything created before it (see migration 0008's header for
-- the full map of which migration owns which table's triggers). The capture
-- triggers below are installed here, at the same time as the table, and
-- every future table should do the same — rather than waiting for a later
-- "add sync to the new tables" migration that is easy to forget to write.
--
-- `locations` is an editable row like `accounts` or `members`: a person
-- renames a branch or edits its address, and last-writer-wins is what they
-- mean by that. So it takes all three verbs (insert/update/delete), exactly
-- like the members precedent, and it must also be added to
-- `slipscan_sync::LWW_TABLES` (crates/slipscan-sync/src/lib.rs) — that
-- addition is the other half of this table's sync story and lives in that
-- crate, not here. `crate::sync::capture::tests::
-- every_mapped_table_has_capture_triggers_and_no_others_do` asserts the two
-- agree in both directions, so leaving either side out fails the suite rather
-- than replicating silently.
-- =============================================================================

CREATE TABLE locations (
    id          TEXT PRIMARY KEY,
    book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'branch' CHECK (kind IN ('branch', 'warehouse', 'site')),
    -- Optional short code for reports, labels and (eventually) barcodes —
    -- e.g. "JHB-01". NULL when nobody has set one; uniqueness is enforced
    -- only where present, the same way `categories_root_name_unique` in
    -- migration 0001 scopes around a nullable column.
    code        TEXT,
    address     TEXT,
    is_archived INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (book_id, name)
);

CREATE INDEX locations_book_idx ON locations (book_id);

CREATE UNIQUE INDEX locations_book_code_unique
    ON locations (book_id, code) WHERE code IS NOT NULL;

-- locations ------------------------------------------------------------------
CREATE TRIGGER sync_capture_locations_ins AFTER INSERT ON locations
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('locations', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_locations_upd AFTER UPDATE ON locations
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('locations', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_locations_del AFTER DELETE ON locations
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('locations', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
