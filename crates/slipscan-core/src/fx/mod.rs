//! Exchange rates via OpenRate — opt-in, cached, decimal-only.
//!
//! Contract (docs/ARCHITECTURE.md "Exchange rates — OpenRate"):
//! * **Opt-in.** FX has exactly one configuration knob, the OpenRate base
//!   URL ([`FX_BASE_URL_KEY`], a plain setting — an endpoint, not a secret).
//!   While it is unset every fetch path fails with
//!   [`crate::error::CoreError::FxNotConfigured`]
//!   *before* touching any transport — zero FX network calls, ever.
//! * **Decimal-only money.** Rates are [`rust_decimal::Decimal`], parsed
//!   from the raw JSON token (never `f64`); conversion is integer `i128`
//!   math with banker's rounding ([`convert_minor`]).
//! * **Cache, never silently refresh.** Fetches persist to the `fx_rates`
//!   table; conversions serve from cache and surface staleness (`as_of`,
//!   `fetched_at`, computed `age_secs`) instead of re-fetching.
//! * **Provenance recorded.** Every conversion records the exact rate it
//!   used (returned payload + audit log), so reports reproduce offline.
//!
//! The service surface is on [`CoreService`](crate::service::CoreService):
//! `fx_configure`, `fx_status`, `fx_fetch_rate`, `fx_convert`.

pub mod cache;
pub mod client;
mod money;

use rust_decimal::Decimal;
use serde::Serialize;
use std::str::FromStr;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::error::{CoreError, CoreResult};

pub use client::{
    normalize_base_url, FxCurrency, FxHttpResponse, FxQuote, FxTransport, OpenRateClient,
};
pub use money::convert_minor;

/// Settings key holding the OpenRate base URL (plain setting — a URL is an
/// endpoint the user chose, not a secret). Empty/absent means FX is off.
pub const FX_BASE_URL_KEY: &str = "fx.openrate_base_url";

/// A cached rate as served to callers, with staleness made explicit.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FxCachedRate {
    pub from_currency: String,
    pub to_currency: String,
    /// Exact decimal rate (serializes as a string, never a JSON float).
    pub rate: Decimal,
    /// RFC 3339 instant the rate is dated at (from OpenRate).
    pub as_of: String,
    /// OpenRate quality grade at fetch time.
    pub grade: String,
    /// When this SlipScan fetched the rate.
    pub fetched_at: String,
    /// Seconds elapsed since `as_of`, computed at read time — a stale
    /// weekend rate says so. `None` only if the stored timestamp is invalid.
    pub age_secs: Option<i64>,
}

/// FX configuration + cache overview (`fx_status`). Purely local — reading
/// status never performs network I/O.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FxStatus {
    pub configured: bool,
    pub base_url: Option<String>,
    pub cached_rates: Vec<FxCachedRate>,
}

/// One performed conversion, carrying the exact rate it used and its
/// provenance (`fx_convert`). Also recorded in the audit log.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FxConversion {
    pub from_currency: String,
    pub to_currency: String,
    pub amount_minor: i64,
    pub converted_minor: i64,
    /// Exact decimal rate used (serializes as a string).
    pub rate: Decimal,
    pub as_of: String,
    pub grade: String,
    pub fetched_at: String,
    pub age_secs: Option<i64>,
}

/// Whole seconds elapsed from RFC 3339 `as_of` to `now`, clamped at zero
/// (clock skew must not report negative staleness). `None` if unparsable.
pub(crate) fn age_secs_since(as_of: &str, now: OffsetDateTime) -> Option<i64> {
    let parsed = OffsetDateTime::parse(as_of, &Rfc3339).ok()?;
    Some((now - parsed).whole_seconds().max(0))
}

/// Materialize a stored cache row for callers: exact decimal rate plus
/// computed staleness. A corrupt stored rate is a hard parse error, never a
/// silent zero.
pub(crate) fn cached_rate_from_row(
    row: cache::FxRateRow,
    now: OffsetDateTime,
) -> CoreResult<FxCachedRate> {
    let rate = Decimal::from_str(&row.rate).map_err(|e| {
        CoreError::FxParse(format!(
            "cached rate {:?} for {}/{}: {e}",
            row.rate, row.from_currency, row.to_currency
        ))
    })?;
    let age_secs = age_secs_since(&row.as_of, now);
    Ok(FxCachedRate {
        from_currency: row.from_currency,
        to_currency: row.to_currency,
        rate,
        as_of: row.as_of,
        grade: row.grade,
        fetched_at: row.fetched_at,
        age_secs,
    })
}

#[cfg(test)]
mod tests {
    use super::client::testutil::{convert_body, MockFxTransport};
    use super::*;
    use crate::db::Db;
    use crate::error::CoreError;
    use crate::secrets::MemorySecretStore;
    use crate::service::CoreService;
    use time::macros::datetime;

    fn svc() -> CoreService {
        CoreService::new(
            Db::open_in_memory().expect("in-memory db"),
            Box::new(MemorySecretStore::new()),
        )
    }

    #[test]
    fn age_secs_computes_and_clamps() {
        let now = datetime!(2026-07-18 12:00:00 UTC);
        assert_eq!(age_secs_since("2026-07-18T11:59:00Z", now), Some(60));
        assert_eq!(age_secs_since("2026-07-18T13:00:00Z", now), Some(0));
        assert_eq!(age_secs_since("not-a-time", now), None);
    }

    #[test]
    fn unconfigured_service_reports_off() {
        let svc = svc();
        let status = svc.fx_status().unwrap();
        assert!(!status.configured);
        assert_eq!(status.base_url, None);
        assert!(status.cached_rates.is_empty());
        // Conversion is cache-only, so unconfigured it is simply a cache
        // miss — never a network call.
        let err = svc.fx_convert("USD", "ZAR", 100).unwrap_err();
        assert!(matches!(err, CoreError::NotFound { .. }), "{err}");
    }

    #[tokio::test]
    async fn no_config_means_no_network_call_ever() {
        let svc = svc();
        let transport = MockFxTransport::new(); // no routes: any call would error loudly
        let err = svc
            .fx_fetch_rate(&transport, "USD", "ZAR")
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::FxNotConfigured), "{err}");
        assert!(
            transport.requested_urls().is_empty(),
            "transport must never be touched while unconfigured"
        );
        // Same for an explicitly cleared configuration.
        svc.fx_configure("https://fx.example.org").unwrap();
        svc.fx_configure("").unwrap();
        let err = svc
            .fx_fetch_rate(&transport, "USD", "ZAR")
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::FxNotConfigured), "{err}");
        assert!(transport.requested_urls().is_empty());
    }

    #[test]
    fn configure_validates_normalizes_and_clears() {
        let svc = svc();
        svc.fx_configure(" https://fx.example.org/ ").unwrap();
        let status = svc.fx_status().unwrap();
        assert!(status.configured);
        assert_eq!(status.base_url.as_deref(), Some("https://fx.example.org"));
        // The base URL is a plain setting — readable, not vaulted.
        assert_eq!(
            svc.settings_get(FX_BASE_URL_KEY).unwrap().as_deref(),
            Some("https://fx.example.org")
        );
        assert!(svc.fx_configure("not a url").is_err());
        // Empty clears the configuration (FX off again).
        svc.fx_configure("").unwrap();
        assert!(!svc.fx_status().unwrap().configured);
    }

    #[tokio::test]
    async fn fetch_persists_and_convert_serves_from_cache_offline() {
        let svc = svc();
        svc.fx_configure("https://fx.example.org").unwrap();
        let body = convert_body("USD", "ZAR", "18.074219053", "2026-07-17T16:00:00Z", "B");
        let transport = MockFxTransport::new().route("/api/v1/convert", 200, &body);
        let quote = svc.fx_fetch_rate(&transport, "usd", "zar").await.unwrap();
        assert_eq!(quote.from_currency, "USD");
        assert_eq!(quote.rate.to_string(), "18.074219053");
        assert_eq!(quote.grade, "B");
        assert_eq!(transport.requested_urls().len(), 1);

        // Conversion is cache-only: no further transport involvement, and
        // staleness/provenance ride along.
        let conversion = svc.fx_convert("USD", "ZAR", 10_000).unwrap();
        assert_eq!(conversion.converted_minor, 180_742); // 10000 × 18.074219053 = 180742.19053
        assert_eq!(conversion.rate.to_string(), "18.074219053");
        assert_eq!(conversion.as_of, "2026-07-17T16:00:00Z");
        assert_eq!(conversion.grade, "B");
        assert!(conversion.age_secs.is_some(), "staleness must be surfaced");
        assert_eq!(transport.requested_urls().len(), 1, "convert never fetches");

        // Status lists the cached pair.
        let status = svc.fx_status().unwrap();
        assert_eq!(status.cached_rates.len(), 1);
        assert_eq!(status.cached_rates[0].rate.to_string(), "18.074219053");

        // The conversion recorded the rate it used in the audit log.
        let audits = svc.audit_list(None, 50).unwrap();
        let entry = audits
            .iter()
            .find(|a| a.entity_type == "fx_conversion")
            .expect("conversion audit entry");
        let after: serde_json::Value =
            serde_json::from_str(entry.after_json.as_deref().unwrap()).unwrap();
        assert_eq!(after["rate"], serde_json::json!("18.074219053"));
        assert_eq!(after["converted_minor"], serde_json::json!(180_742));
    }

    #[tokio::test]
    async fn high_precision_rate_converts_large_amounts_exactly() {
        let svc = svc();
        svc.fx_configure("https://fx.example.org").unwrap();
        let body = convert_body("IDR", "USD", "0.052631578947", "2026-07-17T16:00:00Z", "A");
        let transport = MockFxTransport::new().route("/convert", 200, &body);
        svc.fx_fetch_rate(&transport, "IDR", "USD").await.unwrap();
        let conversion = svc.fx_convert("IDR", "USD", 1_000_000_000_000_000).unwrap();
        assert_eq!(conversion.converted_minor, 52_631_578_947_000);
    }

    #[tokio::test]
    async fn refetch_replaces_the_cached_pair() {
        let svc = svc();
        svc.fx_configure("https://fx.example.org").unwrap();
        let first = convert_body("USD", "ZAR", "18.0", "2026-07-17T16:00:00Z", "A");
        let transport = MockFxTransport::new().route("/convert", 200, &first);
        svc.fx_fetch_rate(&transport, "USD", "ZAR").await.unwrap();

        let second = convert_body("USD", "ZAR", "18.5", "2026-07-18T07:00:00Z", "A");
        let transport = MockFxTransport::new().route("/convert", 200, &second);
        svc.fx_fetch_rate(&transport, "USD", "ZAR").await.unwrap();

        let status = svc.fx_status().unwrap();
        assert_eq!(status.cached_rates.len(), 1, "latest-only cache");
        assert_eq!(status.cached_rates[0].rate.to_string(), "18.5");
        assert_eq!(status.cached_rates[0].as_of, "2026-07-18T07:00:00Z");
    }

    #[tokio::test]
    async fn unknown_pair_404_surfaces_and_caches_nothing() {
        let svc = svc();
        svc.fx_configure("https://fx.example.org").unwrap();
        let transport = MockFxTransport::new().route("/convert", 404, r#"{"error":"nope"}"#);
        let err = svc
            .fx_fetch_rate(&transport, "USD", "XXX")
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::FxUnknownPair { .. }), "{err}");
        assert!(svc.fx_status().unwrap().cached_rates.is_empty());
    }

    #[test]
    fn convert_without_a_cached_rate_is_not_found_not_a_fetch() {
        let svc = svc();
        svc.fx_configure("https://fx.example.org").unwrap();
        let err = svc.fx_convert("USD", "ZAR", 100).unwrap_err();
        assert!(matches!(err, CoreError::NotFound { .. }), "{err}");
    }

    #[test]
    fn same_currency_converts_identically_offline() {
        // Identity conversion needs neither configuration nor cache.
        let svc = svc();
        let conversion = svc.fx_convert("ZAR", "zar", -12_345).unwrap();
        assert_eq!(conversion.converted_minor, -12_345);
        assert_eq!(conversion.rate, Decimal::ONE);
    }

    #[test]
    fn currency_codes_are_validated() {
        let svc = svc();
        assert!(svc.fx_convert("US", "ZAR", 100).is_err());
        assert!(svc.fx_convert("USD", "ZARR", 100).is_err());
    }
}
