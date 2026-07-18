//! slipscan-ingest — getting documents and transactions into SlipScan.
//!
//! Inbound paths, all strictly user-configured (privacy mantra: network egress
//! only to endpoints the user explicitly configured — their mailbox, their
//! bank):
//!
//! * [`email`] — one [`email::MailboxConnector`] trait, four providers:
//!   generic IMAP (UID-cursor sync + IDLE push; Proton Bridge on `127.0.0.1`
//!   works unchanged), Gmail (`history.list` deltas via the user's own OAuth
//!   client + optional Cloud Pub/Sub *pull* push), Microsoft Graph (delta
//!   queries, device-code flow). Attachments and receipt-like bodies feed the
//!   core document pipeline.
//! * [`import`] — file import into the core document pipeline (content-hash
//!   dedup).
//! * [`watch`] — drop-folder scanning and watching (`notify`) for
//!   PDFs/images/CSVs.
//! * [`bank`] — the [`bank::BankAdapter`] framework (fetch statement lines
//!   for a date range) with a CSV-statement adapter and a region-grouped
//!   column-mapping preset catalog ([`bank::presets`]): SA banks (FNB,
//!   Standard Bank, Capitec, Nedbank, Absa), a `generic` worldwide family,
//!   and a custom-mapping constructor
//!   ([`bank::csv_statement::CustomMappingSpec`]) for any other bank. See
//!   `docs/BANK-ADAPTERS.md`.
//! * [`vault`] — how connectors receive credentials: a `use_with`-style
//!   handoff mirroring the core credential vault. Connectors never load,
//!   display, or persist secret material themselves; rotated tokens go back
//!   through the vault.
//!
//! No telemetry, no default network calls; tests run against mock transports
//! and fixtures only.

mod b64;
pub mod bank;
pub mod email;
pub mod fx;
pub mod http;
pub mod import;
pub mod state;
pub mod vault;
pub mod watch;

pub use email::{Attachment, InboundMessage, MailboxConnector, MailboxEvent};
pub use state::{CursorStore, MemoryCursorStore, SettingsCursorStore};
pub use vault::VaultAccess;

/// Errors shared by ingestion paths.
#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("connection failed: {0}")]
    Connection(String),

    #[error("authentication failed: {0}")]
    Auth(String),

    #[error("no credential in vault under {0:?}")]
    MissingCredential(String),

    #[error("protocol error: {0}")]
    Protocol(String),

    #[error("http error: {0}")]
    Http(String),

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
