//! Minimal HTTP abstraction for the OAuth-based connectors (Gmail, Graph,
//! Pub/Sub pull).
//!
//! Protocol logic is written against [`HttpClient`] so every connector is
//! testable with scripted responses — tests never touch the network. The
//! production impl is [`ReqwestHttpClient`] (rustls). Requests only ever go
//! to endpoints derived from the user's own configuration (mantra #2).

use crate::{IngestError, IngestResult};
use async_trait::async_trait;

/// The verbs the connectors need.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

/// One outbound request. `Debug` redacts header values and the body so an
/// `Authorization: Bearer …` or token-exchange form can never reach a log.
#[derive(Clone)]
pub struct HttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

impl HttpRequest {
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            method: HttpMethod::Get,
            url: url.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    pub fn post(url: impl Into<String>) -> Self {
        Self {
            method: HttpMethod::Post,
            url: url.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    /// POST with an `application/x-www-form-urlencoded` body.
    pub fn post_form(url: impl Into<String>, params: &[(&str, &str)]) -> Self {
        Self::post(url)
            .header("content-type", "application/x-www-form-urlencoded")
            .with_body(form_encode(params).into_bytes())
    }

    /// POST with a JSON body.
    pub fn post_json(url: impl Into<String>, value: &serde_json::Value) -> Self {
        Self::post(url)
            .header("content-type", "application/json")
            .with_body(value.to_string().into_bytes())
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    /// Add an `Authorization: Bearer` header. The token value is redacted
    /// from `Debug` like every other header.
    pub fn bearer(self, token: &str) -> Self {
        self.header("authorization", &format!("Bearer {token}"))
    }

    pub fn with_body(mut self, body: Vec<u8>) -> Self {
        self.body = Some(body);
        self
    }
}

impl std::fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field(
                "headers",
                &self
                    .headers
                    .iter()
                    .map(|(k, _)| (k.as_str(), "[REDACTED]"))
                    .collect::<Vec<_>>(),
            )
            .field("body_len", &self.body.as_ref().map(Vec::len))
            .finish()
    }
}

/// A response body plus status. `Debug` prints only the status and body
/// length — OAuth token-endpoint responses carry `access_token` /
/// `refresh_token` material in their bodies, so a `format!("{resp:?}")` in
/// an error path must never leak them.
#[derive(Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl std::fmt::Debug for HttpResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpResponse")
            .field("status", &self.status)
            .field("body_len", &self.body.len())
            .finish()
    }
}

impl HttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn json(&self) -> IngestResult<serde_json::Value> {
        serde_json::from_slice(&self.body)
            .map_err(|e| IngestError::Parse(format!("invalid JSON response: {e}")))
    }
}

/// The transport trait. `?Send` to match the connector traits (connectors
/// may borrow the single-threaded core service).
#[async_trait(?Send)]
pub trait HttpClient {
    async fn send(&self, request: HttpRequest) -> IngestResult<HttpResponse>;
}

/// Production client: reqwest over rustls.
pub struct ReqwestHttpClient {
    client: reqwest::Client,
}

impl ReqwestHttpClient {
    pub fn new() -> IngestResult<Self> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| IngestError::Http(e.to_string()))?;
        Ok(Self { client })
    }
}

#[async_trait(?Send)]
impl HttpClient for ReqwestHttpClient {
    async fn send(&self, request: HttpRequest) -> IngestResult<HttpResponse> {
        let method = match request.method {
            HttpMethod::Get => reqwest::Method::GET,
            HttpMethod::Post => reqwest::Method::POST,
        };
        let mut builder = self.client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        // reqwest errors include URLs at most — never header/body material.
        let response = builder
            .send()
            .await
            .map_err(|e| IngestError::Http(e.to_string()))?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .map_err(|e| IngestError::Http(e.to_string()))?
            .to_vec();
        Ok(HttpResponse { status, body })
    }
}

/// `application/x-www-form-urlencoded` encoding (RFC 3986 unreserved kept).
pub fn form_encode(params: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (i, (k, v)) in params.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        percent_encode_into(&mut out, k);
        out.push('=');
        percent_encode_into(&mut out, v);
    }
    out
}

fn percent_encode_into(out: &mut String, raw: &str) {
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
}

/// Decode a percent-encoded component (query values in OAuth redirects).
pub fn percent_decode(raw: &str) -> IngestResult<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = bytes
                    .get(i + 1..i + 3)
                    .and_then(|h| std::str::from_utf8(h).ok())
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                    .ok_or_else(|| IngestError::Parse("bad percent-encoding".into()))?;
                out.push(hex);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| IngestError::Parse("invalid UTF-8 after decode".into()))
}

#[cfg(test)]
pub(crate) mod testutil {
    //! Scripted fake HTTP client shared by connector tests.

    use super::*;
    use std::cell::RefCell;

    /// Route table: first rule whose `url_contains` matches wins. Every sent
    /// request is recorded for assertions.
    #[derive(Default)]
    pub struct FakeHttpClient {
        pub rules: Vec<(String, u16, String)>,
        pub sent: RefCell<Vec<HttpRequest>>,
    }

    impl FakeHttpClient {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn route(mut self, url_contains: &str, status: u16, body: &str) -> Self {
            self.rules
                .push((url_contains.to_string(), status, body.to_string()));
            self
        }

        /// Requests sent so far (method + url).
        pub fn sent_urls(&self) -> Vec<String> {
            self.sent.borrow().iter().map(|r| r.url.clone()).collect()
        }

        pub fn last_body_utf8(&self) -> String {
            self.sent
                .borrow()
                .last()
                .and_then(|r| r.body.clone())
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default()
        }
    }

    #[async_trait(?Send)]
    impl HttpClient for FakeHttpClient {
        async fn send(&self, request: HttpRequest) -> IngestResult<HttpResponse> {
            let hit = self
                .rules
                .iter()
                .find(|(frag, _, _)| request.url.contains(frag.as_str()))
                .map(|(_, status, body)| HttpResponse {
                    status: *status,
                    body: body.clone().into_bytes(),
                });
            self.sent.borrow_mut().push(request.clone());
            hit.ok_or_else(|| IngestError::Http(format!("no scripted route for {}", request.url)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_encoding_percent_encodes_reserved_characters() {
        let encoded = form_encode(&[("redirect_uri", "http://127.0.0.1:7777/"), ("a b", "c&d")]);
        assert_eq!(
            encoded,
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A7777%2F&a%20b=c%26d"
        );
    }

    #[test]
    fn percent_decode_round_trips() {
        assert_eq!(
            percent_decode("http%3A%2F%2Fx%2F%3Fa%3Db+c").unwrap(),
            "http://x/?a=b c"
        );
        assert!(percent_decode("%zz").is_err());
    }

    #[test]
    fn debug_redacts_headers_and_body() {
        let req = HttpRequest::post_form("https://oauth.example/token", &[("secret", "s3cr3t")])
            .bearer("token-material");
        let dbg = format!("{req:?}");
        assert!(!dbg.contains("s3cr3t"), "{dbg}");
        assert!(!dbg.contains("token-material"), "{dbg}");
        assert!(dbg.contains("[REDACTED]"));
    }

    #[test]
    fn response_debug_never_prints_the_body() {
        // Token-endpoint response bodies carry live OAuth tokens.
        let resp = HttpResponse {
            status: 200,
            body: br#"{"access_token":"live-token","refresh_token":"live-refresh"}"#.to_vec(),
        };
        let dbg = format!("{resp:?}");
        assert!(!dbg.contains("live-token"), "{dbg}");
        assert!(!dbg.contains("live-refresh"), "{dbg}");
        assert!(dbg.contains("body_len"));
    }
}
