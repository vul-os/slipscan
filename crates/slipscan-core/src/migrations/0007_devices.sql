-- =============================================================================
-- Migration 0007: device identity & accountless pairing (docs/NODES.md).
--
-- Phase 1 of the node model. This migration stores IDENTITY ONLY, and nothing
-- here causes anything to sync between devices. The signed operation log is
-- phase 2, in migration 0008, and consumes the key this one mints; there
-- is still no transport — see docs/NODES.md "What is still missing".
--
-- There are NO ACCOUNTS. A device's ed25519 public key IS its id; there is
-- no email, no login, no username, and no directory that maps a name to a
-- device. The private half never appears in this file: it lives in the
-- write-only credential vault (migration 0003) under a single entry name,
-- so a copy of this database yields public keys and nothing usable.
--
-- Pinning discipline (copied from AQL's proto/PAIRING-PROFILE.md, and the
-- same trust-on-first-use rule slipscan-packs already applies to pack
-- signers): a peer's key is accepted at exactly ONE moment — redeeming a
-- pairing acceptance — and thereafter a key change is a REFUSAL, never a
-- silent re-pin. Only a deliberate local reset (`device forget`) can undo a
-- pin.
-- =============================================================================

-- This device's own identity. Exactly one row, ever (id = 1 CHECK).
--
-- `public_key` is the device id: lowercase hex of the 32-byte ed25519 public
-- key. `keyname` is its human-comparable rendering (kotva-core's 8 data
-- words + 1 checksum word) — the thing a person actually reads aloud to
-- confirm two devices agree. It is derived, stored only so the CLI/HTTP
-- surfaces need no key material to display it.
CREATE TABLE device_identity (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    public_key   TEXT NOT NULL,
    keyname      TEXT NOT NULL,
    -- User-chosen, purely cosmetic. Not an identity, not a name to resolve:
    -- two devices may carry the same label and nothing cares.
    label        TEXT NOT NULL,
    -- Name of the vault entry holding the private half. Never the material.
    secret_ref   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    rotated_at   TEXT
);

-- The chain of rotations of THIS device's key. Append-only history: each row
-- records a signature, made by the key being replaced, over the key that
-- replaces it. Rotation is therefore always provable against the outgoing
-- key rather than asserted.
--
-- Nothing transmits these rows today (there is no transport) — they exist so
-- a later phase can present the chain to a peer instead of asking it to
-- accept an unexplained new key.
CREATE TABLE device_identity_rotations (
    id             TEXT PRIMARY KEY,
    old_public_key TEXT NOT NULL,
    new_public_key TEXT NOT NULL,
    -- Detached ed25519 signature by old_public_key over the rotation
    -- statement (see device::identity::rotation_statement).
    signature      TEXT NOT NULL,
    rotated_at     TEXT NOT NULL
);

-- Peer devices this device has paired with. The key is the id, so there is
-- no separate id column under which a key could be swapped.
--
-- `revoked_at` is a TOMBSTONE, not a delete: a revoked peer stays here so it
-- cannot silently re-pair itself. Re-pairing a revoked key is refused; the
-- user must deliberately `device forget` it first. This mirrors
-- slipscan-packs keeping its signer pins after a signer is untrusted.
--
-- `member_id` (docs/ROLES.md "members become principals") is who this
-- device belongs to. NULL is the pre-existing case and stays common: this
-- table was built for a laptop and a phone belonging to the one person
-- running the book, and those peers name nobody. It is set only once a
-- device is paired to a `members` row rather than to the owner directly —
-- that pairing flow is not built yet (ROLES.md scopes this migration to the
-- data model, not the surface); today the column exists so `member_revoke`
-- has somewhere to look when it cascades to a departed principal's devices.
-- `ON DELETE SET NULL` rather than `CASCADE`: deleting the *member* row
-- (only ever possible for a non-principal — see `member_remove`'s guard)
-- must not delete paired *hardware*; the peer simply reverts to nameless
-- rather than vanishing. Deliberately absent from `slipscan_sync`'s mapping
-- lists, same as the rest of this table: "a peer's opinion of who to trust
-- is exactly what must not replicate" (migration 0008's header).
CREATE TABLE device_peers (
    public_key   TEXT PRIMARY KEY,
    keyname      TEXT NOT NULL,
    label        TEXT NOT NULL,
    paired_at    TEXT NOT NULL,
    revoked_at   TEXT,
    -- Reserved for the transport phase. Always NULL today: nothing connects
    -- to anything, so nothing is ever "seen".
    last_seen_at TEXT,
    member_id    TEXT REFERENCES members (id) ON DELETE SET NULL
);

CREATE INDEX device_peers_member_idx ON device_peers (member_id);

-- Outstanding pairing invites minted by THIS device.
--
-- The claim token is stored HASHED (SHA-256, hex) exactly as the server's
-- bearer token is — the clear token exists only in the invite blob the user
-- carries out of band, never at rest here. Single-use: `redeemed_at` burns
-- it. Short TTL via `expires_at`.
CREATE TABLE device_pair_invites (
    id           TEXT PRIMARY KEY,
    claim_sha256 TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    redeemed_at  TEXT,
    redeemed_by  TEXT
);

CREATE INDEX idx_device_pair_invites_expires ON device_pair_invites (expires_at);
