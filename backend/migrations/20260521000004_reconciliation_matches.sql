-- =============================================================================
-- Migration P3-02: Document ↔ bank-feed auto-reconciliation
--
-- Adds the reconciliation_matches table that links a document-derived
-- transaction to an imported statement_line, tracking match state and
-- confidence so the UI can surface auto-matches, suggestions, and the
-- unmatched residue.
--
-- State machine:
--   auto      — high-confidence match applied automatically (no user action)
--   suggested — mid-confidence; surfaced for user review
--   confirmed — user explicitly accepted the link
--   rejected  — user explicitly rejected; prevents re-suggesting
--
-- No-double-match invariant is enforced by the two partial unique indexes
-- below: a transaction_id and a statement_line_id may each appear at most
-- once in non-rejected rows.
-- =============================================================================

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recon_match_state') THEN
        CREATE TYPE recon_match_state AS ENUM ('auto', 'suggested', 'confirmed', 'rejected');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS reconciliation_matches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Document-derived transaction (produced by P1-01 extraction pipeline).
    transaction_id      UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,

    -- Imported bank line (populated by P3-01 bank-feed aggregator or manual
    -- statement import).
    statement_line_id   UUID NOT NULL REFERENCES statement_lines(id) ON DELETE CASCADE,

    -- Matching metadata.
    state               recon_match_state NOT NULL DEFAULT 'suggested',
    confidence          NUMERIC(4, 3) NOT NULL,
    amount_delta        NUMERIC(14, 2) NOT NULL,  -- abs(tx.amount - sl.amount)
    date_delta_days     INTEGER NOT NULL,          -- abs(tx.posted_date - sl.line_date)
    merchant_score      NUMERIC(4, 3) NOT NULL,   -- 0..1 similarity of normalized merchants

    -- Who actioned the match (NULL for auto-applied rows).
    actioned_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    actioned_at         TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT reconciliation_matches_confidence_range
        CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT reconciliation_matches_merchant_score_range
        CHECK (merchant_score >= 0 AND merchant_score <= 1),
    CONSTRAINT reconciliation_matches_amount_delta_nonneg
        CHECK (amount_delta >= 0),
    CONSTRAINT reconciliation_matches_date_delta_nonneg
        CHECK (date_delta_days >= 0)
);

-- Fast lookups by org + state (list buckets).
CREATE INDEX IF NOT EXISTS reconciliation_matches_org_state_idx
    ON reconciliation_matches (organization_id, state);

-- Lookup by transaction (for unmatched-doc list, per-tx status).
CREATE INDEX IF NOT EXISTS reconciliation_matches_tx_idx
    ON reconciliation_matches (transaction_id);

-- Lookup by statement line.
CREATE INDEX IF NOT EXISTS reconciliation_matches_sl_idx
    ON reconciliation_matches (statement_line_id);

-- No-double-match: a transaction_id may appear at most once in active
-- (non-rejected) rows per org.
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_matches_tx_active_unique
    ON reconciliation_matches (organization_id, transaction_id)
    WHERE state <> 'rejected';

-- No-double-match: a statement_line_id may appear at most once in active rows.
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_matches_sl_active_unique
    ON reconciliation_matches (organization_id, statement_line_id)
    WHERE state <> 'rejected';

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reconciliation_matches_set_updated_at') THEN
        CREATE TRIGGER reconciliation_matches_set_updated_at
        BEFORE UPDATE ON reconciliation_matches
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- RLS: org isolation.
ALTER TABLE reconciliation_matches ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'reconciliation_matches'
          AND policyname = 'reconciliation_matches_org_isolation'
    ) THEN
        CREATE POLICY reconciliation_matches_org_isolation ON reconciliation_matches
            USING (organization_id = app_current_organization_id())
            WITH CHECK (organization_id = app_current_organization_id());
    END IF;
END $$;
