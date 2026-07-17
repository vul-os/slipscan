//! slipscan-extract — document extraction.
//!
//! Defines the slip-v2 result schema and the [`ExtractionProvider`] trait,
//! plus the BYO-key provider implementations (Anthropic, OpenAI-compatible,
//! Gemini), the default local path (Ollama), and a deterministic no-LLM
//! regex fallback.
//!
//! Privacy contract:
//! * network egress only to the endpoint the **user explicitly configured**,
//!   and only inside an [`ExtractionProvider::extract`] call the user
//!   triggered — no background calls, no telemetry;
//! * API keys come **only** from the core credential vault
//!   ([`slipscan_core::secrets::Vault::use_with`], adapted through
//!   [`keys::KeySource`]) — never env vars or config files — and never
//!   appear in logs, `Debug` output, or errors;
//! * validation (totals reconcile, sane dates) and confidence scoring are
//!   always computed locally, never trusted from a model.

pub mod confidence;
pub mod currency;
pub mod fallback;
pub mod json_util;
pub mod keys;
pub mod prompt;
pub mod provider;
pub mod providers;
pub mod retry;
pub mod transport;
pub mod types;
pub mod validate;
pub mod wire;

pub use fallback::HeuristicProvider;
pub use keys::{KeySource, SharedKeySource};
pub use provider::{ExtractError, ExtractionProvider, ExtractionRequest};
pub use providers::anthropic::{AnthropicConfig, AnthropicProvider, ANTHROPIC_DEFAULT_MODEL};
pub use providers::gemini::{GeminiConfig, GeminiProvider, GEMINI_DEFAULT_MODEL};
pub use providers::ollama::{OllamaConfig, OllamaProvider, OLLAMA_DEFAULT_MODEL};
pub use providers::openai::{OpenAiCompatConfig, OpenAiCompatProvider, OPENAI_DEFAULT_MODEL};
pub use transport::{HttpRequest, HttpResponse, ReqwestTransport, Transport};
pub use types::{
    LineItem, MerchantInfo, PaymentInfo, SlipExtraction, Totals, VatLine, SLIP_SCHEMA_VERSION,
};
