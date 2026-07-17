//! slipscan-ingest — getting documents and transactions into SlipScan.
//!
//! Inbound paths, all strictly user-configured (privacy mantra: network egress
//! only to the user's own IMAP server / bank session):
//!
//! * [`email`] — [`email::MailboxConnector`] over IMAP (rustls); polls the
//!   user's mailbox since the last-seen UID, extracts attachments and
//!   receipt-like HTML bodies into core document imports
//! * [`watch`] — drop-folder watcher (`notify`) feeding [`import`]
//! * [`statement`] — CSV (per-bank column mapping) and OFX statement parsing,
//!   feeding core's transaction dedupe
//! * [`scraper`] — the [`scraper::BankScraper`] framework: adapter registry
//!   plus the `manual-statement` reference adapter
//!
//! Credentials always come from the OS keychain via slipscan-core's
//! [`slipscan_core::secrets::SecretStore`]; connectors *receive* secrets,
//! they never load or persist them. See `docs/BANK_ADAPTERS.md` for how a
//! real per-bank adapter plugs in.

mod b64;
pub mod email;
pub mod import;
pub mod scraper;
pub mod state;
pub mod statement;
pub mod watch;

pub use email::{Attachment, InboundMessage, MailboxConnector};
pub use scraper::{BankScraper, ScraperRegistry};
pub use state::{CursorStore, MemoryCursorStore, SettingsCursorStore};
pub use statement::{ImportOutcome, IncomingTransaction};

/// Errors shared by ingestion paths.
#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("connection failed: {0}")]
    Connection(String),

    #[error("authentication failed: {0}")]
    Auth(String),

    #[error("protocol error: {0}")]
    Protocol(String),

    #[error("parse error: {0}")]
    Parse(String),

    #[error("unsupported file: {0}")]
    UnsupportedFile(String),

    #[error("watcher error: {0}")]
    Watch(String),

    #[error("cursor state error: {0}")]
    State(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Core(#[from] slipscan_core::CoreError),
}

pub type IngestResult<T> = Result<T, IngestError>;
