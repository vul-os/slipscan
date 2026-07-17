//! BYO OAuth 2.0 machinery for the API-based mailbox connectors.
//!
//! SlipScan never operates a central OAuth client — the client id (and
//! secret, for Google) belong to the **user's own** app registration.
//! Two user-initiated grant flows, both without any public endpoint:
//!
//! * **Loopback flow** (Gmail): the browser is sent to the provider and
//!   redirected back to `http://127.0.0.1:<port>` where [`LoopbackFlow`]
//!   listens for exactly one authorization code. PKCE always.
//! * **Device-code flow** (Microsoft Graph): the user types a short code at
//!   the provider's verification URL; we poll the token endpoint.
//!
//! Refresh tokens live in the credential vault ([`crate::vault`]) as a JSON
//! [`TokenSet`]; refreshed/rotated tokens are persisted straight back.
//! Access tokens stay in memory, zeroized on drop, never logged.

use crate::http::{HttpClient, HttpRequest};
use crate::vault::{read_secret, VaultAccess};
use crate::{b64, IngestError, IngestResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use slipscan_core::secrets::SecretString;
use std::time::Duration;
use zeroize::ZeroizeOnDrop;

/// One provider app registration + where its tokens live in the vault.
/// Serializable except that secret material is only ever *referenced*.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthClientConfig {
    pub auth_endpoint: String,
    pub token_endpoint: String,
    pub client_id: String,
    /// Vault entry holding the client secret (Google desktop clients have
    /// one; public clients like Graph device-code do not).
    pub client_secret_ref: Option<String>,
    /// Vault entry holding the [`TokenSet`] JSON.
    pub token_ref: String,
    pub scopes: Vec<String>,
    /// Extra authorize-URL parameters (e.g. Google's `access_type=offline`).
    pub extra_auth_params: Vec<(String, String)>,
}

/// Tokens as persisted in the vault. Serde exists solely to cross the vault
/// boundary as an encrypted/keychain-backed blob; `Debug` is redacted and
/// the material is zeroized on drop.
#[derive(Clone, Serialize, Deserialize, ZeroizeOnDrop)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix seconds after which `access_token` must be refreshed.
    pub expires_at_unix: i64,
}

impl std::fmt::Debug for TokenSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenSet")
            .field("access_token", &"[REDACTED]")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("expires_at_unix", &self.expires_at_unix)
            .finish()
    }
}

impl TokenSet {
    pub fn is_fresh(&self, now_unix: i64) -> bool {
        !self.access_token.is_empty() && now_unix < self.expires_at_unix
    }
}

pub(crate) fn now_unix() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// Load the persisted token set for `token_ref`, if any.
pub(crate) fn load_tokens(
    vault: &dyn VaultAccess,
    token_ref: &str,
) -> IngestResult<Option<TokenSet>> {
    match read_secret(vault, token_ref) {
        Ok(json) => serde_json::from_str(json.expose_secret())
            .map(Some)
            .map_err(|e| IngestError::State(format!("corrupt token set in vault: {e}"))),
        Err(IngestError::MissingCredential(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Persist a (new or rotated) token set back to the vault.
pub(crate) fn save_tokens(
    vault: &dyn VaultAccess,
    token_ref: &str,
    tokens: &TokenSet,
) -> IngestResult<()> {
    let json = serde_json::to_string(tokens)
        .map_err(|e| IngestError::State(format!("token serialization: {e}")))?;
    vault.store(token_ref, &SecretString::new(json))
}

/// Yield a valid access token, refreshing (and persisting the rotation)
/// when needed. `cache` avoids a vault round-trip per request.
pub(crate) async fn ensure_access(
    http: &dyn HttpClient,
    vault: &dyn VaultAccess,
    config: &OAuthClientConfig,
    cache: &mut Option<TokenSet>,
) -> IngestResult<SecretString> {
    let now = now_unix();
    if let Some(tokens) = cache.as_ref() {
        if tokens.is_fresh(now) {
            return Ok(SecretString::new(tokens.access_token.clone()));
        }
    }
    let stored = load_tokens(vault, &config.token_ref)?
        .ok_or_else(|| IngestError::MissingCredential(config.token_ref.clone()))?;
    if stored.is_fresh(now) {
        let access = SecretString::new(stored.access_token.clone());
        *cache = Some(stored);
        return Ok(access);
    }
    let refresh_token = stored
        .refresh_token
        .clone()
        .ok_or_else(|| IngestError::Auth("no refresh token; reconnect the mailbox".into()))?;

    let mut params = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
        ("client_id", config.client_id.as_str()),
    ];
    let client_secret = match &config.client_secret_ref {
        Some(name) => Some(read_secret(vault, name)?),
        None => None,
    };
    if let Some(secret) = &client_secret {
        params.push(("client_secret", secret.expose_secret()));
    }
    let response = http
        .send(HttpRequest::post_form(&config.token_endpoint, &params))
        .await?;
    let mut refreshed = parse_token_response(&response.status, &response.body)?;
    // Providers may rotate the refresh token or omit it; keep the old one
    // when omitted so the grant survives.
    if refreshed.refresh_token.is_none() {
        refreshed.refresh_token = Some(refresh_token);
    }
    save_tokens(vault, &config.token_ref, &refreshed)?;
    let access = SecretString::new(refreshed.access_token.clone());
    *cache = Some(refreshed);
    Ok(access)
}

fn parse_token_response(status: &u16, body: &[u8]) -> IngestResult<TokenSet> {
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| IngestError::Parse(format!("token response: {e}")))?;
    if !(200..300).contains(status) {
        // OAuth error bodies carry an error code, never secret material.
        let code = value
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("unknown_error");
        return Err(IngestError::Auth(format!("token endpoint: {code}")));
    }
    let access_token = value
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IngestError::Parse("token response missing access_token".into()))?
        .to_string();
    let expires_in = value
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .unwrap_or(3600);
    Ok(TokenSet {
        access_token,
        refresh_token: value
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        // 30s skew so we refresh before the provider's clock does.
        expires_at_unix: now_unix() + expires_in.max(60) - 30,
    })
}

fn random_urlsafe(bytes: usize) -> IngestResult<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| IngestError::State(format!("no entropy: {e}")))?;
    Ok(b64::encode_url_nopad(&buf))
}

// ---------------------------------------------------------------------------
// Loopback (authorization-code + PKCE) flow
// ---------------------------------------------------------------------------

/// A pending loopback authorization: a one-shot listener on `127.0.0.1`.
///
/// User-initiated by construction — nothing runs until the user opens
/// [`LoopbackFlow::authorize_url`] in their browser and consents.
pub struct LoopbackFlow {
    listener: tokio::net::TcpListener,
    redirect_uri: String,
    authorize_url: String,
    state: String,
    verifier: SecretString,
}

impl std::fmt::Debug for LoopbackFlow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoopbackFlow")
            .field("redirect_uri", &self.redirect_uri)
            .finish_non_exhaustive()
    }
}

/// Bind the loopback listener and build the authorize URL (with PKCE).
pub async fn begin_loopback_flow(config: &OAuthClientConfig) -> IngestResult<LoopbackFlow> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| IngestError::Connection(format!("loopback bind: {e}")))?;
    let port = listener.local_addr().map_err(IngestError::Io)?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/");
    let state = random_urlsafe(24)?;
    let verifier = random_urlsafe(48)?; // 64 chars, within RFC 7636's 43..=128
    let challenge = b64::encode_url_nopad(&Sha256::digest(verifier.as_bytes()));

    let scopes = config.scopes.join(" ");
    let mut params = vec![
        ("response_type", "code"),
        ("client_id", config.client_id.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("scope", scopes.as_str()),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ];
    for (k, v) in &config.extra_auth_params {
        params.push((k.as_str(), v.as_str()));
    }
    let authorize_url = format!(
        "{}?{}",
        config.auth_endpoint,
        crate::http::form_encode(&params)
    );
    Ok(LoopbackFlow {
        listener,
        redirect_uri,
        authorize_url,
        state,
        verifier: SecretString::new(verifier),
    })
}

impl LoopbackFlow {
    /// The URL the user must open in their browser.
    pub fn authorize_url(&self) -> &str {
        &self.authorize_url
    }

    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    /// Wait for the provider's redirect, exchange the code, and persist the
    /// resulting tokens straight into the vault. Returns nothing — token
    /// material never crosses this API.
    pub async fn finish(
        self,
        http: &dyn HttpClient,
        vault: &dyn VaultAccess,
        config: &OAuthClientConfig,
    ) -> IngestResult<()> {
        let code = self.wait_for_code().await?;
        let mut params = vec![
            ("grant_type", "authorization_code"),
            ("code", code.expose_secret()),
            ("client_id", config.client_id.as_str()),
            ("redirect_uri", self.redirect_uri.as_str()),
            ("code_verifier", self.verifier.expose_secret()),
        ];
        let client_secret = match &config.client_secret_ref {
            Some(name) => Some(read_secret(vault, name)?),
            None => None,
        };
        if let Some(secret) = &client_secret {
            params.push(("client_secret", secret.expose_secret()));
        }
        let response = http
            .send(HttpRequest::post_form(&config.token_endpoint, &params))
            .await?;
        let tokens = parse_token_response(&response.status, &response.body)?;
        save_tokens(vault, &config.token_ref, &tokens)
    }

    /// Accept connections until one carries the authorization redirect.
    /// Browsers also request favicons etc. — those get a 404 and the wait
    /// continues.
    async fn wait_for_code(&self) -> IngestResult<SecretString> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        loop {
            let (mut stream, _addr) = self
                .listener
                .accept()
                .await
                .map_err(|e| IngestError::Connection(format!("loopback accept: {e}")))?;
            let mut buf = vec![0u8; 8192];
            let n = stream.read(&mut buf).await.map_err(IngestError::Io)?;
            let request = String::from_utf8_lossy(&buf[..n]).into_owned();
            match parse_redirect_request(&request, &self.state) {
                RedirectParse::Code(code) => {
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nconnection: close\r\n\r\n\
<html><body><p>SlipScan is connected. You can close this tab.</p></body></html>",
                        )
                        .await;
                    return Ok(SecretString::new(code));
                }
                RedirectParse::Denied(reason) => {
                    let _ = stream
                        .write_all(b"HTTP/1.1 200 OK\r\nconnection: close\r\n\r\nAuthorization failed; return to SlipScan.")
                        .await;
                    return Err(IngestError::Auth(format!("authorization denied: {reason}")));
                }
                RedirectParse::NotTheRedirect => {
                    let _ = stream
                        .write_all(b"HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n")
                        .await;
                }
            }
        }
    }
}

enum RedirectParse {
    Code(String),
    Denied(String),
    NotTheRedirect,
}

fn parse_redirect_request(request: &str, expected_state: &str) -> RedirectParse {
    let Some(line) = request.lines().next() else {
        return RedirectParse::NotTheRedirect;
    };
    let Some(target) = line.strip_prefix("GET ").and_then(|r| r.split(' ').next()) else {
        return RedirectParse::NotTheRedirect;
    };
    let Some(query) = target.split_once('?').map(|(_, q)| q) else {
        return RedirectParse::NotTheRedirect;
    };
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let Ok(v) = crate::http::percent_decode(v) else {
            continue;
        };
        match k {
            "code" => code = Some(v),
            "state" => state = Some(v),
            "error" => error = Some(v),
            _ => {}
        }
    }
    if let Some(reason) = error {
        return RedirectParse::Denied(reason);
    }
    match (code, state) {
        // A response with a code but the wrong state is an injection
        // attempt — treat as denial, not as "not the redirect".
        (Some(_), Some(s)) if s != expected_state => RedirectParse::Denied("state mismatch".into()),
        (Some(code), Some(_)) => RedirectParse::Code(code),
        _ => RedirectParse::NotTheRedirect,
    }
}

// ---------------------------------------------------------------------------
// Device-code flow (Microsoft Graph)
// ---------------------------------------------------------------------------

/// The prompt to show the user: go to `verification_uri`, type `user_code`.
pub struct DeviceAuthorization {
    pub verification_uri: String,
    pub user_code: String,
    pub interval: Duration,
    pub expires_in: Duration,
    device_code: SecretString,
}

impl std::fmt::Debug for DeviceAuthorization {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceAuthorization")
            .field("verification_uri", &self.verification_uri)
            .field("user_code", &self.user_code)
            .finish_non_exhaustive()
    }
}

/// Ask the provider for a device code. `device_endpoint` is e.g.
/// `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode`.
pub async fn begin_device_flow(
    http: &dyn HttpClient,
    device_endpoint: &str,
    config: &OAuthClientConfig,
) -> IngestResult<DeviceAuthorization> {
    let scopes = config.scopes.join(" ");
    let response = http
        .send(HttpRequest::post_form(
            device_endpoint,
            &[
                ("client_id", config.client_id.as_str()),
                ("scope", scopes.as_str()),
            ],
        ))
        .await?;
    let value = response.json()?;
    if !response.is_success() {
        let code = value
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("unknown_error");
        return Err(IngestError::Auth(format!("device authorization: {code}")));
    }
    let str_field = |name: &str| -> IngestResult<String> {
        value
            .get(name)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| IngestError::Parse(format!("device response missing {name}")))
    };
    Ok(DeviceAuthorization {
        verification_uri: str_field("verification_uri")?,
        user_code: str_field("user_code")?,
        interval: Duration::from_secs(value.get("interval").and_then(|v| v.as_u64()).unwrap_or(5)),
        expires_in: Duration::from_secs(
            value
                .get("expires_in")
                .and_then(|v| v.as_u64())
                .unwrap_or(900),
        ),
        device_code: SecretString::new(str_field("device_code")?),
    })
}

/// Poll the token endpoint until the user completes (or abandons) the
/// device login, then persist the tokens into the vault.
pub async fn finish_device_flow(
    http: &dyn HttpClient,
    vault: &dyn VaultAccess,
    config: &OAuthClientConfig,
    authorization: DeviceAuthorization,
) -> IngestResult<()> {
    let deadline = std::time::Instant::now() + authorization.expires_in;
    let mut interval = authorization.interval;
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(IngestError::Auth("device code expired".into()));
        }
        let response = http
            .send(HttpRequest::post_form(
                &config.token_endpoint,
                &[
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                    ("client_id", config.client_id.as_str()),
                    ("device_code", authorization.device_code.expose_secret()),
                ],
            ))
            .await?;
        if response.is_success() {
            let tokens = parse_token_response(&response.status, &response.body)?;
            return save_tokens(vault, &config.token_ref, &tokens);
        }
        let value = response.json()?;
        match value.get("error").and_then(|e| e.as_str()) {
            Some("authorization_pending") => {}
            Some("slow_down") => interval += Duration::from_secs(5),
            Some(code) => return Err(IngestError::Auth(format!("device login: {code}"))),
            None => return Err(IngestError::Auth("device login failed".into())),
        }
        tokio::time::sleep(interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::testutil::FakeHttpClient;
    use crate::vault::MemoryVault;

    fn config() -> OAuthClientConfig {
        OAuthClientConfig {
            auth_endpoint: "https://provider.example/auth".into(),
            token_endpoint: "https://provider.example/token".into(),
            client_id: "client-123".into(),
            client_secret_ref: Some("oauth.client_secret".into()),
            token_ref: "oauth.tokens".into(),
            scopes: vec!["mail.read".into()],
            extra_auth_params: vec![("access_type".into(), "offline".into())],
        }
    }

    fn stored_tokens(vault: &MemoryVault) -> TokenSet {
        load_tokens(vault, "oauth.tokens").unwrap().expect("tokens")
    }

    #[test]
    fn token_set_debug_is_redacted_and_json_round_trips() {
        let tokens = TokenSet {
            access_token: "at-secret".into(),
            refresh_token: Some("rt-secret".into()),
            expires_at_unix: 1,
        };
        let dbg = format!("{tokens:?}");
        assert!(
            !dbg.contains("at-secret") && !dbg.contains("rt-secret"),
            "{dbg}"
        );
        let back: TokenSet =
            serde_json::from_str(&serde_json::to_string(&tokens).unwrap()).unwrap();
        assert_eq!(back.access_token, "at-secret");
    }

    #[tokio::test]
    async fn ensure_access_refreshes_expired_tokens_and_persists_rotation() {
        let vault = MemoryVault::new().with("oauth.client_secret", "cs-secret");
        save_tokens(
            &vault,
            "oauth.tokens",
            &TokenSet {
                access_token: "stale".into(),
                refresh_token: Some("refresh-1".into()),
                expires_at_unix: now_unix() - 10,
            },
        )
        .unwrap();
        let http = FakeHttpClient::new().route(
            "/token",
            200,
            r#"{"access_token":"fresh","refresh_token":"refresh-2","expires_in":3600}"#,
        );

        let mut cache = None;
        let access = ensure_access(&http, &vault, &config(), &mut cache)
            .await
            .unwrap();
        assert_eq!(access.expose_secret(), "fresh");
        let body = http.last_body_utf8();
        assert!(body.contains("grant_type=refresh_token"), "{body}");
        assert!(body.contains("refresh_token=refresh-1"), "{body}");
        assert!(body.contains("client_secret=cs-secret"), "{body}");
        // The rotated refresh token was persisted back to the vault.
        assert_eq!(
            stored_tokens(&vault).refresh_token.as_deref(),
            Some("refresh-2")
        );

        // Second call hits the in-memory cache — no extra token request.
        let sent_before = http.sent_urls().len();
        let again = ensure_access(&http, &vault, &config(), &mut cache)
            .await
            .unwrap();
        assert_eq!(again.expose_secret(), "fresh");
        assert_eq!(http.sent_urls().len(), sent_before);
    }

    #[tokio::test]
    async fn refresh_keeps_old_refresh_token_when_provider_omits_it() {
        let vault = MemoryVault::new().with("oauth.client_secret", "cs");
        save_tokens(
            &vault,
            "oauth.tokens",
            &TokenSet {
                access_token: "stale".into(),
                refresh_token: Some("keep-me".into()),
                expires_at_unix: 0,
            },
        )
        .unwrap();
        let http = FakeHttpClient::new().route(
            "/token",
            200,
            r#"{"access_token":"fresh","expires_in":100}"#,
        );
        ensure_access(&http, &vault, &config(), &mut None)
            .await
            .unwrap();
        assert_eq!(
            stored_tokens(&vault).refresh_token.as_deref(),
            Some("keep-me")
        );
    }

    #[tokio::test]
    async fn loopback_flow_exchanges_code_for_tokens() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // A long, collision-proof marker: the old 2-char needle "cs" showed
        // up inside the random base64url state/PKCE-challenge params in ~2%
        // of runs, making this test flaky for no real reason.
        let secret = "client-secret-material-must-never-leak";
        let vault = MemoryVault::new().with("oauth.client_secret", secret);
        let cfg = config();
        let flow = begin_loopback_flow(&cfg).await.unwrap();
        let url = flow.authorize_url().to_string();
        assert!(url.contains("code_challenge_method=S256"), "{url}");
        assert!(url.contains("access_type=offline"), "{url}");
        assert!(
            !url.contains(secret) && !url.contains("client_secret="),
            "no client secret in the browser URL: {url}"
        );
        let state = flow.state.clone();
        let redirect = flow.redirect_uri().to_string();

        // Simulate the browser redirect hitting the loopback listener
        // (loopback only — no external network).
        let browser = tokio::spawn(async move {
            let addr = redirect
                .trim_start_matches("http://")
                .trim_end_matches('/')
                .to_string();
            // First a stray favicon request — must not consume the wait.
            let mut s = tokio::net::TcpStream::connect(&addr).await.unwrap();
            s.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n")
                .await
                .unwrap();
            let mut buf = [0u8; 128];
            let _ = s.read(&mut buf).await;
            // Then the real redirect.
            let mut s = tokio::net::TcpStream::connect(&addr).await.unwrap();
            s.write_all(
                format!("GET /?state={state}&code=auth-code-1 HTTP/1.1\r\n\r\n").as_bytes(),
            )
            .await
            .unwrap();
            let mut response = Vec::new();
            let _ = s.read_to_end(&mut response).await;
            String::from_utf8_lossy(&response).into_owned()
        });

        let http = FakeHttpClient::new().route(
            "/token",
            200,
            r#"{"access_token":"at","refresh_token":"rt","expires_in":3600}"#,
        );
        flow.finish(&http, &vault, &cfg).await.unwrap();

        let body = http.last_body_utf8();
        assert!(body.contains("grant_type=authorization_code"), "{body}");
        assert!(body.contains("code=auth-code-1"), "{body}");
        assert!(body.contains("code_verifier="), "{body}");
        assert_eq!(stored_tokens(&vault).refresh_token.as_deref(), Some("rt"));

        let page = browser.await.unwrap();
        assert!(page.contains("close this tab"), "{page}");
    }

    #[test]
    fn redirect_with_wrong_state_is_rejected() {
        let parsed = parse_redirect_request(
            "GET /?state=evil&code=stolen HTTP/1.1\r\n\r\n",
            "expected-state",
        );
        assert!(matches!(parsed, RedirectParse::Denied(_)));
    }

    #[tokio::test]
    async fn device_flow_polls_until_authorized() {
        let vault = MemoryVault::new();
        let mut cfg = config();
        cfg.client_secret_ref = None; // public client

        let http = FakeHttpClient::new()
            .route(
                "/devicecode",
                200,
                r#"{"device_code":"dc-1","user_code":"ABC-123","verification_uri":"https://provider.example/devicelogin","interval":0,"expires_in":900}"#,
            )
            .route(
                "/token",
                200,
                r#"{"access_token":"at","refresh_token":"rt","expires_in":3600}"#,
            );
        let auth = begin_device_flow(&http, "https://provider.example/devicecode", &cfg)
            .await
            .unwrap();
        assert_eq!(auth.user_code, "ABC-123");
        assert!(
            !format!("{auth:?}").contains("dc-1"),
            "device code redacted"
        );

        finish_device_flow(&http, &vault, &cfg, auth).await.unwrap();
        let body = http.last_body_utf8();
        assert!(body.contains("device_code=dc-1"), "{body}");
        assert!(
            body.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"),
            "{body}"
        );
        assert_eq!(stored_tokens(&vault).access_token, "at");
    }
}
