-- =============================================================================
-- Migration 0101: ledger hardening.
--
--   * Posted journals are immutable: UPDATE/DELETE on journals and
--     journal_lines are blocked by triggers. Corrections are reversals.
--   * Reversal linkage: journals.reversal_of points at the journal a reversal
--     cancels; a journal can be reversed at most once.
--   * Multi-currency groundwork: an optional fixed currency on
--     chart_of_accounts entries (NULL = follows the book / any currency).
--     No FX revaluation yet.
-- =============================================================================

ALTER TABLE journals ADD COLUMN reversal_of TEXT REFERENCES journals (id);

CREATE UNIQUE INDEX journals_reversal_of_unique
    ON journals (reversal_of) WHERE reversal_of IS NOT NULL;

ALTER TABLE chart_of_accounts ADD COLUMN currency TEXT
    CHECK (currency IS NULL OR length(currency) = 3);

-- Reversal-not-edit: once posted, a journal and its lines never change.
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
