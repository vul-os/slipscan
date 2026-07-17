-- =============================================================================
-- Migration 0100: accounting engine.
--
--   * VAT capture on journal lines: vat_rate_id + vat_role tag so input/output
--     VAT (and their bases) can be summed straight into a VAT201-style report.
--   * merchant_score on recon_matches (amount/date/merchant matcher).
--   * coa_map: links personal-finance entities (accounts, categories) to
--     chart-of-accounts entries for automatic journal generation.
--   * one generated journal per source: partial unique index on journals.
-- =============================================================================

-- VAT on journal lines. vat_role tags a line's role in the VAT return:
--   output_vat  — VAT charged on sales (credit on the VAT output control)
--   input_vat   — VAT paid on purchases (debit on the VAT input control)
--   output_base — the sale amount the output VAT was computed from
--   input_base  — the purchase amount the input VAT was computed from
ALTER TABLE journal_lines ADD COLUMN vat_rate_id TEXT REFERENCES vat_rates (id);
ALTER TABLE journal_lines ADD COLUMN vat_role TEXT
    CHECK (vat_role IS NULL OR vat_role IN ('output_vat', 'input_vat', 'output_base', 'input_base'));

CREATE INDEX journal_lines_vat_role_idx
    ON journal_lines (book_id, vat_role) WHERE vat_role IS NOT NULL;

-- Merchant-similarity component of a reconciliation match (0..1).
ALTER TABLE recon_matches ADD COLUMN merchant_score REAL NOT NULL DEFAULT 0.0
    CHECK (merchant_score >= 0.0 AND merchant_score <= 1.0);

-- Personal-finance entity -> chart-of-accounts mapping used when generating
-- journals from transactions/documents. Fallbacks are well-known seed codes.
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

CREATE INDEX coa_map_coa_idx ON coa_map (coa_id);

-- A non-manual source (transaction, document, opening balance) may generate
-- at most one journal.
CREATE UNIQUE INDEX journals_source_unique
    ON journals (book_id, source_type, source_id)
    WHERE source_id IS NOT NULL AND source_type <> 'manual';
