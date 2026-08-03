-- =============================================================================
-- Migration 0002: accounting engine.
--
--   * VAT capture on journal lines (`vat_rate_id` + `vat_role`), the
--     immutability guarantee on posted journals/journal lines, and
--     `recon_matches.merchant_score` all live directly on their tables in
--     migration 0001 — see the comments beside `journals`, `journal_lines`
--     and `recon_matches` there for the design reasoning. This file holds
--     what is actually new here: `coa_map`, and the source-lookup index on
--     `journals`.
--   * coa_map: links personal-finance entities (accounts, categories) to
--     chart-of-accounts entries for automatic journal generation.
-- =============================================================================

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

-- Sync capture. See migration 0008's header for why this is a trigger and
-- the full replicated table list.
CREATE TRIGGER sync_capture_coa_map_ins AFTER INSERT ON coa_map
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('coa_map', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_coa_map_upd AFTER UPDATE ON coa_map
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('coa_map', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_coa_map_del AFTER DELETE ON coa_map
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('coa_map', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- A non-manual source (transaction, document, opening balance) may generate
-- more than one journal over its lifetime once reversals are involved, so
-- this is a plain lookup index rather than a uniqueness guard: uniqueness
-- among *net-live* generated journals (liveness depends on the reversal
-- chain, which an index cannot express) is enforced in the service layer
-- (`post_journal_in_tx`) instead. A plain unique index here would have
-- permanently occupied the "one generated journal per source" slot with a
-- reversed, net-cancelled row, making the documented correction path
-- (reverse the wrong generated journal, post the right one) impossible for
-- transaction- and document-sourced journals.
CREATE INDEX journals_source_idx
    ON journals (book_id, source_type, source_id)
    WHERE source_id IS NOT NULL;
