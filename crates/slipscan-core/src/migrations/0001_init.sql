-- =============================================================================
-- Migration 0001: SlipScan v1 schema (SQLite).
--
-- Adapted from the legacy Postgres schema with all cloud concepts removed:
-- no orgs/members/invitations, no billing, no auth/JWT/api tokens, no email
-- outbox, no workspaces. `books` replaces organizations; everything is scoped
-- by book_id inside a single user-owned SQLite file.
--
-- Conventions:
--   * ids           TEXT, UUID v7 strings
--   * timestamps    TEXT, ISO-8601 / RFC 3339 UTC
--   * dates         TEXT, YYYY-MM-DD
--   * money         INTEGER minor units (never floats) + ISO-4217 currency
--   * booleans      INTEGER 0/1
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Books: a ledgerable context (personal / business). Replaces legacy orgs.
-- -----------------------------------------------------------------------------

CREATE TABLE books (
    id                  TEXT PRIMARY KEY,
    kind                TEXT NOT NULL CHECK (kind IN ('personal', 'business')),
    name                TEXT NOT NULL,
    currency            TEXT NOT NULL DEFAULT 'ZAR' CHECK (length(currency) = 3),
    country             TEXT CHECK (country IS NULL OR length(country) = 2),
    locale              TEXT NOT NULL DEFAULT 'en',
    timezone            TEXT NOT NULL DEFAULT 'UTC',
    financial_lock_date TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- Accounts: personal-finance view (bank / cash / card / asset / liability).
-- -----------------------------------------------------------------------------

CREATE TABLE accounts (
    id                    TEXT PRIMARY KEY,
    book_id               TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    kind                  TEXT NOT NULL
        CHECK (kind IN ('bank', 'cash', 'card', 'asset', 'liability')),
    currency              TEXT NOT NULL CHECK (length(currency) = 3),
    institution           TEXT,
    account_number_masked TEXT,
    opening_balance_minor INTEGER NOT NULL DEFAULT 0,
    is_archived           INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);

CREATE INDEX accounts_book_idx ON accounts (book_id);

-- -----------------------------------------------------------------------------
-- Categories: hierarchical, per book.
-- -----------------------------------------------------------------------------

CREATE TABLE categories (
    id         TEXT PRIMARY KEY,
    book_id    TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    parent_id  TEXT REFERENCES categories (id) ON DELETE RESTRICT,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer')),
    icon       TEXT,
    color      TEXT,
    is_system  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX categories_book_kind_idx ON categories (book_id, kind);
CREATE INDEX categories_parent_idx ON categories (parent_id);
-- SQLite treats NULLs as distinct in UNIQUE constraints, so root categories
-- need their own uniqueness guard.
CREATE UNIQUE INDEX categories_sibling_name_unique
    ON categories (book_id, parent_id, name) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX categories_root_name_unique
    ON categories (book_id, name) WHERE parent_id IS NULL;

-- -----------------------------------------------------------------------------
-- Documents: receipts / slips / statements + extraction results (slip-v2).
-- -----------------------------------------------------------------------------

CREATE TABLE documents (
    id            TEXT PRIMARY KEY,
    book_id       TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    source        TEXT NOT NULL CHECK (source IN ('upload', 'email', 'import')),
    kind          TEXT NOT NULL DEFAULT 'unknown'
        CHECK (kind IN ('slip', 'invoice', 'bank_statement', 'unknown')),
    file_path     TEXT NOT NULL,
    mime_type     TEXT,
    size_bytes    INTEGER,
    original_name TEXT,
    sha256        TEXT,
    status        TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'extracted', 'reviewed', 'failed')),
    error         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE INDEX documents_book_created_idx ON documents (book_id, created_at DESC);
CREATE INDEX documents_book_status_idx ON documents (book_id, status);
CREATE UNIQUE INDEX documents_sha256_unique
    ON documents (book_id, sha256) WHERE sha256 IS NOT NULL;

CREATE TABLE document_extractions (
    id          TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    provider    TEXT,
    model       TEXT,
    status      TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'extracted', 'reviewed', 'failed')),
    -- slip-v2 JSON payload (schema lives in slipscan-extract)
    payload     TEXT,
    error       TEXT,
    is_current  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE INDEX document_extractions_doc_idx
    ON document_extractions (document_id, created_at DESC);
CREATE UNIQUE INDEX document_extractions_current_unique
    ON document_extractions (document_id) WHERE is_current = 1;

-- -----------------------------------------------------------------------------
-- Transactions: bank-level, deduped by (account, provider_txn_id | hash).
-- -----------------------------------------------------------------------------

CREATE TABLE transactions (
    id                  TEXT PRIMARY KEY,
    book_id             TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    account_id          TEXT NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
    category_id         TEXT REFERENCES categories (id) ON DELETE SET NULL,
    document_id         TEXT REFERENCES documents (id) ON DELETE SET NULL,
    source              TEXT NOT NULL
        CHECK (source IN ('scraper', 'email', 'import', 'manual')),
    provider_txn_id     TEXT,
    dedupe_hash         TEXT NOT NULL,
    posted_date         TEXT NOT NULL,
    amount_minor        INTEGER NOT NULL,
    currency            TEXT NOT NULL CHECK (length(currency) = 3),
    merchant            TEXT,
    merchant_normalized TEXT,
    description         TEXT,
    notes               TEXT,
    status              TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verified', 'rejected')),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX transactions_book_date_idx ON transactions (book_id, posted_date DESC);
CREATE INDEX transactions_book_category_idx ON transactions (book_id, category_id);
CREATE INDEX transactions_account_idx ON transactions (account_id);
CREATE INDEX transactions_document_idx ON transactions (document_id);
CREATE UNIQUE INDEX transactions_provider_dedupe_unique
    ON transactions (account_id, provider_txn_id) WHERE provider_txn_id IS NOT NULL;
CREATE UNIQUE INDEX transactions_hash_dedupe_unique
    ON transactions (account_id, dedupe_hash);

-- -----------------------------------------------------------------------------
-- Classification: merchant → category mappings + local correction log.
-- Learning loop stays local; packs only ship rules.
-- -----------------------------------------------------------------------------

CREATE TABLE merchant_mappings (
    id                  TEXT PRIMARY KEY,
    book_id             TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    merchant_normalized TEXT NOT NULL,
    category_id         TEXT NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
    source              TEXT NOT NULL DEFAULT 'user'
        CHECK (source IN ('user', 'rule', 'llm', 'pack', 'system')),
    confidence          REAL NOT NULL DEFAULT 1.0
        CHECK (confidence >= 0.0 AND confidence <= 1.0),
    applied_count       INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE (book_id, merchant_normalized)
);

CREATE TABLE classification_corrections (
    id                  TEXT PRIMARY KEY,
    book_id             TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    transaction_id      TEXT NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    merchant_normalized TEXT,
    old_category_id     TEXT REFERENCES categories (id) ON DELETE SET NULL,
    new_category_id     TEXT REFERENCES categories (id) ON DELETE SET NULL,
    created_at          TEXT NOT NULL
);

CREATE INDEX classification_corrections_book_idx
    ON classification_corrections (book_id, created_at DESC);
CREATE INDEX classification_corrections_merchant_idx
    ON classification_corrections (merchant_normalized);

-- -----------------------------------------------------------------------------
-- Budgets: per-category monthly budgets with rollover.
-- -----------------------------------------------------------------------------

CREATE TABLE budgets (
    id           TEXT PRIMARY KEY,
    book_id      TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    category_id  TEXT NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
    month        TEXT NOT NULL
        CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
    currency     TEXT NOT NULL CHECK (length(currency) = 3),
    rollover     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE (book_id, category_id, month)
);

CREATE INDEX budgets_book_month_idx ON budgets (book_id, month);

-- -----------------------------------------------------------------------------
-- Double-entry ledger: chart of accounts, journals, journal lines, VAT rates.
-- -----------------------------------------------------------------------------

CREATE TABLE chart_of_accounts (
    id          TEXT PRIMARY KEY,
    book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    code        TEXT NOT NULL,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL
        CHECK (kind IN ('asset', 'liability', 'equity', 'income', 'expense')),
    description TEXT,
    is_archived INTEGER NOT NULL DEFAULT 0,
    is_system   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (book_id, code)
);

CREATE INDEX chart_of_accounts_book_kind_idx ON chart_of_accounts (book_id, kind);

CREATE TABLE journals (
    id          TEXT PRIMARY KEY,
    book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    posted_date TEXT NOT NULL,
    narrative   TEXT,
    reference   TEXT,
    source_type TEXT NOT NULL DEFAULT 'manual'
        CHECK (source_type IN ('manual', 'transaction', 'document', 'opening_balance')),
    source_id   TEXT,
    created_at  TEXT NOT NULL
);

CREATE INDEX journals_book_date_idx ON journals (book_id, posted_date DESC);

CREATE TABLE journal_lines (
    id           TEXT PRIMARY KEY,
    journal_id   TEXT NOT NULL REFERENCES journals (id) ON DELETE CASCADE,
    book_id      TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    coa_id       TEXT NOT NULL REFERENCES chart_of_accounts (id) ON DELETE RESTRICT,
    debit_minor  INTEGER NOT NULL DEFAULT 0,
    credit_minor INTEGER NOT NULL DEFAULT 0,
    currency     TEXT NOT NULL CHECK (length(currency) = 3),
    description  TEXT,
    line_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    CHECK (
        (debit_minor = 0 AND credit_minor > 0)
        OR (credit_minor = 0 AND debit_minor > 0)
    )
);

CREATE INDEX journal_lines_journal_idx ON journal_lines (journal_id);
CREATE INDEX journal_lines_coa_idx ON journal_lines (coa_id);
CREATE INDEX journal_lines_book_idx ON journal_lines (book_id);

CREATE TABLE vat_rates (
    id         TEXT PRIMARY KEY,
    book_id    TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    code       TEXT NOT NULL,
    name       TEXT NOT NULL,
    -- basis points: 1500 = 15.00%
    rate_bps   INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
    country    TEXT CHECK (country IS NULL OR length(country) = 2),
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (book_id, code)
);

-- -----------------------------------------------------------------------------
-- Reconciliation: documents ↔ transactions ↔ journals.
-- -----------------------------------------------------------------------------

CREATE TABLE recon_matches (
    id                 TEXT PRIMARY KEY,
    book_id            TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    transaction_id     TEXT NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    document_id        TEXT REFERENCES documents (id) ON DELETE CASCADE,
    journal_id         TEXT REFERENCES journals (id) ON DELETE CASCADE,
    state              TEXT NOT NULL DEFAULT 'suggested'
        CHECK (state IN ('auto', 'suggested', 'confirmed', 'rejected')),
    confidence         REAL NOT NULL DEFAULT 0.0
        CHECK (confidence >= 0.0 AND confidence <= 1.0),
    amount_delta_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_delta_minor >= 0),
    date_delta_days    INTEGER NOT NULL DEFAULT 0 CHECK (date_delta_days >= 0),
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

CREATE INDEX recon_matches_book_state_idx ON recon_matches (book_id, state);
CREATE INDEX recon_matches_document_idx ON recon_matches (document_id);
-- No-double-match: a transaction may appear at most once in non-rejected rows.
CREATE UNIQUE INDEX recon_matches_tx_active_unique
    ON recon_matches (transaction_id) WHERE state <> 'rejected';

-- -----------------------------------------------------------------------------
-- Audit log: append-only, local. UPDATE/DELETE are blocked by triggers.
-- -----------------------------------------------------------------------------

CREATE TABLE audit_log (
    id          TEXT PRIMARY KEY,
    book_id     TEXT,
    entity_type TEXT NOT NULL,
    entity_id   TEXT,
    action      TEXT NOT NULL,
    before_json TEXT,
    after_json  TEXT,
    created_at  TEXT NOT NULL
);

CREATE INDEX audit_log_book_created_idx ON audit_log (book_id, created_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- -----------------------------------------------------------------------------
-- Settings: key/value. Secret values live in the OS keychain; the row only
-- stores the keychain entry name (secret_ref). Never plaintext secrets here.
-- -----------------------------------------------------------------------------

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    secret_ref TEXT,
    updated_at TEXT NOT NULL
);
