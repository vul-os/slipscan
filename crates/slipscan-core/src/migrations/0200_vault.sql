-- =============================================================================
-- Migration 0200: credential vault (envelope encryption).
--
-- Write-only secret storage per docs/ARCHITECTURE.md "Credential vault":
--   * vault_keys holds the per-machine data-encryption key (DEK), wrapped
--     with XChaCha20-Poly1305 under a key-encryption key (KEK) that lives
--     ONLY in the OS keychain (`kek_ref` is the keychain entry name).
--     Copying this database off the machine yields nothing.
--   * vault_secrets holds per-secret ciphertext plus displayable metadata.
--     No plaintext secret material ever lands in this file.
--
-- Rotation overwrites ciphertext in place (version bump); revocation deletes
-- the row. History lives only in the append-only audit_log (metadata only).
-- =============================================================================

CREATE TABLE vault_keys (
    id          TEXT PRIMARY KEY,
    wrapped_key BLOB NOT NULL,
    nonce       BLOB NOT NULL,
    kek_ref     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

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
