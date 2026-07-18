//! Thin OpenRate HTTP client, written against an injected [`FxTransport`]
//! so this crate stays strictly network-free (mantra #1). The production
//! transport (reqwest over rustls) lives in `slipscan-ingest::fx`; tests use
//! the scripted mock below.
//!
//! Endpoints (all GET, relative to the user-configured base URL):
//! * `/api/v1/convert?from=X&to=Y&amount=1` — one rate quote
//! * `/api/v1/meta` — supported currencies
//! * `/healthz` — instance liveness
//!
//! The `rate.rate` field is captured as a raw JSON token ([`RawValue`]) and
//! parsed straight into [`Decimal`] — it never round-trips through `f64`, so
//! a 28-digit rate survives verbatim.

use async_trait::async_trait;
use rust_decimal::Decimal;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use std::str::FromStr;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::error::{CoreError, CoreResult};

/// Response from an [`FxTransport`] request: status plus raw body.
#[derive(Debug, Clone)]
pub struct FxHttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Minimal async GET transport the OpenRate client depends on.
///
/// `?Send` to match the other injected transports (callers may borrow the
/// single-threaded core service across awaits). Implementations only ever
/// receive URLs derived from the user's configured OpenRate base URL
/// (mantra #2); when no base URL is configured no transport is ever invoked.
#[async_trait(?Send)]
pub trait FxTransport {
    async fn get(&self, url: &str) -> CoreResult<FxHttpResponse>;
}

/// One quote from `/api/v1/convert` — the fields SlipScan keeps, including
/// the provenance OpenRate reports (quality grade, staleness, sources).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FxQuote {
    pub from_currency: String,
    pub to_currency: String,
    /// Exact decimal rate, parsed from the JSON token — never via `f64`.
    pub rate: Decimal,
    /// RFC 3339 timestamp the rate is dated at (validated on parse).
    pub as_of: String,
    /// Server-reported staleness at fetch time, in seconds. `None` when the
    /// server omitted it — unknown staleness must never masquerade as
    /// "fresh" (0).
    pub age_sec: Option<i64>,
    /// OpenRate quality grade (e.g. "A", "B").
    pub grade: String,
    /// Upstream sources that produced the rate.
    pub sources: Vec<String>,
}

/// How far in the future a quote's `as_of` may be before it is rejected as
/// bogus. Generous enough for real clock skew, small enough that a
/// far-future-dated rate cannot masquerade as fresh forever.
const MAX_AS_OF_FUTURE_SKEW: time::Duration = time::Duration::days(1);

/// A currency from `/api/v1/meta`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FxCurrency {
    pub code: String,
    pub name: Option<String>,
}

/// Validate and normalize an OpenRate base URL: http(s) with a host,
/// optionally a port and path — nothing else. No trailing slash, no
/// userinfo (credentials embedded in a URL would land in a plain setting,
/// status output and transport error strings — mantra #4), no query, no
/// fragment. The scheme is accepted case-insensitively, normalized to
/// lowercase.
pub fn normalize_base_url(raw: &str) -> CoreResult<String> {
    let invalid = || {
        CoreError::Validation(format!(
            "invalid OpenRate base URL {raw:?} (expected http(s)://host[:port][/path])"
        ))
    };
    let trimmed = raw.trim().trim_end_matches('/');
    let (scheme, rest) = trimmed.split_once("://").ok_or_else(invalid)?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(invalid());
    }
    if rest.is_empty() || rest.contains(char::is_whitespace) {
        return Err(invalid());
    }
    if rest.contains(['?', '#']) {
        return Err(CoreError::Validation(format!(
            "invalid OpenRate base URL {raw:?}: queries and fragments are not allowed"
        )));
    }
    let authority = rest.split('/').next().unwrap_or_default();
    if authority.is_empty() {
        return Err(invalid());
    }
    if authority.contains('@') {
        // Deliberately not echoing the URL — it contains the credentials.
        return Err(CoreError::Validation(
            "OpenRate base URL must not embed credentials (user:pass@host): the URL is stored \
             as a plain setting and shown in status output; front the instance with \
             network-level auth instead"
                .into(),
        ));
    }
    Ok(format!("{scheme}://{rest}"))
}

/// Validate a currency code before URL interpolation: exactly 3 ASCII
/// uppercase letters. Defense in depth — the service normalizes first, but
/// this public client must never emit an injectable query string.
fn validate_currency_code(code: &str) -> CoreResult<()> {
    if code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase()) {
        Ok(())
    } else {
        Err(CoreError::Validation(format!(
            "invalid currency code {code:?} (expected 3 uppercase ASCII letters)"
        )))
    }
}

/// Thin client over one OpenRate instance.
pub struct OpenRateClient<'a> {
    base_url: String,
    transport: &'a dyn FxTransport,
}

impl std::fmt::Debug for OpenRateClient<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenRateClient")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl<'a> OpenRateClient<'a> {
    /// Build a client for `base_url` (validated) over `transport`.
    pub fn new(base_url: &str, transport: &'a dyn FxTransport) -> CoreResult<Self> {
        Ok(Self {
            base_url: normalize_base_url(base_url)?,
            transport,
        })
    }

    /// Fetch the current rate for one pair (`amount=1`). Currency codes are
    /// validated here (3 uppercase ASCII letters) so nothing injectable can
    /// reach the query string. A 404 means OpenRate does not know the pair.
    pub async fn convert_one(&self, from: &str, to: &str) -> CoreResult<FxQuote> {
        validate_currency_code(from)?;
        validate_currency_code(to)?;
        let url = format!(
            "{}/api/v1/convert?from={from}&to={to}&amount=1",
            self.base_url
        );
        let response = self.transport.get(&url).await?;
        if response.status == 404 {
            return Err(CoreError::FxUnknownPair {
                from: from.to_string(),
                to: to.to_string(),
            });
        }
        expect_success(&response)?;
        let wire: ConvertWire = serde_json::from_slice(&response.body)
            .map_err(|e| CoreError::FxParse(format!("convert response: {e}")))?;
        // as_of must be a real RFC 3339 instant — staleness math depends on
        // it. A far-future date (hostile/misconfigured server) would make a
        // stale rate look perfectly fresh forever, so it is rejected here;
        // small clock skew stays tolerated.
        let as_of = OffsetDateTime::parse(&wire.rate.as_of, &Rfc3339).map_err(|e| {
            CoreError::FxParse(format!("as_of {:?} is not RFC 3339: {e}", wire.rate.as_of))
        })?;
        if as_of - OffsetDateTime::now_utc() > MAX_AS_OF_FUTURE_SKEW {
            return Err(CoreError::FxParse(format!(
                "as_of {:?} is more than a day in the future — refusing to treat it as fresh",
                wire.rate.as_of
            )));
        }
        Ok(FxQuote {
            from_currency: from.to_string(),
            to_currency: to.to_string(),
            rate: wire.rate.rate,
            as_of: wire.rate.as_of,
            age_sec: wire.rate.age_sec,
            grade: wire.rate.quality.grade,
            sources: wire.rate.sources,
        })
    }

    /// Currencies this OpenRate instance can quote.
    pub async fn meta(&self) -> CoreResult<Vec<FxCurrency>> {
        let url = format!("{}/api/v1/meta", self.base_url);
        let response = self.transport.get(&url).await?;
        expect_success(&response)?;
        let wire: MetaWire = serde_json::from_slice(&response.body)
            .map_err(|e| CoreError::FxParse(format!("meta response: {e}")))?;
        Ok(wire
            .currencies
            .into_iter()
            .map(|c| match c {
                CurrencyWire::Code(code) => FxCurrency { code, name: None },
                CurrencyWire::Full { code, name } => FxCurrency { code, name },
            })
            .collect())
    }

    /// `true` when `/healthz` answers 2xx.
    pub async fn healthz(&self) -> CoreResult<bool> {
        let url = format!("{}/healthz", self.base_url);
        let response = self.transport.get(&url).await?;
        Ok((200..300).contains(&response.status))
    }
}

fn expect_success(response: &FxHttpResponse) -> CoreResult<()> {
    if (200..300).contains(&response.status) {
        Ok(())
    } else {
        // Body is server-controlled: report the status only, never echo it.
        Err(CoreError::FxTransport(format!(
            "OpenRate returned HTTP {}",
            response.status
        )))
    }
}

// ---------------------------------------------------------------------------
// Wire shapes (openrate rateView). Unknown fields are ignored.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ConvertWire {
    rate: RateWire,
}

#[derive(Deserialize)]
struct RateWire {
    #[serde(deserialize_with = "decimal_from_token")]
    rate: Decimal,
    as_of: String,
    /// Optional on the wire: a missing value is *unknown* staleness, not 0.
    #[serde(default)]
    age_sec: Option<i64>,
    #[serde(default)]
    sources: Vec<String>,
    quality: QualityWire,
}

#[derive(Deserialize)]
struct QualityWire {
    grade: String,
}

#[derive(Deserialize)]
struct MetaWire {
    #[serde(default)]
    currencies: Vec<CurrencyWire>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CurrencyWire {
    Code(String),
    Full { code: String, name: Option<String> },
}

/// Deserialize a decimal from the *raw* JSON token — number or string —
/// without ever constructing an `f64`.
fn decimal_from_token<'de, D>(deserializer: D) -> Result<Decimal, D::Error>
where
    D: Deserializer<'de>,
{
    let raw: Box<RawValue> = Deserialize::deserialize(deserializer)?;
    let token = raw.get().trim();
    let token = token
        .strip_prefix('"')
        .and_then(|t| t.strip_suffix('"'))
        .unwrap_or(token);
    Decimal::from_str(token)
        .or_else(|_| Decimal::from_scientific(token))
        .map_err(|e| serde::de::Error::custom(format!("rate token {token:?}: {e}")))
}

// ---------------------------------------------------------------------------
// Test transport
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod testutil {
    //! Scripted mock transport shared by FX tests — no network, ever.

    use super::*;
    use std::cell::RefCell;

    /// Route table: first rule whose `url_contains` matches wins. Every URL
    /// requested is recorded so tests can assert "no network call happened".
    #[derive(Default)]
    pub struct MockFxTransport {
        rules: Vec<(String, u16, String)>,
        pub requested: RefCell<Vec<String>>,
    }

    impl MockFxTransport {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn route(mut self, url_contains: &str, status: u16, body: &str) -> Self {
            self.rules
                .push((url_contains.to_string(), status, body.to_string()));
            self
        }

        pub fn requested_urls(&self) -> Vec<String> {
            self.requested.borrow().clone()
        }
    }

    #[async_trait(?Send)]
    impl FxTransport for MockFxTransport {
        async fn get(&self, url: &str) -> CoreResult<FxHttpResponse> {
            self.requested.borrow_mut().push(url.to_string());
            self.rules
                .iter()
                .find(|(frag, _, _)| url.contains(frag.as_str()))
                .map(|(_, status, body)| FxHttpResponse {
                    status: *status,
                    body: body.clone().into_bytes(),
                })
                .ok_or_else(|| CoreError::FxTransport(format!("no scripted route for {url}")))
        }
    }

    /// A realistic OpenRate `rateView` convert body.
    pub fn convert_body(from: &str, to: &str, rate: &str, as_of: &str, grade: &str) -> String {
        format!(
            r#"{{
              "from": "{from}", "to": "{to}", "amount": 1, "result": {rate},
              "rate": {{
                "rate": {rate},
                "hops": 1,
                "as_of": "{as_of}",
                "age_sec": 93600,
                "path": ["{from}", "{to}"],
                "sources": ["ecb", "sarb"],
                "quality": {{ "grade": "{grade}", "confidence": 0.87 }}
              }}
            }}"#
        )
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn base_url_normalizes_or_rejects() {
        assert_eq!(
            normalize_base_url(" https://fx.example.org/ ").unwrap(),
            "https://fx.example.org"
        );
        assert_eq!(
            normalize_base_url("http://127.0.0.1:8080/openrate//").unwrap(),
            "http://127.0.0.1:8080/openrate"
        );
        // A legal uppercase scheme is accepted and normalized to lowercase.
        assert_eq!(
            normalize_base_url("HTTPS://fx.example.org").unwrap(),
            "https://fx.example.org"
        );
        assert!(normalize_base_url("").is_err());
        assert!(normalize_base_url("ftp://fx.example.org").is_err());
        assert!(normalize_base_url("https://").is_err());
        assert!(normalize_base_url("https://a b").is_err());
        // No host at all (path only) is rejected.
        assert!(normalize_base_url("https:///nohost-path-only").is_err());
        // Queries and fragments would corrupt the request URLs built on top.
        assert!(normalize_base_url("https://fx.example.org?query=1").is_err());
        assert!(normalize_base_url("https://fx.example.org#frag").is_err());
    }

    #[test]
    fn base_url_with_embedded_credentials_is_rejected_without_echoing_them() {
        // Regression: user:pass in the URL used to be accepted, landing the
        // password in a PLAIN setting, fx_status output and error strings
        // (mantra #4: credentials never on disk in plaintext).
        let err = normalize_base_url("https://alice:hunter2@fx.example.org").unwrap_err();
        assert!(matches!(err, CoreError::Validation(_)), "{err}");
        let rendered = err.to_string();
        assert!(rendered.contains("credentials"), "{rendered}");
        assert!(
            !rendered.contains("hunter2") && !rendered.contains("alice"),
            "the rejection must not echo the credentials: {rendered}"
        );
    }

    #[tokio::test]
    async fn convert_parses_the_rate_token_exactly() {
        // 18 significant digits — an f64 round-trip would corrupt this.
        let body = convert_body(
            "USD",
            "ZAR",
            "0.052631578947368421",
            "2026-07-17T16:00:00Z",
            "B",
        );
        let transport = MockFxTransport::new().route("/api/v1/convert", 200, &body);
        let client = OpenRateClient::new("https://fx.example.org", &transport).unwrap();
        let quote = client.convert_one("USD", "ZAR").await.unwrap();
        assert_eq!(quote.rate.to_string(), "0.052631578947368421");
        assert_eq!(quote.as_of, "2026-07-17T16:00:00Z");
        assert_eq!(quote.age_sec, Some(93600));
        assert_eq!(quote.grade, "B");
        assert_eq!(quote.sources, vec!["ecb".to_string(), "sarb".to_string()]);
        assert_eq!(
            transport.requested_urls(),
            vec!["https://fx.example.org/api/v1/convert?from=USD&to=ZAR&amount=1".to_string()]
        );
    }

    #[tokio::test]
    async fn convert_accepts_a_string_rate_token() {
        let body = r#"{"rate":{"rate":"18.074219053","as_of":"2026-07-17T16:00:00Z",
                       "age_sec":10,"sources":[],"quality":{"grade":"A"}}}"#;
        let transport = MockFxTransport::new().route("/convert", 200, body);
        let client = OpenRateClient::new("https://fx.example.org", &transport).unwrap();
        let quote = client.convert_one("USD", "ZAR").await.unwrap();
        assert_eq!(quote.rate.to_string(), "18.074219053");
    }

    #[tokio::test]
    async fn quote_serializes_rate_as_a_string() {
        // The IPC/HTTP surface must carry rates as decimal strings, never
        // JSON floats.
        let body = convert_body("EUR", "JPY", "163.25", "2026-07-17T16:00:00Z", "A");
        let transport = MockFxTransport::new().route("/convert", 200, &body);
        let client = OpenRateClient::new("https://fx.example.org", &transport).unwrap();
        let quote = client.convert_one("EUR", "JPY").await.unwrap();
        let json = serde_json::to_value(&quote).unwrap();
        assert_eq!(json["rate"], serde_json::json!("163.25"));
    }

    #[tokio::test]
    async fn unknown_pair_maps_404() {
        let transport =
            MockFxTransport::new().route("/convert", 404, r#"{"error":"unknown pair"}"#);
        let client = OpenRateClient::new("https://fx.example.org", &transport).unwrap();
        let err = client.convert_one("USD", "XXX").await.unwrap_err();
        match err {
            CoreError::FxUnknownPair { from, to } => {
                assert_eq!(from, "USD");
                assert_eq!(to, "XXX");
            }
            other => panic!("expected FxUnknownPair, got {other}"),
        }
    }

    #[tokio::test]
    async fn server_errors_surface_status_without_echoing_the_body() {
        let transport = MockFxTransport::new().route("/convert", 500, "secret internals");
        let client = OpenRateClient::new("https://fx.example.org", &transport).unwrap();
        let err = client.convert_one("USD", "ZAR").await.unwrap_err();
        let rendered = err.to_string();
        assert!(rendered.contains("500"), "{rendered}");
        assert!(!rendered.contains("secret internals"), "{rendered}");
    }

    #[tokio::test]
    async fn bad_as_of_is_a_parse_error() {
        let body = convert_body("USD", "ZAR", "1.5", "yesterday-ish", "A");
        let transport = MockFxTransport::new().route("/convert", 200, &body);
        let client = OpenRateClient::new("https://fx.example.org", &transport).unwrap();
        let err = client.convert_one("USD", "ZAR").await.unwrap_err();
        assert!(matches!(err, CoreError::FxParse(_)), "{err}");
    }

    #[tokio::test]
    async fn far_future_as_of_is_rejected_at_fetch_time() {
        // Regression: a hostile/misconfigured server dating rates in year
        // 9999 would surface as age 0 ("fresh") forever.
        let body = convert_body("USD", "ZAR", "1.5", "9999-01-01T00:00:00Z", "A");
        let transport = MockFxTransport::new().route("/convert", 200, &body);
        let client = OpenRateClient::new("https://fx.example.org", &transport).unwrap();
        let err = client.convert_one("USD", "ZAR").await.unwrap_err();
        assert!(matches!(err, CoreError::FxParse(_)), "{err}");
        assert!(err.to_string().contains("future"), "{err}");
    }

    #[tokio::test]
    async fn missing_age_sec_reports_unknown_not_fresh() {
        let body = r#"{"rate":{"rate":"1.5","as_of":"2026-07-17T16:00:00Z",
                       "sources":[],"quality":{"grade":"A"}}}"#;
        let transport = MockFxTransport::new().route("/convert", 200, body);
        let client = OpenRateClient::new("https://fx.example.org", &transport).unwrap();
        let quote = client.convert_one("USD", "ZAR").await.unwrap();
        assert_eq!(quote.age_sec, None, "omitted staleness must stay unknown");
    }

    #[tokio::test]
    async fn injectable_currency_codes_are_rejected_before_any_request() {
        // Regression: `from="USD&to=EUR"` used to be interpolated verbatim
        // into the query string.
        let transport = MockFxTransport::new();
        let client = OpenRateClient::new("https://fx.example.org", &transport).unwrap();
        for (from, to) in [("USD&to=EUR", "ZAR"), ("usd", "ZAR"), ("USD", "ZARR")] {
            let err = client.convert_one(from, to).await.unwrap_err();
            assert!(matches!(err, CoreError::Validation(_)), "{err}");
        }
        assert!(
            transport.requested_urls().is_empty(),
            "invalid codes must never reach the transport"
        );
    }

    #[tokio::test]
    async fn meta_parses_string_and_object_currencies() {
        let body = r#"{"currencies": ["USD", {"code": "ZAR", "name": "South African Rand"}]}"#;
        let transport = MockFxTransport::new().route("/api/v1/meta", 200, body);
        let client = OpenRateClient::new("https://fx.example.org", &transport).unwrap();
        let currencies = client.meta().await.unwrap();
        assert_eq!(
            currencies,
            vec![
                FxCurrency {
                    code: "USD".into(),
                    name: None
                },
                FxCurrency {
                    code: "ZAR".into(),
                    name: Some("South African Rand".into())
                },
            ]
        );
    }

    #[tokio::test]
    async fn healthz_reports_liveness() {
        let up = MockFxTransport::new().route("/healthz", 200, "ok");
        let client = OpenRateClient::new("https://fx.example.org", &up).unwrap();
        assert!(client.healthz().await.unwrap());

        let down = MockFxTransport::new().route("/healthz", 503, "");
        let client = OpenRateClient::new("https://fx.example.org", &down).unwrap();
        assert!(!client.healthz().await.unwrap());
    }
}
