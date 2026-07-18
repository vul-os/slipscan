//! The provider abstraction: OCR/LLM backends implement [`ExtractionProvider`].
//!
//! Providers may only reach endpoints the user explicitly configured (BYO key
//! or a local model). Credentials come from the OS keychain via
//! slipscan-core's `SecretStore` — never from config files.

use crate::types::SlipExtraction;
use async_trait::async_trait;

/// Mime types every provider must understand (subset per provider).
pub const MIME_JPEG: &str = "image/jpeg";
pub const MIME_PNG: &str = "image/png";
pub const MIME_GIF: &str = "image/gif";
pub const MIME_WEBP: &str = "image/webp";
pub const MIME_PDF: &str = "application/pdf";
pub const MIME_TEXT: &str = "text/plain";

/// Input to an extraction run: raw image bytes or a PDF.
#[derive(Debug, Clone)]
pub struct ExtractionRequest {
    pub mime_type: String,
    pub bytes: Vec<u8>,
    /// Optional user hint, e.g. "grocery slip" or a document kind.
    pub hint: Option<String>,
    /// Currency assumed when the slip itself shows none — the *book's*
    /// currency, injected by the caller. Never a hardcoded jurisdiction
    /// ("global by default"): when absent and undetectable, the extracted
    /// currency stays `None` and downstream falls back to the book currency.
    pub default_currency: Option<String>,
}

impl ExtractionRequest {
    pub fn new(mime_type: impl Into<String>, bytes: Vec<u8>) -> Self {
        Self {
            mime_type: mime_type.into(),
            bytes,
            hint: None,
            default_currency: None,
        }
    }

    /// Set the currency assumed when the slip shows none (the book currency).
    pub fn with_default_currency(mut self, currency: impl Into<String>) -> Self {
        self.default_currency = Some(currency.into());
        self
    }

    pub fn is_pdf(&self) -> bool {
        self.mime_type == MIME_PDF
    }

    pub fn is_supported_image(&self) -> bool {
        matches!(
            self.mime_type.as_str(),
            MIME_JPEG | MIME_PNG | MIME_GIF | MIME_WEBP
        )
    }
}

/// Errors an extraction provider can produce.
#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    #[error("unsupported mime type: {mime_type}")]
    Unsupported { mime_type: String },

    #[error("provider is not configured: {0}")]
    NotConfigured(String),

    #[error("authentication failed: {0}")]
    Auth(String),

    #[error("rate limited by provider")]
    RateLimited,

    #[error("http transport error: {0}")]
    Transport(String),

    #[error("secret store error: {0}")]
    Secret(String),

    #[error("provider error: {0}")]
    Provider(String),

    #[error("provider returned an invalid slip-v2 payload: {0}")]
    InvalidResponse(String),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

impl ExtractError {
    /// Transport-level failures worth retrying (the HTTP status retry logic
    /// lives in [`crate::retry`]).
    pub fn is_retryable(&self) -> bool {
        matches!(self, ExtractError::Transport(_) | ExtractError::RateLimited)
    }
}

/// An OCR/LLM document extraction backend.
#[async_trait]
pub trait ExtractionProvider: Send + Sync {
    /// Stable provider id, e.g. `"anthropic"`, `"openai"`, `"mock"`.
    fn name(&self) -> &str;

    /// Extract a slip-v2 result (with confidence) from a document.
    async fn extract(&self, request: ExtractionRequest) -> Result<SlipExtraction, ExtractError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Totals;

    /// Compile-time proof the trait is object-safe + a trivial fake provider.
    struct FakeProvider;

    #[async_trait]
    impl ExtractionProvider for FakeProvider {
        fn name(&self) -> &str {
            "fake"
        }

        async fn extract(
            &self,
            request: ExtractionRequest,
        ) -> Result<SlipExtraction, ExtractError> {
            if request.mime_type != MIME_JPEG {
                return Err(ExtractError::Unsupported {
                    mime_type: request.mime_type,
                });
            }
            Ok(SlipExtraction {
                schema: crate::types::SLIP_SCHEMA_VERSION.to_string(),
                merchant: None,
                purchased_at: None,
                currency: Some("ZAR".into()),
                totals: Totals {
                    total_minor: 100,
                    ..Default::default()
                },
                line_items: vec![],
                discounts: vec![],
                vat_breakdown: vec![],
                payment: None,
                confidence: Some(1.0),
                validation: None,
                warnings: vec![],
            })
        }
    }

    #[test]
    fn fake_provider_extracts() {
        let provider: Box<dyn ExtractionProvider> = Box::new(FakeProvider);
        let result =
            futures_block_on(provider.extract(ExtractionRequest::new(MIME_JPEG, vec![1, 2, 3])))
                .unwrap();
        assert_eq!(result.totals.total_minor, 100);

        let err =
            futures_block_on(provider.extract(ExtractionRequest::new("application/zip", vec![])))
                .unwrap_err();
        assert!(matches!(err, ExtractError::Unsupported { .. }));
    }

    #[test]
    fn request_mime_helpers() {
        assert!(ExtractionRequest::new(MIME_PDF, vec![]).is_pdf());
        assert!(ExtractionRequest::new(MIME_WEBP, vec![]).is_supported_image());
        assert!(!ExtractionRequest::new("text/plain", vec![]).is_supported_image());
    }

    /// Minimal block_on so unit tests do not need a runtime.
    fn futures_block_on<F: std::future::Future>(fut: F) -> F::Output {
        use std::sync::Arc;
        use std::task::{Context, Poll, Wake, Waker};

        struct NoopWaker;
        impl Wake for NoopWaker {
            fn wake(self: Arc<Self>) {}
        }

        let waker = Waker::from(Arc::new(NoopWaker));
        let mut cx = Context::from_waker(&waker);
        let mut fut = Box::pin(fut);
        loop {
            match fut.as_mut().poll(&mut cx) {
                Poll::Ready(out) => return out,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }
}
