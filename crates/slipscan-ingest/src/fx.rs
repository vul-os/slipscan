//! Production transport for slipscan-core's OpenRate FX client.
//!
//! Core defines the [`FxTransport`] trait so it stays strictly network-free;
//! this crate already carries `reqwest`, so the real implementation lives
//! here (same split as [`crate::http`]). Requests only ever go to the
//! OpenRate base URL the user configured (`fx_configure`) — core refuses to
//! call the transport at all while no base URL is set (mantra #1/#2).

use async_trait::async_trait;
use slipscan_core::fx::{FxHttpResponse, FxTransport};
use slipscan_core::CoreError;
use std::time::Duration;

/// reqwest (rustls) GET transport for OpenRate.
pub struct ReqwestFxTransport {
    client: reqwest::Client,
}

impl ReqwestFxTransport {
    pub fn new() -> Result<Self, CoreError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| CoreError::FxTransport(e.to_string()))?;
        Ok(Self { client })
    }
}

impl std::fmt::Debug for ReqwestFxTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReqwestFxTransport").finish_non_exhaustive()
    }
}

#[async_trait(?Send)]
impl FxTransport for ReqwestFxTransport {
    async fn get(&self, url: &str) -> Result<FxHttpResponse, CoreError> {
        // reqwest errors include at most the URL — an OpenRate endpoint the
        // user configured, not a secret. That assumption is *enforced*, not
        // assumed: `fx::normalize_base_url` rejects credential-embedding
        // URLs (user:pass@host) on every configuration path.
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| CoreError::FxTransport(e.to_string()))?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .map_err(|e| CoreError::FxTransport(e.to_string()))?
            .to_vec();
        Ok(FxHttpResponse { status, body })
    }
}
