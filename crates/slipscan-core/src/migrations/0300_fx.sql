-- =============================================================================
-- Migration 0300: local exchange-rate cache (OpenRate).
--
-- One row per currency pair, latest rate only — OpenRate serves no history,
-- so conversions record the rate they used at booking time (audit log +
-- returned payloads) rather than re-deriving it later.
--
-- Conventions (as 0001):
--   * rate is TEXT holding a decimal string — money paths never touch floats
--   * timestamps TEXT, RFC 3339 UTC
--   * grade is OpenRate's quality grade, stored verbatim for provenance
-- =============================================================================

CREATE TABLE fx_rates (
    from_currency TEXT NOT NULL CHECK (length(from_currency) = 3),
    to_currency   TEXT NOT NULL CHECK (length(to_currency) = 3),
    rate          TEXT NOT NULL,
    as_of         TEXT NOT NULL,
    grade         TEXT NOT NULL,
    fetched_at    TEXT NOT NULL,
    PRIMARY KEY (from_currency, to_currency)
);
