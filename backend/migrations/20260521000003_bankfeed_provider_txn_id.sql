-- =============================================================================
-- Migration: P3-01 bank-feed aggregator support
--
-- Adds:
--   1. provider_txn_id column to statement_lines for idempotent deduplication
--      on re-sync (unique per connection).
--   2. stitch value to bank_feed_provider enum (SA-first aggregator).
--
-- statement_lines.provider_txn_id holds the raw transaction ID returned by the
-- bank-feed provider (e.g. Stitch transaction UUID).  The unique constraint on
-- (bank_feed_connection_id, provider_txn_id) prevents duplicate import on any
-- re-sync cycle, regardless of fetch-window overlap.
--
-- Why a new enum value?
--   The existing bank_feed_provider enum covers legacy/European providers
--   (plaid, yodlee, truelayer, salt_edge) but has no SA-first entry.  Stitch
--   (https://stitch.money) is the recommended SA provider (see P3-01 notes).
--   Adding 'stitch' keeps the column constraint tight and auditable.
-- =============================================================================

-- 1. Extend the provider enum with 'stitch' (South Africa / sub-Saharan Africa).
ALTER TYPE bank_feed_provider ADD VALUE IF NOT EXISTS 'stitch';

-- 2. Add provider_txn_id to statement_lines.
--    NULL for manually-imported lines; NOT NULL for feed-imported lines is
--    enforced at the application layer (the store sets it on every upsert).
ALTER TABLE statement_lines
    ADD COLUMN IF NOT EXISTS bank_feed_connection_id UUID
        REFERENCES bank_feed_connections(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS provider_txn_id TEXT;

-- Unique dedup index: one provider transaction id per connection.
-- Partial — only applies where provider_txn_id IS NOT NULL so manual lines
-- (NULL) are not affected.
CREATE UNIQUE INDEX IF NOT EXISTS statement_lines_feed_dedup_idx
    ON statement_lines (bank_feed_connection_id, provider_txn_id)
    WHERE provider_txn_id IS NOT NULL;
