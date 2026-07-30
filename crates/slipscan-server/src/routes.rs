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
use slipscan_core::region::RegionInfo;
use slipscan_core::{datadir, fx, CoreError};

use slipscan_core::device::pairing::PairingInviteMeta;
use slipscan_core::device::{DeviceIdentity, DevicePeer, DeviceRotation};
use slipscan_core::secrets::VaultSecretMeta;

use crate::ops::{
    self, BalanceSheet, BenchmarkReport, InstalledPackEntry, OpsError, PackInstallResult,
    ProfitAndLoss, TaxReport,
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

    pub(crate) fn devices_unavailable() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "devices_unavailable",
            message: "no device identity is attached to this server instance".into(),
        }
    }

    fn data_dir_unavailable() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "data_dir_unavailable",
            message: "this server was started on an explicit database path, not the managed \
                      data folder; run `slipscan data status` on the host instead"
                .into(),
        }
    }

    fn fx_unavailable() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "fx_unavailable",
            message: "this server instance has no FX transport; fetch rates locally (CLI/desktop)"
                .into(),
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
            // FX: not configured is a user-precondition (set the OpenRate URL
            // first), an unknown pair is a missing rate, and transport/parse
            // failures are upstream problems — never internal errors.
            CoreError::FxNotConfigured => (StatusCode::CONFLICT, "fx_not_configured"),
            CoreError::FxUnknownPair { .. } => (StatusCode::NOT_FOUND, "fx_unknown_pair"),
            CoreError::FxTransport(_) | CoreError::FxParse(_) => {
                (StatusCode::BAD_GATEWAY, "fx_upstream")
            }
            // Payments: a webhook receiver being unreachable is an upstream
            // problem, same posture as FX transport failures.
            CoreError::PayTransport(_) => (StatusCode::BAD_GATEWAY, "pay_upstream"),
            // Data folder: an occupied target is a conflict (the client may
            // offer "open that instead"); refused/invalid moves are
            // user-precondition failures. Neither is reachable over HTTP
            // today (the move itself is local-only), but the mapping keeps
            // the error surface total.
            CoreError::DataMoveTargetHasDatabase { .. } => (StatusCode::CONFLICT, "conflict"),
            CoreError::DataMove(_) => (StatusCode::UNPROCESSABLE_ENTITY, "validation"),
            // Device identity & pairing (docs/NODES.md). Every one of these
            // is a refusal, so each maps to a status a client must not retry
            // its way past. A key-name mismatch and a revoked peer are 403
            // with their own codes precisely so a UI can say "this is the
            // wrong device" rather than "something went wrong".
            CoreError::DeviceKeynameMismatch { .. } => {
                (StatusCode::FORBIDDEN, "device_keyname_mismatch")
            }
            CoreError::DevicePeerRevoked { .. } => (StatusCode::FORBIDDEN, "device_peer_revoked"),
            CoreError::DeviceIdentityExists { .. }
            | CoreError::DeviceIdentityTorn
            | CoreError::DeviceKeyMismatch => (StatusCode::CONFLICT, "conflict"),
            CoreError::DeviceIdentityMissing => (StatusCode::NOT_FOUND, "not_found"),
            CoreError::DeviceKeyUnusable { .. }
            | CoreError::DeviceKeynameMistyped { .. }
            | CoreError::DevicePairing(_) => (StatusCode::UNPROCESSABLE_ENTITY, "validation"),
            CoreError::DeviceRotationUnsigned => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
            // The operation log (docs/NODES.md). None of these is reachable
            // over HTTP today — sealing and verifying the log are local-only,
            // like every other operation that touches the device key — but the
            // mapping stays total so the surface cannot silently become a 500.
            //
            // A drifted clock is the operator's machine to fix, and retrying
            // will not help until they do: a precondition, not a fault.
            CoreError::SyncClockDrift { .. } => (StatusCode::CONFLICT, "sync_clock_drift"),
            // An op that does not verify is a refusal with its own code, so a
            // client can say "this device's log has been tampered with" rather
            // than "something went wrong".
            CoreError::SyncOpUnverified { .. } => (StatusCode::FORBIDDEN, "sync_op_unverified"),
            CoreError::SyncMapping(_) => (StatusCode::UNPROCESSABLE_ENTITY, "validation"),
            CoreError::Sqlite(_)
            | CoreError::Migration { .. }
            | CoreError::Secret(_)
            | CoreError::DataDir(_)
            | CoreError::Io(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
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

/// Shared by every per-member report — same `(book_id, from_date, to_date)`
/// shape as `ReportSpendingReq`, kept as its own type since the two are
/// conceptually distinct report families.
#[derive(Debug, Deserialize)]
struct MemberReportReq {
    book_id: String,
    from_date: String,
    to_date: String,
}

#[derive(Debug, Deserialize)]
struct MemberUpdateReq {
    id: String,
    #[serde(flatten)]
    patch: MemberPatch,
}

#[derive(Debug, Deserialize)]
struct MemberRemoveReq {
    id: String,
    /// Another member in the same book to move this member's attributions
    /// and splits onto first. Omit only when the member has no attribution
    /// history — `member_remove` refuses otherwise (see core service docs).
    #[serde(default)]
    reassign_to: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TransactionIdReq {
    transaction_id: String,
}

#[derive(Debug, Deserialize)]
struct TransactionAttributeReq {
    transaction_id: String,
    /// `None` clears the attribution back to unattributed.
    #[serde(default)]
    member_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TransactionSplitSetReq {
    transaction_id: String,
    /// Empty clears the split, reverting to single-member attribution /
    /// unattributed.
    shares: Vec<SplitShare>,
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
struct PackIdReq {
    book_id: String,
    pack_id: String,
}

/// Add a pack source. There is no default and nothing seeds the list, so
/// this — a user asking — is the only way one ever exists.
#[derive(Debug, Deserialize)]
struct PackSourceAddReq {
    /// Short handle the user refers to it by.
    name: String,
    /// `file:<path>`, `folder:<path>`, `git:<url>[#ref]` or `https://<url>`.
    uri: String,
}

#[derive(Debug, Deserialize)]
struct PackSourceNameReq {
    name: String,
}

#[derive(Debug, Deserialize)]
struct PackSourceFetchReq {
    book_id: String,
    /// Source name from `pack_source_list`.
    source: String,
}

#[derive(Debug, Deserialize)]
struct PackSourceInstallReq {
    book_id: String,
    source: String,
    pack_id: String,
    /// Exact blob name from `pack_source_fetch`. Omit to take the source's
    /// offer for `pack_id`; either way the claim is cross-checked against the
    /// signed payload before anything installs.
    #[serde(default)]
    document: Option<String>,
    /// The trust-on-first-use answer: the signer fingerprint the user
    /// compared against the publisher's own channel. Omit and an unknown
    /// signer refuses. Never an override for a changed publisher key.
    #[serde(default)]
    accept_signer: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PackSourcePublishReq {
    /// A `folder:` source to write into.
    source: String,
    /// The exact signed document text.
    manifest: String,
    signature_hex: String,
    public_key_hex: String,
}

#[derive(Debug, Deserialize)]
struct PackBenchmarkReq {
    book_id: String,
    /// Calendar month to compare, `YYYY-MM`.
    period: String,
}

#[derive(Debug, Deserialize)]
struct VaultNameReq {
    name: String,
}

/// A device id: the lowercase hex ed25519 public key. There is no other kind
/// of device identifier — no account, no email, no username.
#[derive(Debug, Deserialize)]
struct DeviceIdReq {
    device_id: String,
}

#[derive(Debug, Deserialize)]
struct SetEnabledReq {
    id: String,
    enabled: bool,
}

#[derive(Debug, Deserialize)]
struct FxConfigureReq {
    /// OpenRate base URL; an empty string clears the configuration (FX off).
    base_url: String,
}

#[derive(Debug, Deserialize)]
struct FxPairReq {
    from: String,
    to: String,
}

#[derive(Debug, Deserialize)]
struct FxConvertReq {
    from: String,
    to: String,
    amount_minor: i64,
    /// Optional pinned rate (decimal string). When present the conversion
    /// replays at exactly this rate (`fx_convert_at`) instead of the current
    /// cached rate — booked conversions must reproduce, never re-rate.
    #[serde(default)]
    rate: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VatRateSetReq {
    book_id: String,
    /// Rate code within the book, e.g. "STD".
    code: String,
    /// Basis points: 1500 = 15.00%.
    rate_bps: i64,
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

/// Override (or clear, with `member_id: null`) a transaction's attributed
/// member. Metadata only — never touches amount/currency/category/journals.
async fn transaction_attribute(
    State(s): State<AppState>,
    Json(req): Json<TransactionAttributeReq>,
) -> ApiResult<Transaction> {
    Ok(Json(s.service()?.transaction_attribute(
        &req.transaction_id,
        req.member_id.as_deref(),
    )?))
}

async fn transaction_splits_list(
    State(s): State<AppState>,
    Json(req): Json<TransactionIdReq>,
) -> ApiResult<Vec<TransactionSplit>> {
    Ok(Json(
        s.service()?.transaction_splits_list(&req.transaction_id)?,
    ))
}

async fn transaction_split_set(
    State(s): State<AppState>,
    Json(req): Json<TransactionSplitSetReq>,
) -> ApiResult<Vec<TransactionSplit>> {
    Ok(Json(
        s.service()?
            .transaction_split_set(&req.transaction_id, req.shares)?,
    ))
}

// -- Household members (ARCHITECTURE.md "Household members & per-person
// attribution"). Local data, never logins — no auth concept lives here, just
// CRUD over the book like categories.

async fn member_add(State(s): State<AppState>, Json(req): Json<NewMember>) -> ApiResult<Member> {
    Ok(Json(s.service()?.member_add(req)?))
}

async fn member_get(State(s): State<AppState>, Json(req): Json<IdReq>) -> ApiResult<Member> {
    Ok(Json(s.service()?.member_get(&req.id)?))
}

async fn member_list(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<Member>> {
    Ok(Json(s.service()?.member_list(&req.book_id)?))
}

async fn member_update(
    State(s): State<AppState>,
    Json(req): Json<MemberUpdateReq>,
) -> ApiResult<Member> {
    Ok(Json(s.service()?.member_update(&req.id, req.patch)?))
}

async fn member_remove(
    State(s): State<AppState>,
    Json(req): Json<MemberRemoveReq>,
) -> ApiResult<OkResp> {
    s.service()?
        .member_remove(&req.id, req.reassign_to.as_deref())?;
    Ok(Json(OK))
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

/// Configure a tax rate's percentage for one book — how the generic
/// profile's standard-rate placeholder (seeded at 0 bps) gets its actual
/// rate, and how a statutory rate change is tracked.
async fn vat_rate_set_bps(
    State(s): State<AppState>,
    Json(req): Json<VatRateSetReq>,
) -> ApiResult<VatRate> {
    Ok(Json(s.service()?.vat_rate_set_bps(
        &req.book_id,
        &req.code,
        req.rate_bps,
    )?))
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

// -- Per-member reports (household attribution): expense/contribution
// rollups, category share, and "who owes whom" settle-up, all in the book's
// base currency, mirroring `repo::report::member_*` one-to-one.

async fn report_member_expense(
    State(s): State<AppState>,
    Json(req): Json<MemberReportReq>,
) -> ApiResult<Vec<MemberAmountRow>> {
    Ok(Json(s.service()?.report_member_expense(
        &req.book_id,
        &req.from_date,
        &req.to_date,
    )?))
}

async fn report_member_contribution(
    State(s): State<AppState>,
    Json(req): Json<MemberReportReq>,
) -> ApiResult<Vec<MemberAmountRow>> {
    Ok(Json(s.service()?.report_member_contribution(
        &req.book_id,
        &req.from_date,
        &req.to_date,
    )?))
}

async fn report_member_category(
    State(s): State<AppState>,
    Json(req): Json<MemberReportReq>,
) -> ApiResult<Vec<MemberCategoryRow>> {
    Ok(Json(s.service()?.report_member_category(
        &req.book_id,
        &req.from_date,
        &req.to_date,
    )?))
}

async fn report_settle_up(
    State(s): State<AppState>,
    Json(req): Json<MemberReportReq>,
) -> ApiResult<Vec<MemberSettleRow>> {
    Ok(Json(s.service()?.report_settle_up(
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

async fn report_tax(State(s): State<AppState>, Json(req): Json<BookIdReq>) -> ApiResult<TaxReport> {
    Ok(Json(ops::report_tax(&*s.service()?, &req.book_id)?))
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
    // Secret material never transits the wire in either direction: the
    // server does no TLS, so accepting `secret: true` here would carry raw
    // credentials over plaintext HTTP. Secrets are set locally (CLI prompt /
    // desktop IPC) — same contract as the vault routes below.
    if req.secret {
        return Err(ApiError::forbidden(
            "secret settings are set locally (CLI / desktop app), never over HTTP",
        ));
    }
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

/// Built-in region profiles for pickers ("global by default — regions are
/// data, not code"). Static data; no book required.
async fn region_list(State(_): State<AppState>) -> ApiResult<Vec<RegionInfo>> {
    Ok(Json(slipscan_core::region::region_infos()))
}

// -- FX (OpenRate): mirrors the core service surface. Only `fx_fetch_rate`
// ever touches the network, only when a client explicitly calls it, and only
// against the user-configured base URL — the server never auto-fetches.

async fn fx_configure(
    State(s): State<AppState>,
    Json(req): Json<FxConfigureReq>,
) -> ApiResult<OkResp> {
    s.service()?.fx_configure(&req.base_url)?;
    Ok(Json(OK))
}

async fn fx_status(State(s): State<AppState>) -> ApiResult<fx::FxStatus> {
    Ok(Json(s.service()?.fx_status()?))
}

async fn fx_convert(
    State(s): State<AppState>,
    Json(req): Json<FxConvertReq>,
) -> ApiResult<fx::FxConversion> {
    let service = s.service()?;
    Ok(Json(match req.rate.as_deref() {
        // Pinned-rate replay: reproduces a booked conversion no matter how
        // the cache has moved. Purely local.
        Some(rate) => service.fx_convert_at(&req.from, &req.to, req.amount_minor, rate)?,
        // Cache-only: a missing pair is a 404, never a silent fetch.
        None => service.fx_convert(&req.from, &req.to, req.amount_minor)?,
    }))
}

async fn fx_fetch_rate(
    State(s): State<AppState>,
    Json(req): Json<FxPairReq>,
) -> ApiResult<fx::FxQuote> {
    let factory = s.fx_transport().ok_or_else(ApiError::fx_unavailable)?;
    let service = s.service_owned();
    // Core's FX future is `?Send`, so it cannot ride an axum worker: drive
    // it to completion on a blocking thread with a self-contained
    // current-thread runtime. The transport is built and dropped there.
    let quote = tokio::task::spawn_blocking(move || -> Result<fx::FxQuote, ApiError> {
        let transport = factory()?;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| ApiError::internal(format!("fx runtime: {e}")))?;
        let service = service
            .lock()
            .map_err(|_| ApiError::internal("service state poisoned"))?;
        Ok(rt.block_on(service.fx_fetch_rate(transport.as_ref(), &req.from, &req.to))?)
    })
    .await
    .map_err(|e| ApiError::internal(format!("fx fetch task: {e}")))??;
    Ok(Json(quote))
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

// -- Device identity & pairing (docs/NODES.md) ---------------------------
//
// **Nothing here syncs anything.** These routes read and revoke identity;
// there is no transport, no endpoint to point at, and no
// coordinator. Phase 1 of the node model is identity only.
//
// The split follows the vault's rule exactly: an operation that would put
// key material or a claim token on the wire is local-only, because this
// server terminates no TLS and may be bound to a LAN. Reading identity and
// revoking a peer leak nothing and are served; minting a key or running the
// pairing ceremony are refused below with a pointer to the CLI.

/// This device's own identity — public key, key-name, label. `null` when the
/// host has no identity yet. Never any key material: the private half lives
/// in the write-only vault and has no read path at all.
async fn device_status(State(s): State<AppState>) -> ApiResult<Option<DeviceIdentity>> {
    Ok(Json(s.devices()?.identity()?))
}

/// Pinned peers, revoked tombstones included. Public keys and labels only.
async fn device_list(State(s): State<AppState>) -> ApiResult<Vec<DevicePeer>> {
    Ok(Json(s.devices()?.peer_list()?))
}

/// One pinned peer, for showing its fingerprint (key-name) next to the one a
/// user is reading off the other device.
async fn device_get(
    State(s): State<AppState>,
    Json(req): Json<DeviceIdReq>,
) -> ApiResult<DevicePeer> {
    s.devices()?
        .peer_get(&req.device_id)?
        .map(Json)
        .ok_or_else(|| {
            ApiError::from(CoreError::NotFound {
                entity: "device peer",
                id: req.device_id,
            })
        })
}

/// Invite metadata. Never carries a claim token — the clear token exists
/// only inside the blob the user already holds.
async fn device_invite_list(State(s): State<AppState>) -> ApiResult<Vec<PairingInviteMeta>> {
    Ok(Json(s.devices()?.invite_list()?))
}

/// The rotation chain of this device's own key. Public keys and signatures.
async fn device_rotations(State(s): State<AppState>) -> ApiResult<Vec<DeviceRotation>> {
    Ok(Json(s.devices()?.rotations()?))
}

/// Revoke a peer. Served deliberately: cutting a lost device off a
/// self-hosted box should not require physical access to that box. The pin
/// becomes a tombstone, so this is a one-way door over HTTP — undoing it
/// (`forget`) is local-only below.
async fn device_revoke(
    State(s): State<AppState>,
    Json(req): Json<DeviceIdReq>,
) -> ApiResult<DevicePeer> {
    Ok(Json(s.devices()?.peer_revoke(&req.device_id)?))
}

/// Creating this device's key is **local-only**: the private half is
/// generated on the device and put straight into the write-only vault, and
/// there is nothing an authenticated HTTP caller should be able to mint on
/// somebody else's machine.
async fn device_init() -> ApiError {
    ApiError::forbidden(
        "a device's identity is created locally (CLI `slipscan device init` / desktop app): the \
         keypair is generated on the device and its private half never leaves the vault",
    )
}

/// Rotation is local-only for the same reason, and one more: it requires
/// proving possession of the key being replaced, which is a decision that
/// belongs at the machine, not at whoever holds a bearer token.
async fn device_rotate() -> ApiError {
    ApiError::forbidden(
        "device keys are rotated locally (CLI `slipscan device rotate`): rotation must be signed \
         by the key it replaces, on the device that holds it",
    )
}

/// Wiping the identity is the **deliberate local reset** — the one path that
/// clears a trust root without proving possession of it. If HTTP could reach
/// it, the pin would be exactly as strong as the bearer token. It is not a
/// route, by design.
async fn device_reset() -> ApiError {
    ApiError::forbidden(
        "a device identity is reset locally (CLI `slipscan device reset`): a reset clears the \
         trust root without proving possession of it, so no remote caller may reach it",
    )
}

/// Dropping a peer's pin is a reset too — it is the only way a revoked key
/// gets back in — so it is local-only for the same reason as
/// [`device_reset`]. Revocation is served; un-revocation is not.
async fn device_forget() -> ApiError {
    ApiError::forbidden(
        "a peer pin is dropped locally (CLI `slipscan device forget <device-id>`): forgetting is \
         what lets a revoked key pair again, so no remote caller may reach it",
    )
}

/// The pairing ceremony is **local-only**, all three steps.
///
/// Two independent reasons, either sufficient. First, an invite carries a
/// single-use claim token and this server does no TLS — the same contract
/// that keeps vault writes and webhook secrets off HTTP. Second, and more
/// fundamental: the step that actually authenticates a pairing is a human
/// comparing a key-name against the *other device's screen*. There is no
/// human on the far end of a POST, so a routed ceremony would be pinning
/// whatever the network offered. On a headless box, run the CLI over ssh —
/// that is where the human is anyway.
async fn device_pair_refused() -> ApiError {
    ApiError::forbidden(
        "pairing happens locally (CLI `slipscan device invite` / `accept` / `confirm`, or the \
         desktop app): invites carry a single-use claim token, and the key-name comparison that \
         authenticates a pairing needs a person in front of the device",
    )
}

// -- Payments (Phase 4.8): watch codes, webhook endpoints, matches and the
// delivery queue. Deliberately simple — watches are a flat list, `enabled`
// the only state. Everything served here is configuration/metadata;
// detection runs inside `transaction_create` (already routed above), and the
// delivery loop lives in serve mode (`crate::serve`), not behind a route.

async fn pay_watch_add(
    State(s): State<AppState>,
    Json(req): Json<NewPayWatch>,
) -> ApiResult<PayWatch> {
    Ok(Json(s.service()?.pay_watch_add(req)?))
}

async fn pay_watch_list(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<PayWatch>> {
    Ok(Json(s.service()?.pay_watch_list(&req.book_id)?))
}

async fn pay_watch_remove(State(s): State<AppState>, Json(req): Json<IdReq>) -> ApiResult<OkResp> {
    s.service()?.pay_watch_remove(&req.id)?;
    Ok(Json(OK))
}

async fn pay_watch_set_enabled(
    State(s): State<AppState>,
    Json(req): Json<SetEnabledReq>,
) -> ApiResult<PayWatch> {
    Ok(Json(
        s.service()?.pay_watch_set_enabled(&req.id, req.enabled)?,
    ))
}

/// Adding a webhook endpoint is **local-only** (CLI `slipscan pay endpoint
/// add` / desktop IPC), refused here by design: creation returns the signing
/// secret exactly once, this server does no TLS, and secret material never
/// transits HTTP in either direction — the same contract as vault writes and
/// secret settings. Endpoint *configuration* (list / enable / remove) is
/// served below; nothing that carries secret material is.
async fn pay_endpoint_add() -> ApiError {
    ApiError::forbidden(
        "webhook endpoints are added locally (CLI `slipscan pay endpoint add` / desktop app): \
         creation displays the signing secret exactly once, and secret material never transits \
         HTTP",
    )
}

/// Rotation is local-only for the same reason as [`pay_endpoint_add`]: the
/// new secret's single display must never ride plaintext HTTP.
async fn pay_endpoint_rotate_secret() -> ApiError {
    ApiError::forbidden(
        "webhook endpoint secrets are rotated locally (CLI `slipscan pay endpoint rotate` / \
         desktop app): the new signing secret is displayed exactly once and never transits HTTP",
    )
}

async fn pay_endpoint_list(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<PayEndpoint>> {
    Ok(Json(s.service()?.pay_endpoint_list(&req.book_id)?))
}

async fn pay_endpoint_remove(
    State(s): State<AppState>,
    Json(req): Json<IdReq>,
) -> ApiResult<OkResp> {
    s.service()?.pay_endpoint_remove(&req.id)?;
    Ok(Json(OK))
}

async fn pay_endpoint_set_enabled(
    State(s): State<AppState>,
    Json(req): Json<SetEnabledReq>,
) -> ApiResult<PayEndpoint> {
    Ok(Json(
        s.service()?
            .pay_endpoint_set_enabled(&req.id, req.enabled)?,
    ))
}

async fn pay_match_list(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<PayMatch>> {
    Ok(Json(s.service()?.pay_match_list(&req.book_id)?))
}

async fn pay_delivery_list(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<PayDelivery>> {
    Ok(Json(s.service()?.pay_delivery_list(&req.book_id)?))
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

/// Install the built-in seed packs into a book.
///
/// Deliberately an **explicit user action** and not something book creation
/// does: which taxonomy a book should start from is the user's decision — a
/// ZA chart auto-installed for someone in Portugal would be wrong. Idempotent
/// and non-clobbering: a seed already installed at the same version is
/// skipped, and categories the user already has are adopted by (parent, name)
/// rather than duplicated.
async fn pack_install_seeds(
    State(s): State<AppState>,
    Json(req): Json<BookIdReq>,
) -> ApiResult<Vec<PackInstallResult>> {
    Ok(Json(ops::pack_install_seeds(&*s.service()?, &req.book_id)?))
}

/// Remove an installed pack. Categories it created stay (history never
/// breaks); so does the signer pin. `false` = that pack was not installed.
async fn pack_uninstall(State(s): State<AppState>, Json(req): Json<PackIdReq>) -> ApiResult<bool> {
    Ok(Json(ops::pack_uninstall(
        &*s.service()?,
        &req.book_id,
        &req.pack_id,
    )?))
}

/// Peer comparison for one month against the installed benchmark packs.
///
/// A read, and only a read: the comparison is computed here from the book's
/// own spend and a public pack of cohort aggregates. Nothing is transmitted —
/// benchmark *contribution* does not exist (docs/BENCHMARKS.md).
async fn pack_benchmark(
    State(s): State<AppState>,
    Json(req): Json<PackBenchmarkReq>,
) -> ApiResult<Vec<BenchmarkReport>> {
    Ok(Json(ops::pack_benchmark(
        &*s.service()?,
        &req.book_id,
        &req.period,
    )?))
}

async fn pack_list(State(s): State<AppState>) -> ApiResult<Vec<InstalledPackEntry>> {
    Ok(Json(ops::pack_list(&*s.service()?)?))
}

// -- pack sources: the fetch half (docs/PACKS.md "Getting a pack") ----------
//
// Reading a source grants it nothing. Bytes come back, the signature is
// checked before the database is touched, the signer must be accepted
// explicitly on first sight, and a pack id stays pinned to the key that first
// signed it — the same gates a local file goes through, because it is
// literally the same code.
//
// `pack_source_add` is the only way a source exists. Nothing seeds the list,
// so a server nobody has configured makes no outbound pack request, ever.

async fn pack_source_add(
    State(s): State<AppState>,
    Json(req): Json<PackSourceAddReq>,
) -> ApiResult<ops::PackSourceEntry> {
    Ok(Json(ops::pack_source_add(
        &*s.service()?,
        &req.name,
        &req.uri,
    )?))
}

/// Forget a source. Installed packs are untouched — where a pack came from is
/// history, not a dependency. `false` = no source by that name.
async fn pack_source_remove(
    State(s): State<AppState>,
    Json(req): Json<PackSourceNameReq>,
) -> ApiResult<bool> {
    Ok(Json(ops::pack_source_remove(&*s.service()?, &req.name)?))
}

async fn pack_source_list(State(s): State<AppState>) -> ApiResult<Vec<ops::PackSourceEntry>> {
    Ok(Json(ops::pack_source_list(&*s.service()?)?))
}

/// Read a source's catalogue and preflight every pack against a book.
/// **Installs nothing** — this is where a signer fingerprint is put in front
/// of the user before any decision.
///
/// Runs on a blocking thread: reading a folder, a git remote or an HTTPS base
/// is synchronous, and it must not sit on an axum worker.
async fn pack_source_fetch(
    State(s): State<AppState>,
    Json(req): Json<PackSourceFetchReq>,
) -> ApiResult<Vec<ops::PackOffer>> {
    let service = s.service_owned();
    let factory = s.pack_transport();
    let offers = tokio::task::spawn_blocking(move || -> Result<Vec<ops::PackOffer>, ApiError> {
        let ctx = pack_transport_context(factory.as_ref())?;
        let service = service
            .lock()
            .map_err(|_| ApiError::internal("service state poisoned"))?;
        Ok(ops::pack_source_fetch(
            &service,
            &req.book_id,
            &req.source,
            &ctx,
        )?)
    })
    .await
    .map_err(|e| ApiError::internal(format!("pack fetch task: {e}")))??;
    Ok(Json(offers))
}

/// Fetch one pack from a source and install it. Verification happens first,
/// on the bytes; an unknown signer refuses unless `accept_signer` carries the
/// fingerprint the user checked; a changed publisher key on a pinned pack id
/// refuses regardless.
async fn pack_source_install(
    State(s): State<AppState>,
    Json(req): Json<PackSourceInstallReq>,
) -> ApiResult<PackInstallResult> {
    let service = s.service_owned();
    let factory = s.pack_transport();
    let result = tokio::task::spawn_blocking(move || -> Result<PackInstallResult, ApiError> {
        let ctx = pack_transport_context(factory.as_ref())?;
        let service = service
            .lock()
            .map_err(|_| ApiError::internal("service state poisoned"))?;
        Ok(ops::pack_source_install(
            &service,
            &req.book_id,
            &req.source,
            &req.pack_id,
            req.document.as_deref(),
            req.accept_signer.as_deref(),
            &ctx,
        )?)
    })
    .await
    .map_err(|e| ApiError::internal(format!("pack install task: {e}")))??;
    Ok(Json(result))
}

/// Write a signed pack into a `folder:` source — the publish half of
/// sneakernet. The three inputs are verified before a byte is written, so
/// nothing unverified lands in a shared folder under a publisher's name.
async fn pack_source_publish(
    State(s): State<AppState>,
    Json(req): Json<PackSourcePublishReq>,
) -> ApiResult<ops::PackPublishResult> {
    let signature = hex_decode(&req.signature_hex)
        .ok_or_else(|| ApiError::unprocessable("signature_hex is not valid hex"))?;
    let public_key = hex_decode(&req.public_key_hex)
        .ok_or_else(|| ApiError::unprocessable("public_key_hex is not valid hex"))?;
    Ok(Json(ops::pack_source_publish(
        &*s.service()?,
        &req.source,
        req.manifest.as_bytes(),
        &signature,
        &public_key,
    )?))
}

/// The transport capabilities for one pack-source read.
///
/// With no factory attached this is an **empty** context rather than an
/// error: `file:` and `folder:` sources need nothing, so a server without a
/// pack transport still reads a USB stick or a synced folder perfectly well.
/// A `git:` or `https:` source then refuses from inside `transport::open`,
/// which is exactly where the refusal belongs — and there is no default
/// endpoint for it to reach instead.
fn pack_transport_context(
    factory: Option<&crate::PackTransportFactory>,
) -> Result<slipscan_packs::transport::TransportContext, ApiError> {
    match factory {
        Some(factory) => Ok(factory()?),
        None => Ok(slipscan_packs::transport::TransportContext::new()),
    }
}

async fn audit_list(
    State(s): State<AppState>,
    Json(req): Json<AuditListReq>,
) -> ApiResult<Vec<AuditEntry>> {
    Ok(Json(
        s.service()?.audit_list(req.book_id.as_deref(), req.limit)?,
    ))
}

/// `GET`: where the data lives — folder, pointer path, sizes. Status only.
///
/// The data-folder **move** is deliberately not exposed over HTTP and stays
/// local-only (CLI `slipscan data move`, desktop Settings), because a move
/// is a physical operation on the server's own filesystem:
/// * the target is a local path — remote clients cannot meaningfully name
///   one, and accepting arbitrary filesystem paths from any bearer-token
///   holder would let a leaked token redirect (and then delete) the data;
/// * mid-move the process must be quiesced read-only, which an HTTP client
///   cannot be trusted to coordinate;
/// * moving deletes the old copy — an owner-present decision, per the
///   contract's "your folder, your responsibility".
async fn data_status(State(s): State<AppState>) -> ApiResult<datadir::DataStatus> {
    let resolver = s.data_dir().ok_or_else(ApiError::data_dir_unavailable)?;
    Ok(Json(datadir::status(resolver)?))
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
        .route("/transaction_attribute", post(transaction_attribute))
        .route("/transaction_splits_list", post(transaction_splits_list))
        .route("/transaction_split_set", post(transaction_split_set))
        .route("/member_add", post(member_add))
        .route("/member_get", post(member_get))
        .route("/member_list", post(member_list))
        .route("/member_update", post(member_update))
        .route("/member_remove", post(member_remove))
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
        .route("/vat_rate_set_bps", post(vat_rate_set_bps))
        .route("/recon_suggest", post(recon_suggest))
        .route("/recon_confirm", post(recon_confirm))
        .route("/report_spending", post(report_spending))
        .route("/report_member_expense", post(report_member_expense))
        .route(
            "/report_member_contribution",
            post(report_member_contribution),
        )
        .route("/report_member_category", post(report_member_category))
        .route("/report_settle_up", post(report_settle_up))
        .route("/report_trial_balance", post(report_trial_balance))
        // Generic name first; `/report_vat` stays as a compatibility alias
        // ("VAT" wording belongs to region profiles, not the API).
        .route("/report_tax", post(report_tax))
        .route("/report_vat", post(report_tax))
        .route("/report_profit_loss", post(report_profit_loss))
        .route("/report_balance_sheet", post(report_balance_sheet))
        .route("/region_list", post(region_list))
        .route("/fx_configure", post(fx_configure))
        .route("/fx_status", post(fx_status))
        .route("/fx_fetch_rate", post(fx_fetch_rate))
        .route("/fx_convert", post(fx_convert))
        .route("/settings_set", post(settings_set))
        .route("/settings_get", post(settings_get))
        .route("/pay_watch_add", post(pay_watch_add))
        .route("/pay_watch_list", post(pay_watch_list))
        .route("/pay_watch_remove", post(pay_watch_remove))
        .route("/pay_watch_set_enabled", post(pay_watch_set_enabled))
        // Add/rotate are refused with the rationale in their handlers:
        // secret material never transits HTTP.
        .route("/pay_endpoint_add", post(pay_endpoint_add))
        .route(
            "/pay_endpoint_rotate_secret",
            post(pay_endpoint_rotate_secret),
        )
        .route("/pay_endpoint_list", post(pay_endpoint_list))
        .route("/pay_endpoint_remove", post(pay_endpoint_remove))
        .route("/pay_endpoint_set_enabled", post(pay_endpoint_set_enabled))
        .route("/pay_match_list", post(pay_match_list))
        .route("/pay_delivery_list", post(pay_delivery_list))
        .route("/pack_install", post(pack_install))
        .route("/pack_install_seeds", post(pack_install_seeds))
        .route("/pack_uninstall", post(pack_uninstall))
        .route("/pack_benchmark", post(pack_benchmark))
        .route("/pack_list", post(pack_list))
        .route("/pack_source_add", post(pack_source_add))
        .route("/pack_source_remove", post(pack_source_remove))
        .route("/pack_source_list", post(pack_source_list))
        .route("/pack_source_fetch", post(pack_source_fetch))
        .route("/pack_source_install", post(pack_source_install))
        .route("/pack_source_publish", post(pack_source_publish))
        .route("/audit_list", post(audit_list))
        // Read-only data-folder status; the move op is local-only (see the
        // handler's rationale), so this is a GET and no move route exists.
        .route("/data_status", get(data_status))
        .route("/vault_list", post(vault_list))
        .route("/vault_revoke", post(vault_revoke))
        // Devices (docs/NODES.md): identity only — nothing here syncs.
        // Read + revoke are served; anything that mints a key or moves a
        // claim token is refused with a pointer to the CLI.
        .route("/device_status", post(device_status))
        .route("/device_list", post(device_list))
        .route("/device_get", post(device_get))
        .route("/device_invite_list", post(device_invite_list))
        .route("/device_rotations", post(device_rotations))
        .route("/device_revoke", post(device_revoke))
        .route("/device_init", post(device_init))
        .route("/device_rotate", post(device_rotate))
        .route("/device_reset", post(device_reset))
        .route("/device_forget", post(device_forget))
        .route("/device_pair_invite", post(device_pair_refused))
        .route("/device_pair_accept", post(device_pair_refused))
        .route("/device_pair_confirm", post(device_pair_refused))
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
    use crate::devices::DeviceHandle;
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

    /// The pack **source** surface over HTTP: add a source, read it, install
    /// from it. Self-hosters had verification and installation but no way to
    /// get a pack to the machine in the first place.
    ///
    /// Uses a `folder:` source so the test needs no transport factory — which
    /// is itself the point: local sources work on a server that was given no
    /// network capability at all.
    #[tokio::test]
    async fn pack_sources_add_read_and_install_over_http() {
        use ed25519_dalek::{Signer, SigningKey};

        let dir = tempfile::tempdir().unwrap();
        let app = open_app();
        let (_, book) = call(
            &app,
            post_req(
                "/api/v1/book_create",
                json!({"name": "Personal", "kind": "personal", "currency": null, "country": "ZA"}),
                None,
            ),
        )
        .await;
        let book_id = book["id"].as_str().unwrap().to_string();

        // 1. Nothing configured: nothing to reach out to.
        let (status, sources) =
            call(&app, post_req("/api/v1/pack_source_list", json!({}), None)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(sources.as_array().unwrap().is_empty());

        // 2. A source exists because somebody added one. Plaintext refuses.
        let (status, bad) = call(
            &app,
            post_req(
                "/api/v1/pack_source_add",
                json!({ "name": "plain", "uri": "http://packs.example" }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");

        let (status, added) = call(
            &app,
            post_req(
                "/api/v1/pack_source_add",
                json!({ "name": "share", "uri": format!("folder:{}", dir.path().display()) }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{added}");
        assert_eq!(added["kind"], "folder");
        assert_eq!(added["network"], false);

        // 3. Publish a signed pack into it, over the same API.
        let payload = json!({
            "meta": {
                "id": "za-http", "name": "HTTP pack", "version": "1.0.0",
                "region": "ZA", "author": "route tests"
            },
            "categories": [
                { "key": "food", "name": "Food", "kind": "expense" }
            ],
            "merchant_rules": [
                { "match": "contains", "pattern": "pick n pay",
                  "category_key": "food", "confidence": 0.9 }
            ]
        });
        let document = serde_json::to_string_pretty(&payload).unwrap();
        let key = SigningKey::from_bytes(&[13u8; 32]);
        let signature = crate::hex_encode(&key.sign(document.as_bytes()).to_bytes());
        let public_key = crate::hex_encode(key.verifying_key().as_bytes());

        let (status, published) = call(
            &app,
            post_req(
                "/api/v1/pack_source_publish",
                json!({
                    "source": "share",
                    "manifest": document,
                    "signature_hex": signature,
                    "public_key_hex": public_key,
                }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{published}");
        let fingerprint = published["fingerprint"].as_str().unwrap().to_string();

        // 4. Reading installs nothing and shows the signer.
        let (status, offers) = call(
            &app,
            post_req(
                "/api/v1/pack_source_fetch",
                json!({ "book_id": book_id, "source": "share" }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{offers}");
        let offers = offers.as_array().unwrap();
        assert_eq!(offers.len(), 1);
        let plan = &offers[0]["verified"];
        assert_eq!(plan["pack_id"], "za-http");
        assert_eq!(plan["action"], "install");
        assert_eq!(plan["needs_signer_acceptance"], true);
        assert_eq!(plan["signer_fingerprint"], fingerprint);
        let (_, listed) = call(&app, post_req("/api/v1/pack_list", json!({}), None)).await;
        assert!(listed.as_array().unwrap().is_empty(), "a read is a read");

        // 5. Arriving is not accepting.
        let (status, refused) = call(
            &app,
            post_req(
                "/api/v1/pack_source_install",
                json!({ "book_id": book_id, "source": "share", "pack_id": "za-http" }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
        assert!(
            refused["error"]["message"]
                .as_str()
                .unwrap()
                .contains("never been seen here"),
            "{refused}"
        );

        // 6. With the fingerprint the caller was shown, it installs.
        let (status, installed) = call(
            &app,
            post_req(
                "/api/v1/pack_source_install",
                json!({
                    "book_id": book_id, "source": "share", "pack_id": "za-http",
                    "accept_signer": fingerprint,
                }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{installed}");
        assert_eq!(installed["pack_id"], "za-http");
        assert_eq!(installed["rules"], 1);

        // 7. And it is gone from the source list's business: forgetting a
        //    source leaves the installed pack exactly where it is.
        let (status, removed) = call(
            &app,
            post_req(
                "/api/v1/pack_source_remove",
                json!({ "name": "share" }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(removed, json!(true));
        let (_, listed) = call(&app, post_req("/api/v1/pack_list", json!({}), None)).await;
        assert_eq!(listed.as_array().unwrap().len(), 1);
    }

    /// The pack surface over HTTP. `pack_install_seeds`, `pack_uninstall` and
    /// `pack_benchmark` all existed as ops (and, for uninstall, as a Tauri
    /// command) with no route at all, so self-hosters could install a signed
    /// pack and then had no way to seed, remove or compare.
    #[tokio::test]
    async fn pack_seed_list_benchmark_and_uninstall_round_trip_over_http() {
        let app = open_app();
        let (_, book) = call(
            &app,
            post_req(
                "/api/v1/book_create",
                json!({"name": "Personal", "kind": "personal", "currency": null, "country": "ZA"}),
                None,
            ),
        )
        .await;
        let book_id = book["id"].as_str().unwrap().to_string();

        // Seeding is an explicit action, and an idempotent one.
        let (status, seeded) = call(
            &app,
            post_req(
                "/api/v1/pack_install_seeds",
                json!({ "book_id": book_id }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{seeded}");
        assert_eq!(seeded.as_array().unwrap().len(), 3);
        let (status, again) = call(
            &app,
            post_req(
                "/api/v1/pack_install_seeds",
                json!({ "book_id": book_id }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(again.as_array().unwrap().is_empty(), "already installed");

        let (_, listed) = call(&app, post_req("/api/v1/pack_list", json!({}), None)).await;
        assert_eq!(listed.as_array().unwrap().len(), 3);

        // Benchmark packs are a different kind of pack; the seeds are
        // taxonomies, so there is nothing to compare against — and the route
        // says so with an empty list rather than inventing numbers.
        let (status, reports) = call(
            &app,
            post_req(
                "/api/v1/pack_benchmark",
                json!({ "book_id": book_id, "period": "2026-07" }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{reports}");
        assert!(reports.as_array().unwrap().is_empty());

        let (status, bad) = call(
            &app,
            post_req(
                "/api/v1/pack_benchmark",
                json!({ "book_id": book_id, "period": "2026-13" }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(bad["error"]["code"], "validation");

        let (status, removed) = call(
            &app,
            post_req(
                "/api/v1/pack_uninstall",
                json!({ "book_id": book_id, "pack_id": "za-personal" }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{removed}");
        assert_eq!(removed, json!(true));
        let (_, listed) = call(&app, post_req("/api/v1/pack_list", json!({}), None)).await;
        assert_eq!(listed.as_array().unwrap().len(), 2);
        // Categories the pack created survive it.
        let (_, tree) = call(
            &app,
            post_req("/api/v1/category_tree", json!({ "book_id": book_id }), None),
        )
        .await;
        assert!(tree
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "Groceries"));

        // Removing it twice is `false`, not an error.
        let (status, removed) = call(
            &app,
            post_req(
                "/api/v1/pack_uninstall",
                json!({ "book_id": book_id, "pack_id": "za-personal" }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(removed, json!(false));
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
    async fn data_status_is_get_only_and_needs_the_managed_folder() {
        // Without a resolver attached (explicit --db): 503, not a made-up
        // answer about a folder this server is not serving.
        let (status, body) = call(
            &open_app(),
            Request::builder()
                .method("GET")
                .uri("/api/v1/data_status")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"]["code"], "data_dir_unavailable");

        // With the managed folder attached: read-only status.
        let tmp = tempfile::tempdir().unwrap();
        let resolver = slipscan_core::datadir::DataDirResolver::new(
            tmp.path().join("config"),
            tmp.path().join("data"),
        );
        let app = app(AppState::new(svc(), None).with_data_dir(resolver));
        let (status, body) = call(
            &app,
            Request::builder()
                .method("GET")
                .uri("/api/v1/data_status")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["data_dir"]
            .as_str()
            .unwrap()
            .ends_with(&format!("{}data", std::path::MAIN_SEPARATOR)));
        assert_eq!(body["pointer_set"], false);
        assert_eq!(body["db_exists"], false);

        // No move route exists over HTTP — moving is local-only by design.
        let (status, _) = call(&app, post_req("/api/v1/data_move", json!({}), None)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // And the status route is not accidentally a POST mutation surface.
        let (status, _) = call(&app, post_req("/api/v1/data_status", json!({}), None)).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
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
    async fn secret_settings_never_transit_http() {
        // A secret stored locally (CLI / desktop IPC path)…
        let state = AppState::new(svc(), None);
        state
            .service()
            .unwrap()
            .settings_set("llm.api_key", "sk-super-secret", true)
            .unwrap();
        let app = app(state);

        // Writing secret material over HTTP is rejected outright — the
        // server does no TLS, so raw credentials must never ride a request
        // body (regression: settings_set used to accept `secret: true`).
        let (status, body) = call(
            &app,
            post_req(
                "/api/v1/settings_set",
                json!({"key": "llm.api_key2", "value": "sk-other-secret", "secret": true}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

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
    async fn region_list_and_regioned_book_create() {
        let app = open_app();
        let (status, regions) = call(&app, post_req("/api/v1/region_list", json!({}), None)).await;
        assert_eq!(status, StatusCode::OK);
        let ids: Vec<&str> = regions
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert!(ids.contains(&"generic") && ids.contains(&"za"), "{ids:?}");
        // Profile summaries carry what a picker needs.
        let za = regions
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "za")
            .unwrap();
        assert_eq!(za["display_name"], "South Africa");
        assert_eq!(za["default_currency"], "ZAR");
        assert_eq!(za["tax_report_name"], "VAT201");

        // book_create accepts an explicit region; the profile drives the
        // default currency.
        let (status, book) = call(
            &app,
            post_req(
                "/api/v1/book_create",
                json!({"name": "SA books", "kind": "business", "region": "za"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{book}");
        assert_eq!(book["region"], "za");
        assert_eq!(book["currency"], "ZAR");

        // Unknown regions are rejected, not silently mapped.
        let (status, body) = call(
            &app,
            post_req(
                "/api/v1/book_create",
                json!({"name": "Atlantis", "kind": "personal", "region": "atlantis"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }

    /// Scripted FX transport: records every URL, answers with a canned body.
    struct ScriptedFx {
        status_code: u16,
        body: String,
        requested: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    #[async_trait::async_trait(?Send)]
    impl slipscan_core::fx::FxTransport for ScriptedFx {
        async fn get(&self, url: &str) -> Result<fx::FxHttpResponse, CoreError> {
            self.requested.lock().unwrap().push(url.to_string());
            Ok(fx::FxHttpResponse {
                status: self.status_code,
                body: self.body.clone().into_bytes(),
            })
        }
    }

    fn scripted_fx_factory(
        status_code: u16,
        body: &str,
    ) -> (
        crate::FxTransportFactory,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        let requested = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let urls = requested.clone();
        let body = body.to_string();
        let factory: crate::FxTransportFactory = std::sync::Arc::new(move || {
            Ok(Box::new(ScriptedFx {
                status_code,
                body: body.clone(),
                requested: urls.clone(),
            }) as Box<dyn slipscan_core::fx::FxTransport>)
        });
        (factory, requested)
    }

    /// A realistic OpenRate convert body (mirrors core's test fixture).
    fn convert_body(rate: &str, as_of: &str, grade: &str) -> String {
        format!(
            r#"{{"rate":{{"rate":{rate},"as_of":"{as_of}","age_sec":600,
                 "sources":["ecb"],"quality":{{"grade":"{grade}"}}}}}}"#
        )
    }

    #[tokio::test]
    async fn fx_fetch_without_a_transport_is_unavailable_and_local_routes_still_work() {
        let app = open_app(); // no FX transport factory attached
        let (status, body) = call(
            &app,
            post_req(
                "/api/v1/fx_fetch_rate",
                json!({"from": "USD", "to": "ZAR"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"]["code"], "fx_unavailable");

        // Purely local FX routes work without any transport.
        let (status, body) = call(&app, post_req("/api/v1/fx_status", json!({}), None)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["configured"], false);
        // Identity conversion needs neither configuration nor cache.
        let (status, body) = call(
            &app,
            post_req(
                "/api/v1/fx_convert",
                json!({"from": "EUR", "to": "eur", "amount_minor": -1234}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["converted_minor"], -1234);
    }

    #[tokio::test]
    async fn fx_fetch_refuses_while_unconfigured_and_never_touches_the_transport() {
        let (factory, requested) = scripted_fx_factory(200, "should never be requested");
        let app = app(AppState::new(svc(), None).with_fx_transport(factory));
        let (status, body) = call(
            &app,
            post_req(
                "/api/v1/fx_fetch_rate",
                json!({"from": "USD", "to": "ZAR"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "fx_not_configured");
        assert!(
            requested.lock().unwrap().is_empty(),
            "no network call may ever happen while FX is unconfigured"
        );
    }

    #[tokio::test]
    async fn fx_configure_fetch_convert_round_trip() {
        let body = convert_body("18.074219053", "2026-07-17T16:00:00Z", "B");
        let (factory, requested) = scripted_fx_factory(200, &body);
        let app = app(AppState::new(svc(), None).with_fx_transport(factory));

        // Configure the OpenRate endpoint (normalized on save).
        let (status, _) = call(
            &app,
            post_req(
                "/api/v1/fx_configure",
                json!({"base_url": " https://fx.example.org/ "}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, status_body) = call(&app, post_req("/api/v1/fx_status", json!({}), None)).await;
        assert_eq!(status_body["configured"], true);
        assert_eq!(status_body["base_url"], "https://fx.example.org");

        // Explicit fetch: the only route that touches the transport, and it
        // carries the rate as a decimal string (never a JSON float).
        let (status, quote) = call(
            &app,
            post_req(
                "/api/v1/fx_fetch_rate",
                json!({"from": "usd", "to": "zar"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{quote}");
        assert_eq!(quote["rate"], json!("18.074219053"));
        assert_eq!(quote["grade"], "B");
        {
            let urls = requested.lock().unwrap();
            assert_eq!(urls.len(), 1);
            assert!(
                urls[0].starts_with("https://fx.example.org/api/v1/convert"),
                "{urls:?}"
            );
        }

        // Conversion serves from the cache with provenance — no new fetch.
        let (status, conv) = call(
            &app,
            post_req(
                "/api/v1/fx_convert",
                json!({"from": "USD", "to": "ZAR", "amount_minor": 10_000}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{conv}");
        assert_eq!(conv["converted_minor"], 180_742);
        assert_eq!(conv["rate"], json!("18.074219053"));
        assert_eq!(conv["as_of"], "2026-07-17T16:00:00Z");
        assert!(conv["age_secs"].is_i64(), "staleness must surface: {conv}");
        assert_eq!(requested.lock().unwrap().len(), 1, "convert never fetches");

        // Status lists the cached pair; an uncached pair is a 404 miss.
        let (_, status_body) = call(&app, post_req("/api/v1/fx_status", json!({}), None)).await;
        assert_eq!(status_body["cached_rates"].as_array().unwrap().len(), 1);
        let (status, body) = call(
            &app,
            post_req(
                "/api/v1/fx_convert",
                json!({"from": "GBP", "to": "JPY", "amount_minor": 100}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    }

    #[tokio::test]
    async fn generic_book_tax_rate_is_configurable_over_http() {
        // Regression: the generic profile's STD placeholder seeded at 0 bps
        // with no surface able to configure it — all tax math ran at 0%.
        let app = open_app();
        let (_, book) = call(
            &app,
            post_req(
                "/api/v1/book_create",
                json!({"name": "Global", "kind": "business", "region": "generic"}),
                None,
            ),
        )
        .await;
        let book_id = book["id"].as_str().unwrap().to_string();
        let (status, _) = call(
            &app,
            post_req("/api/v1/coa_seed", json!({"book_id": book_id}), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (_, rates) = call(
            &app,
            post_req("/api/v1/vat_rate_list", json!({"book_id": book_id}), None),
        )
        .await;
        assert_eq!(rates[0]["code"], "STD");
        assert_eq!(rates[0]["rate_bps"], 0, "placeholder seeds at 0");

        let (status, updated) = call(
            &app,
            post_req(
                "/api/v1/vat_rate_set_bps",
                json!({"book_id": book_id, "code": "STD", "rate_bps": 750}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{updated}");
        assert_eq!(updated["rate_bps"], 750);
        let (_, rates) = call(
            &app,
            post_req("/api/v1/vat_rate_list", json!({"book_id": book_id}), None),
        )
        .await;
        assert_eq!(rates[0]["rate_bps"], 750, "persisted");

        // Out-of-range and unknown codes are rejected cleanly.
        let (status, _) = call(
            &app,
            post_req(
                "/api/v1/vat_rate_set_bps",
                json!({"book_id": book_id, "code": "STD", "rate_bps": 10_001}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let (status, _) = call(
            &app,
            post_req(
                "/api/v1/vat_rate_set_bps",
                json!({"book_id": book_id, "code": "NOPE", "rate_bps": 100}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn fx_convert_accepts_a_pinned_rate_for_replay() {
        // A booked conversion replays at its recorded rate — locally, with
        // no transport and no cache row for the pair.
        let app = open_app();
        let (status, conv) = call(
            &app,
            post_req(
                "/api/v1/fx_convert",
                json!({"from": "USD", "to": "ZAR", "amount_minor": 10_000, "rate": "18.0"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{conv}");
        assert_eq!(conv["converted_minor"], 180_000);
        assert_eq!(conv["rate"], json!("18.0"));
        assert_eq!(conv["grade"], "pinned");
        // A bogus pinned rate is a validation error, not a cache miss.
        let (status, _) = call(
            &app,
            post_req(
                "/api/v1/fx_convert",
                json!({"from": "USD", "to": "ZAR", "amount_minor": 10_000, "rate": "-1"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn pay_watch_crud_round_trip_over_http() {
        let app = open_app();
        let (_, book) = call(
            &app,
            post_req(
                "/api/v1/book_create",
                json!({"name": "Pay", "kind": "personal", "currency": "ZAR"}),
                None,
            ),
        )
        .await;
        let book_id = book["id"].as_str().unwrap().to_string();

        let (status, watch) = call(
            &app,
            post_req(
                "/api/v1/pay_watch_add",
                json!({
                    "book_id": book_id,
                    "code": "INV-7031",
                    "label": "Rent",
                    "expected_amount_minor": 50_000,
                    "expected_currency": "zar"
                }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{watch}");
        assert_eq!(watch["code"], "INV-7031");
        assert_eq!(watch["expected_currency"], "ZAR", "normalized");
        assert_eq!(watch["enabled"], true);
        let watch_id = watch["id"].as_str().unwrap().to_string();

        // Validation flows through core: an exact amount needs a currency.
        let (status, body) = call(
            &app,
            post_req(
                "/api/v1/pay_watch_add",
                json!({"book_id": book_id, "code": "X1", "expected_amount_minor": 500}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

        let (status, listed) = call(
            &app,
            post_req("/api/v1/pay_watch_list", json!({"book_id": book_id}), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed.as_array().unwrap().len(), 1);

        let (status, toggled) = call(
            &app,
            post_req(
                "/api/v1/pay_watch_set_enabled",
                json!({"id": watch_id, "enabled": false}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{toggled}");
        assert_eq!(toggled["enabled"], false);

        let (status, _) = call(
            &app,
            post_req("/api/v1/pay_watch_remove", json!({"id": watch_id}), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, listed) = call(
            &app,
            post_req("/api/v1/pay_watch_list", json!({"book_id": book_id}), None),
        )
        .await;
        assert!(listed.as_array().unwrap().is_empty());
        let (status, _) = call(
            &app,
            post_req("/api/v1/pay_watch_remove", json!({"id": watch_id}), None),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn pay_endpoint_add_and_rotate_are_refused_and_never_carry_secrets() {
        // Endpoint creation/rotation display a signing secret exactly once —
        // that display must never ride plaintext HTTP, so both routes refuse
        // outright (same posture as vault writes / secret settings).
        let state = AppState::new(svc(), None);
        let app = app(state.clone());
        for route in [
            "/api/v1/pay_endpoint_add",
            "/api/v1/pay_endpoint_rotate_secret",
        ] {
            let (status, body) = call(
                &app,
                post_req(
                    route,
                    json!({"book_id": "b", "label": "Shop", "url": "https://x.example.org/h"}),
                    None,
                ),
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{route}: {body}");
            assert_eq!(body["error"]["code"], "forbidden");
            assert!(
                body["error"]["message"].as_str().unwrap().contains("local"),
                "refusal must point at the local flow: {body}"
            );
            assert!(
                body.get("secret").is_none(),
                "no secret field may ever appear: {body}"
            );
        }

        // An endpoint added locally is served as metadata: list / disable /
        // remove work over HTTP and no response ever carries the secret.
        let (book_id, endpoint_id, secret) = {
            let service = state.service().unwrap();
            let book = service
                .book_create(NewBook {
                    name: "Pay".into(),
                    kind: BookKind::Personal,
                    currency: Some("ZAR".into()),
                    country: None,
                    region: None,
                })
                .unwrap();
            let created = service
                .pay_endpoint_add(NewPayEndpoint {
                    book_id: book.id.clone(),
                    label: "Shop".into(),
                    url: "https://hooks.example.org/pay".into(),
                })
                .unwrap();
            (book.id, created.endpoint.id, created.secret)
        };

        let (status, listed) = call(
            &app,
            post_req(
                "/api/v1/pay_endpoint_list",
                json!({"book_id": book_id}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert_eq!(listed[0]["url"], "https://hooks.example.org/pay");
        assert!(
            !listed.to_string().contains(&secret),
            "endpoint listing leaked the signing secret"
        );

        let (status, toggled) = call(
            &app,
            post_req(
                "/api/v1/pay_endpoint_set_enabled",
                json!({"id": endpoint_id, "enabled": false}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{toggled}");
        assert_eq!(toggled["enabled"], false);
        assert!(!toggled.to_string().contains(&secret));

        let (status, _) = call(
            &app,
            post_req(
                "/api/v1/pay_endpoint_remove",
                json!({"id": endpoint_id}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, listed) = call(
            &app,
            post_req(
                "/api/v1/pay_endpoint_list",
                json!({"book_id": book_id}),
                None,
            ),
        )
        .await;
        assert!(listed.as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn transaction_create_over_http_detects_matches_and_queues_deliveries() {
        // The detection hook lives in core's transaction_create, so a
        // transaction posted over HTTP inherits it like every other source.
        let state = AppState::new(svc(), None);
        let app = app(state.clone());
        let (_, book) = call(
            &app,
            post_req(
                "/api/v1/book_create",
                json!({"name": "Pay", "kind": "personal", "currency": "ZAR"}),
                None,
            ),
        )
        .await;
        let book_id = book["id"].as_str().unwrap().to_string();
        let (_, account) = call(
            &app,
            post_req(
                "/api/v1/account_create",
                json!({"book_id": book_id, "name": "Cheque", "kind": "bank", "currency": "ZAR"}),
                None,
            ),
        )
        .await;
        let account_id = account["id"].as_str().unwrap().to_string();
        let (status, _) = call(
            &app,
            post_req(
                "/api/v1/pay_watch_add",
                json!({"book_id": book_id, "code": "INV-7031", "label": "Rent"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        // The endpoint (and its vault-held secret) is created locally.
        let secret = state
            .service()
            .unwrap()
            .pay_endpoint_add(NewPayEndpoint {
                book_id: book_id.clone(),
                label: "Shop".into(),
                url: "https://hooks.example.org/pay".into(),
            })
            .unwrap()
            .secret;

        let (status, txn) = call(
            &app,
            post_req(
                "/api/v1/transaction_create",
                json!({
                    "book_id": book_id,
                    "account_id": account_id,
                    "source": "email",
                    "posted_date": "2026-07-01",
                    "amount_minor": 50_000,
                    "currency": "ZAR",
                    "description": "EFT CREDIT REF INV-7031 FROM ACC 62001234567",
                    "dedupe_occurrence": 0
                }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{txn}");

        let (status, matches) = call(
            &app,
            post_req("/api/v1/pay_match_list", json!({"book_id": book_id}), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{matches}");
        assert_eq!(matches.as_array().unwrap().len(), 1);
        assert_eq!(matches[0]["transaction_id"], txn["id"]);

        let (status, deliveries) = call(
            &app,
            post_req(
                "/api/v1/pay_delivery_list",
                json!({"book_id": book_id}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{deliveries}");
        assert_eq!(deliveries.as_array().unwrap().len(), 1);
        assert_eq!(deliveries[0]["state"], "pending");
        let rendered = deliveries.to_string();
        // Queue rows carry the metadata-only payload, never bank data or
        // secret material.
        assert!(!rendered.contains("62001234567"), "{rendered}");
        assert!(!rendered.contains("EFT CREDIT"), "{rendered}");
        assert!(!rendered.contains(&secret), "secret leaked to deliveries");
    }

    #[tokio::test]
    async fn member_routes_require_bearer_auth() {
        let token = "correct-horse-battery";
        let app = app(AppState::new(svc(), Some(token_hash(token))));
        for (path, body) in [
            ("/api/v1/member_add", json!({"book_id": "x", "label": "A"})),
            ("/api/v1/member_list", json!({"book_id": "x"})),
            (
                "/api/v1/transaction_attribute",
                json!({"transaction_id": "x", "member_id": null}),
            ),
            (
                "/api/v1/report_settle_up",
                json!({"book_id": "x", "from_date": "2026-01-01", "to_date": "2026-12-31"}),
            ),
        ] {
            let (status, _) = call(&app, post_req(path, body, None)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
        }
    }

    /// End-to-end household flow over HTTP: members CRUD, default-owner
    /// attribution on transaction_create, an explicit override, a split, and
    /// the settle-up report — mirrors ARCHITECTURE.md "Household members &
    /// per-person attribution".
    #[tokio::test]
    async fn member_crud_attribution_and_settle_up_report_round_trip() {
        let app = open_app();
        let (_, book) = call(
            &app,
            post_req(
                "/api/v1/book_create",
                json!({"name": "Household", "kind": "personal", "currency": "ZAR"}),
                None,
            ),
        )
        .await;
        let book_id = book["id"].as_str().unwrap().to_string();

        // Two members; Alex owns the cheque account by default.
        let (status, alex) = call(
            &app,
            post_req(
                "/api/v1/member_add",
                json!({"book_id": book_id, "label": "Alex"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{alex}");
        let alex_id = alex["id"].as_str().unwrap().to_string();
        assert_eq!(alex["initial"], "A");

        let (status, bailey) = call(
            &app,
            post_req(
                "/api/v1/member_add",
                json!({"book_id": book_id, "label": "Bailey"}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{bailey}");
        let bailey_id = bailey["id"].as_str().unwrap().to_string();

        let (_, account) = call(
            &app,
            post_req(
                "/api/v1/account_create",
                json!({"book_id": book_id, "name": "Cheque", "kind": "bank", "currency": "ZAR"}),
                None,
            ),
        )
        .await;
        let account_id = account["id"].as_str().unwrap().to_string();

        // Set Alex as the account's default owner via member_update.
        let (status, updated_alex) = call(
            &app,
            post_req(
                "/api/v1/member_update",
                json!({"id": alex_id, "default_account_id": account_id}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{updated_alex}");
        assert_eq!(updated_alex["default_account_id"], account_id);

        // member_get and member_list both reflect the change.
        let (status, fetched) = call(
            &app,
            post_req("/api/v1/member_get", json!({"id": alex_id}), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fetched["default_account_id"], account_id);
        let (status, listed) = call(
            &app,
            post_req("/api/v1/member_list", json!({"book_id": book_id}), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed.as_array().unwrap().len(), 2);

        // A new transaction on Alex's account defaults its attribution.
        let (status, txn) = call(
            &app,
            post_req(
                "/api/v1/transaction_create",
                json!({
                    "book_id": book_id,
                    "account_id": account_id,
                    "source": "manual",
                    "posted_date": "2026-07-01",
                    "amount_minor": -20_000,
                    "currency": "ZAR",
                    "description": "Groceries",
                    "dedupe_occurrence": 0
                }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{txn}");
        let txn_id = txn["id"].as_str().unwrap().to_string();
        assert_eq!(
            txn["attributed_member_id"], alex_id,
            "defaults from the account's owning member"
        );

        // Override the attribution to Bailey, metadata only — amount and
        // currency are untouched.
        let (status, overridden) = call(
            &app,
            post_req(
                "/api/v1/transaction_attribute",
                json!({"transaction_id": txn_id, "member_id": bailey_id}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{overridden}");
        assert_eq!(overridden["attributed_member_id"], bailey_id);
        assert_eq!(overridden["amount_minor"], -20_000);
        assert_eq!(overridden["currency"], "ZAR");

        // Split the same transaction across both members.
        let (status, splits) = call(
            &app,
            post_req(
                "/api/v1/transaction_split_set",
                json!({
                    "transaction_id": txn_id,
                    "shares": [
                        {"member_id": alex_id, "share_minor": 12_000},
                        {"member_id": bailey_id, "share_minor": 8_000},
                    ]
                }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{splits}");
        assert_eq!(splits.as_array().unwrap().len(), 2);
        let (status, listed_splits) = call(
            &app,
            post_req(
                "/api/v1/transaction_splits_list",
                json!({"transaction_id": txn_id}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed_splits.as_array().unwrap().len(), 2);

        // A contribution, singly attributed to Bailey (unsplit).
        let (status, income) = call(
            &app,
            post_req(
                "/api/v1/transaction_create",
                json!({
                    "book_id": book_id,
                    "account_id": account_id,
                    "source": "manual",
                    "posted_date": "2026-07-05",
                    "amount_minor": 100_000,
                    "currency": "ZAR",
                    "description": "Salary",
                    "dedupe_occurrence": 0
                }),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{income}");
        let (status, _) = call(
            &app,
            post_req(
                "/api/v1/transaction_attribute",
                json!({"transaction_id": income["id"], "member_id": bailey_id}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        // Reports: expense/contribution/category rollups and settle-up.
        let period =
            json!({"book_id": book_id, "from_date": "2026-07-01", "to_date": "2026-07-31"});
        let (status, expense) = call(
            &app,
            post_req("/api/v1/report_member_expense", period.clone(), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{expense}");
        let expense_total: i64 = expense
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["total_minor"].as_i64().unwrap())
            .sum();
        assert_eq!(expense_total, 20_000);

        let (status, contribution) = call(
            &app,
            post_req("/api/v1/report_member_contribution", period.clone(), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{contribution}");

        let (status, category) = call(
            &app,
            post_req("/api/v1/report_member_category", period.clone(), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{category}");

        let (status, settle) = call(&app, post_req("/api/v1/report_settle_up", period, None)).await;
        assert_eq!(status, StatusCode::OK, "{settle}");
        let bailey_row = settle
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["member_id"] == bailey_id)
            .expect("bailey row present");
        assert_eq!(bailey_row["contributions_minor"], 100_000);
        // Bailey's expense share = the 8,000 split + nothing else.
        assert_eq!(bailey_row["expenses_minor"], 8_000);
        assert_eq!(bailey_row["net_minor"], 92_000);

        // member_remove refuses while attribution exists...
        let (status, refused) = call(
            &app,
            post_req("/api/v1/member_remove", json!({"id": alex_id}), None),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
        // ...but succeeds once reassigned to the other member.
        let (status, _) = call(
            &app,
            post_req(
                "/api/v1/member_remove",
                json!({"id": alex_id, "reassign_to": bailey_id}),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, gone) = call(
            &app,
            post_req("/api/v1/member_get", json!({"id": alex_id}), None),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{gone}");
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
            "/api/v1/report_tax",
            "/api/v1/report_vat", // compatibility alias for report_tax
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

    // -- Devices (docs/NODES.md): identity only, nothing syncs ------------

    /// Build a server whose attached device handle already has an identity
    /// and one pinned peer, produced by the real pairing ceremony.
    fn device_app() -> (Router, String, String) {
        use slipscan_core::device::pairing::KeynameCheck;
        use slipscan_core::device::Devices;

        let host = DeviceHandle::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        host.initialize("home server").unwrap();

        // A second, separate device — its own database and keychain.
        let peer_db = Db::open_in_memory().unwrap();
        let peer_keys = MemorySecretStore::new();
        let peer = Devices::new(peer_db.conn(), &peer_keys);
        peer.initialize("laptop").unwrap();

        let invite = host.invite_create("laptop", 600).unwrap();
        let acceptance = peer
            .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();
        let pinned = host
            .pair_confirm(&acceptance.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();

        let host_id = host.identity().unwrap().unwrap().public_key;
        (
            app(AppState::new(svc(), None).with_devices(host)),
            host_id,
            pinned.public_key,
        )
    }

    #[tokio::test]
    async fn device_routes_expose_identity_metadata_and_never_key_material() {
        let (app, host_id, peer_id) = device_app();

        let (status, body) = call(&app, post_req("/api/v1/device_status", json!({}), None)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["public_key"], host_id);
        // The device id IS the public key, and the key-name is the
        // human-comparable rendering of it.
        assert_eq!(body["public_key"].as_str().unwrap().len(), 64);
        assert_eq!(body["keyname"].as_str().unwrap().split('-').count(), 9);
        // No account concepts anywhere in the payload.
        let rendered = body.to_string();
        for forbidden in ["email", "password", "username", "login", "account", "token"] {
            assert!(!rendered.contains(forbidden), "{forbidden} in {rendered}");
        }

        let (status, body) = call(&app, post_req("/api/v1/device_list", json!({}), None)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body[0]["public_key"], peer_id);
        assert!(body[0]["revoked_at"].is_null());

        let (status, body) = call(
            &app,
            post_req("/api/v1/device_get", json!({"device_id": peer_id}), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["keyname"].as_str().unwrap().split('-').count(), 9);

        // Invite metadata never carries the claim token.
        let (status, body) = call(
            &app,
            post_req("/api/v1/device_invite_list", json!({}), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(
            !body.to_string().contains("claim"),
            "a claim token reached HTTP: {body}"
        );
    }

    /// Revoking over HTTP works (cutting a lost device off a headless box
    /// should not need physical access) and leaves a tombstone.
    #[tokio::test]
    async fn device_revoke_is_served_and_leaves_a_tombstone() {
        let (app, _, peer_id) = device_app();

        let (status, body) = call(
            &app,
            post_req("/api/v1/device_revoke", json!({"device_id": peer_id}), None),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(!body["revoked_at"].is_null());

        let (_, body) = call(&app, post_req("/api/v1/device_list", json!({}), None)).await;
        assert_eq!(
            body.as_array().unwrap().len(),
            1,
            "revocation is a tombstone, not a delete"
        );
        assert!(!body[0]["revoked_at"].is_null());
    }

    /// Everything that would mint a key or move a claim token is refused,
    /// with a message naming the local command instead. Un-revocation
    /// (`forget`) is refused too: it is the reset that lets a revoked key
    /// back in, so HTTP must not reach it.
    #[tokio::test]
    async fn device_key_and_pairing_routes_are_refused_as_local_only() {
        let (app, _, _) = device_app();
        for route in [
            "/api/v1/device_init",
            "/api/v1/device_rotate",
            "/api/v1/device_reset",
            "/api/v1/device_forget",
            "/api/v1/device_pair_invite",
            "/api/v1/device_pair_accept",
            "/api/v1/device_pair_confirm",
        ] {
            let (status, body) = call(&app, post_req(route, json!({}), None)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{route}: {body}");
            assert_eq!(body["error"]["code"], "forbidden");
            let message = body["error"]["message"].as_str().unwrap();
            assert!(
                message.contains("local"),
                "{route} must point at the local command: {message}"
            );
            // A refusal must not leak a blob or a token in the message.
            assert!(!message.contains("ss-pair1."), "{route}: {message}");
        }
    }

    /// A refusal, not a silent re-pin: the HTTP surface maps the two
    /// pinning refusals to their own 403 codes so a client can tell "wrong
    /// device" from "something broke".
    #[tokio::test]
    async fn a_revoked_peer_is_refused_with_its_own_error_code() {
        use slipscan_core::device::pairing::KeynameCheck;
        use slipscan_core::device::Devices;

        let host = DeviceHandle::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        host.initialize("home server").unwrap();
        let peer_db = Db::open_in_memory().unwrap();
        let peer_keys = MemorySecretStore::new();
        let peer = Devices::new(peer_db.conn(), &peer_keys);
        peer.initialize("laptop").unwrap();

        let invite = host.invite_create("laptop", 600).unwrap();
        let acceptance = peer
            .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();
        let pinned = host
            .pair_confirm(&acceptance.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();
        host.peer_revoke(&pinned.public_key).unwrap();

        // The same device tries the ceremony again, locally.
        let invite = host.invite_create("laptop", 600).unwrap();
        let acceptance = peer
            .pair_accept(&invite.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap();
        let err = host
            .pair_confirm(&acceptance.blob, KeynameCheck::ConfirmedByHuman)
            .unwrap_err();
        let api: ApiError = err.into();
        assert_eq!(api.status, StatusCode::FORBIDDEN);
        assert_eq!(api.code, "device_peer_revoked");

        // And a key-name mismatch gets its own code too.
        let mismatch: ApiError = slipscan_core::CoreError::DeviceKeynameMismatch {
            expected: "a".into(),
            actual: "b".into(),
        }
        .into();
        assert_eq!(mismatch.status, StatusCode::FORBIDDEN);
        assert_eq!(mismatch.code, "device_keyname_mismatch");
    }

    /// With no device handle attached, the device routes say so rather than
    /// pretending this server has an identity.
    #[tokio::test]
    async fn device_routes_without_a_handle_answer_503() {
        let app = open_app();
        for route in ["/api/v1/device_status", "/api/v1/device_list"] {
            let (status, body) = call(&app, post_req(route, json!({}), None)).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{route}: {body}");
            assert_eq!(body["error"]["code"], "devices_unavailable");
        }
    }

    /// Device routes sit behind the same bearer-token wall as everything
    /// else under `/api/v1`.
    #[tokio::test]
    async fn device_routes_require_the_bearer_token_when_auth_is_on() {
        let handle = DeviceHandle::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        handle.initialize("home server").unwrap();
        let app = app(
            AppState::new(svc(), Some(token_hash("t".repeat(20).as_str()))).with_devices(handle),
        );

        for route in [
            "/api/v1/device_status",
            "/api/v1/device_list",
            "/api/v1/device_revoke",
        ] {
            let (status, _) = call(&app, post_req(route, json!({}), None)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{route}");
        }
        let (status, _) = call(
            &app,
            post_req("/api/v1/device_status", json!({}), Some(&"t".repeat(20))),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
}
