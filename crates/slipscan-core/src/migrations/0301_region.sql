-- =============================================================================
-- Migration 0301: region profiles ("global by default — regions are data").
--
-- Books gain a `region` column naming the region profile that drives their
-- chart-of-accounts seeds, tax rate table, and tax-report labels. Profiles
-- themselves are embedded data in slipscan-core (src/region.rs), not rows.
--
-- Backfill: every pre-existing book was created by an implicitly
-- South-African core (ZAR currency default, ZA VAT rate seeds), so books
-- showing any of that implicit-SA evidence map to the 'za' profile:
--   * seeded ZA VAT rates (coa_seed stamped country = 'ZA'), or
--   * country explicitly 'ZA', or
--   * the old implicit 'ZAR' currency default.
-- Everything else maps to 'generic'.
--
-- Note: the legacy `DEFAULT 'ZAR'` on books.currency (0001) is dead — the
-- code layer always binds an explicit, profile-resolved currency. It is left
-- in place because rewriting the books table in SQLite is not worth the risk.
-- =============================================================================

ALTER TABLE books ADD COLUMN region TEXT NOT NULL DEFAULT 'generic';

UPDATE books
SET region = 'za'
WHERE country = 'ZA'
   OR currency = 'ZAR'
   OR EXISTS (
        SELECT 1 FROM vat_rates v
        WHERE v.book_id = books.id AND v.country = 'ZA'
   );
