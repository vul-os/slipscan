-- index accounts_book_idx
CREATE INDEX accounts_book_idx ON accounts (book_id);

-- index audit_log_book_created_idx
CREATE INDEX audit_log_book_created_idx ON audit_log (book_id, created_at DESC);

-- index audit_log_entity_idx
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

-- index budgets_book_month_idx
CREATE INDEX budgets_book_month_idx ON budgets (book_id, month);

-- index categories_book_kind_idx
CREATE INDEX categories_book_kind_idx ON categories (book_id, kind);

-- index categories_parent_idx
CREATE INDEX categories_parent_idx ON categories (parent_id);

-- index categories_root_name_unique
CREATE UNIQUE INDEX categories_root_name_unique
    ON categories (book_id, name) WHERE parent_id IS NULL;

-- index categories_sibling_name_unique
CREATE UNIQUE INDEX categories_sibling_name_unique
    ON categories (book_id, parent_id, name) WHERE parent_id IS NOT NULL;

-- index chart_of_accounts_book_kind_idx
CREATE INDEX chart_of_accounts_book_kind_idx ON chart_of_accounts (book_id, kind);

-- index classification_corrections_book_idx
CREATE INDEX classification_corrections_book_idx
    ON classification_corrections (book_id, created_at DESC);

-- index classification_corrections_merchant_idx
CREATE INDEX classification_corrections_merchant_idx
    ON classification_corrections (merchant_normalized);

-- index coa_map_coa_idx
CREATE INDEX coa_map_coa_idx ON coa_map (coa_id);

-- index contacts_book_idx
CREATE INDEX contacts_book_idx ON contacts (book_id);

-- index contacts_book_role_idx
CREATE INDEX contacts_book_role_idx ON contacts (book_id, role);

-- index document_extractions_current_unique
CREATE UNIQUE INDEX document_extractions_current_unique
    ON document_extractions (document_id) WHERE is_current = 1;

-- index document_extractions_doc_idx
CREATE INDEX document_extractions_doc_idx
    ON document_extractions (document_id, created_at DESC);

-- index documents_book_created_idx
CREATE INDEX documents_book_created_idx ON documents (book_id, created_at DESC);

-- index documents_book_status_idx
CREATE INDEX documents_book_status_idx ON documents (book_id, status);

-- index documents_sha256_unique
CREATE UNIQUE INDEX documents_sha256_unique
    ON documents (book_id, sha256) WHERE sha256 IS NOT NULL;

-- index idx_device_pair_invites_expires
CREATE INDEX idx_device_pair_invites_expires ON device_pair_invites (expires_at);

-- index journal_lines_book_idx
CREATE INDEX journal_lines_book_idx ON journal_lines (book_id);

-- index journal_lines_coa_idx
CREATE INDEX journal_lines_coa_idx ON journal_lines (coa_id);

-- index journal_lines_journal_idx
CREATE INDEX journal_lines_journal_idx ON journal_lines (journal_id);

-- index journal_lines_vat_role_idx
CREATE INDEX journal_lines_vat_role_idx
    ON journal_lines (book_id, vat_role) WHERE vat_role IS NOT NULL;

-- index journals_book_date_idx
CREATE INDEX journals_book_date_idx ON journals (book_id, posted_date DESC);

-- index journals_reversal_of_unique
CREATE UNIQUE INDEX journals_reversal_of_unique
    ON journals (reversal_of) WHERE reversal_of IS NOT NULL;

-- index journals_source_idx
CREATE INDEX journals_source_idx
    ON journals (book_id, source_type, source_id)
    WHERE source_id IS NOT NULL;

-- index locations_book_code_unique
CREATE UNIQUE INDEX locations_book_code_unique
    ON locations (book_id, code) WHERE code IS NOT NULL;

-- index locations_book_idx
CREATE INDEX locations_book_idx ON locations (book_id);

-- index members_book_idx
CREATE INDEX members_book_idx ON members (book_id);

-- index members_default_account_idx
CREATE INDEX members_default_account_idx ON members (default_account_id);

-- index networth_snapshots_account_date_idx
CREATE INDEX networth_snapshots_account_date_idx
    ON networth_snapshots (account_id, as_of_date);

-- index networth_snapshots_book_date_idx
CREATE INDEX networth_snapshots_book_date_idx
    ON networth_snapshots (book_id, as_of_date);

-- index pay_deliveries_due_idx
CREATE INDEX pay_deliveries_due_idx ON pay_deliveries (state, next_attempt_at);

-- index pay_endpoints_book_idx
CREATE INDEX pay_endpoints_book_idx ON pay_endpoints (book_id, enabled);

-- index pay_matches_book_idx
CREATE INDEX pay_matches_book_idx ON pay_matches (book_id, matched_at DESC);

-- index pay_watch_codes_book_idx
CREATE INDEX pay_watch_codes_book_idx ON pay_watch_codes (book_id, enabled);

-- index product_categories_book_idx
CREATE INDEX product_categories_book_idx ON product_categories (book_id);

-- index product_variants_book_idx
CREATE INDEX product_variants_book_idx ON product_variants (book_id);

-- index product_variants_product_idx
CREATE INDEX product_variants_product_idx ON product_variants (product_id);

-- index products_book_idx
CREATE INDEX products_book_idx ON products (book_id);

-- index products_category_idx
CREATE INDEX products_category_idx ON products (product_category_id);

-- index recon_matches_book_state_idx
CREATE INDEX recon_matches_book_state_idx ON recon_matches (book_id, state);

-- index recon_matches_document_idx
CREATE INDEX recon_matches_document_idx ON recon_matches (document_id);

-- index recon_matches_tx_active_unique
CREATE UNIQUE INDEX recon_matches_tx_active_unique
    ON recon_matches (transaction_id) WHERE state <> 'rejected';

-- index sqlite_autoindex_accounts_1
;

-- index sqlite_autoindex_audit_log_1
;

-- index sqlite_autoindex_books_1
;

-- index sqlite_autoindex_budgets_1
;

-- index sqlite_autoindex_budgets_2
;

-- index sqlite_autoindex_categories_1
;

-- index sqlite_autoindex_chart_of_accounts_1
;

-- index sqlite_autoindex_chart_of_accounts_2
;

-- index sqlite_autoindex_classification_corrections_1
;

-- index sqlite_autoindex_coa_map_1
;

-- index sqlite_autoindex_coa_map_2
;

-- index sqlite_autoindex_contacts_1
;

-- index sqlite_autoindex_device_identity_rotations_1
;

-- index sqlite_autoindex_device_pair_invites_1
;

-- index sqlite_autoindex_device_pair_invites_2
;

-- index sqlite_autoindex_device_peers_1
;

-- index sqlite_autoindex_document_extractions_1
;

-- index sqlite_autoindex_documents_1
;

-- index sqlite_autoindex_fx_rates_1
;

-- index sqlite_autoindex_journal_lines_1
;

-- index sqlite_autoindex_journals_1
;

-- index sqlite_autoindex_locations_1
;

-- index sqlite_autoindex_locations_2
;

-- index sqlite_autoindex_members_1
;

-- index sqlite_autoindex_members_2
;

-- index sqlite_autoindex_merchant_mappings_1
;

-- index sqlite_autoindex_merchant_mappings_2
;

-- index sqlite_autoindex_networth_snapshots_1
;

-- index sqlite_autoindex_pay_deliveries_1
;

-- index sqlite_autoindex_pay_endpoints_1
;

-- index sqlite_autoindex_pay_matches_1
;

-- index sqlite_autoindex_pay_matches_2
;

-- index sqlite_autoindex_pay_watch_codes_1
;

-- index sqlite_autoindex_product_categories_1
;

-- index sqlite_autoindex_product_categories_2
;

-- index sqlite_autoindex_product_variants_1
;

-- index sqlite_autoindex_product_variants_2
;

-- index sqlite_autoindex_products_1
;

-- index sqlite_autoindex_recon_matches_1
;

-- index sqlite_autoindex_settings_1
;

-- index sqlite_autoindex_stock_movements_1
;

-- index sqlite_autoindex_sync_oplog_1
;

-- index sqlite_autoindex_transaction_splits_1
;

-- index sqlite_autoindex_transaction_splits_2
;

-- index sqlite_autoindex_transactions_1
;

-- index sqlite_autoindex_vat_rates_1
;

-- index sqlite_autoindex_vat_rates_2
;

-- index sqlite_autoindex_vault_keys_1
;

-- index sqlite_autoindex_vault_secrets_1
;

-- index sqlite_autoindex_vault_secrets_2
;

-- index stock_movements_book_idx
CREATE INDEX stock_movements_book_idx ON stock_movements (book_id);

-- index stock_movements_location_idx
CREATE INDEX stock_movements_location_idx ON stock_movements (location_id);

-- index stock_movements_ref_idx
CREATE INDEX stock_movements_ref_idx
    ON stock_movements (ref_kind, ref_id) WHERE ref_id IS NOT NULL;

-- index stock_movements_variant_location_idx
CREATE INDEX stock_movements_variant_location_idx
    ON stock_movements (variant_id, location_id);

-- index sync_oplog_author_idx
CREATE INDEX sync_oplog_author_idx ON sync_oplog (author, hlc_wall, hlc_counter);

-- index sync_oplog_ns_idx
CREATE INDEX sync_oplog_ns_idx ON sync_oplog (ns, hlc_wall, hlc_counter);

-- index sync_oplog_order_idx
CREATE INDEX sync_oplog_order_idx ON sync_oplog (hlc_wall, hlc_counter, op_id);

-- index sync_outbox_row_idx
CREATE INDEX sync_outbox_row_idx ON sync_outbox (table_name, row_id, seq);

-- index transaction_splits_member_idx
CREATE INDEX transaction_splits_member_idx ON transaction_splits (member_id);

-- index transaction_splits_txn_idx
CREATE INDEX transaction_splits_txn_idx ON transaction_splits (transaction_id);

-- index transactions_account_idx
CREATE INDEX transactions_account_idx ON transactions (account_id);

-- index transactions_attributed_member_idx
CREATE INDEX transactions_attributed_member_idx
    ON transactions (book_id, attributed_member_id);

-- index transactions_book_category_idx
CREATE INDEX transactions_book_category_idx ON transactions (book_id, category_id);

-- index transactions_book_date_idx
CREATE INDEX transactions_book_date_idx ON transactions (book_id, posted_date DESC);

-- index transactions_document_idx
CREATE INDEX transactions_document_idx ON transactions (document_id);

-- index transactions_hash_dedupe_unique
CREATE UNIQUE INDEX transactions_hash_dedupe_unique
    ON transactions (account_id, dedupe_hash);

-- index transactions_provider_dedupe_unique
CREATE UNIQUE INDEX transactions_provider_dedupe_unique
    ON transactions (account_id, provider_txn_id) WHERE provider_txn_id IS NOT NULL;

-- table accounts
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

-- table audit_log
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

-- table books
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

-- table budgets
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

-- table categories
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

-- table chart_of_accounts
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

-- table classification_corrections
CREATE TABLE classification_corrections (
    id                  TEXT PRIMARY KEY,
    book_id             TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    transaction_id      TEXT NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    merchant_normalized TEXT,
    old_category_id     TEXT REFERENCES categories (id) ON DELETE SET NULL,
    new_category_id     TEXT REFERENCES categories (id) ON DELETE SET NULL,
    created_at          TEXT NOT NULL
);

-- table coa_map
CREATE TABLE coa_map (
    id          TEXT PRIMARY KEY,
    book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('account', 'category')),
    entity_id   TEXT NOT NULL,
    coa_id      TEXT NOT NULL REFERENCES chart_of_accounts (id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (book_id, entity_type, entity_id)
);

-- table contacts
CREATE TABLE contacts (
    id                  TEXT PRIMARY KEY,
    book_id             TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    -- 'both' is not a shorthand for "unsure" — it is the genuinely common case
    -- this table exists to stop forcing into two rows.
    role                TEXT NOT NULL CHECK (role IN ('customer', 'supplier', 'both')),
    name                TEXT NOT NULL,
    company_name        TEXT,
    email               TEXT,
    phone               TEXT,
    billing_address     TEXT,
    shipping_address    TEXT,
    tax_number          TEXT,
    -- Net payment terms in days (e.g. 30 for "Net 30"). NULL = no term on
    -- record, not "due immediately" — that distinction matters once aging
    -- reports read this column.
    payment_terms_days  INTEGER CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0),
    -- In the book's base currency (`books.currency`); see the header note.
    credit_limit_minor  INTEGER CHECK (credit_limit_minor IS NULL OR credit_limit_minor >= 0),
    notes               TEXT,
    is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

-- table device_identity
CREATE TABLE device_identity (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    public_key   TEXT NOT NULL,
    keyname      TEXT NOT NULL,
    -- User-chosen, purely cosmetic. Not an identity, not a name to resolve:
    -- two devices may carry the same label and nothing cares.
    label        TEXT NOT NULL,
    -- Name of the vault entry holding the private half. Never the material.
    secret_ref   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    rotated_at   TEXT
);

-- table device_identity_rotations
CREATE TABLE device_identity_rotations (
    id             TEXT PRIMARY KEY,
    old_public_key TEXT NOT NULL,
    new_public_key TEXT NOT NULL,
    -- Detached ed25519 signature by old_public_key over the rotation
    -- statement (see device::identity::rotation_statement).
    signature      TEXT NOT NULL,
    rotated_at     TEXT NOT NULL
);

-- table device_pair_invites
CREATE TABLE device_pair_invites (
    id           TEXT PRIMARY KEY,
    claim_sha256 TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    redeemed_at  TEXT,
    redeemed_by  TEXT
);

-- table device_peers
CREATE TABLE device_peers (
    public_key   TEXT PRIMARY KEY,
    keyname      TEXT NOT NULL,
    label        TEXT NOT NULL,
    paired_at    TEXT NOT NULL,
    revoked_at   TEXT,
    -- Reserved for the transport phase. Always NULL today: nothing connects
    -- to anything, so nothing is ever "seen".
    last_seen_at TEXT
);

-- table document_extractions
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

-- table documents
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

-- table fx_rates
CREATE TABLE fx_rates (
    from_currency TEXT NOT NULL CHECK (length(from_currency) = 3),
    to_currency   TEXT NOT NULL CHECK (length(to_currency) = 3),
    rate          TEXT NOT NULL,
    as_of         TEXT NOT NULL,
    grade         TEXT NOT NULL,
    fetched_at    TEXT NOT NULL,
    PRIMARY KEY (from_currency, to_currency)
);

-- table journal_lines
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

-- table journals
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
, reversal_of TEXT REFERENCES journals (id));

-- table locations
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

-- table members
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

-- table merchant_mappings
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

-- table networth_snapshots
CREATE TABLE networth_snapshots (
    id            TEXT PRIMARY KEY,
    book_id       TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
    as_of_date    TEXT NOT NULL,
    balance_minor INTEGER NOT NULL,
    currency      TEXT NOT NULL CHECK (length(currency) = 3),
    source        TEXT NOT NULL CHECK (source IN ('captured', 'backfilled')),
    created_at    TEXT NOT NULL
);

-- table pay_deliveries
CREATE TABLE pay_deliveries (
    id              TEXT PRIMARY KEY,
    book_id         TEXT NOT NULL REFERENCES books (id),
    endpoint_id     TEXT NOT NULL REFERENCES pay_endpoints (id) ON DELETE CASCADE,
    match_id        TEXT NOT NULL REFERENCES pay_matches (id) ON DELETE CASCADE,
    payload         TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'delivered', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_status     INTEGER,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- table pay_endpoints
CREATE TABLE pay_endpoints (
    id         TEXT PRIMARY KEY,
    book_id    TEXT NOT NULL REFERENCES books (id),
    label      TEXT NOT NULL,
    url        TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL
);

-- table pay_matches
CREATE TABLE pay_matches (
    id             TEXT PRIMARY KEY,
    book_id        TEXT NOT NULL REFERENCES books (id),
    watch_id       TEXT NOT NULL REFERENCES pay_watch_codes (id) ON DELETE CASCADE,
    transaction_id TEXT NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    matched_at     TEXT NOT NULL,
    UNIQUE (watch_id, transaction_id)
);

-- table pay_watch_codes
CREATE TABLE pay_watch_codes (
    id                    TEXT PRIMARY KEY,
    book_id               TEXT NOT NULL REFERENCES books (id),
    -- Stored verbatim; matched case-insensitively as a whole token.
    code                  TEXT NOT NULL,
    label                 TEXT,
    expected_amount_minor INTEGER CHECK (expected_amount_minor IS NULL OR expected_amount_minor > 0),
    expected_currency     TEXT CHECK (expected_currency IS NULL OR length(expected_currency) = 3),
    enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at            TEXT NOT NULL
);

-- table product_categories
CREATE TABLE product_categories (
    id         TEXT PRIMARY KEY,
    book_id    TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (book_id, name)
);

-- table product_variants
CREATE TABLE product_variants (
    id               TEXT PRIMARY KEY,
    product_id       TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    -- Denormalized from products.book_id — see the header note.
    book_id          TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    sku              TEXT NOT NULL,
    name             TEXT NOT NULL,
    price_minor      INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
    cost_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (cost_price_minor >= 0),
    currency         TEXT NOT NULL CHECK (length(currency) = 3),
    reorder_point    INTEGER NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
    -- Free-form JSON object ("size", "colour", …), never interpreted by
    -- this crate — the same "store verbatim, never parse" treatment
    -- migration 0001 gives document_extractions.payload. NULL = no
    -- attributes recorded, distinct from an empty object.
    attributes       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (book_id, sku)
);

-- table products
CREATE TABLE products (
    id                  TEXT PRIMARY KEY,
    book_id             TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    product_category_id TEXT REFERENCES product_categories (id) ON DELETE SET NULL,
    name                TEXT NOT NULL,
    description         TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

-- table recon_matches
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

-- table schema_migrations
CREATE TABLE schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            applied_at TEXT NOT NULL
        );

-- table settings
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    secret_ref TEXT,
    updated_at TEXT NOT NULL
);

-- table sqlite_sequence
CREATE TABLE sqlite_sequence(name,seq);

-- table stock_movements
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

-- table sync_clock
CREATE TABLE sync_clock (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    wall       INTEGER NOT NULL,
    counter    INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);

-- table sync_control
CREATE TABLE sync_control (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    applying INTEGER NOT NULL DEFAULT 0 CHECK (applying IN (0, 1))
);

-- table sync_oplog
CREATE TABLE sync_oplog (
    op_id       TEXT PRIMARY KEY,
    ns          TEXT NOT NULL,
    -- The engine's op-kind discriminator, read from `dmtap_sync` and never
    -- hard-coded on the Rust side.
    kind        INTEGER NOT NULL,
    target      TEXT NOT NULL,
    -- Lowercase hex ed25519 public key: the author's device id, and the same
    -- value carried inside the signed payload's HLC.
    author      TEXT NOT NULL,
    hlc_wall    INTEGER NOT NULL,
    hlc_counter INTEGER NOT NULL,
    cose        BLOB NOT NULL,
    -- 'local' if this device authored it, 'remote' if it arrived from a peer.
    -- Only 'local' is ever written today; nothing arrives from anywhere yet.
    origin      TEXT NOT NULL CHECK (origin IN ('local', 'remote')),
    recorded_at TEXT NOT NULL
);

-- table sync_outbox
CREATE TABLE sync_outbox (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name  TEXT NOT NULL,
    row_id      TEXT NOT NULL,
    ns          TEXT NOT NULL,
    -- 1 for a DELETE. The row is already gone by the time this is sealed,
    -- which is why a tombstone op carries identity only.
    deleted     INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    captured_at TEXT NOT NULL
);

-- table transaction_splits
CREATE TABLE transaction_splits (
    id             TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    book_id        TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    member_id      TEXT NOT NULL REFERENCES members (id) ON DELETE RESTRICT,
    share_minor    INTEGER NOT NULL CHECK (share_minor > 0),
    created_at     TEXT NOT NULL,
    UNIQUE (transaction_id, member_id)
);

-- table transactions
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

-- table vat_rates
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

-- table vault_keys
CREATE TABLE vault_keys (
    id          TEXT PRIMARY KEY,
    wrapped_key BLOB NOT NULL,
    nonce       BLOB NOT NULL,
    kek_ref     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- table vault_secrets
CREATE TABLE vault_secrets (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    version      INTEGER NOT NULL DEFAULT 1,
    ciphertext   BLOB NOT NULL,
    nonce        BLOB NOT NULL,
    -- Short non-reversible fingerprint (hex prefix of a domain-separated
    -- SHA-256) — safe to show in the UI, useless to an attacker.
    fingerprint  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    rotated_at   TEXT,
    last_used_at TEXT
);

-- trigger audit_log_no_delete
CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- trigger audit_log_no_update
CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- trigger journal_lines_no_delete
CREATE TRIGGER journal_lines_no_delete
BEFORE DELETE ON journal_lines
BEGIN
    SELECT RAISE(ABORT, 'posted journal lines are immutable; post a reversal instead');
END;

-- trigger journal_lines_no_update
CREATE TRIGGER journal_lines_no_update
BEFORE UPDATE ON journal_lines
BEGIN
    SELECT RAISE(ABORT, 'posted journal lines are immutable; post a reversal instead');
END;

-- trigger journals_no_delete
CREATE TRIGGER journals_no_delete
BEFORE DELETE ON journals
BEGIN
    SELECT RAISE(ABORT, 'posted journals are immutable; post a reversal instead');
END;

-- trigger journals_no_update
CREATE TRIGGER journals_no_update
BEFORE UPDATE ON journals
BEGIN
    SELECT RAISE(ABORT, 'posted journals are immutable; post a reversal instead');
END;

-- trigger networth_snapshots_no_delete
CREATE TRIGGER networth_snapshots_no_delete
BEFORE DELETE ON networth_snapshots
BEGIN
    SELECT RAISE(ABORT, 'net-worth snapshots are immutable; record a new snapshot instead');
END;

-- trigger networth_snapshots_no_update
CREATE TRIGGER networth_snapshots_no_update
BEFORE UPDATE ON networth_snapshots
BEGIN
    SELECT RAISE(ABORT, 'net-worth snapshots are immutable; record a new snapshot instead');
END;

-- trigger stock_movements_no_delete
CREATE TRIGGER stock_movements_no_delete
BEFORE DELETE ON stock_movements
BEGIN
    SELECT RAISE(ABORT, 'stock movements are immutable; record a compensating movement instead');
END;

-- trigger stock_movements_no_update
CREATE TRIGGER stock_movements_no_update
BEFORE UPDATE ON stock_movements
BEGIN
    SELECT RAISE(ABORT, 'stock movements are immutable; record a compensating movement instead');
END;

-- trigger sync_capture_accounts_del
CREATE TRIGGER sync_capture_accounts_del AFTER DELETE ON accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('accounts', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_accounts_ins
CREATE TRIGGER sync_capture_accounts_ins AFTER INSERT ON accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('accounts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_accounts_upd
CREATE TRIGGER sync_capture_accounts_upd AFTER UPDATE ON accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('accounts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_books_del
CREATE TRIGGER sync_capture_books_del AFTER DELETE ON books
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('books', OLD.id, OLD.id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_books_ins
CREATE TRIGGER sync_capture_books_ins AFTER INSERT ON books
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('books', NEW.id, NEW.id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_books_upd
CREATE TRIGGER sync_capture_books_upd AFTER UPDATE ON books
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('books', NEW.id, NEW.id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_budgets_del
CREATE TRIGGER sync_capture_budgets_del AFTER DELETE ON budgets
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('budgets', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_budgets_ins
CREATE TRIGGER sync_capture_budgets_ins AFTER INSERT ON budgets
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('budgets', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_budgets_upd
CREATE TRIGGER sync_capture_budgets_upd AFTER UPDATE ON budgets
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('budgets', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_categories_del
CREATE TRIGGER sync_capture_categories_del AFTER DELETE ON categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('categories', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_categories_ins
CREATE TRIGGER sync_capture_categories_ins AFTER INSERT ON categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('categories', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_categories_upd
CREATE TRIGGER sync_capture_categories_upd AFTER UPDATE ON categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('categories', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_chart_of_accounts_del
CREATE TRIGGER sync_capture_chart_of_accounts_del AFTER DELETE ON chart_of_accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('chart_of_accounts', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_chart_of_accounts_ins
CREATE TRIGGER sync_capture_chart_of_accounts_ins AFTER INSERT ON chart_of_accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('chart_of_accounts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_chart_of_accounts_upd
CREATE TRIGGER sync_capture_chart_of_accounts_upd AFTER UPDATE ON chart_of_accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('chart_of_accounts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_coa_map_del
CREATE TRIGGER sync_capture_coa_map_del AFTER DELETE ON coa_map
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('coa_map', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_coa_map_ins
CREATE TRIGGER sync_capture_coa_map_ins AFTER INSERT ON coa_map
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('coa_map', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_coa_map_upd
CREATE TRIGGER sync_capture_coa_map_upd AFTER UPDATE ON coa_map
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('coa_map', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_contacts_del
CREATE TRIGGER sync_capture_contacts_del AFTER DELETE ON contacts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('contacts', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_contacts_ins
CREATE TRIGGER sync_capture_contacts_ins AFTER INSERT ON contacts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('contacts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_contacts_upd
CREATE TRIGGER sync_capture_contacts_upd AFTER UPDATE ON contacts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('contacts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_journal_lines_ins
CREATE TRIGGER sync_capture_journal_lines_ins AFTER INSERT ON journal_lines
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('journal_lines', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_journals_ins
CREATE TRIGGER sync_capture_journals_ins AFTER INSERT ON journals
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('journals', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_locations_del
CREATE TRIGGER sync_capture_locations_del AFTER DELETE ON locations
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('locations', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_locations_ins
CREATE TRIGGER sync_capture_locations_ins AFTER INSERT ON locations
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('locations', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_locations_upd
CREATE TRIGGER sync_capture_locations_upd AFTER UPDATE ON locations
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('locations', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_members_del
CREATE TRIGGER sync_capture_members_del AFTER DELETE ON members
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('members', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_members_ins
CREATE TRIGGER sync_capture_members_ins AFTER INSERT ON members
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('members', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_members_upd
CREATE TRIGGER sync_capture_members_upd AFTER UPDATE ON members
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('members', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_merchant_mappings_del
CREATE TRIGGER sync_capture_merchant_mappings_del AFTER DELETE ON merchant_mappings
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('merchant_mappings', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_merchant_mappings_ins
CREATE TRIGGER sync_capture_merchant_mappings_ins AFTER INSERT ON merchant_mappings
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('merchant_mappings', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_merchant_mappings_upd
CREATE TRIGGER sync_capture_merchant_mappings_upd AFTER UPDATE ON merchant_mappings
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('merchant_mappings', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_networth_snapshots_ins
CREATE TRIGGER sync_capture_networth_snapshots_ins AFTER INSERT ON networth_snapshots
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('networth_snapshots', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_product_categories_del
CREATE TRIGGER sync_capture_product_categories_del AFTER DELETE ON product_categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('product_categories', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_product_categories_ins
CREATE TRIGGER sync_capture_product_categories_ins AFTER INSERT ON product_categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('product_categories', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_product_categories_upd
CREATE TRIGGER sync_capture_product_categories_upd AFTER UPDATE ON product_categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('product_categories', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_product_variants_del
CREATE TRIGGER sync_capture_product_variants_del AFTER DELETE ON product_variants
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('product_variants', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_product_variants_ins
CREATE TRIGGER sync_capture_product_variants_ins AFTER INSERT ON product_variants
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('product_variants', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_product_variants_upd
CREATE TRIGGER sync_capture_product_variants_upd AFTER UPDATE ON product_variants
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('product_variants', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_products_del
CREATE TRIGGER sync_capture_products_del AFTER DELETE ON products
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('products', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_products_ins
CREATE TRIGGER sync_capture_products_ins AFTER INSERT ON products
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('products', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_products_upd
CREATE TRIGGER sync_capture_products_upd AFTER UPDATE ON products
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('products', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_stock_movements_ins
CREATE TRIGGER sync_capture_stock_movements_ins AFTER INSERT ON stock_movements
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('stock_movements', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_transaction_splits_del
CREATE TRIGGER sync_capture_transaction_splits_del AFTER DELETE ON transaction_splits
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transaction_splits', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_transaction_splits_ins
CREATE TRIGGER sync_capture_transaction_splits_ins AFTER INSERT ON transaction_splits
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transaction_splits', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_transaction_splits_upd
CREATE TRIGGER sync_capture_transaction_splits_upd AFTER UPDATE ON transaction_splits
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transaction_splits', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_transactions_del
CREATE TRIGGER sync_capture_transactions_del AFTER DELETE ON transactions
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transactions', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_transactions_ins
CREATE TRIGGER sync_capture_transactions_ins AFTER INSERT ON transactions
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transactions', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_transactions_upd
CREATE TRIGGER sync_capture_transactions_upd AFTER UPDATE ON transactions
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transactions', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_vat_rates_del
CREATE TRIGGER sync_capture_vat_rates_del AFTER DELETE ON vat_rates
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('vat_rates', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_vat_rates_ins
CREATE TRIGGER sync_capture_vat_rates_ins AFTER INSERT ON vat_rates
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('vat_rates', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_capture_vat_rates_upd
CREATE TRIGGER sync_capture_vat_rates_upd AFTER UPDATE ON vat_rates
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('vat_rates', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- trigger sync_oplog_no_update
CREATE TRIGGER sync_oplog_no_update
BEFORE UPDATE ON sync_oplog
BEGIN
    SELECT RAISE(ABORT, 'a signed op is immutable; its content is its identity');
END;

