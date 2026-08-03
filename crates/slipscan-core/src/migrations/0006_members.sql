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
    UNIQUE (book_id, label)
);

CREATE INDEX members_book_idx ON members (book_id);
CREATE INDEX members_default_account_idx ON members (default_account_id);

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
