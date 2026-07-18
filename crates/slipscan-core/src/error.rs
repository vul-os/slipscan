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

    #[error("validation error: {0}")]
    Validation(String),

    #[error("secret store error: {0}")]
    Secret(String),

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

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type CoreResult<T> = Result<T, CoreError>;
