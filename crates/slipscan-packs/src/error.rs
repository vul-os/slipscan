//! Pack error type. This is a library: `thiserror`, never `anyhow`.

/// Every fallible pack operation returns `Result<T, PackError>`.
#[derive(Debug, thiserror::Error)]
pub enum PackError {
    #[error("invalid manifest TOML: {0}")]
    ManifestParse(#[from] toml::de::Error),

    #[error("manifest serialization failed: {0}")]
    ManifestSerialize(#[from] toml::ser::Error),

    #[error("invalid payload JSON: {0}")]
    PayloadParse(#[from] serde_json::Error),

    #[error("pack validation failed: {0}")]
    Validation(String),

    #[error("manifest/payload mismatch: {0}")]
    Mismatch(String),

    #[error("payload hash mismatch: manifest says {expected}, payload hashes to {actual}")]
    HashMismatch { expected: String, actual: String },

    #[error(
        "pack {0:?} is unsigned; signed packs are required \
         (an explicit dev override exists for local pack development)"
    )]
    Unsigned(String),

    #[error("invalid ed25519 public key")]
    InvalidPublicKey,

    #[error("invalid ed25519 signature encoding")]
    InvalidSignature,

    #[error("unsupported signature algorithm {0:?} (only \"ed25519\")")]
    UnsupportedAlgorithm(String),

    #[error("signature verification failed")]
    VerificationFailed,

    #[error(
        "pack signer {fingerprint} is not trusted; verify the fingerprint \
         out-of-band and trust the signer first (trust-on-first-use)"
    )]
    UntrustedSigner { fingerprint: String },

    #[error(
        "pack {pack_id} was previously signed by a different key \
         (pinned signer {pinned_fingerprint}); refusing to install"
    )]
    SignerChanged {
        pack_id: String,
        pinned_fingerprint: String,
    },

    #[error(
        "refusing to trust the well-known builtin seed key for external packs \
         (it is public knowledge and proves nothing)"
    )]
    SignerNotTrustable,

    #[error("pack {pack_id} version {version} is already installed")]
    AlreadyInstalled { pack_id: String, version: String },

    #[error(
        "pack {pack_id}: offered version {offered} is older than installed \
         version {installed}; downgrades are rejected"
    )]
    Downgrade {
        pack_id: String,
        installed: String,
        offered: String,
    },

    #[error("invalid semantic version {0:?} (expected MAJOR.MINOR.PATCH)")]
    InvalidVersion(String),

    #[error("invalid regex pattern {pattern:?}: {message}")]
    InvalidRegex { pattern: String, message: String },

    #[error("unsafe payload file name {0:?} in manifest")]
    UnsafePayloadPath(String),

    // -- transports (crate::transport) --------------------------------------
    // Fetching is a separate concern from trusting: nothing in this group can
    // produce installed state on its own, because the only way out of a
    // transport is a `FetchedBundle` and the only way out of *that* is
    // `verify_detached`.
    #[error(
        "unsupported pack source {0:?}; use file:<path>, folder:<path>, \
         git:<url>, or https://<url>"
    )]
    UnknownScheme(String),

    #[error(
        "refusing the plaintext source {0:?}: use https://. The signature is \
         what is trusted, but a plaintext fetch still tells the network which \
         packs you run"
    )]
    InsecureUrl(String),

    #[error("pack source {0:?} cannot be listed; it needs an index.json")]
    SourceUnlistable(String),

    #[error("pack source transport failed: {0}")]
    Transport(String),

    #[error("pack source index at {path:?} is invalid: {message}")]
    InvalidIndex { path: String, message: String },

    #[error(
        "source index claims {claimed:?} but the signed pack is {actual:?}; \
         refusing to install a pack the catalogue misdescribes"
    )]
    IndexMismatch { claimed: String, actual: String },

    // `source_name` rather than `source`: thiserror reserves a field called
    // `source` for the error-chain accessor, and a `String` is not an error.
    #[error("pack {pack_id:?} is not offered by source {source_name:?}")]
    NoSuchPack {
        pack_id: String,
        source_name: String,
    },

    #[error(
        "pack source name {0:?} is invalid (1-64 chars of [a-z0-9._-], and \
         not a scheme)"
    )]
    InvalidSourceName(String),

    #[error("no pack source named {0:?}; add one with `pack source add`")]
    NoSuchSource(String),

    #[error("a pack source named {0:?} already exists")]
    SourceExists(String),

    #[error(
        "signer {fingerprint} for pack {pack_id:?} has never been seen here; \
         check the fingerprint against the publisher's own channel and accept \
         it explicitly (nothing a source hands you is trusted by arriving)"
    )]
    SignerNotAccepted {
        pack_id: String,
        fingerprint: String,
    },

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("core error: {0}")]
    Core(#[from] slipscan_core::CoreError),

    #[error("book not found: {0}")]
    BookNotFound(String),

    #[error("installed pack state for {pack_id} is corrupt: {message}")]
    CorruptState { pack_id: String, message: String },
}

pub type PackResult<T> = Result<T, PackError>;
