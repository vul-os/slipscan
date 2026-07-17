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

    #[error("pack is signed by an untrusted key")]
    UntrustedKey,

    #[error("invalid semantic version {0:?} (expected MAJOR.MINOR.PATCH)")]
    InvalidVersion(String),

    #[error("invalid regex pattern {pattern:?}: {message}")]
    InvalidRegex { pattern: String, message: String },

    #[error("unsafe payload file name {0:?} in manifest")]
    UnsafePayloadPath(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("core error: {0}")]
    Core(#[from] slipscan_core::CoreError),

    #[error("book not found: {0}")]
    BookNotFound(String),

    #[error("installed pack state for {pack_id} is corrupt: {message}")]
    CorruptState { pack_id: String, message: String },
}

pub type PackResult<T> = Result<T, PackError>;
