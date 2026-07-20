-- =============================================================================
-- Migration 0500: household members & per-person attribution.
--
-- A book can belong to a household of several people sharing one set of
-- books. Members are local data, never logins — a label, initial/colour, and
-- an optional default account they own (ARCHITECTURE.md "Household members
-- & per-person attribution"). Attribution is metadata on a transaction (who
-- actually incurred it), orthogonal to the ledger: it never touches
-- journals/journal_lines, so double-entry integrity is untouched.
--
-- Backward compatible: attributed_member_id is additive and nullable —
-- every pre-existing transaction becomes NULL (unattributed), and a book
-- with zero members keeps working exactly as before.
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

-- Who actually incurred the transaction — independent of which account it
-- hit. NULL is the only state a pre-existing transaction can be in after
-- this migration, and stays a legitimate "unattributed" state going
-- forward.
ALTER TABLE transactions
    ADD COLUMN attributed_member_id TEXT REFERENCES members (id) ON DELETE SET NULL;

CREATE INDEX transactions_attributed_member_idx
    ON transactions (book_id, attributed_member_id);

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
