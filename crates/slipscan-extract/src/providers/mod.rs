//! BYO-key LLM extraction providers.
//!
//! All providers share the same shape: build a JSON request (API key fetched
//! from the vault via [`crate::keys::use_api_key`], only ever placed in a
//! request header), send it through a [`Transport`] with bounded retries,
//! pull the model's text out of the provider-specific response envelope, and
//! run it through the [`crate::wire`] pipeline.
//!
//! Network egress happens only to the endpoint the user configured, only
//! when the user triggers an extraction. [`ollama`] is the default local /
//! offline path; [`crate::fallback`] is the no-LLM path.

pub mod anthropic;
pub mod gemini;
pub mod ollama;
pub mod openai;

use crate::provider::ExtractError;
use crate::retry;
use crate::transport::{HttpRequest, HttpResponse, Transport};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

/// POST with bounded, immediate retries for transient transport failures
/// (connection errors and 5xx). Auth errors and rate limits surface at once.
pub(crate) async fn post_with_retry(
    transport: &dyn Transport,
    request: HttpRequest,
    provider: &str,
) -> Result<HttpResponse, ExtractError> {
    let mut last_err = None;
    for attempt in 0..retry::MAX_ATTEMPTS {
        let err = match transport.post_json(request.clone()).await {
            Ok(resp) => {
                match retry::error_for_status(
                    provider,
                    resp.status,
                    retry::snippet(&resp.body, 200),
                ) {
                    None => return Ok(resp),
                    Some(err) => err,
                }
            }
            Err(err) => err,
        };
        if retry::should_retry(&err) && attempt + 1 < retry::MAX_ATTEMPTS {
            last_err = Some(err);
        } else {
            return Err(err);
        }
    }
    Err(last_err.expect("loop ran at least once"))
}

/// Standard base64 for inline document payloads.
pub(crate) fn base64(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

/// `data:` URL for OpenAI-compatible image content parts.
pub(crate) fn data_url(mime_type: &str, bytes: &[u8]) -> String {
    format!("data:{mime_type};base64,{}", base64(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::mock::MockTransport;

    fn request() -> HttpRequest {
        HttpRequest {
            url: "https://example.test/api".into(),
            headers: vec![],
            body: serde_json::json!({}),
        }
    }

    #[tokio::test]
    async fn retries_transient_failures_then_succeeds() {
        let mock = MockTransport::new();
        mock.push_response(500, "boom");
        mock.push_error(ExtractError::Transport("connection reset".into()));
        mock.push_response(200, "ok");
        let resp = post_with_retry(&mock, request(), "test").await.unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(mock.requests().len(), 3);
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts() {
        let mock = MockTransport::new();
        for _ in 0..3 {
            mock.push_response(503, "unavailable");
        }
        let err = post_with_retry(&mock, request(), "test").await.unwrap_err();
        assert!(matches!(err, ExtractError::Transport(_)));
        assert_eq!(mock.requests().len(), 3);
    }

    #[tokio::test]
    async fn auth_and_rate_limit_do_not_retry() {
        let mock = MockTransport::new();
        mock.push_response(401, "no");
        let err = post_with_retry(&mock, request(), "test").await.unwrap_err();
        assert!(matches!(err, ExtractError::Auth(_)));
        assert_eq!(mock.requests().len(), 1);

        let mock = MockTransport::new();
        mock.push_response(429, "slow down");
        let err = post_with_retry(&mock, request(), "test").await.unwrap_err();
        assert!(matches!(err, ExtractError::RateLimited));
        assert_eq!(mock.requests().len(), 1);
    }
}
