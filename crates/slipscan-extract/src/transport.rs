//! HTTP transport abstraction so providers are testable without a network.
//!
//! Providers build an [`HttpRequest`] and hand it to a [`Transport`]. The
//! real implementation is [`ReqwestTransport`]; tests use the canned
//! [`mock::MockTransport`]. Requests only ever happen inside
//! [`crate::provider::ExtractionProvider::extract`] calls, which the user
//! explicitly triggers — this crate performs no background network I/O.
//!
//! `HttpRequest`'s `Debug` impl redacts header values by construction so API
//! keys can never leak through logs or error formatting.

use crate::provider::ExtractError;
use async_trait::async_trait;
use std::fmt;
use std::time::Duration;

/// An outbound JSON POST. Headers may contain credentials — see the manual
/// [`fmt::Debug`] impl below.
#[derive(Clone)]
pub struct HttpRequest {
    pub url: String,
    /// Header name/value pairs. Values are treated as secret.
    pub headers: Vec<(String, String)>,
    pub body: serde_json::Value,
}

impl fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<&str> = self.headers.iter().map(|(k, _)| k.as_str()).collect();
        f.debug_struct("HttpRequest")
            .field("url", &self.url)
            .field("headers", &names)
            .field("body", &"<omitted>")
            .finish()
    }
}

/// A completed HTTP exchange.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// Minimal async HTTP client surface providers depend on.
#[async_trait]
pub trait Transport: Send + Sync {
    async fn post_json(&self, request: HttpRequest) -> Result<HttpResponse, ExtractError>;
}

/// Real transport over `reqwest` (rustls, no system TLS).
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .connect_timeout(Duration::from_secs(20))
            .build()
            .expect("reqwest client builds with static config");
        Self { client }
    }
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Transport for ReqwestTransport {
    async fn post_json(&self, request: HttpRequest) -> Result<HttpResponse, ExtractError> {
        let mut builder = self.client.post(&request.url).json(&request.body);
        for (name, value) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        // reqwest::Error Display can embed the URL but never header values;
        // URLs here are provider endpoints, not secrets.
        let response = builder
            .send()
            .await
            .map_err(|e| ExtractError::Transport(e.to_string()))?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .map_err(|e| ExtractError::Transport(e.to_string()))?;
        Ok(HttpResponse { status, body })
    }
}

#[cfg(test)]
pub(crate) mod mock {
    //! Canned transport for unit tests — records requests, replays responses.

    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MockTransport {
        requests: Mutex<Vec<HttpRequest>>,
        responses: Mutex<VecDeque<Result<HttpResponse, ExtractError>>>,
    }

    impl MockTransport {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn push_response(&self, status: u16, body: impl Into<String>) {
            self.responses.lock().unwrap().push_back(Ok(HttpResponse {
                status,
                body: body.into(),
            }));
        }

        pub fn push_error(&self, err: ExtractError) {
            self.responses.lock().unwrap().push_back(Err(err));
        }

        pub fn requests(&self) -> Vec<HttpRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl Transport for MockTransport {
        async fn post_json(&self, request: HttpRequest) -> Result<HttpResponse, ExtractError> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("MockTransport: no canned response left")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_prints_header_values() {
        let req = HttpRequest {
            url: "https://api.example.com/v1/messages".into(),
            headers: vec![("x-api-key".into(), "sk-super-secret".into())],
            body: serde_json::json!({"model": "m"}),
        };
        let rendered = format!("{req:?}");
        assert!(rendered.contains("x-api-key"), "header names are fine");
        assert!(
            !rendered.contains("sk-super-secret"),
            "values must be redacted"
        );
        assert!(!rendered.contains("model"), "body is omitted");
    }
}
