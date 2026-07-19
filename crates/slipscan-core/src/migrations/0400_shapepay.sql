-- =============================================================================
-- Migration 0400: ShapePay — email-driven payment webhooks.
--
-- Deliberately SIMPLE (TODO-FOLD-SHAPEPAY.md): watch codes are a flat list —
-- no expiry, no recurrence, no lifecycle machinery. When an inbound (positive)
-- transaction's text carries an enabled watch code as a whole token, a match
-- row is written and one signed webhook delivery is queued per enabled
-- endpoint.
--
-- Conventions (as 0001): ids UUIDv7 TEXT, money i64 minor units + ISO-4217,
-- timestamps TEXT RFC 3339 UTC, booleans INTEGER 0/1.
--
-- Secrets: endpoint signing secrets are NOT here — they live in the
-- credential vault (vault_secrets, envelope-encrypted) under a name derived
-- from the endpoint id. This schema stores only non-secret configuration.
-- =============================================================================

-- Reference codes the user watches for. A flat list: enabled on/off is the
-- only state. `expected_amount_minor`/`expected_currency` optionally narrow a
-- code to one exact amount — the only filter that exists.
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
CREATE INDEX pay_watch_codes_book_idx ON pay_watch_codes (book_id, enabled);

-- Webhook receivers. The signing secret is vault-held (write-only), never a
-- column here.
CREATE TABLE pay_endpoints (
    id         TEXT PRIMARY KEY,
    book_id    TEXT NOT NULL REFERENCES books (id),
    label      TEXT NOT NULL,
    url        TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL
);
CREATE INDEX pay_endpoints_book_idx ON pay_endpoints (book_id, enabled);

-- One row per (watch, transaction) detection. The UNIQUE pair plus the
-- transactions content-hash dedupe is what guarantees a re-imported statement
-- can never re-fire a webhook.
CREATE TABLE pay_matches (
    id             TEXT PRIMARY KEY,
    book_id        TEXT NOT NULL REFERENCES books (id),
    watch_id       TEXT NOT NULL REFERENCES pay_watch_codes (id) ON DELETE CASCADE,
    transaction_id TEXT NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    matched_at     TEXT NOT NULL,
    UNIQUE (watch_id, transaction_id)
);
CREATE INDEX pay_matches_book_idx ON pay_matches (book_id, matched_at DESC);

-- Outbound delivery queue: at-least-once, exponential backoff. `payload` is
-- the exact JSON body POSTed (and signed) — built at enqueue time from
-- metadata only: watch label + reference, amount/currency/posted_date,
-- matched_at. Never account numbers, never the raw bank description.
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
CREATE INDEX pay_deliveries_due_idx ON pay_deliveries (state, next_attempt_at);
