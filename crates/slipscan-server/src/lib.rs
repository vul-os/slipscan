//! slipscan-server — headless self-host mode.
//!
//! A thin axum wrapper over slipscan-core services. Every core operation is
//! exposed as a JSON route under `/api/v1/<operation_name>` — the same names
//! the Tauri IPC layer uses (`book_list`, `transaction_categorize`, …).
//!
//! Privacy posture (mantra #3):
//! * binds `127.0.0.1` by default; a non-loopback bind is an explicit user
//!   opt-in the caller must have surfaced
//! * no telemetry, no default network calls — this server only ever *listens*
//! * no TLS termination here: put a reverse proxy in front for LAN/remote
//!   access (see this crate's README.md)
//! * optional bearer-token auth: the token is generated on first run, printed
//!   exactly once, and only its SHA-256 is stored in settings

use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard};

use slipscan_core::datadir::DataDirResolver;
use slipscan_core::fx::FxTransport;
use slipscan_core::pay::WebhookTransport;
use slipscan_core::{CoreError, CoreService};

pub mod ops;
mod routes;
pub mod vault;

pub use routes::app;

/// Default bind: localhost only.
pub const DEFAULT_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DEFAULT_PORT);
pub const DEFAULT_PORT: u16 = 7151;

/// Settings key holding the SHA-256 (hex) of the API bearer token. The token
/// itself is never stored anywhere.
pub const AUTH_TOKEN_SETTING: &str = "server.auth_token_sha256";

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("bind failed: {0}")]
    Bind(std::io::Error),

    #[error("server error: {0}")]
    Serve(std::io::Error),

    #[error(transparent)]
    Core(#[from] CoreError),

    #[error("auth requested but no token is initialized; call ensure_auth_token first")]
    AuthNotInitialized,

    #[error("stored auth token hash is malformed; re-initialize it")]
    MalformedTokenHash,

    #[error("token must be at least 16 characters")]
    TokenTooShort,
}

/// How to run the server.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// Listen address. Anything non-loopback is an explicit user opt-in.
    pub addr: SocketAddr,
    /// Require `Authorization: Bearer <token>` on every `/api/v1` route.
    pub require_auth: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            addr: DEFAULT_ADDR,
            require_auth: false,
        }
    }
}

/// Builds an [`FxTransport`] for one explicit FX fetch (the `fx_fetch_rate`
/// route). The factory itself is `Send + Sync`; the transport it builds is
/// only ever used on the thread that called it (core's transports are
/// `?Send`). Without a factory the fetch route answers 503 — every other FX
/// route (configure/status/convert) is purely local and works regardless.
///
/// Mantra: this transport is only invoked when a client explicitly calls
/// `fx_fetch_rate`, and core only ever points it at the user-configured
/// OpenRate base URL — the server never fetches rates on its own.
pub type FxTransportFactory =
    Arc<dyn Fn() -> Result<Box<dyn FxTransport>, CoreError> + Send + Sync>;

/// Builds a [`WebhookTransport`] for one ShapePay delivery pass. Same shape
/// and rationale as [`FxTransportFactory`]: the factory is `Send + Sync`, the
/// `?Send` transport it builds lives and dies on the thread that called it.
///
/// Mantra: the transport only ever POSTs to webhook endpoint URLs the user
/// registered (`pay_endpoint_add` validates them), and only when a queued
/// delivery is actually due — an empty queue means zero network activity.
pub type PayTransportFactory =
    Arc<dyn Fn() -> Result<Box<dyn WebhookTransport>, CoreError> + Send + Sync>;

/// How often serve mode's delivery loop checks the queue. The queue itself
/// honors each delivery's `next_attempt_at` (backoff is core's schedule);
/// this cadence only bounds the extra latency on top of it.
pub const PAY_DELIVERY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// One ShapePay delivery pass: POST every due pending delivery. Blocking —
/// core's `?Send` dispatch future is driven on a self-contained
/// current-thread runtime, exactly like the FX fetch route. Returns how many
/// deliveries were acted on. The service mutex is held for the whole pass
/// (same trade-off as `fx_fetch_rate`); passes are short unless receivers
/// are slow, and the transport's timeouts bound each POST.
fn pay_delivery_pass(
    service: &Arc<Mutex<CoreService>>,
    factory: &PayTransportFactory,
) -> Result<usize, String> {
    let transport = factory().map_err(|e| e.to_string())?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("pay delivery runtime: {e}"))?;
    let service = service.lock().map_err(|_| "service state poisoned")?;
    let now = slipscan_core::util::now_iso();
    let updated = rt
        .block_on(service.pay_deliver_due(transport.as_ref(), &now))
        .map_err(|e| e.to_string())?;
    Ok(updated.len())
}

/// Serve mode's delivery loop: every [`PAY_DELIVERY_INTERVAL`], flush due
/// deliveries on a blocking thread. Errors are logged and the loop keeps
/// going — the queue's own backoff state is the source of truth, so a failed
/// pass loses nothing.
async fn pay_delivery_loop(service: Arc<Mutex<CoreService>>, factory: PayTransportFactory) {
    let mut ticker = tokio::time::interval(PAY_DELIVERY_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let service = Arc::clone(&service);
        let factory = Arc::clone(&factory);
        match tokio::task::spawn_blocking(move || pay_delivery_pass(&service, &factory)).await {
            Ok(Ok(_)) => {}
            // Metadata only, never payloads or URLs beyond what the error
            // string itself carries (transport errors name the endpoint URL
            // the user registered, nothing more).
            Ok(Err(e)) => eprintln!("pay delivery pass failed: {e}"),
            Err(e) => eprintln!("pay delivery task failed: {e}"),
        }
    }
}

/// Shared router state: one core service behind a mutex (SQLite connections
/// are `Send` but not `Sync`), the optional expected token hash, the
/// optional credential-vault handle (its own connection to the same file),
/// and the optional FX transport factory for explicit rate fetches.
#[derive(Clone)]
pub struct AppState {
    service: Arc<Mutex<CoreService>>,
    auth: Option<[u8; 32]>,
    vault: Option<Arc<Mutex<vault::VaultHandle>>>,
    fx_transport: Option<FxTransportFactory>,
    /// Resolver for the managed (movable) data folder, when this server is
    /// serving it. Powers the read-only `data_status` route; absent when the
    /// caller opened an explicit database path instead.
    data_dir: Option<Arc<DataDirResolver>>,
}

impl AppState {
    /// `auth` is the SHA-256 of the accepted bearer token, or `None` to serve
    /// without authentication (the localhost default).
    pub fn new(service: CoreService, auth: Option<[u8; 32]>) -> Self {
        Self {
            service: Arc::new(Mutex::new(service)),
            auth,
            vault: None,
            fx_transport: None,
            data_dir: None,
        }
    }

    /// Attach a vault handle so the metadata-only vault routes work.
    pub fn with_vault(mut self, handle: vault::VaultHandle) -> Self {
        self.vault = Some(Arc::new(Mutex::new(handle)));
        self
    }

    /// Attach an FX transport factory so the explicit `fx_fetch_rate` route
    /// works. Without one the route answers 503; no other route needs it.
    pub fn with_fx_transport(mut self, factory: FxTransportFactory) -> Self {
        self.fx_transport = Some(factory);
        self
    }

    /// Attach the managed data-folder resolver so `GET data_status` works.
    /// Only attach it when the served database actually is the resolver's —
    /// with an explicit database path the route answers 503 instead of
    /// describing a folder this server is not serving.
    pub fn with_data_dir(mut self, resolver: DataDirResolver) -> Self {
        self.data_dir = Some(Arc::new(resolver));
        self
    }

    pub(crate) fn service(&self) -> Result<MutexGuard<'_, CoreService>, routes::ApiError> {
        self.service
            .lock()
            .map_err(|_| routes::ApiError::internal("service state poisoned"))
    }

    /// Owned handle for work that must move to a blocking thread (the FX
    /// fetch drives a `?Send` future off the async workers).
    pub(crate) fn service_owned(&self) -> Arc<Mutex<CoreService>> {
        Arc::clone(&self.service)
    }

    pub(crate) fn fx_transport(&self) -> Option<FxTransportFactory> {
        self.fx_transport.clone()
    }

    pub(crate) fn data_dir(&self) -> Option<&DataDirResolver> {
        self.data_dir.as_deref()
    }

    pub(crate) fn vault(&self) -> Result<MutexGuard<'_, vault::VaultHandle>, routes::ApiError> {
        self.vault
            .as_ref()
            .ok_or_else(routes::ApiError::vault_unavailable)?
            .lock()
            .map_err(|_| routes::ApiError::internal("vault state poisoned"))
    }

    pub(crate) fn auth_hash(&self) -> Option<&[u8; 32]> {
        self.auth.as_ref()
    }
}

/// Result of [`ensure_auth_token`].
#[derive(Debug)]
pub enum AuthToken {
    /// A fresh token was generated and its hash stored. This is the only time
    /// the token is ever available — print it once, then drop it.
    Generated(String),
    /// A token hash already exists; the original token cannot be recovered.
    Existing,
}

/// Make sure an API token exists. On first run a random token is generated
/// and only its SHA-256 hex is written to settings; the caller must show the
/// returned token to the user exactly once.
pub fn ensure_auth_token(service: &CoreService) -> Result<AuthToken, ServerError> {
    if service.settings_get(AUTH_TOKEN_SETTING)?.is_some() {
        return Ok(AuthToken::Existing);
    }
    Ok(AuthToken::Generated(rotate_auth_token(service)?))
}

/// Store the hash of a user-chosen token (e.g. from an environment
/// variable), replacing any previous one. Only the SHA-256 is persisted.
pub fn set_auth_token(service: &CoreService, token: &str) -> Result<(), ServerError> {
    if token.len() < 16 {
        return Err(ServerError::TokenTooShort);
    }
    let hash = hex_encode(&token_hash(token));
    service.settings_set(AUTH_TOKEN_SETTING, &hash, false)?;
    Ok(())
}

/// Generate a fresh random token, overwrite the stored hash, and return the
/// token — the caller must show it exactly once. The old token stops working
/// immediately.
pub fn rotate_auth_token(service: &CoreService) -> Result<String, ServerError> {
    // Two UUID v7s give ~148 bits of CSPRNG-backed entropy.
    let token = format!(
        "ss_{}{}",
        uuid::Uuid::now_v7().simple(),
        uuid::Uuid::now_v7().simple()
    );
    let hash = hex_encode(&token_hash(&token));
    service.settings_set(AUTH_TOKEN_SETTING, &hash, false)?;
    Ok(token)
}

/// SHA-256 of a bearer token.
pub fn token_hash(token: &str) -> [u8; 32] {
    let digest = Sha256::digest(token.as_bytes());
    digest.into()
}

/// Load the stored token hash, if any.
pub fn stored_token_hash(service: &CoreService) -> Result<Option<[u8; 32]>, ServerError> {
    match service.settings_get(AUTH_TOKEN_SETTING)? {
        None => Ok(None),
        Some(hex) => {
            let bytes = hex_decode(&hex).ok_or(ServerError::MalformedTokenHash)?;
            let arr: [u8; 32] = bytes
                .try_into()
                .map_err(|_| ServerError::MalformedTokenHash)?;
            Ok(Some(arr))
        }
    }
}

/// Serve `service` per `config`. With `require_auth` the token hash must
/// already exist in settings (see [`ensure_auth_token`]). Pass a
/// [`vault::VaultHandle`] on the same database so the metadata-only vault
/// routes work; with `None` they answer 503. Pass an [`FxTransportFactory`]
/// so the explicit `fx_fetch_rate` route works; with `None` it answers 503
/// (all other FX routes are purely local). Pass a [`PayTransportFactory`] to
/// run the ShapePay delivery loop (due webhook deliveries flushed every
/// [`PAY_DELIVERY_INTERVAL`], honoring each delivery's `next_attempt_at`);
/// with `None` the queue only moves when a local `slipscan pay deliver` /
/// `mail-sync` flushes it. Pass the [`DataDirResolver`] when (and only when)
/// the served database is the managed data folder's, so the read-only
/// `GET data_status` route can describe it; with `None` it answers 503. The
/// data-folder *move* is deliberately not served — see the route module's
/// rationale.
pub async fn serve(
    service: CoreService,
    vault: Option<vault::VaultHandle>,
    fx_transport: Option<FxTransportFactory>,
    pay_transport: Option<PayTransportFactory>,
    data_dir: Option<DataDirResolver>,
    config: ServerConfig,
) -> Result<(), ServerError> {
    let auth = if config.require_auth {
        Some(stored_token_hash(&service)?.ok_or(ServerError::AuthNotInitialized)?)
    } else {
        None
    };
    let mut state = AppState::new(service, auth);
    if let Some(handle) = vault {
        state = state.with_vault(handle);
    }
    if let Some(factory) = fx_transport {
        state = state.with_fx_transport(factory);
    }
    if let Some(resolver) = data_dir {
        state = state.with_data_dir(resolver);
    }
    if let Some(factory) = pay_transport {
        tokio::spawn(pay_delivery_loop(state.service_owned(), factory));
    }
    let listener = tokio::net::TcpListener::bind(config.addr)
        .await
        .map_err(ServerError::Bind)?;
    axum::serve(listener, app(state))
        .await
        .map_err(ServerError::Serve)
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Decode a hex string (even length, `[0-9a-fA-F]`); `None` when malformed.
pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Constant-time equality for token hashes.
pub(crate) fn ct_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use slipscan_core::secrets::MemorySecretStore;
    use slipscan_core::Db;

    fn svc() -> CoreService {
        CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        )
    }

    #[test]
    fn default_bind_is_loopback() {
        assert!(DEFAULT_ADDR.ip().is_loopback());
    }

    #[test]
    fn hex_round_trips() {
        let bytes = [0x00u8, 0x0f, 0xa5, 0xff];
        assert_eq!(hex_encode(&bytes), "000fa5ff");
        assert_eq!(hex_decode("000fa5ff").unwrap(), bytes.to_vec());
        assert!(hex_decode("zz").is_none());
        assert!(hex_decode("abc").is_none());
    }

    #[test]
    fn ct_eq_distinguishes() {
        let a = token_hash("a");
        let b = token_hash("b");
        assert!(ct_eq(&a, &a));
        assert!(!ct_eq(&a, &b));
    }

    #[test]
    fn ensure_auth_token_generates_once_and_stores_only_the_hash() {
        let service = svc();
        let token = match ensure_auth_token(&service).unwrap() {
            AuthToken::Generated(t) => t,
            AuthToken::Existing => panic!("expected a fresh token"),
        };
        assert!(token.starts_with("ss_"));
        assert!(token.len() > 40);

        // The stored value is the hash, never the token.
        let stored = service.settings_get(AUTH_TOKEN_SETTING).unwrap().unwrap();
        assert_eq!(stored, hex_encode(&token_hash(&token)));
        assert_ne!(stored, token);

        // Second run: existing, token not regenerated.
        assert!(matches!(
            ensure_auth_token(&service).unwrap(),
            AuthToken::Existing
        ));
        assert_eq!(
            stored_token_hash(&service).unwrap().unwrap(),
            token_hash(&token)
        );
    }

    #[test]
    fn set_and_rotate_auth_token_store_only_hashes() {
        let service = svc();
        assert!(matches!(
            set_auth_token(&service, "short"),
            Err(ServerError::TokenTooShort)
        ));
        set_auth_token(&service, "a-long-user-chosen-token").unwrap();
        assert_eq!(
            stored_token_hash(&service).unwrap().unwrap(),
            token_hash("a-long-user-chosen-token")
        );

        let rotated = rotate_auth_token(&service).unwrap();
        assert!(rotated.starts_with("ss_"));
        let stored = service.settings_get(AUTH_TOKEN_SETTING).unwrap().unwrap();
        assert_eq!(stored, hex_encode(&token_hash(&rotated)));
        assert_ne!(stored, rotated);
        // Old token no longer matches.
        assert_ne!(
            stored_token_hash(&service).unwrap().unwrap(),
            token_hash("a-long-user-chosen-token")
        );
    }

    /// Always answers the scripted status; never touches any network.
    struct ScriptedWebhook {
        status: u16,
        sent: Arc<Mutex<usize>>,
    }

    #[async_trait::async_trait(?Send)]
    impl WebhookTransport for ScriptedWebhook {
        async fn post(
            &self,
            _url: &str,
            _headers: &[(String, String)],
            _body: &[u8],
        ) -> Result<slipscan_core::pay::WebhookResponse, CoreError> {
            *self.sent.lock().unwrap() += 1;
            Ok(slipscan_core::pay::WebhookResponse {
                status: self.status,
            })
        }
    }

    /// The loop's per-tick pass: flushes the due queue via the factory's
    /// transport and marks outcomes — the same path serve mode drives on its
    /// interval (`next_attempt_at` gating itself is covered by core's tests).
    #[test]
    fn pay_delivery_pass_flushes_the_due_queue() {
        use slipscan_core::domain::*;
        let service = svc();
        let book = service
            .book_create(NewBook {
                name: "Pay".into(),
                kind: BookKind::Personal,
                currency: Some("ZAR".into()),
                country: None,
                region: None,
            })
            .unwrap();
        let account = service
            .account_create(NewAccount {
                book_id: book.id.clone(),
                name: "Cheque".into(),
                kind: AccountKind::Bank,
                currency: "ZAR".into(),
                institution: None,
                account_number_masked: None,
                opening_balance_minor: None,
            })
            .unwrap();
        service
            .pay_watch_add(NewPayWatch {
                book_id: book.id.clone(),
                code: "INV-7031".into(),
                label: None,
                expected_amount_minor: None,
                expected_currency: None,
            })
            .unwrap();
        service
            .pay_endpoint_add(NewPayEndpoint {
                book_id: book.id.clone(),
                label: "Shop".into(),
                url: "https://hooks.example.org/pay".into(),
            })
            .unwrap();
        service
            .transaction_create(NewTransaction {
                book_id: book.id.clone(),
                account_id: account.id,
                source: TransactionSource::Email,
                provider_txn_id: None,
                posted_date: "2026-07-01".into(),
                amount_minor: 50_000,
                currency: "ZAR".into(),
                merchant: None,
                description: Some("EFT REF INV-7031".into()),
                notes: None,
                category_id: None,
                document_id: None,
                dedupe_occurrence: 0,
            })
            .unwrap();

        let service = Arc::new(Mutex::new(service));
        let sent = Arc::new(Mutex::new(0usize));
        let sent_in_factory = Arc::clone(&sent);
        let factory: PayTransportFactory = Arc::new(move || {
            Ok(Box::new(ScriptedWebhook {
                status: 200,
                sent: Arc::clone(&sent_in_factory),
            }) as Box<dyn WebhookTransport>)
        });

        assert_eq!(pay_delivery_pass(&service, &factory).unwrap(), 1);
        assert_eq!(*sent.lock().unwrap(), 1);
        let deliveries = service.lock().unwrap().pay_delivery_list(&book.id).unwrap();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(
            deliveries[0].state,
            slipscan_core::domain::PayDeliveryState::Delivered
        );

        // Nothing due on the next pass — the transport is never invoked.
        assert_eq!(pay_delivery_pass(&service, &factory).unwrap(), 0);
        assert_eq!(*sent.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn serve_with_auth_requires_initialized_token() {
        let service = svc();
        let config = ServerConfig {
            require_auth: true,
            ..ServerConfig::default()
        };
        let err = serve(service, None, None, None, None, config)
            .await
            .unwrap_err();
        assert!(matches!(err, ServerError::AuthNotInitialized));
    }
}
