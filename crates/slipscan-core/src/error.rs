//! Core error type. Libraries use `thiserror`; binaries may wrap in `anyhow`.

/// Every fallible core operation returns `Result<T, CoreError>`.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("migration {version} failed: {message}")]
    Migration { version: i64, message: String },

    #[error("{entity} not found: {id}")]
    NotFound { entity: &'static str, id: String },

    #[error("invalid value {value:?} for {ty}")]
    InvalidEnum { ty: &'static str, value: String },

    #[error("duplicate transaction (existing id {existing_id})")]
    DuplicateTransaction { existing_id: String },

    #[error("duplicate document (existing id {existing_id})")]
    DuplicateDocument { existing_id: String },

    #[error("journal is unbalanced: debits {debit_minor} != credits {credit_minor}")]
    UnbalancedJournal { debit_minor: i64, credit_minor: i64 },

    #[error("a journal was already generated from {source_type} {source_id}")]
    DuplicateJournal {
        source_type: String,
        source_id: String,
    },

    #[error("invalid status transition: {from} -> {to}")]
    InvalidStatusTransition { from: String, to: String },

    #[error("book is not closeable for this period: {reasons:?}")]
    CloseBlocked { reasons: Vec<String> },

    #[error("book is not closed; there is no period to reopen")]
    NotClosed,

    #[error("validation error: {0}")]
    Validation(String),

    #[error("secret store error: {0}")]
    Secret(String),

    // -- Device identity & pairing (docs/NODES.md) ------------------------
    //
    // Every one of these is a REFUSAL rather than a fallback. A pinned key
    // is never silently replaced, so each of these paths must end here and
    // not in some "re-pair anyway" branch.
    #[error(
        "this device already has an identity ({keyname}); replacing it is \
         `slipscan device rotate` (signed by the current key) or \
         `slipscan device reset` (a deliberate local wipe)"
    )]
    DeviceIdentityExists { keyname: String },

    #[error("this device has no identity yet — run `slipscan device init` first")]
    DeviceIdentityMissing,

    #[error(
        "a device private key exists in the vault with no identity row — a torn write. \
         Run `slipscan device reset` to clear it, then `slipscan device init`"
    )]
    DeviceIdentityTorn,

    #[error(
        "the private key in the vault is not this device's pinned public key; refusing to \
         act on a key this device cannot prove it holds"
    )]
    DeviceKeyMismatch,

    #[error("refusing to record a rotation that does not verify against the key it replaces")]
    DeviceRotationUnsigned,

    #[error(
        "the {subject} is unusable (not 32 bytes of hex); refusing rather than \
         verifying against a key that cannot be decoded"
    )]
    DeviceKeyUnusable { subject: String },

    #[error(
        "key-name mismatch: you expected {expected}, this key is {actual}. \
         Refusing to pair — compare the key-name on the other device's screen"
    )]
    DeviceKeynameMismatch { expected: String, actual: String },

    #[error(
        "{typed} is not a well-formed key-name (its checksum word does not agree) — \
         it looks mistyped rather than wrong; check it and try again"
    )]
    DeviceKeynameMistyped { typed: String },

    // The device id, not the key-name, is what `forget` takes — the message
    // has to name the argument the user can actually paste.
    #[error(
        "this device is revoked here ({keyname}); refusing to re-pair it. A revoked key cannot \
         let itself back in — run `slipscan device forget {public_key}` first if you really \
         mean to"
    )]
    DevicePeerRevoked { keyname: String, public_key: String },

    #[error("pairing refused: {0}")]
    DevicePairing(String),

    // -- The signed operation log (docs/NODES.md) -------------------------
    #[error(
        "this device's sync clock is {ahead_ms}ms ahead of its wall clock, past the \
         {bound_ms}ms bound. Every operation signed from here would carry a timestamp \
         no peer will accept, and the timestamp is inside the signature — so nothing \
         was sealed. Correct this machine's clock; the pending writes are safe in the \
         outbox and seal once it is sound"
    )]
    SyncClockDrift { ahead_ms: u64, bound_ms: u64 },

    #[error("operation {op_id} does not verify: {reason}")]
    SyncOpUnverified { op_id: String, reason: String },

    #[error("sync mapping error: {0}")]
    SyncMapping(String),

    #[error(
        "exchange rates are not configured: set the OpenRate base URL first \
         (fx_configure) — SlipScan makes no FX network calls until you do"
    )]
    FxNotConfigured,

    #[error("unknown currency pair {from}/{to}")]
    FxUnknownPair { from: String, to: String },

    #[error("fx transport error: {0}")]
    FxTransport(String),

    #[error("fx response parse error: {0}")]
    FxParse(String),

    #[error("webhook transport error: {0}")]
    PayTransport(String),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("data folder error: {0}")]
    DataDir(String),

    #[error("cannot move the data folder: {0}")]
    DataMove(String),

    #[error(
        "the target folder already contains a SlipScan database ({path}) — \
         open that database instead, or pick an empty folder"
    )]
    DataMoveTargetHasDatabase { path: String },

    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
}

pub type CoreResult<T> = Result<T, CoreError>;
