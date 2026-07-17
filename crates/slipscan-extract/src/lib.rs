//! slipscan-extract — document extraction.
//!
//! Defines the slip-v2 result schema and the [`ExtractionProvider`] trait
//! that OCR/LLM providers implement. Providers are bring-your-own-key and
//! only ever talk to endpoints the user explicitly configured; this crate
//! itself performs no network I/O.

pub mod provider;
pub mod types;

pub use provider::{ExtractError, ExtractionProvider, ExtractionRequest};
pub use types::{
    LineItem, MerchantInfo, PaymentInfo, SlipExtraction, Totals, VatLine, SLIP_SCHEMA_VERSION,
};
