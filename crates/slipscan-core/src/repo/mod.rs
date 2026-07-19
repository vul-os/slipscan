//! Repository layer: raw SQL, one module per domain area.
//!
//! Functions take a `&Connection` (or transaction deref) and stay free of
//! business rules — validation, audit, and orchestration live in the service
//! layer.

pub mod account;
pub mod audit;
pub mod book;
pub mod budget;
pub mod category;
pub mod document;
pub mod ledger;
pub mod pay;
pub mod recon;
pub mod report;
pub mod settings;
pub mod transaction;

use rusqlite::Row;
use std::str::FromStr;

use crate::error::CoreError;

/// Read a TEXT column into a string-backed enum, surfacing bad data as a
/// conversion failure instead of a panic.
pub(crate) fn col_enum<T>(row: &Row<'_>, column: &str) -> rusqlite::Result<T>
where
    T: FromStr<Err = CoreError>,
{
    let raw: String = row.get(column)?;
    raw.parse().map_err(|e: CoreError| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
