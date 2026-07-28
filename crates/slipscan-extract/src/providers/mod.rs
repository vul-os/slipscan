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

/// Decode a provider's response envelope, failing **closed and loud** on an
/// empty or truncated body.
///
/// A success status proves only that the server *began* a successful
/// response. A server that writes its header before it finishes encoding JSON
/// publishes a short 200 on an encode/write failure; the truncated body is
/// still a complete, well-formed HTTP message, so no transport-level check
/// can catch it and this parse is the only place it can be caught. Every
/// provider routes its envelope through here rather than calling
/// `serde_json::from_str` directly, so the failure says what happened instead
/// of surfacing a bare "json error: EOF while parsing".
///
/// Deliberately **not** retryable: a truncated body is the server publishing
/// a wrong result, and quietly re-asking would hide it.
pub(crate) fn decode_response_body(
    provider: &str,
    body: &str,
) -> Result<serde_json::Value, ExtractError> {
    if body.trim().is_empty() {
        return Err(ExtractError::InvalidResponse(format!(
            "{provider} answered with a success status but an empty body — a 200 is not proof of \
             a complete body"
        )));
    }
    serde_json::from_str(body).map_err(|e| {
        if e.is_eof() {
            ExtractError::InvalidResponse(format!(
                "{provider} response body ends mid-JSON ({e}) — it was truncated; a 200 is not \
                 proof of a complete body"
            ))
        } else {
            ExtractError::InvalidResponse(format!("{provider} response is not valid JSON: {e}"))
        }
    })
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

    #[test]
    fn every_truncation_of_a_success_body_is_a_loud_error() {
        // A 200 is not proof of a complete body: a server that writes its
        // header before it finishes encoding JSON emits a short 200 that is
        // a perfectly well-formed HTTP message.
        let full = r#"{"choices":[{"message":{"content":"{\"total\": 34.99}"}}]}"#;
        for cut in 0..full.len() {
            let err = decode_response_body("test", &full[..cut])
                .expect_err("a truncated envelope must never decode");
            assert!(matches!(err, ExtractError::InvalidResponse(_)), "{err}");
            assert!(
                err.to_string().contains("not proof of a complete body"),
                "cut {cut}: {err}"
            );
        }
        assert!(decode_response_body("test", full).is_ok());
    }

    #[test]
    fn empty_success_bodies_are_rejected() {
        for body in ["", "   ", "\n"] {
            let err = decode_response_body("test", body).unwrap_err();
            assert!(err.to_string().contains("empty body"), "{err}");
        }
    }

    #[test]
    fn a_truncated_body_is_not_retryable() {
        // Re-asking would hide a server publishing a wrong result.
        let err = decode_response_body("test", r#"{"choices":["#).unwrap_err();
        assert!(!err.is_retryable(), "{err}");
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
