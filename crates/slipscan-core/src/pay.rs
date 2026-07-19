//! ShapePay — email-driven payment webhooks (TODO-FOLD-SHAPEPAY.md, Phase 4.8).
//!
//! Deliberately SIMPLE: watch reference codes on inbound transactions, fire
//! signed webhooks when one is detected. Watch codes are a flat list — no
//! expiry, no recurrence, no lifecycle machinery; an optional exact amount is
//! the only filter.
//!
//! What lives here: the pure logic — whole-token code matching, webhook URL
//! validation, HMAC-SHA256 signing + constant-time verification, the retry
//! backoff schedule, and the [`WebhookTransport`] trait (production impl:
//! `slipscan_ingest::pay::ReqwestWebhookTransport`, beside the FX transport —
//! this crate stays strictly network-free, mantra #1).
//!
//! The service surface is on [`CoreService`](crate::service::CoreService):
//! `pay_watch_add/list/remove`, `pay_endpoint_add/list/remove`,
//! `pay_endpoint_rotate_secret`, `pay_deliver_due`, plus the detection hook
//! inside `transaction_create` (every ingestion source flows through it, so
//! email-ingested and imported transactions all inherit detection).
//!
//! Security posture:
//! * Signing secrets are generated here (32 random bytes, hex), stored ONLY
//!   in the credential vault under [`endpoint_secret_name`], and displayed
//!   exactly once from add/rotate (see `PayEndpointWithSecret`). Signatures
//!   are computed inside the vault's `use_with` closure at delivery time.
//! * Delivery payloads carry metadata only: watch label + reference, amount,
//!   currency, posted date, matched_at — never account numbers, never the
//!   raw bank description.
//! * Deliveries are at-least-once: a crash between the POST and the state
//!   write redelivers, and the stable per-delivery nonce lets receivers
//!   deduplicate.

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::domain::{PayWatch, Transaction};
use crate::error::{CoreError, CoreResult};

/// Signature header: lowercase hex HMAC-SHA256 over
/// `"{timestamp}.{nonce}." + body`, keyed with the endpoint's secret string
/// exactly as displayed at creation (the 64-char hex, used verbatim as the
/// HMAC key bytes).
pub const HEADER_SIGNATURE: &str = "X-SlipScan-Signature";
/// Unix seconds (as a decimal string) at send time. Changes per attempt;
/// receivers should reject stale timestamps to bound replays.
pub const HEADER_TIMESTAMP: &str = "X-SlipScan-Timestamp";
/// Stable per-delivery nonce (the delivery id). Identical across retries of
/// the same delivery — receivers deduplicate on it (at-least-once semantics).
pub const HEADER_NONCE: &str = "X-SlipScan-Nonce";

/// A delivery is abandoned (state `failed`) once it has been attempted this
/// many times.
pub const MAX_DELIVERY_ATTEMPTS: i64 = 20;

/// Backoff after the n-th consecutive failure: 1m, 5m, 30m, 2h, 12h, then
/// daily.
const BACKOFF_SECS: [i64; 5] = [60, 300, 1_800, 7_200, 43_200];
const BACKOFF_DAILY_SECS: i64 = 86_400;

/// Delay in seconds before the next attempt, given how many attempts have
/// failed so far (1-based: after the first failure pass 1).
pub fn backoff_delay_secs(failed_attempts: i64) -> i64 {
    if failed_attempts <= 0 {
        return BACKOFF_SECS[0];
    }
    *BACKOFF_SECS
        .get((failed_attempts - 1) as usize)
        .unwrap_or(&BACKOFF_DAILY_SECS)
}

/// Vault entry name for an endpoint's signing secret. Derived from the
/// endpoint id so remove/rotate always address the right entry.
pub fn endpoint_secret_name(endpoint_id: &str) -> String {
    format!("pay.endpoint.{endpoint_id}")
}

// ---------------------------------------------------------------------------
// Whole-token code matching
// ---------------------------------------------------------------------------

/// Case-insensitive whole-token match of `code` within `text`.
///
/// "Whole token" means the match may not be flanked by an alphanumeric
/// character on either side, so watch code `INV1` never fires on `INV11` (or
/// `XINV1`), while `REF INV1.` and `inv1/2026` still match. Codes may
/// themselves contain separators (`INV-001`).
pub fn text_contains_code(text: &str, code: &str) -> bool {
    let code_upper = code.trim().to_uppercase();
    if code_upper.is_empty() {
        return false;
    }
    let text_upper = text.to_uppercase();
    let mut from = 0;
    while let Some(offset) = text_upper[from..].find(&code_upper) {
        let start = from + offset;
        let end = start + code_upper.len();
        let before_ok = text_upper[..start]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric());
        let after_ok = text_upper[end..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        // Overlapping occurrences: advance one char past this hit's start.
        from = start + text_upper[start..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// Does this transaction's user-facing text carry `code` as a whole token?
/// Looks at the description and the merchant — the fields bank alerts and
/// statement lines put reference text in.
pub(crate) fn transaction_carries_code(txn: &Transaction, code: &str) -> bool {
    [txn.description.as_deref(), txn.merchant.as_deref()]
        .into_iter()
        .flatten()
        .any(|text| text_contains_code(text, code))
}

/// The webhook body for one match — built at enqueue time, stored verbatim
/// in the queue, and signed byte-for-byte at delivery time.
///
/// Metadata only, by construction: the watch's own label and reference code,
/// the transaction's amount/currency/posted date, and when the match
/// happened. NO account numbers, NO raw bank description — the receiver
/// already knows what the reference means.
pub(crate) fn build_payload(watch: &PayWatch, txn: &Transaction, matched_at: &str) -> String {
    serde_json::json!({
        "event": "payment.matched",
        "reference": watch.code,
        "watch_label": watch.label,
        "amount_minor": txn.amount_minor,
        "currency": txn.currency,
        "posted_date": txn.posted_date,
        "matched_at": matched_at,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Webhook URL validation
// ---------------------------------------------------------------------------

/// Validate and normalize a webhook endpoint URL — same approach as
/// `fx::normalize_base_url`: http(s) with a host, no whitespace, no fragment,
/// and **no embedded credentials** (`user:pass@host` would land the password
/// in a plain column, listings, and error strings — mantra #4; deliveries are
/// authenticated by the HMAC signature instead). Unlike the FX base URL a
/// path and query are the receiver's business, so they are kept verbatim.
pub fn normalize_webhook_url(raw: &str) -> CoreResult<String> {
    let trimmed = raw.trim();
    // Any input carrying an '@' may embed credentials (user:pass@host), so it
    // is NEVER echoed into a rejection message, whichever rule fires — the
    // message reaches CLI stderr, the desktop error banner, and the server's
    // 422 body. (An '@' in the path/query is legitimate and accepted below;
    // withholding such a URL from an error message costs nothing.)
    let shown = if trimmed.contains('@') {
        "<url withheld: it contains '@' and may embed credentials>".to_string()
    } else {
        format!("{raw:?}")
    };
    let invalid = || {
        CoreError::Validation(format!(
            "invalid webhook URL {shown} (expected http(s)://host[:port][/path])"
        ))
    };
    let (scheme, rest) = trimmed.split_once("://").ok_or_else(invalid)?;
    let scheme = scheme.to_ascii_lowercase();
    if rest.is_empty() {
        return Err(invalid());
    }
    // The credential check runs before every other rejection so a
    // credentialed URL always gets the dedicated (never-echoing) message.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        // Deliberately not echoing the URL — it contains the credentials.
        return Err(CoreError::Validation(
            "webhook URL must not embed credentials (user:pass@host): the URL is stored as a \
             plain column and shown in listings; deliveries are authenticated by the endpoint's \
             HMAC signing secret instead"
                .into(),
        ));
    }
    if scheme != "http" && scheme != "https" {
        return Err(invalid());
    }
    if rest.contains(char::is_whitespace) {
        return Err(invalid());
    }
    if rest.contains('#') {
        return Err(CoreError::Validation(format!(
            "invalid webhook URL {shown}: fragments are not allowed"
        )));
    }
    if authority.is_empty() {
        return Err(invalid());
    }
    Ok(format!("{scheme}://{rest}"))
}

// ---------------------------------------------------------------------------
// Signing secrets and HMAC-SHA256 signatures
// ---------------------------------------------------------------------------

/// Generate a fresh signing secret: 32 random bytes, lowercase hex (64
/// chars). Returned as a plain `String` because this **is** the sanctioned
/// single display — the caller hands one copy to the vault and shows the
/// other to the user exactly once.
pub(crate) fn generate_secret_hex() -> String {
    use chacha20poly1305::aead::{KeyInit, OsRng};
    use chacha20poly1305::XChaCha20Poly1305;
    // generate_key is 32 bytes from the OS CSPRNG — the same primitive the
    // vault uses for its keys.
    let bytes = Zeroizing::new(XChaCha20Poly1305::generate_key(&mut OsRng).to_vec());
    to_hex(&bytes)
}

/// HMAC-SHA256 (RFC 2104) over the concatenation of `parts`. Implemented on
/// the `sha2` primitive this crate already carries — small, readable,
/// verified against RFC 4231 vectors in the tests below (mantra #6:
/// dependency-light).
fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut key_block = Zeroizing::new([0u8; BLOCK]);
    if key.len() > BLOCK {
        key_block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    let ipad = Zeroizing::new(key_block.map(|b| b ^ 0x36));
    inner.update(&ipad[..]);
    for part in parts {
        inner.update(part);
    }
    let inner_digest = inner.finalize();
    let opad = Zeroizing::new(key_block.map(|b| b ^ 0x5c));
    let mut outer = Sha256::new();
    outer.update(&opad[..]);
    outer.update(inner_digest);
    outer.finalize().into()
}

/// Compute the delivery signature: lowercase hex of
/// `HMAC-SHA256(secret, "{timestamp}.{nonce}." + body)`.
///
/// `secret` is the endpoint's secret string exactly as displayed once at
/// creation/rotation — its ASCII bytes are the HMAC key, so receivers can
/// verify with the string they were handed, no decoding required.
pub fn sign_webhook(secret: &str, timestamp: &str, nonce: &str, body: &[u8]) -> String {
    let mac = hmac_sha256(
        secret.as_bytes(),
        &[timestamp.as_bytes(), b".", nonce.as_bytes(), b".", body],
    );
    to_hex(&mac)
}

/// Receiver-side verification helper (documented in the receiver guide):
/// recompute the signature and compare in constant time. Accepts the hex
/// case-insensitively; any length mismatch is a fail, never a panic.
pub fn verify_webhook_signature(
    secret: &str,
    timestamp: &str,
    nonce: &str,
    body: &[u8],
    signature_hex: &str,
) -> bool {
    let expected = sign_webhook(secret, timestamp, nonce, body);
    let provided = signature_hex.trim().to_ascii_lowercase();
    constant_time_eq(expected.as_bytes(), provided.as_bytes())
}

/// Constant-time byte comparison: examines every byte regardless of where a
/// difference occurs, so verification time leaks nothing about how much of a
/// forged signature was correct.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

// ---------------------------------------------------------------------------
// Delivery transport
// ---------------------------------------------------------------------------

/// Response from a webhook POST. Only the status matters — response bodies
/// are receiver-controlled and are never stored or echoed into errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebhookResponse {
    pub status: u16,
}

/// Minimal async POST transport the dispatcher depends on, so this crate
/// stays strictly network-free. `?Send` to match the other injected
/// transports. Implementations only ever receive URLs the user configured as
/// webhook endpoints (mantra #2); the production impl
/// (`slipscan_ingest::pay::ReqwestWebhookTransport`) follows no redirects —
/// a redirect would re-send the signed body to a location the user never
/// configured.
#[async_trait(?Send)]
pub trait WebhookTransport {
    async fn post(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> CoreResult<WebhookResponse>;
}

#[cfg(test)]
pub(crate) mod testutil {
    //! Scripted mock transport for dispatcher tests — no network, ever.

    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    /// One recorded POST.
    #[derive(Debug, Clone)]
    pub struct SentWebhook {
        pub url: String,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    impl SentWebhook {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
    }

    /// Scripted responses are consumed in order; a POST with nothing scripted
    /// errors loudly so tests catch unexpected network attempts.
    #[derive(Default)]
    pub struct MockWebhookTransport {
        script: RefCell<VecDeque<Result<u16, String>>>,
        pub sent: RefCell<Vec<SentWebhook>>,
    }

    impl MockWebhookTransport {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn respond(self, status: u16) -> Self {
            self.script.borrow_mut().push_back(Ok(status));
            self
        }

        pub fn respond_err(self, message: &str) -> Self {
            self.script.borrow_mut().push_back(Err(message.to_string()));
            self
        }

        pub fn sent_count(&self) -> usize {
            self.sent.borrow().len()
        }
    }

    #[async_trait(?Send)]
    impl WebhookTransport for MockWebhookTransport {
        async fn post(
            &self,
            url: &str,
            headers: &[(String, String)],
            body: &[u8],
        ) -> CoreResult<WebhookResponse> {
            self.sent.borrow_mut().push(SentWebhook {
                url: url.to_string(),
                headers: headers.to_vec(),
                body: body.to_vec(),
            });
            match self.script.borrow_mut().pop_front() {
                Some(Ok(status)) => Ok(WebhookResponse { status }),
                Some(Err(message)) => Err(CoreError::PayTransport(message)),
                None => Err(CoreError::PayTransport(
                    "unscripted webhook POST — test did not expect any delivery here".into(),
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::MockWebhookTransport;
    use super::*;
    use crate::db::Db;
    use crate::domain::*;
    use crate::secrets::MemorySecretStore;
    use crate::service::CoreService;

    // -- pure helpers -------------------------------------------------------

    #[test]
    fn token_matching_is_whole_token_and_case_insensitive() {
        // The headline false-positive: INV1 must not fire on INV11.
        assert!(!text_contains_code("PAYMENT RECEIVED INV11", "INV1"));
        assert!(!text_contains_code("XINV1 SUFFIXED", "INV1"));
        assert!(text_contains_code("PAYMENT RECEIVED INV1", "INV1"));
        assert!(text_contains_code("INV1", "INV1"));
        // Case-insensitive both ways.
        assert!(text_contains_code(
            "payment ref inv-7031 thanks",
            "INV-7031"
        ));
        assert!(text_contains_code("PAYMENT REF INV-7031", "inv-7031"));
        // Non-alphanumeric neighbours are token boundaries.
        assert!(text_contains_code("REF:INV1.", "INV1"));
        assert!(text_contains_code("inv1/2026 rent", "INV1"));
        // Later occurrence still found after an embedded first hit.
        assert!(text_contains_code("INV11 then INV1 alone", "INV1"));
        // Codes with separators match as one token.
        assert!(!text_contains_code("INV-0011", "INV-001"));
        assert!(text_contains_code("EFT INV-001 OK", "INV-001"));
        // Empty / whitespace codes never match anything.
        assert!(!text_contains_code("anything", ""));
        assert!(!text_contains_code("anything", "   "));
        // Multibyte neighbours must not panic and are non-alphanumeric-aware.
        assert!(text_contains_code("münze→INV1←done", "INV1"));
        assert!(!text_contains_code("caféINV1", "INV1"));
    }

    #[test]
    fn hmac_sha256_matches_rfc_4231_vectors() {
        // RFC 4231 test case 1.
        let mac = hmac_sha256(&[0x0b; 20], &[b"Hi There"]);
        assert_eq!(
            to_hex(&mac),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        // RFC 4231 test case 2 (key shorter than the block).
        let mac = hmac_sha256(b"Jefe", &[b"what do ya want ", b"for nothing?"]);
        assert_eq!(
            to_hex(&mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // RFC 4231 test case 6 (key longer than the block: hashed first).
        let mac = hmac_sha256(
            &[0xaa; 131],
            &[b"Test Using Larger Than Block-Size Key - Hash Key First".as_slice()],
        );
        assert_eq!(
            to_hex(&mac),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn signature_roundtrip_and_tamper_detection() {
        let secret = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
        let body = br#"{"event":"payment.matched"}"#;
        let sig = sign_webhook(secret, "1789000000", "nonce-1", body);
        assert_eq!(sig.len(), 64);
        assert!(verify_webhook_signature(
            secret,
            "1789000000",
            "nonce-1",
            body,
            &sig
        ));
        // Uppercase hex is accepted.
        assert!(verify_webhook_signature(
            secret,
            "1789000000",
            "nonce-1",
            body,
            &sig.to_ascii_uppercase()
        ));
        // Any tampered ingredient fails: body, timestamp, nonce, secret, sig.
        assert!(!verify_webhook_signature(
            secret,
            "1789000000",
            "nonce-1",
            b"{}",
            &sig
        ));
        assert!(!verify_webhook_signature(
            secret,
            "1789000001",
            "nonce-1",
            body,
            &sig
        ));
        assert!(!verify_webhook_signature(
            secret,
            "1789000000",
            "nonce-2",
            body,
            &sig
        ));
        assert!(!verify_webhook_signature(
            "wrong-secret",
            "1789000000",
            "nonce-1",
            body,
            &sig
        ));
        let mut forged = sig.clone().into_bytes();
        forged[0] = if forged[0] == b'0' { b'1' } else { b'0' };
        assert!(!verify_webhook_signature(
            secret,
            "1789000000",
            "nonce-1",
            body,
            std::str::from_utf8(&forged).unwrap()
        ));
        // Wrong length is a clean fail, never a panic.
        assert!(!verify_webhook_signature(
            secret,
            "1789000000",
            "nonce-1",
            body,
            "abc"
        ));
        assert!(!verify_webhook_signature(
            secret,
            "1789000000",
            "nonce-1",
            body,
            ""
        ));
    }

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn backoff_progression_is_1m_5m_30m_2h_12h_then_daily() {
        assert_eq!(backoff_delay_secs(1), 60);
        assert_eq!(backoff_delay_secs(2), 300);
        assert_eq!(backoff_delay_secs(3), 1_800);
        assert_eq!(backoff_delay_secs(4), 7_200);
        assert_eq!(backoff_delay_secs(5), 43_200);
        assert_eq!(backoff_delay_secs(6), 86_400);
        assert_eq!(backoff_delay_secs(19), 86_400);
        // Defensive: nonsense input maps to the first step, never a panic.
        assert_eq!(backoff_delay_secs(0), 60);
    }

    #[test]
    fn webhook_urls_normalize_or_reject() {
        assert_eq!(
            normalize_webhook_url(" HTTPS://hooks.example.org/pay ").unwrap(),
            "https://hooks.example.org/pay"
        );
        // Paths and queries are the receiver's business — kept verbatim.
        assert_eq!(
            normalize_webhook_url("https://hooks.example.org/pay?channel=eft").unwrap(),
            "https://hooks.example.org/pay?channel=eft"
        );
        assert_eq!(
            normalize_webhook_url("http://127.0.0.1:8787/hook/").unwrap(),
            "http://127.0.0.1:8787/hook/"
        );
        assert!(normalize_webhook_url("").is_err());
        assert!(normalize_webhook_url("hooks.example.org").is_err());
        assert!(normalize_webhook_url("ftp://hooks.example.org").is_err());
        assert!(normalize_webhook_url("https://").is_err());
        assert!(normalize_webhook_url("https:///path-only").is_err());
        assert!(normalize_webhook_url("https://a b").is_err());
        assert!(normalize_webhook_url("https://hooks.example.org/x#frag").is_err());
        // An '@' past the authority is not a credential — path and query are
        // the receiver's business.
        assert_eq!(
            normalize_webhook_url("https://hooks.example.org/path@v1?to=ops@example.org").unwrap(),
            "https://hooks.example.org/path@v1?to=ops@example.org"
        );
    }

    #[test]
    fn credentialed_webhook_urls_are_rejected_without_echoing_them() {
        let err = normalize_webhook_url("https://alice:hunter2@hooks.example.org").unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)), "{err}");
        assert!(err.to_string().contains("credentials"), "{err}");
        // Whichever validation rule fires first, a URL carrying '@' must
        // never be echoed back — the message reaches CLI stderr, the desktop
        // error banner, and the server's 422 body. (Regression: the fragment,
        // scheme, whitespace, and no-scheme rejections used to interpolate
        // the raw URL, credentials and all.)
        for bad in [
            "https://alice:hunter2@hooks.example.org", // credential rule
            "https://alice:hunter2@hooks.example.org/x#frag", // fragment
            "ftp://alice:hunter2@hooks.example.org",   // scheme
            "https://alice:hunter2@hooks example.org/x", // whitespace
            "alice:hunter2@hooks.example.org",         // no scheme at all
            "https://alice:hunter2@",                  // nothing after '@'
        ] {
            let err = normalize_webhook_url(bad).unwrap_err();
            assert!(matches!(err, CoreError::Validation(_)), "{err}");
            let rendered = err.to_string();
            assert!(
                !rendered.contains("hunter2") && !rendered.contains("alice"),
                "the rejection for {bad:?} must not echo the credentials: {rendered}"
            );
        }
    }

    #[test]
    fn generated_secrets_are_64_hex_chars_and_random() {
        let a = generate_secret_hex();
        let b = generate_secret_hex();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "two generated secrets must differ");
    }

    // -- service-level tests ------------------------------------------------

    fn svc() -> CoreService {
        CoreService::new(
            Db::open_in_memory().expect("in-memory db"),
            Box::new(MemorySecretStore::new()),
        )
    }

    fn book(svc: &CoreService) -> Book {
        svc.book_create(NewBook {
            name: "Pay".into(),
            kind: BookKind::Personal,
            currency: Some("ZAR".into()),
            country: None,
            region: None,
        })
        .unwrap()
    }

    fn account(svc: &CoreService, book_id: &str) -> Account {
        svc.account_create(NewAccount {
            book_id: book_id.into(),
            name: "Cheque".into(),
            kind: AccountKind::Bank,
            currency: "ZAR".into(),
            institution: None,
            account_number_masked: None,
            opening_balance_minor: None,
        })
        .unwrap()
    }

    fn watch(svc: &CoreService, book_id: &str, code: &str) -> PayWatch {
        svc.pay_watch_add(NewPayWatch {
            book_id: book_id.into(),
            code: code.into(),
            label: Some("Rent".into()),
            expected_amount_minor: None,
            expected_currency: None,
        })
        .unwrap()
    }

    fn endpoint(svc: &CoreService, book_id: &str) -> PayEndpointWithSecret {
        svc.pay_endpoint_add(NewPayEndpoint {
            book_id: book_id.into(),
            label: "Shop".into(),
            url: "https://hooks.example.org/pay".into(),
        })
        .unwrap()
    }

    fn inbound(book_id: &str, account_id: &str, amount: i64, description: &str) -> NewTransaction {
        NewTransaction {
            book_id: book_id.into(),
            account_id: account_id.into(),
            source: TransactionSource::Email,
            provider_txn_id: None,
            posted_date: "2026-07-01".into(),
            amount_minor: amount,
            currency: "ZAR".into(),
            merchant: None,
            description: Some(description.into()),
            notes: None,
            category_id: None,
            document_id: None,
            dedupe_occurrence: 0,
        }
    }

    const NOW: &str = "2027-01-01T12:00:00Z";

    #[test]
    fn watch_add_list_remove_roundtrip() {
        let svc = svc();
        let book = book(&svc);
        let w = svc
            .pay_watch_add(NewPayWatch {
                book_id: book.id.clone(),
                code: "  INV-7031  ".into(),
                label: Some("Rent".into()),
                expected_amount_minor: Some(50_000),
                expected_currency: Some("zar".into()),
            })
            .unwrap();
        assert_eq!(w.code, "INV-7031", "code is trimmed");
        assert_eq!(w.expected_currency.as_deref(), Some("ZAR"), "normalized");
        assert!(w.enabled);
        let listed = svc.pay_watch_list(&book.id).unwrap();
        assert_eq!(listed, vec![w.clone()]);
        svc.pay_watch_remove(&w.id).unwrap();
        assert!(svc.pay_watch_list(&book.id).unwrap().is_empty());
        assert!(matches!(
            svc.pay_watch_remove(&w.id),
            Err(CoreError::NotFound { .. })
        ));
        // Audited (metadata is the user's own config — no bank data exists).
        let audits = svc.audit_list(Some(&book.id), 50).unwrap();
        for action in ["create", "remove"] {
            assert!(
                audits
                    .iter()
                    .any(|a| a.entity_type == "pay_watch" && a.action == action),
                "missing pay_watch audit {action}"
            );
        }
    }

    #[test]
    fn watch_validation_rejects_bad_input() {
        let svc = svc();
        let book = book(&svc);
        let base = |code: &str| NewPayWatch {
            book_id: book.id.clone(),
            code: code.into(),
            label: None,
            expected_amount_minor: None,
            expected_currency: None,
        };
        assert!(svc.pay_watch_add(base("   ")).is_err(), "empty code");
        let mut amount_no_currency = base("INV1");
        amount_no_currency.expected_amount_minor = Some(500);
        assert!(
            svc.pay_watch_add(amount_no_currency).is_err(),
            "an exact amount needs a currency"
        );
        let mut bad_currency = base("INV1");
        bad_currency.expected_amount_minor = Some(500);
        bad_currency.expected_currency = Some("ZARR".into());
        assert!(svc.pay_watch_add(bad_currency).is_err());
        let mut negative = base("INV1");
        negative.expected_amount_minor = Some(-500);
        negative.expected_currency = Some("ZAR".into());
        assert!(
            svc.pay_watch_add(negative).is_err(),
            "expected amount must be positive: only inbound transactions match"
        );
        let mut unknown_book = base("INV1");
        unknown_book.book_id = "nope".into();
        assert!(matches!(
            svc.pay_watch_add(unknown_book),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    fn match_writes_row_and_enqueues_per_enabled_endpoint() {
        let svc = svc();
        let book = book(&svc);
        let account = account(&svc, &book.id);
        let w = watch(&svc, &book.id, "INV-7031");
        let ep_on = endpoint(&svc, &book.id);
        let ep_off = svc
            .pay_endpoint_add(NewPayEndpoint {
                book_id: book.id.clone(),
                label: "Disabled".into(),
                url: "https://other.example.org/hook".into(),
            })
            .unwrap();
        svc.pay_endpoint_set_enabled(&ep_off.endpoint.id, false)
            .unwrap();

        let txn = svc
            .transaction_create(inbound(
                &book.id,
                &account.id,
                50_000,
                "EFT CREDIT REF INV-7031 FROM ACC 62001234567",
            ))
            .unwrap();

        let matches = svc.pay_match_list(&book.id).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].watch_id, w.id);
        assert_eq!(matches[0].transaction_id, txn.id);

        // One delivery — only for the enabled endpoint.
        let deliveries = svc.pay_delivery_list(&book.id).unwrap();
        assert_eq!(deliveries.len(), 1);
        let d = &deliveries[0];
        assert_eq!(d.endpoint_id, ep_on.endpoint.id);
        assert_eq!(d.state, PayDeliveryState::Pending);
        assert_eq!(d.attempts, 0);

        // Payload carries metadata only: reference + label + amount fields,
        // never the raw bank description or account numbers.
        let payload: serde_json::Value = serde_json::from_str(&d.payload).unwrap();
        assert_eq!(payload["event"], "payment.matched");
        assert_eq!(payload["reference"], "INV-7031");
        assert_eq!(payload["watch_label"], "Rent");
        assert_eq!(payload["amount_minor"], 50_000);
        assert_eq!(payload["currency"], "ZAR");
        assert_eq!(payload["posted_date"], "2026-07-01");
        assert!(!d.payload.contains("62001234567"), "no account numbers");
        assert!(!d.payload.contains("EFT CREDIT"), "no raw description");

        // The match is audited — metadata only.
        let audits = svc.audit_list(Some(&book.id), 50).unwrap();
        let entry = audits
            .iter()
            .find(|a| a.entity_type == "pay_match" && a.action == "match")
            .expect("match audit entry");
        let after = entry.after_json.as_deref().unwrap();
        assert!(!after.contains("62001234567"));
        assert!(!after.contains("EFT CREDIT"));
    }

    #[test]
    fn matching_respects_tokens_case_amount_currency_and_direction() {
        let svc = svc();
        let book = book(&svc);
        let account = account(&svc, &book.id);
        endpoint(&svc, &book.id);

        // INV1 vs INV11: no substring false positive.
        watch(&svc, &book.id, "INV1");
        svc.transaction_create(inbound(&book.id, &account.id, 100, "credit INV11"))
            .unwrap();
        assert!(svc.pay_match_list(&book.id).unwrap().is_empty());
        // Case-insensitive whole token fires.
        svc.transaction_create(inbound(&book.id, &account.id, 100, "credit inv1 received"))
            .unwrap();
        assert_eq!(svc.pay_match_list(&book.id).unwrap().len(), 1);

        // Outflow NEVER matches, even with the code present.
        svc.transaction_create(inbound(&book.id, &account.id, -100, "debit INV1 reversal"))
            .unwrap();
        assert_eq!(svc.pay_match_list(&book.id).unwrap().len(), 1);

        // Amount+currency filter: only the exact amount in the exact
        // currency matches.
        svc.pay_watch_add(NewPayWatch {
            book_id: book.id.clone(),
            code: "DEP-9".into(),
            label: None,
            expected_amount_minor: Some(50_000),
            expected_currency: Some("ZAR".into()),
        })
        .unwrap();
        svc.transaction_create(inbound(&book.id, &account.id, 49_999, "ref DEP-9"))
            .unwrap();
        assert_eq!(
            svc.pay_match_list(&book.id).unwrap().len(),
            1,
            "wrong amount"
        );
        let mut usd = inbound(&book.id, &account.id, 50_000, "ref DEP-9 usd");
        usd.currency = "USD".into();
        svc.transaction_create(usd).unwrap();
        assert_eq!(
            svc.pay_match_list(&book.id).unwrap().len(),
            1,
            "wrong currency"
        );
        svc.transaction_create(inbound(&book.id, &account.id, 50_000, "ref DEP-9 exact"))
            .unwrap();
        assert_eq!(
            svc.pay_match_list(&book.id).unwrap().len(),
            2,
            "exact match fires"
        );

        // The merchant field is matched too (bank alerts put references
        // there).
        let mut via_merchant = inbound(&book.id, &account.id, 75, "no code here");
        via_merchant.merchant = Some("TRANSFER INV1".into());
        svc.transaction_create(via_merchant).unwrap();
        assert_eq!(svc.pay_match_list(&book.id).unwrap().len(), 3);

        // A disabled watch never matches.
        let w2 = watch(&svc, &book.id, "OFF-1");
        svc.pay_watch_set_enabled(&w2.id, false).unwrap();
        svc.transaction_create(inbound(&book.id, &account.id, 10, "ref OFF-1"))
            .unwrap();
        assert_eq!(svc.pay_match_list(&book.id).unwrap().len(), 3);
    }

    /// Content-hash dedupe already rejects a re-imported duplicate before the
    /// detection hook runs — the same statement imported twice can never fire
    /// the webhook twice.
    #[test]
    fn reimported_duplicate_cannot_double_fire() {
        let svc = svc();
        let book = book(&svc);
        let account = account(&svc, &book.id);
        watch(&svc, &book.id, "INV-7031");
        endpoint(&svc, &book.id);

        let new = inbound(&book.id, &account.id, 50_000, "EFT REF INV-7031");
        svc.transaction_create(new.clone()).unwrap();
        assert_eq!(svc.pay_match_list(&book.id).unwrap().len(), 1);
        assert_eq!(svc.pay_delivery_list(&book.id).unwrap().len(), 1);

        // Re-import of the identical line: rejected by the content hash…
        let err = svc.transaction_create(new).unwrap_err();
        assert!(
            matches!(err, CoreError::DuplicateTransaction { .. }),
            "{err}"
        );
        // …so nothing new was matched or enqueued.
        assert_eq!(svc.pay_match_list(&book.id).unwrap().len(), 1);
        assert_eq!(svc.pay_delivery_list(&book.id).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn deliver_due_success_signs_verifiably_and_marks_delivered() {
        let svc = svc();
        let book = book(&svc);
        let account = account(&svc, &book.id);
        watch(&svc, &book.id, "INV-7031");
        let created = endpoint(&svc, &book.id);
        svc.transaction_create(inbound(&book.id, &account.id, 50_000, "ref INV-7031"))
            .unwrap();

        let transport = MockWebhookTransport::new().respond(200);
        let updated = svc.pay_deliver_due(&transport, NOW).await.unwrap();
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0].state, PayDeliveryState::Delivered);
        assert_eq!(updated[0].attempts, 1);
        assert_eq!(updated[0].last_status, Some(200));

        // The POST went to the endpoint URL with the signed headers.
        // (Scoped so the RefCell borrow ends before the next dispatch.)
        {
            let sent = transport.sent.borrow();
            assert_eq!(sent.len(), 1);
            assert_eq!(sent[0].url, "https://hooks.example.org/pay");
            let timestamp = sent[0].header(HEADER_TIMESTAMP).unwrap();
            let nonce = sent[0].header(HEADER_NONCE).unwrap();
            let signature = sent[0].header(HEADER_SIGNATURE).unwrap();
            assert_eq!(nonce, updated[0].id, "nonce is the stable delivery id");
            // The receiver-side check passes with the secret displayed at
            // add time — the full roundtrip.
            assert!(verify_webhook_signature(
                &created.secret,
                timestamp,
                nonce,
                &sent[0].body,
                signature
            ));
            // Body is the stored payload, byte for byte.
            assert_eq!(sent[0].body, updated[0].payload.as_bytes());
        }

        // Nothing left due.
        let again = svc.pay_deliver_due(&transport, NOW).await.unwrap();
        assert!(again.is_empty());
        assert_eq!(transport.sent_count(), 1);

        // Outcome audited, signature/secret never in the audit log.
        let audits = svc.audit_list(Some(&book.id), 50).unwrap();
        let entry = audits
            .iter()
            .find(|a| a.entity_type == "pay_delivery" && a.action == "delivered")
            .expect("delivered audit entry");
        assert!(!entry
            .after_json
            .as_deref()
            .unwrap()
            .contains(&created.secret));
    }

    #[tokio::test]
    async fn deliver_due_5xx_and_transport_errors_retry_with_backoff() {
        let svc = svc();
        let book = book(&svc);
        let account = account(&svc, &book.id);
        watch(&svc, &book.id, "INV-7031");
        endpoint(&svc, &book.id);
        svc.transaction_create(inbound(&book.id, &account.id, 50_000, "ref INV-7031"))
            .unwrap();

        // First attempt: 503 → retry in 1m.
        let transport = MockWebhookTransport::new().respond(503);
        let updated = svc.pay_deliver_due(&transport, NOW).await.unwrap();
        assert_eq!(updated[0].state, PayDeliveryState::Pending);
        assert_eq!(updated[0].attempts, 1);
        assert_eq!(updated[0].last_status, Some(503));
        assert_eq!(updated[0].next_attempt_at, "2027-01-01T12:01:00Z");

        // Not due yet: no POST is even attempted.
        let idle = MockWebhookTransport::new();
        assert!(svc
            .pay_deliver_due(&idle, "2027-01-01T12:00:30Z")
            .await
            .unwrap()
            .is_empty());
        assert_eq!(idle.sent_count(), 0);

        // Second failure (transport error this time) → retry in 5m.
        let transport = MockWebhookTransport::new().respond_err("connection refused");
        let updated = svc
            .pay_deliver_due(&transport, "2027-01-01T12:01:00Z")
            .await
            .unwrap();
        assert_eq!(updated[0].state, PayDeliveryState::Pending);
        assert_eq!(updated[0].attempts, 2);
        assert_eq!(
            updated[0].last_status, None,
            "transport failure has no status"
        );
        assert!(updated[0]
            .last_error
            .as_deref()
            .unwrap()
            .contains("connection refused"));
        assert_eq!(updated[0].next_attempt_at, "2027-01-01T12:06:00Z");

        // Third failure → 30m.
        let transport = MockWebhookTransport::new().respond(500);
        let updated = svc
            .pay_deliver_due(&transport, "2027-01-01T12:06:00Z")
            .await
            .unwrap();
        assert_eq!(updated[0].next_attempt_at, "2027-01-01T12:36:00Z");

        // Eventually a success clears it.
        let transport = MockWebhookTransport::new().respond(200);
        let updated = svc
            .pay_deliver_due(&transport, "2027-01-01T12:36:00Z")
            .await
            .unwrap();
        assert_eq!(updated[0].state, PayDeliveryState::Delivered);
        assert_eq!(updated[0].attempts, 4);
    }

    #[tokio::test]
    async fn deliver_due_4xx_fails_fast() {
        let svc = svc();
        let book = book(&svc);
        let account = account(&svc, &book.id);
        watch(&svc, &book.id, "INV-7031");
        endpoint(&svc, &book.id);
        svc.transaction_create(inbound(&book.id, &account.id, 50_000, "ref INV-7031"))
            .unwrap();

        let transport = MockWebhookTransport::new().respond(422);
        let updated = svc.pay_deliver_due(&transport, NOW).await.unwrap();
        assert_eq!(updated[0].state, PayDeliveryState::Failed);
        assert_eq!(updated[0].attempts, 1);
        assert_eq!(updated[0].last_status, Some(422));

        // Terminal: never retried.
        let idle = MockWebhookTransport::new();
        assert!(svc
            .pay_deliver_due(&idle, "2027-02-01T12:00:00Z")
            .await
            .unwrap()
            .is_empty());
        assert_eq!(idle.sent_count(), 0);
    }

    #[tokio::test]
    async fn persistent_failure_is_abandoned_at_the_attempt_cap() {
        let svc = svc();
        let book = book(&svc);
        let account = account(&svc, &book.id);
        watch(&svc, &book.id, "INV-7031");
        endpoint(&svc, &book.id);
        svc.transaction_create(inbound(&book.id, &account.id, 50_000, "ref INV-7031"))
            .unwrap();

        // Fail forever, advancing a day past each scheduled retry.
        let mut now = time::macros::datetime!(2027-01-01 12:00:00 UTC);
        let mut last = Vec::new();
        for _ in 0..MAX_DELIVERY_ATTEMPTS {
            let now_s = now
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap();
            let transport = MockWebhookTransport::new().respond(500);
            last = svc.pay_deliver_due(&transport, &now_s).await.unwrap();
            assert_eq!(last.len(), 1, "delivery must stay claimable until the cap");
            now += time::Duration::days(2);
        }
        assert_eq!(last[0].attempts, MAX_DELIVERY_ATTEMPTS);
        assert_eq!(last[0].state, PayDeliveryState::Failed);

        // Abandoned for good.
        let idle = MockWebhookTransport::new();
        let now_s = now
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        assert!(svc.pay_deliver_due(&idle, &now_s).await.unwrap().is_empty());
        assert_eq!(idle.sent_count(), 0);
    }

    #[tokio::test]
    async fn disabled_endpoint_is_not_claimed() {
        let svc = svc();
        let book = book(&svc);
        let account = account(&svc, &book.id);
        watch(&svc, &book.id, "INV-7031");
        let created = endpoint(&svc, &book.id);
        svc.transaction_create(inbound(&book.id, &account.id, 50_000, "ref INV-7031"))
            .unwrap();
        // Disable after enqueue: the pending delivery must not be POSTed.
        svc.pay_endpoint_set_enabled(&created.endpoint.id, false)
            .unwrap();
        let idle = MockWebhookTransport::new();
        assert!(svc.pay_deliver_due(&idle, NOW).await.unwrap().is_empty());
        assert_eq!(idle.sent_count(), 0);
        // Re-enable: it becomes claimable again (still pending, untouched).
        svc.pay_endpoint_set_enabled(&created.endpoint.id, true)
            .unwrap();
        let transport = MockWebhookTransport::new().respond(200);
        let updated = svc.pay_deliver_due(&transport, NOW).await.unwrap();
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0].state, PayDeliveryState::Delivered);
    }

    #[test]
    fn endpoint_secret_is_displayed_once_vaulted_and_revoked_on_remove() {
        let svc = svc();
        let book = book(&svc);
        let created = endpoint(&svc, &book.id);
        let id = created.endpoint.id.clone();
        assert_eq!(created.secret.len(), 64);
        assert!(created.secret.bytes().all(|c| c.is_ascii_hexdigit()));

        // The vault holds it under the endpoint-derived name; listings and
        // the endpoint row expose metadata only.
        let vault_names: Vec<String> = svc
            .vault_list()
            .unwrap()
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert_eq!(vault_names, vec![endpoint_secret_name(&id)]);
        let listed = svc.pay_endpoint_list(&book.id).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(
            !serde_json::to_string(&listed)
                .unwrap()
                .contains(&created.secret),
            "endpoint listings must never carry the secret"
        );

        // The secret appears nowhere in the audit log (vault audits carry
        // metadata + fingerprint only).
        for entry in svc.audit_list(None, 100).unwrap() {
            let blob = format!("{entry:?}");
            assert!(!blob.contains(&created.secret), "secret leaked to audit");
        }

        // Rotate: a brand-new secret, displayed exactly once again.
        let rotated = svc.pay_endpoint_rotate_secret(&id).unwrap();
        assert_ne!(rotated.secret, created.secret);
        assert_eq!(rotated.endpoint.id, id);
        let metas = svc.vault_list().unwrap();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].version, 2, "rotation bumps the vault version");

        // Remove: the endpoint row goes and the vault entry is revoked.
        svc.pay_endpoint_remove(&id).unwrap();
        assert!(svc.pay_endpoint_list(&book.id).unwrap().is_empty());
        assert!(svc.vault_list().unwrap().is_empty(), "secret revoked");
        assert!(matches!(
            svc.pay_endpoint_rotate_secret(&id),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    fn endpoint_remove_drops_its_queued_deliveries() {
        let svc = svc();
        let book = book(&svc);
        let account = account(&svc, &book.id);
        watch(&svc, &book.id, "INV-7031");
        let created = endpoint(&svc, &book.id);
        svc.transaction_create(inbound(&book.id, &account.id, 50_000, "ref INV-7031"))
            .unwrap();
        assert_eq!(svc.pay_delivery_list(&book.id).unwrap().len(), 1);
        svc.pay_endpoint_remove(&created.endpoint.id).unwrap();
        assert!(
            svc.pay_delivery_list(&book.id).unwrap().is_empty(),
            "deliveries cascade with their endpoint"
        );
    }

    #[test]
    fn endpoint_urls_are_validated_on_add() {
        let svc = svc();
        let book = book(&svc);
        for bad in [
            "hooks.example.org",
            "ftp://hooks.example.org",
            "https://alice:pw@hooks.example.org",
            "",
        ] {
            assert!(
                svc.pay_endpoint_add(NewPayEndpoint {
                    book_id: book.id.clone(),
                    label: "x".into(),
                    url: bad.into(),
                })
                .is_err(),
                "URL {bad:?} must be rejected"
            );
        }
        // A rejected add leaves no orphan vault entry behind.
        assert!(svc.vault_list().unwrap().is_empty());
    }
}
