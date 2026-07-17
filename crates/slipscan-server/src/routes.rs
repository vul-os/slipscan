//! HTTP surface: `/api/v1/<operation_name>` routes mirroring the core
//! service operations one-to-one. All operations are `POST` with JSON bodies
//! (empty body allowed for nullary operations); `/health` is a `GET` probe
//! and is never behind auth.

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use slipscan_core::domain::*;
use slipscan_core::CoreError;

use slipscan_core::secrets::VaultSecretMeta;

use crate::ops::{
    self, BalanceSheet, InstalledPackEntry, OpsError, PackInstallResult, ProfitAndLoss, VatReport,
};
use crate::{ct_eq, hex_decode, token_hash, AppState, AUTH_TOKEN_SETTING};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// An HTTP-mapped error. The JSON body is `{"error":{"code","message"}}`.
#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: message.into(),
        }
    }

    fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: "missing or invalid bearer token".into(),
        }
    }

    fn unprocessable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: message.into(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: message.into(),
        }
    }

    pub(crate) fn vault_unavailable() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "vault_unavailable",
            message: "no vault is attached to this server instance".into(),
        }
    }
}

impl From<CoreError> for ApiError {
    fn from(err: CoreError) -> Self {
        let (status, code) = match &err {
            CoreError::NotFound { .. } => (StatusCode::NOT_FOUND, "not_found"),
            CoreError::DuplicateTransaction { .. }
            | CoreError::DuplicateDocument { .. }
            | CoreError::DuplicateJournal { .. } => (StatusCode::CONFLICT, "conflict"),
            CoreError::Validation(_)
            | CoreError::InvalidEnum { .. }
            | CoreError::InvalidStatusTransition { .. }
            | CoreError::UnbalancedJournal { .. } => {
                (StatusCode::UNPROCESSABLE_ENTITY, "validation")
            }
            CoreError::Json(_) => (StatusCode::BAD_REQUEST, "invalid_json"),
            CoreError::Sqlite(_) | CoreError::Migration { .. } | CoreError::Secret(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal")
            }
        };
        Self {
            status,
            code,
            message: err.to_string(),
        }
    }
}

impl From<OpsError> for ApiError {
    fn from(err: OpsError) -> Self {
        match err {
            OpsError::Core(core) => core.into(),
            OpsError::Pack(pack) => Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "invalid_pack",
                message: pack.to_string(),
            },
            OpsError::Validation(message) => Self::unprocessable(message),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({ "error": { "code": self.code, "message": self.message } });
        (self.status, Json(body)).into_response()
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct IdReq {
    id: String,
}

#[derive(Debug, Deserialize)]
struct BookIdReq {
    book_id: String,
}

#[derive(Debug, Deserialize)]
struct AccountUpdateReq {
    id: String,
    #[serde(flatten)]
    patch: AccountPatch,
}

#[derive(Debug, Deserialize)]
struct TransactionListReq {
    book_id: String,
    #[serde(flatten)]
    filter: TransactionFilter,
}

#[derive(Debug, Deserialize)]
struct CategorizeReq {
    transaction_id: String,
    category_id: String,
}

#[derive(Debug, Deserialize)]
struct BudgetStatusReq {
    book_id: String,
    /// `YYYY-MM`.
    month: String,
}

#[derive(Debug, Deserialize)]
struct DocumentListReq {
    book_id: String,
    #[serde(default)]
    status: Option<DocumentStatus>,
}

#[derive(Debug, Deserialize)]
struct DocumentTransitionReq {
    id: String,
    to: DocumentStatus,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DocumentIdReq {
    document_id: String,
}

#[derive(Debug, Deserialize)]
struct RecordExtractionReq {
    document_id: String,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    /// slip-v2 payload as JSON.
    payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct MatchIdReq {
    match_id: String,
}

#[derive(Debug, Deserialize)]
struct ReportSpendingReq {
    book_id: String,
    from_date: String,
    to_date: String,
}

#[derive(Debug, Deserialize)]
struct SettingsSetReq {
    key: String,
    value: String,
    #[serde(default)]
    secret: bool,
}

#[derive(Debug, Deserialize)]
struct SettingsGetReq {
    key: String,
}

#[derive(Debug, Serialize)]
struct SettingsGetResp {
    key: String,
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuditListReq {
    #[serde(default)]
    book_id: Option<String>,
    #[serde(default = "default_audit_limit")]
    limit: u32,
}

fn default_audit_limit() -> u32 {
    100
}

#[derive(Debug, Deserialize)]
struct PackInstallReq {
    book_id: String,
    /// The exact manifest JSON text the signature covers.
    manifest: String,
    /// Detached ed25519 signature, hex (64 bytes).
    signature_hex: String,
    /// Verifying key, hex (32 bytes).
    public_key_hex: String,
}

#[derive(Debug, Deserialize)]
struct VaultNameReq {
    name: String,
}

#[derive(Debug, Serialize)]
struct OkResp {
    ok: bool,
}

const OK: OkResp = OkResp { ok: true };

/// Keys the generic settings routes must never serve: the auth-token hash is
/// managed by the serve command (and would enable offline brute-forcing of a
/// user-chosen token if it leaked).
fn reject_reserved_settings_key(key: &str) -> Result<(), ApiError> {
    if key == AUTH_TOKEN_SETTING {
        return Err(ApiError::forbidden(
            "the API token is managed by the serve command, not the settings API",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
struct Health {
    status: &'static str,
    version: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn book_create(State(s): State<AppState>, Json(req): Json<NewBook>) -> ApiResult<Book> {
    Ok(Json(s.service()?.book_create(req)?))
}

async fn book_list(State(s): State<AppState>) -> ApiResult<Vec<Book>> {
    Ok(Json(s.service()?.book_list()?))
}

async fn book_get(State(s): State<AppState>, Json(req): Json<IdReq>) -> ApiResult<Book> {
    Ok(Json(s.service()?.book_get(&req.id)?))
}

async fn account_create(
    State(s): State<AppState>,
    Json(req): Json<NewAccount>,
) -> ApiResult<Account> {
    Ok(Json(s.service()?.account_create(req)?))
}

async fn account_get(State(s): State<AppState>, Json(req): Json<IdReq>) -> ApiResult<Account> {
    Ok(Json(s.service()?.account_get(&req.id)?))
}

async fn account_list(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<Account>> {
    Ok(Json(s.service()?.account_list(&req.book_id)?))
}

async fn account_update(
    State(s): State<AppState>,
    Json(req): Json<AccountUpdateReq>,
) -> ApiResult<Account> {
    Ok(Json(s.service()?.account_update(&req.id, req.patch)?))
}

async fn account_delete(State(s): State<AppState>, Json(req): Json<IdReq>) -> ApiResult<OkResp> {
    s.service()?.account_delete(&req.id)?;
    Ok(Json(OK))
}

async fn transaction_create(
    State(s): State<AppState>,
    Json(req): Json<NewTransaction>,
) -> ApiResult<Transaction> {
    Ok(Json(s.service()?.transaction_create(req)?))
}

async fn transaction_get(
    State(s): State<AppState>,
    Json(req): Json<IdReq>,
) -> ApiResult<Transaction> {
    Ok(Json(s.service()?.transaction_get(&req.id)?))
}

async fn transaction_list(
    State(s): State<AppState>,
    Json(req): Json<TransactionListReq>,
) -> ApiResult<Vec<Transaction>> {
    Ok(Json(
        s.service()?.transaction_list(&req.book_id, &req.filter)?,
    ))
}

async fn transaction_categorize(
    State(s): State<AppState>,
    Json(req): Json<CategorizeReq>,
) -> ApiResult<Transaction> {
    Ok(Json(s.service()?.transaction_categorize(
        &req.transaction_id,
        &req.category_id,
    )?))
}

async fn category_create(
    State(s): State<AppState>,
    Json(req): Json<NewCategory>,
) -> ApiResult<Category> {
    Ok(Json(s.service()?.category_create(req)?))
}

async fn category_tree(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<CategoryNode>> {
    Ok(Json(s.service()?.category_tree(&req.book_id)?))
}

async fn budget_upsert(
    State(s): State<AppState>,
    Json(req): Json<BudgetUpsert>,
) -> ApiResult<Budget> {
    Ok(Json(s.service()?.budget_upsert(req)?))
}

async fn budget_status(
    State(s): State<AppState>,
    Json(req): Json<BudgetStatusReq>,
) -> ApiResult<Vec<BudgetStatus>> {
    Ok(Json(s.service()?.budget_status(&req.book_id, &req.month)?))
}

async fn document_import(
    State(s): State<AppState>,
    Json(req): Json<NewDocument>,
) -> ApiResult<Document> {
    Ok(Json(s.service()?.document_import(req)?))
}

async fn document_get(State(s): State<AppState>, Json(req): Json<IdReq>) -> ApiResult<Document> {
    Ok(Json(s.service()?.document_get(&req.id)?))
}

async fn document_list(
    State(s): State<AppState>,
    Json(req): Json<DocumentListReq>,
) -> ApiResult<Vec<Document>> {
    Ok(Json(s.service()?.document_list(&req.book_id, req.status)?))
}

async fn document_transition(
    State(s): State<AppState>,
    Json(req): Json<DocumentTransitionReq>,
) -> ApiResult<Document> {
    Ok(Json(s.service()?.document_transition(
        &req.id,
        req.to,
        req.error.as_deref(),
    )?))
}

async fn document_record_extraction(
    State(s): State<AppState>,
    Json(req): Json<RecordExtractionReq>,
) -> ApiResult<DocumentExtraction> {
    let payload = serde_json::to_string(&req.payload)
        .map_err(|e| ApiError::unprocessable(format!("payload not serializable: {e}")))?;
    Ok(Json(s.service()?.document_record_extraction(
        &req.document_id,
        req.provider.as_deref(),
        req.model.as_deref(),
        &payload,
    )?))
}

async fn document_current_extraction(
    State(s): State<AppState>,
    Json(req): Json<DocumentIdReq>,
) -> ApiResult<Option<DocumentExtraction>> {
    Ok(Json(
        s.service()?.document_current_extraction(&req.document_id)?,
    ))
}

async fn journal_post(
    State(s): State<AppState>,
    Json(req): Json<NewJournal>,
) -> ApiResult<PostedJournal> {
    Ok(Json(s.service()?.journal_post(req)?))
}

async fn journal_get(
    State(s): State<AppState>,
    Json(req): Json<IdReq>,
) -> ApiResult<PostedJournal> {
    Ok(Json(s.service()?.journal_get(&req.id)?))
}

async fn coa_list(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<CoaAccount>> {
    Ok(Json(s.service()?.coa_list(&req.book_id)?))
}

async fn coa_seed(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<CoaAccount>> {
    Ok(Json(s.service()?.coa_seed(&req.book_id)?))
}

async fn vat_rate_list(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<VatRate>> {
    Ok(Json(s.service()?.vat_rate_list(&req.book_id)?))
}

async fn recon_suggest(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<ReconMatch>> {
    Ok(Json(s.service()?.recon_suggest(&req.book_id)?))
}

async fn recon_confirm(
    State(s): State<AppState>,
    Json(req): Json<MatchIdReq>,
) -> ApiResult<ReconMatch> {
    Ok(Json(s.service()?.recon_confirm(&req.match_id)?))
}

async fn report_spending(
    State(s): State<AppState>,
    Json(req): Json<ReportSpendingReq>,
) -> ApiResult<Vec<SpendingRow>> {
    Ok(Json(s.service()?.report_spending(
        &req.book_id,
        &req.from_date,
        &req.to_date,
    )?))
}

async fn report_trial_balance(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<TrialBalanceRow>> {
    Ok(Json(s.service()?.report_trial_balance(&req.book_id)?))
}

async fn report_vat(State(s): State<AppState>, Json(req): Json<BookIdReq>) -> ApiResult<VatReport> {
    Ok(Json(ops::report_vat(&*s.service()?, &req.book_id)?))
}

async fn report_profit_loss(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<ProfitAndLoss> {
    Ok(Json(ops::report_profit_loss(&*s.service()?, &req.book_id)?))
}

async fn report_balance_sheet(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<BalanceSheet> {
    Ok(Json(ops::report_balance_sheet(
        &*s.service()?,
        &req.book_id,
    )?))
}

async fn settings_set(
    State(s): State<AppState>,
    Json(req): Json<SettingsSetReq>,
) -> ApiResult<OkResp> {
    reject_reserved_settings_key(&req.key)?;
    s.service()?
        .settings_set(&req.key, &req.value, req.secret)?;
    Ok(Json(OK))
}

async fn settings_get(
    State(s): State<AppState>,
    Json(req): Json<SettingsGetReq>,
) -> ApiResult<SettingsGetResp> {
    reject_reserved_settings_key(&req.key)?;
    let value = s.service()?.settings_get(&req.key)?;
    Ok(Json(SettingsGetResp {
        key: req.key,
        value,
    }))
}

/// Vault over HTTP is metadata-only: list and revoke. Setting or replacing
/// material happens locally (CLI prompt / desktop IPC), never over the wire,
/// and no route ever returns secret material.
async fn vault_list(State(s): State<AppState>) -> ApiResult<Vec<VaultSecretMeta>> {
    Ok(Json(s.vault()?.list()?))
}

async fn vault_revoke(
    State(s): State<AppState>,
    Json(req): Json<VaultNameReq>,
) -> ApiResult<OkResp> {
    s.vault()?.revoke(&req.name)?;
    Ok(Json(OK))
}

async fn pack_install(
    State(s): State<AppState>,
    Json(req): Json<PackInstallReq>,
) -> ApiResult<PackInstallResult> {
    let signature = hex_decode(&req.signature_hex)
        .ok_or_else(|| ApiError::unprocessable("signature_hex is not valid hex"))?;
    let public_key = hex_decode(&req.public_key_hex)
        .ok_or_else(|| ApiError::unprocessable("public_key_hex is not valid hex"))?;
    Ok(Json(ops::pack_install(
        &*s.service()?,
        &req.book_id,
        req.manifest.as_bytes(),
        &signature,
        &public_key,
    )?))
}

async fn pack_list(State(s): State<AppState>) -> ApiResult<Vec<InstalledPackEntry>> {
    Ok(Json(ops::pack_list(&*s.service()?)?))
}

async fn audit_list(
    State(s): State<AppState>,
    Json(req): Json<AuditListReq>,
) -> ApiResult<Vec<AuditEntry>> {
    Ok(Json(
        s.service()?.audit_list(req.book_id.as_deref(), req.limit)?,
    ))
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

async fn require_bearer(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let Some(expected) = state.auth_hash() else {
        return next.run(req).await;
    };
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|token| token_hash(token.trim()));
    match presented {
        Some(hash) if ct_eq(&hash, expected) => next.run(req).await,
        _ => ApiError::unauthorized().into_response(),
    }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/// Build the full application router over `state`. `/health` is public;
/// everything under `/api/v1` goes through the (optional) bearer check.
pub fn app(state: AppState) -> Router {
    let api = Router::new()
        .route("/book_create", post(book_create))
        .route("/book_list", post(book_list))
        .route("/book_get", post(book_get))
        .route("/account_create", post(account_create))
        .route("/account_get", post(account_get))
        .route("/account_list", post(account_list))
        .route("/account_update", post(account_update))
        .route("/account_delete", post(account_delete))
        .route("/transaction_create", post(transaction_create))
        .route("/transaction_get", post(transaction_get))
        .route("/transaction_list", post(transaction_list))
        .route("/transaction_categorize", post(transaction_categorize))
        .route("/category_create", post(category_create))
        .route("/category_tree", post(category_tree))
        .route("/budget_upsert", post(budget_upsert))
        .route("/budget_status", post(budget_status))
        .route("/document_import", post(document_import))
        .route("/document_get", post(document_get))
        .route("/document_list", post(document_list))
        .route("/document_transition", post(document_transition))
        .route(
            "/document_record_extraction",
            post(document_record_extraction),
        )
        .route(
            "/document_current_extraction",
            post(document_current_extraction),
        )
        .route("/journal_post", post(journal_post))
        .route("/journal_get", post(journal_get))
        .route("/coa_list", post(coa_list))
        .route("/coa_seed", post(coa_seed))
        .route("/vat_rate_list", post(vat_rate_list))
        .route("/recon_suggest", post(recon_suggest))
        .route("/recon_confirm", post(recon_confirm))
        .route("/report_spending", post(report_spending))
        .route("/report_trial_balance", post(report_trial_balance))
        .route("/report_vat", post(report_vat))
        .route("/report_profit_loss", post(report_profit_loss))
        .route("/report_balance_sheet", post(report_balance_sheet))
        .route("/settings_set", post(settings_set))
        .route("/settings_get", post(settings_get))
        .route("/pack_install", post(pack_install))
        .route("/pack_list", post(pack_list))
        .route("/audit_list", post(audit_list))
        .route("/vault_list", post(vault_list))
        .route("/vault_revoke", post(vault_revoke))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ));

    Router::new()
        .route("/health", get(health))
        .nest("/api/v1", api)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::VaultHandle;
    use axum::body::Body;
    use axum::http::Request;
    use serde_json::{json, Value};
    use slipscan_core::secrets::MemorySecretStore;
    use slipscan_core::{CoreService, Db};
    use tower::ServiceExt;

    fn svc() -> CoreService {
        CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        )
    }

    fn open_app() -> Router {
        app(AppState::new(svc(), None))
    }

    fn post_req(path: &str, body: Value, token: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(token) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        builder.body(Body::from(body.to_string())).unwrap()
    }

    async fn call(app: &Router, req: Request<Body>) -> (StatusCode, Value) {
        let response = app.clone().oneshot(req).await.unwrap();
        let status = response.status();
        assert!(
            response
                .headers()
                .get("access-control-allow-origin")
                .is_none(),
            "no CORS headers, ever (mantra: nothing is exposed by default)"
        );
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, body)
    }

    #[tokio::test]
    async fn health_is_public_and_unversioned_routes_404() {
        let app = open_app();
        let (status, body) = call(
            &app,
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ok");

        let (status, _) = call(&app, post_req("/api/v1/nope", json!({}), None)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn book_create_list_get_round_trip() {
        let app = open_app();
        let (status, created) = call(
            &app,
            post_req(
                "/api/v1/book_create",
                json!({"name": "Personal", "kind": "personal", "currency": null, "country": "ZA"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let id = created["id"].as_str().unwrap().to_string();

        let (status, listed) = call(&app, post_req("/api/v1/book_list", json!({}), None)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed.as_array().unwrap().len(), 1);

        let (status, fetched) =
            call(&app, post_req("/api/v1/book_get", json!({"id": id}), None)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fetched["name"], "Personal");

        let (status, missing) = call(
            &app,
            post_req("/api/v1/book_get", json!({"id": "nope"}), None),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(missing["error"]["code"], "not_found");
    }

    #[tokio::test]
    async fn validation_errors_map_to_422() {
        let app = open_app();
        let (status, body) = call(
            &app,
            post_req(
                "/api/v1/book_create",
                json!({"name": "  ", "kind": "personal"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"]["code"], "validation");
    }

    #[tokio::test]
    async fn bearer_auth_gates_api_but_not_health() {
        let token = "correct-horse-battery";
        let app = app(AppState::new(svc(), Some(token_hash(token))));

        // No token / wrong token: 401 with no data leakage.
        let (status, body) = call(&app, post_req("/api/v1/book_list", json!({}), None)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"]["code"], "unauthorized");
        let (status, _) = call(
            &app,
            post_req("/api/v1/book_list", json!({}), Some("wrong")),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        // Right token passes; /health stays public.
        let (status, _) = call(&app, post_req("/api/v1/book_list", json!({}), Some(token))).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = call(
            &app,
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn vault_routes_expose_metadata_never_material() {
        use slipscan_core::secrets::SecretString;
        let handle = VaultHandle::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        handle
            .set("imap.fastmail", SecretString::new("super-secret-imap-pass"))
            .unwrap();
        let app = app(AppState::new(svc(), None).with_vault(handle));

        let (status, body) = call(&app, post_req("/api/v1/vault_list", json!({}), None)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body[0]["name"], "imap.fastmail");
        assert_eq!(body[0]["fingerprint"].as_str().unwrap().len(), 8);
        assert!(!body.to_string().contains("super-secret-imap-pass"));

        // The auth-token hash is not readable or writable over the wire.
        let (status, body) = call(
            &app,
            post_req(
                "/api/v1/settings_get",
                json!({"key": crate::AUTH_TOKEN_SETTING}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"]["code"], "forbidden");
        let (status, _) = call(
            &app,
            post_req(
                "/api/v1/settings_set",
                json!({"key": crate::AUTH_TOKEN_SETTING, "value": "x"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // Revoke over HTTP works (no material involved) and 404s once gone.
        let (status, body) = call(
            &app,
            post_req(
                "/api/v1/vault_revoke",
                json!({"name": "imap.fastmail"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = call(&app, post_req("/api/v1/vault_list", json!({}), None)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 0);
        let (status, _) = call(
            &app,
            post_req(
                "/api/v1/vault_revoke",
                json!({"name": "imap.fastmail"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn secret_settings_are_write_only_over_http() {
        let app = open_app();
        // Store a secret via the settings API…
        let (status, body) = call(
            &app,
            post_req(
                "/api/v1/settings_set",
                json!({"key": "llm.api_key", "value": "sk-super-secret", "secret": true}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");

        // …and it must never be readable back: no GET-for-display, ever
        // (ARCHITECTURE.md credential vault: write-only semantics).
        let (status, body) = call(
            &app,
            post_req("/api/v1/settings_get", json!({"key": "llm.api_key"}), None),
        )
        .await;
        assert_ne!(status, StatusCode::OK, "secret readable back: {body}");
        assert!(
            !body.to_string().contains("sk-super-secret"),
            "secret material leaked in response: {body}"
        );

        // Plain settings still round-trip.
        let (status, _) = call(
            &app,
            post_req(
                "/api/v1/settings_set",
                json!({"key": "ui.theme", "value": "dark"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) = call(
            &app,
            post_req("/api/v1/settings_get", json!({"key": "ui.theme"}), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["value"], "dark");
    }

    #[tokio::test]
    async fn vault_routes_answer_503_without_a_vault() {
        let app = open_app();
        let (status, body) = call(&app, post_req("/api/v1/vault_list", json!({}), None)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"]["code"], "vault_unavailable");
    }

    #[tokio::test]
    async fn derived_report_routes_respond() {
        let app = open_app();
        let (_, book) = call(
            &app,
            post_req(
                "/api/v1/book_create",
                json!({"name": "Biz", "kind": "business"}),
                None,
            ),
        )
        .await;
        let book_id = book["id"].as_str().unwrap();
        let (status, _) = call(
            &app,
            post_req("/api/v1/coa_seed", json!({"book_id": book_id}), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        for route in [
            "/api/v1/report_profit_loss",
            "/api/v1/report_balance_sheet",
            "/api/v1/report_vat",
            "/api/v1/report_trial_balance",
        ] {
            let (status, body) =
                call(&app, post_req(route, json!({"book_id": book_id}), None)).await;
            assert_eq!(status, StatusCode::OK, "{route}: {body}");
        }
        let (status, _) = call(
            &app,
            post_req(
                "/api/v1/report_profit_loss",
                json!({"book_id": "nope"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
