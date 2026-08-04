-- =============================================================================
-- Migration 0006: household members & per-person attribution.
--
-- A book can belong to a household of several people sharing one set of
-- books. Members are local data, never logins — a label, initial/colour, and
-- an optional default account they own (ARCHITECTURE.md "Household members
-- & per-person attribution"). Attribution is metadata on a transaction (who
-- actually incurred it), orthogonal to the ledger: it never touches
-- journals/journal_lines, so double-entry integrity is untouched.
--
-- `transactions.attributed_member_id` (and its index) lives on `transactions`
-- itself, in migration 0001 — see the comment there. NULL is the only state
-- a book with zero members ever has, and stays a legitimate "unattributed"
-- state going forward, not a placeholder for one.
--
-- Splits: a transaction may be split across members as (member, share_minor)
-- rows summing to the transaction's absolute amount — the extension of the
-- single-member case. The sum invariant is enforced in the service layer
-- (transaction_split_set); SQLite CHECK constraints cannot express a
-- cross-row sum.
--
-- -----------------------------------------------------------------------------
-- Members become principals (docs/ROLES.md).
-- -----------------------------------------------------------------------------
--
-- A household member and staff who is paid to be there turn out to be the
-- same table (ROLES.md "People are members, not a parallel table") with two
-- flags distinguishing them:
--
--   attributable  appears in "whose spend is this" — the original purpose.
--   principal     may act — holds capabilities and devices. **Monotonic**:
--                 set true once (by `member_capability_grant`, the moment a
--                 member first holds an operation) and never reset to false,
--                 because `member_remove`'s principal guard below has to
--                 refuse a member who *ever* held authority, not just one
--                 who holds it right now.
--
-- `status`/`revoked_at` give a person the same tombstone `device_peers`
-- already gives a device key: revocation keeps the row (audit history and
-- capability grants point at it) instead of deleting it. That is also why
-- `UNIQUE (book_id, label)` had to go — it would let a revoked person's
-- label block the next hire forever. `members_active_label_idx` below is a
-- partial index over `status = 'active'` rows only, so a revoked label is
-- released for reuse while the revoked row itself stays put.
--
-- **This is the data model and lifecycle only.** Nothing here, and nothing
-- in `CoreService`, refuses an operation because a capability is missing —
-- the enforcement boundary is HTTP/IPC, and that is not built yet. See
-- ROLES.md for the full design and what still does not exist.
-- =============================================================================

CREATE TABLE members (
    id                 TEXT PRIMARY KEY,
    book_id            TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    label              TEXT NOT NULL,
    initial            TEXT NOT NULL,
    colour             TEXT NOT NULL,
    -- The account this member owns by default; new transactions on it
    -- attribute to this member unless overridden. NULL = no default.
    default_account_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    -- Tombstone, exactly like `device_peers.revoked_at`: a revoked person
    -- keeps the row (their attributions and capability history point at it)
    -- and simply stops being able to act. `member_revoke` is the only writer
    -- of 'revoked'/`revoked_at`; nothing here ever un-revokes.
    status             TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    revoked_at         TEXT,
    -- Whether this member appears in "whose spend is this" (attribution /
    -- splits). A till operator who never incurs household spend can be
    -- `principal` with `attributable = 0`; a household member is the
    -- reverse. No setter exists yet — every member starts attributable,
    -- which is the only case the product has today.
    attributable       INTEGER NOT NULL DEFAULT 1 CHECK (attributable IN (0, 1)),
    -- May hold capabilities and devices. See the monotonic note above.
    principal          INTEGER NOT NULL DEFAULT 0 CHECK (principal IN (0, 1))
);

CREATE INDEX members_book_idx ON members (book_id);
CREATE INDEX members_default_account_idx ON members (default_account_id);
-- Replaces `UNIQUE (book_id, label)` (see the header above): active rows
-- only, so a revoked person's label is released for the next hire while
-- their own row, and every attribution pointing at it, stays exactly where
-- it was.
CREATE UNIQUE INDEX members_active_label_idx
    ON members (book_id, label) WHERE status = 'active';

-- Sync capture. See migration 0008's header for why this is a trigger and
-- the full replicated table list.
CREATE TRIGGER sync_capture_members_ins AFTER INSERT ON members
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('members', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_members_upd AFTER UPDATE ON members
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('members', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_members_del AFTER DELETE ON members
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('members', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- member_id is intentionally NOT NULL and ON DELETE RESTRICT: "unattributed"
-- is expressed by the absence of a split row, never a NULL member on one — a
-- member with live splits must be reassigned or cleared before the member
-- row can be removed (member_remove in the service layer guarantees this
-- before ever reaching this constraint).
CREATE TABLE transaction_splits (
    id             TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    book_id        TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    member_id      TEXT NOT NULL REFERENCES members (id) ON DELETE RESTRICT,
    share_minor    INTEGER NOT NULL CHECK (share_minor > 0),
    created_at     TEXT NOT NULL,
    UNIQUE (transaction_id, member_id)
);

CREATE INDEX transaction_splits_txn_idx ON transaction_splits (transaction_id);
CREATE INDEX transaction_splits_member_idx ON transaction_splits (member_id);

-- Sync capture. See migration 0008's header for why this is a trigger and
-- the full replicated table list.
CREATE TRIGGER sync_capture_transaction_splits_ins AFTER INSERT ON transaction_splits
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transaction_splits', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_transaction_splits_upd AFTER UPDATE ON transaction_splits
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transaction_splits', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_transaction_splits_del AFTER DELETE ON transaction_splits
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transaction_splits', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Capabilities: the set of named operations a principal holds (ROLES.md
-- "Authority is a set of operations, not table permissions"). One row per
-- granted operation — `CoreService::member_capability_grant` inserts,
-- `member_capability_revoke` deletes, nothing ever updates a row in place,
-- so there is no field on this table that changes value under a live id the
-- way `members.label` can.
--
-- `book_id` is denormalized from `members.book_id` (the same choice
-- `transaction_splits.book_id` already makes off the same table), needed
-- for a per-book scan and so the sync capture triggers below have a
-- namespace to stamp without a subquery.
--
-- **Sync decision: replicated, LWW, same as `members` itself.** Today's
-- sync model (docs/NODES.md) is device-to-device between an owner's own
-- fully-trusted devices, each holding a complete local copy of the book —
-- there is no keyless thin client yet for `sync` to reach at all (that is
-- the mobile phase ROLES.md defers). A grant made from one of the owner's
-- devices has to be visible on the other, so it belongs on the same list
-- `members` is already on, not on the not-replicated list beside
-- `device_peers` (a *device's* pin is deliberately local-only — "a peer's
-- opinion of who to trust is exactly what must not replicate", migration
-- 0008's header — but a *capability grant* is authored data about a person,
-- exactly like their label or colour, not an opinion about a key). A grant
-- and its matching revoke are each an ordinary insert/delete on this table,
-- so last-writer-wins resolves a concurrent grant/revoke on two devices the
-- same way it already resolves a concurrent label edit: the later HLC
-- stamp wins, and the row's own presence or absence is the state, exactly
-- like `transaction_splits`.
CREATE TABLE member_capabilities (
    id         TEXT PRIMARY KEY,
    book_id    TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    -- CASCADE, not RESTRICT: `member_remove`'s own principal guard is what
    -- actually stops a capability-holder from being deleted (a member with
    -- any capability row is `principal`, and `member_remove` refuses any
    -- member that is or ever was one — see `service.rs`). This FK exists
    -- for the ordinary non-principal case, where it can never fire, and as
    -- a second line of defence rather than a first.
    member_id  TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
    operation  TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    UNIQUE (member_id, operation)
);

CREATE INDEX member_capabilities_member_idx ON member_capabilities (member_id);
CREATE INDEX member_capabilities_book_idx ON member_capabilities (book_id);

-- Sync capture. See migration 0008's header for why this is a trigger and
-- the full replicated table list.
CREATE TRIGGER sync_capture_member_capabilities_ins AFTER INSERT ON member_capabilities
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('member_capabilities', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_member_capabilities_upd AFTER UPDATE ON member_capabilities
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('member_capabilities', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_member_capabilities_del AFTER DELETE ON member_capabilities
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('member_capabilities', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
