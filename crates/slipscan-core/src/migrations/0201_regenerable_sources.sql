-- =============================================================================
-- Migration 0201: reversed generated journals unblock regeneration.
--
-- The partial unique index from 0100 enforced "one generated journal per
-- source" over *all* journals — including ones whose ledger effect has been
-- net-cancelled by a reversal. That made the documented correction path
-- (reverse the wrong generated journal, post the right one) impossible for
-- transaction- and document-sourced journals: the dead row still occupied
-- the unique slot forever.
--
-- Uniqueness among *net-live* generated journals is now enforced in the
-- service layer (post_journal_in_tx): liveness depends on other rows (the
-- reversal chain), which a partial index cannot express. The plain index
-- below remains for source-lookup speed.
-- =============================================================================

DROP INDEX journals_source_unique;

CREATE INDEX journals_source_idx
    ON journals (book_id, source_type, source_id)
    WHERE source_id IS NOT NULL;
