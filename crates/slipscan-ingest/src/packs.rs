//! Production HTTPS transport for `slipscan-packs`' `https:` pack sources.
//!
//! slipscan-packs defines [`PackHttp`] and ships no implementation, exactly as
//! slipscan-core defines `FxTransport` and ships none — so that no default
//! endpoint can exist and the pack format stays testable without a socket.
//! This crate already carries `reqwest`, so the real one lives here, beside
//! [`crate::fx::ReqwestFxTransport`] and for the same reason.
//!
//! Requests only ever go to a base URL **the user added as a source**
//! (`slipscan pack source add https://…`). With no source configured, nothing
//! constructs this at all.

use std::time::Duration;

use slipscan_packs::transport::{HttpBlob, PackHttp};

/// Default per-request budget. Fetching a pack is a foreground action a user
/// is waiting on; it should fail rather than hang.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// reqwest (rustls) GET transport for pack sources.
///
/// Blocking on the outside, async on the inside: [`PackHttp`] is synchronous
/// because the whole pack path (rusqlite, verification, install) is, and the
/// runtime this owns is private to it. Constructing one per fetch round is
/// fine — pack fetches are rare and explicit.
pub struct ReqwestPackHttp {
    client: reqwest::Client,
    runtime: tokio::runtime::Runtime,
}

impl ReqwestPackHttp {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            // A pack source is a static file host; a handful of redirects is
            // ordinary, an unbounded chain is not.
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| format!("pack http client: {e}"))?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("pack http runtime: {e}"))?;
        Ok(Self { client, runtime })
    }
}

impl std::fmt::Debug for ReqwestPackHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReqwestPackHttp").finish_non_exhaustive()
    }
}

impl PackHttp for ReqwestPackHttp {
    fn get(&self, url: &str) -> Result<HttpBlob, String> {
        // `block_on` on this struct's own current-thread runtime. Callers on
        // an async runtime must reach here from a blocking context
        // (`spawn_blocking` / `block_in_place`), which is how every surface
        // wires it — the same shape as the explicit FX fetch.
        self.runtime.block_on(async {
            let response = self
                .client
                .get(url)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            let body = response.bytes().await.map_err(|e| e.to_string())?.to_vec();
            Ok(HttpBlob { status, body })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The type-level part of the contract: this is the thing
    /// `slipscan-packs` will accept, and it is `Send + Sync` so a surface can
    /// hand it to a background task.
    #[test]
    fn it_is_the_transport_slipscan_packs_asks_for() {
        fn assert_pack_http<T: PackHttp + Send + Sync + 'static>() {}
        assert_pack_http::<ReqwestPackHttp>();
    }

    /// Constructing one performs no request. Building a client is not
    /// contacting anybody, and nothing here has an endpoint to contact.
    #[test]
    fn constructing_it_talks_to_nobody() {
        let http = ReqwestPackHttp::new().unwrap();
        assert!(format!("{http:?}").contains("ReqwestPackHttp"));
    }
}
