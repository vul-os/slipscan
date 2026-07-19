//! Production transport for slipscan-core's ShapePay webhook dispatcher.
//!
//! Core defines the [`WebhookTransport`] trait so it stays strictly
//! network-free; this crate already carries `reqwest`, so the real
//! implementation lives here beside [`crate::fx::ReqwestFxTransport`] (same
//! split as [`crate::http`]). POSTs only ever go to webhook endpoint URLs the
//! user registered (`pay_endpoint_add` validates them — http(s), no embedded
//! credentials), and core signs every body before it reaches this transport.

use async_trait::async_trait;
use slipscan_core::pay::{WebhookResponse, WebhookTransport};
use slipscan_core::CoreError;
use std::time::Duration;

/// reqwest (rustls) POST transport for webhook deliveries.
///
/// **Follows no redirects**: a redirect would re-send the signed payload to a
/// location the user never configured, so any 3xx is surfaced as-is (core
/// treats it as a retryable non-success).
pub struct ReqwestWebhookTransport {
    client: reqwest::Client,
}

impl ReqwestWebhookTransport {
    pub fn new() -> Result<Self, CoreError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| CoreError::PayTransport(e.to_string()))?;
        Ok(Self { client })
    }
}

impl std::fmt::Debug for ReqwestWebhookTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReqwestWebhookTransport")
            .finish_non_exhaustive()
    }
}

#[async_trait(?Send)]
impl WebhookTransport for ReqwestWebhookTransport {
    async fn post(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> Result<WebhookResponse, CoreError> {
        let mut builder = self.client.post(url);
        for (name, value) in headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        // reqwest errors include at most the URL — an endpoint the user
        // registered, never secret material (the signature headers are
        // derived MACs, not the secret; and header values never appear in
        // reqwest error strings anyway).
        let response = builder
            .body(body.to_vec())
            .send()
            .await
            .map_err(|e| CoreError::PayTransport(e.to_string()))?;
        // The response body is receiver-controlled and deliberately dropped:
        // core records only the status.
        Ok(WebhookResponse {
            status: response.status().as_u16(),
        })
    }
}
