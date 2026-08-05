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
--
-- SlipScan has never shipped, so this whole schema is one baseline rather
-- than a chain of patches applied to deployed databases: every table below
-- is created once, in its final shape, with its own indexes and triggers
-- beside it. A handful of columns — `books.region`, `chart_of_accounts.
-- currency`, `journals.reversal_of`, `journal_lines.vat_rate_id`/`vat_role`,
-- `recon_matches.merchant_score`, `transactions.attributed_member_id` — read
-- as if spliced onto an already-created table, because that is literally
-- what produced their stored `CREATE TABLE` text (SQLite's column-add
-- machinery rewrites a table's stored schema text in place rather than
-- reissuing it), and that exact text is preserved verbatim here rather than
-- reformatted, so the schema this migration produces is byte-identical to
-- the one the original migration sequence produced. The design reasoning
-- for each of those columns lives in a comment beside its table, same as
-- everything else.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Books: a ledgerable context (personal / business). Replaces legacy orgs.
--
-- `region` names the region profile driving a book's chart-of-accounts
-- seeds, tax rate table and tax-report labels ("global by default — regions
-- are data"). Profiles themselves are embedded data in slipscan-core
-- (src/region.rs), not rows: `CoreService::book_create` takes an explicit
-- region if given one, otherwise infers one from `country`
-- (`crate::region::for_country`), falling back to 'generic'. The
-- `DEFAULT 'ZAR'` on `currency` above is vestigial in the same sense —
-- `book_create` always binds an explicit, profile-resolved currency, so no
-- row is ever created relying on that default.
--
-- `multi_location_override` is Phase 6.0's one piece of persisted state
-- (ROADMAP.md "Phase 6" decision #3): personal vs. business vs. business
-- multi-location is otherwise pure display logic computed by
-- `crate::profile::resolve` from `kind` plus a `COUNT(*)` over `locations`
-- (migration 0009) — never a stored flag that could drift out of step with
-- how many locations actually exist. NULL (the default, and what every book
-- created before this axis existed implicitly has) means "derive it";
-- 0/1 pins the flag either way. The one case derivation gets wrong is a
-- business setting up its first branch that wants the location UI before a
-- second `locations` row exists — this column is that override and nothing
-- else, which is why it lives beside `kind` rather than in `settings`
-- (`settings` is a single global key/value table, not per-book, so it
-- cannot hold a per-book override at all).
-- -----------------------------------------------------------------------------

CREATE TABLE books (
    id                       TEXT PRIMARY KEY,
    kind                     TEXT NOT NULL CHECK (kind IN ('personal', 'business')),
    name                     TEXT NOT NULL,
    currency                 TEXT NOT NULL DEFAULT 'ZAR' CHECK (length(currency) = 3),
    country                  TEXT CHECK (country IS NULL OR length(country) = 2),
    locale                   TEXT NOT NULL DEFAULT 'en',
    timezone                 TEXT NOT NULL DEFAULT 'UTC',
    financial_lock_date      TEXT,
    multi_location_override  INTEGER CHECK (multi_location_override IN (0, 1)),
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
, region TEXT NOT NULL DEFAULT 'generic');

-- Sync capture (docs/NODES.md phase 2 — see migration 0008's header for why
-- this is a trigger rather than a call from the repo layer, and for the full
-- replicated/not-replicated table list). A book row is its own namespace: it
-- has no `book_id` column of its own to take one from.
CREATE TRIGGER sync_capture_books_ins AFTER INSERT ON books
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('books', NEW.id, NEW.id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_books_upd AFTER UPDATE ON books
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('books', NEW.id, NEW.id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_books_del AFTER DELETE ON books
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('books', OLD.id, OLD.id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

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

-- Sync capture. See migration 0008's header for why this is a trigger and
-- the full replicated table list.
CREATE TRIGGER sync_capture_accounts_ins AFTER INSERT ON accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('accounts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_accounts_upd AFTER UPDATE ON accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('accounts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_accounts_del AFTER DELETE ON accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('accounts', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

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

-- Sync capture. See migration 0008's header for why this is a trigger and
-- the full replicated table list.
CREATE TRIGGER sync_capture_categories_ins AFTER INSERT ON categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('categories', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_categories_upd AFTER UPDATE ON categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('categories', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_categories_del AFTER DELETE ON categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('categories', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- -----------------------------------------------------------------------------
-- Documents: receipts / slips / statements + extraction results (slip-v2).
--
-- Not sync-replicated: a document row is a pointer into the movable data
-- folder, and replicating the pointer without the bytes would land a broken
-- reference on the peer. Needs blob transport, which does not exist yet
-- (see migration 0008's header).
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
--
-- `attributed_member_id` records who actually incurred the transaction,
-- independent of which account it hit — a household can share one set of
-- books with several people, and this is metadata on a transaction rather
-- than a ledger concept: it never touches journals/journal_lines, so
-- double-entry integrity is untouched. NULL means unattributed, which is a
-- legitimate, permanent state for a book with zero members, not a
-- placeholder for one. The `members` table itself is defined later, in
-- migration 0006 — the forward reference below is fine in SQLite, which does
-- not require a `REFERENCES` target to exist yet at `CREATE TABLE` time, only
-- by the time a foreign key is actually checked.
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
, attributed_member_id TEXT REFERENCES members (id) ON DELETE SET NULL);

CREATE INDEX transactions_book_date_idx ON transactions (book_id, posted_date DESC);
CREATE INDEX transactions_book_category_idx ON transactions (book_id, category_id);
CREATE INDEX transactions_account_idx ON transactions (account_id);
CREATE INDEX transactions_document_idx ON transactions (document_id);
CREATE UNIQUE INDEX transactions_provider_dedupe_unique
    ON transactions (account_id, provider_txn_id) WHERE provider_txn_id IS NOT NULL;
CREATE UNIQUE INDEX transactions_hash_dedupe_unique
    ON transactions (account_id, dedupe_hash);
CREATE INDEX transactions_attributed_member_idx
    ON transactions (book_id, attributed_member_id);

-- Sync capture. See migration 0008's header for why this is a trigger and
-- the full replicated table list.
CREATE TRIGGER sync_capture_transactions_ins AFTER INSERT ON transactions
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transactions', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_transactions_upd AFTER UPDATE ON transactions
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transactions', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_transactions_del AFTER DELETE ON transactions
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transactions', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

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

-- Sync capture. See migration 0008's header for why this is a trigger and
-- the full replicated table list.
CREATE TRIGGER sync_capture_merchant_mappings_ins AFTER INSERT ON merchant_mappings
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('merchant_mappings', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_merchant_mappings_upd AFTER UPDATE ON merchant_mappings
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('merchant_mappings', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_merchant_mappings_del AFTER DELETE ON merchant_mappings
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('merchant_mappings', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Not sync-replicated: a local learning log, not shared state (see migration
-- 0008's header for the full not-replicated list).
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

-- Sync capture. See migration 0008's header for why this is a trigger and
-- the full replicated table list.
CREATE TRIGGER sync_capture_budgets_ins AFTER INSERT ON budgets
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('budgets', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_budgets_upd AFTER UPDATE ON budgets
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('budgets', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_budgets_del AFTER DELETE ON budgets
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('budgets', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- -----------------------------------------------------------------------------
-- Double-entry ledger: chart of accounts, journals, journal lines, VAT rates.
--
-- `chart_of_accounts.currency` is multi-currency groundwork: an optional
-- fixed currency on a chart-of-accounts entry, NULL meaning "follows the
-- book / any currency". There is no FX revaluation yet.
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
    updated_at  TEXT NOT NULL, currency TEXT
    CHECK (currency IS NULL OR length(currency) = 3),
    UNIQUE (book_id, code)
);

CREATE INDEX chart_of_accounts_book_kind_idx ON chart_of_accounts (book_id, kind);

-- Sync capture. See migration 0008's header for why this is a trigger and
-- the full replicated table list.
CREATE TRIGGER sync_capture_chart_of_accounts_ins AFTER INSERT ON chart_of_accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('chart_of_accounts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_chart_of_accounts_upd AFTER UPDATE ON chart_of_accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('chart_of_accounts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_chart_of_accounts_del AFTER DELETE ON chart_of_accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('chart_of_accounts', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Journals: posted entries are immutable by construction. `reversal_of`
-- points at the journal a reversal cancels; a journal can be reversed at
-- most once (enforced by the unique index below). A correction is therefore
-- always a new journal, never an edit — `journals_no_update`/`_no_delete`
-- make SQLite itself refuse the alternative, so replication (migration
-- 0008) can give this table an INSERT-only capture trigger and mean it.
CREATE TABLE journals (
    id          TEXT PRIMARY KEY,
    book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    posted_date TEXT NOT NULL,
    narrative   TEXT,
    reference   TEXT,
    -- Four of these sources are posted automatically by Phase 6.6's trade
    -- postings (`post_po_receipt_journal`, `post_sales_confirm_journals`,
    -- `reverse_sales_confirm_journals`, `post_invoice_payment_journal`).
    -- `post_journal_in_tx` keeps one net-live generated journal per
    -- (source_type, source_id), so receiving/confirming/paying the same id
    -- twice cannot double-post. A confirmed sale is deliberately two
    -- journals sharing one source_id — the cost/inventory leg and the
    -- revenue/AR/VAT leg — so a cancellation can reverse either on its own,
    -- and so a book seeded with only one side still gets a coherent posting.
    -- `depreciation` (migration 0016, fixed-asset register) is posted by
    -- `CoreService::depreciation_run`, one journal per (asset, period) —
    -- `source_id` is the owning `asset_depreciation_runs` row's own id, the
    -- same "the row is the source" idiom `po_receipt`/`invoice_payment`
    -- already use.
    source_type TEXT NOT NULL DEFAULT 'manual'
        CHECK (source_type IN (
            'manual', 'transaction', 'document', 'opening_balance',
            'po_receipt', 'sales_cogs', 'sales_revenue', 'invoice_payment',
            'depreciation'
        )),
    source_id   TEXT,
    created_at  TEXT NOT NULL,
    reversal_of TEXT REFERENCES journals (id)
);

CREATE INDEX journals_book_date_idx ON journals (book_id, posted_date DESC);
CREATE UNIQUE INDEX journals_reversal_of_unique
    ON journals (reversal_of) WHERE reversal_of IS NOT NULL;

CREATE TRIGGER journals_no_update
BEFORE UPDATE ON journals
BEGIN
    SELECT RAISE(ABORT, 'posted journals are immutable; post a reversal instead');
END;

CREATE TRIGGER journals_no_delete
BEFORE DELETE ON journals
BEGIN
    SELECT RAISE(ABORT, 'posted journals are immutable; post a reversal instead');
END;

-- Sync capture: INSERT only. `journals_no_update`/`_no_delete` above make an
-- UPDATE/DELETE capture trigger unreachable code, and writing one would
-- suggest the statement it captures is possible.
CREATE TRIGGER sync_capture_journals_ins AFTER INSERT ON journals
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('journals', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Journal lines. VAT capture: `vat_rate_id` + `vat_role` tag a line's role in
-- the VAT return so input/output VAT (and their bases) can be summed
-- straight into a VAT201-style report —
--   output_vat  — VAT charged on sales (credit on the VAT output control)
--   input_vat   — VAT paid on purchases (debit on the VAT input control)
--   output_base — the sale amount the output VAT was computed from
--   input_base  — the purchase amount the input VAT was computed from
-- `journal_lines_no_update`/`_no_delete` give this table the same
-- reversal-not-edit guarantee as `journals`, for the same reason.
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
    created_at   TEXT NOT NULL, vat_rate_id TEXT REFERENCES vat_rates (id), vat_role TEXT
    CHECK (vat_role IS NULL OR vat_role IN ('output_vat', 'input_vat', 'output_base', 'input_base')),
    CHECK (
        (debit_minor = 0 AND credit_minor > 0)
        OR (credit_minor = 0 AND debit_minor > 0)
    )
);

CREATE INDEX journal_lines_journal_idx ON journal_lines (journal_id);
CREATE INDEX journal_lines_coa_idx ON journal_lines (coa_id);
CREATE INDEX journal_lines_book_idx ON journal_lines (book_id);
CREATE INDEX journal_lines_vat_role_idx
    ON journal_lines (book_id, vat_role) WHERE vat_role IS NOT NULL;

CREATE TRIGGER journal_lines_no_update
BEFORE UPDATE ON journal_lines
BEGIN
    SELECT RAISE(ABORT, 'posted journal lines are immutable; post a reversal instead');
END;

CREATE TRIGGER journal_lines_no_delete
BEFORE DELETE ON journal_lines
BEGIN
    SELECT RAISE(ABORT, 'posted journal lines are immutable; post a reversal instead');
END;

-- Sync capture: INSERT only, for the same reason as `journals` above.
CREATE TRIGGER sync_capture_journal_lines_ins AFTER INSERT ON journal_lines
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('journal_lines', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

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

-- Sync capture. See migration 0008's header for why this is a trigger and
-- the full replicated table list.
CREATE TRIGGER sync_capture_vat_rates_ins AFTER INSERT ON vat_rates
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('vat_rates', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_vat_rates_upd AFTER UPDATE ON vat_rates
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('vat_rates', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_vat_rates_del AFTER DELETE ON vat_rates
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('vat_rates', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- -----------------------------------------------------------------------------
-- Reconciliation: documents ↔ transactions ↔ journals.
--
-- `merchant_score` is the merchant-similarity component of a reconciliation
-- match (0..1), alongside the existing amount/date deltas. Not
-- sync-replicated: this table references documents and follows them (see
-- migration 0008's header for the full not-replicated list).
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
, merchant_score REAL NOT NULL DEFAULT 0.0
    CHECK (merchant_score >= 0.0 AND merchant_score <= 1.0));

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
