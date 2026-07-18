//! slipscan-core — domain model, SQLite storage, migrations, and services.
//!
//! Everything else (Tauri shell, axum server, CLI) is a thin adapter over
//! [`service::CoreService`]. See `docs/ARCHITECTURE.md` for the contract.
//!
//! Privacy non-negotiables enforced at this layer:
//! * no network access whatsoever — this crate is purely local
//! * secrets go through [`secrets::SecretStore`] (OS keychain), never SQLite
//! * every mutation lands in the append-only `audit_log`

pub mod csv;
pub mod db;
pub mod domain;
pub mod error;
pub mod fx;
pub mod region;
pub mod repo;
pub mod secrets;
pub mod service;
mod slip;
pub mod util;
pub mod vat;

pub use db::Db;
pub use error::{CoreError, CoreResult};
pub use service::CoreService;
