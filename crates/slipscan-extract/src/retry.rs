//! Retry policy for provider HTTP calls.
//!
//! Extraction runs are explicit user actions, so retries are bounded and
//! immediate — we never sleep in the background or keep hammering a rate
//! limit. Only transient transport failures (connection errors, 5xx) are
//! retried; auth failures and rate limits surface to the user right away.

use crate::provider::ExtractError;

/// Total attempts per request (1 initial + 2 retries).
pub const MAX_ATTEMPTS: usize = 3;

/// True for errors worth an immediate bounded retry.
pub fn should_retry(err: &ExtractError) -> bool {
    matches!(err, ExtractError::Transport(_))
}

/// Map a non-success HTTP status to the corresponding error, or `None` for
/// 2xx. `detail` is a short, secret-free snippet of the response body.
pub fn error_for_status(provider: &str, status: u16, detail: &str) -> Option<ExtractError> {
    match status {
        200..=299 => None,
        401 | 403 => Some(ExtractError::Auth(format!(
            "{provider} rejected the API key (HTTP {status})"
        ))),
        429 => Some(ExtractError::RateLimited),
        500..=599 => Some(ExtractError::Transport(format!(
            "{provider} returned HTTP {status}"
        ))),
        _ => Some(ExtractError::Provider(format!(
            "{provider} returned HTTP {status}: {detail}"
        ))),
    }
}

/// Truncate a response body for error messages (avoids dumping payloads).
pub fn snippet(body: &str, max: usize) -> &str {
    match body.char_indices().nth(max) {
        Some((idx, _)) => &body[..idx],
        None => body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_mapping() {
        assert!(error_for_status("p", 200, "").is_none());
        assert!(matches!(
            error_for_status("p", 401, ""),
            Some(ExtractError::Auth(_))
        ));
        assert!(matches!(
            error_for_status("p", 429, ""),
            Some(ExtractError::RateLimited)
        ));
        assert!(matches!(
            error_for_status("p", 503, ""),
            Some(ExtractError::Transport(_))
        ));
        assert!(matches!(
            error_for_status("p", 400, "bad schema"),
            Some(ExtractError::Provider(m)) if m.contains("bad schema")
        ));
    }

    #[test]
    fn only_transport_errors_retry() {
        assert!(should_retry(&ExtractError::Transport("boom".into())));
        assert!(!should_retry(&ExtractError::RateLimited));
        assert!(!should_retry(&ExtractError::Auth("no".into())));
    }

    #[test]
    fn snippet_truncates_on_char_boundary() {
        assert_eq!(snippet("héllo world", 4), "héll");
        assert_eq!(snippet("ok", 10), "ok");
    }
}
