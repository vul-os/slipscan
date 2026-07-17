//! Local peer-comparison math over benchmark packs (read side only).
//!
//! Reading is perfectly private (docs/BENCHMARKS.md): a benchmark pack is a
//! public file of cohort aggregates, and "you vs households like yours" is
//! computed entirely on this machine from your own spend totals. This module
//! contains no I/O and no network — pure arithmetic over parsed packs.
//! Contribution (the write side) is a separate, opt-in pipeline and is
//! deliberately **not** implemented here.

use std::collections::BTreeMap;

use crate::model::{BenchmarkSet, BenchmarkStat};

/// Where your spend sits relative to the cohort quartiles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuartilePosition {
    /// Below the 25th percentile.
    BelowP25,
    /// Inside the interquartile range (p25..=p75) — typical.
    Typical,
    /// Above the 75th percentile.
    AboveP75,
}

/// One category compared against the cohort. Amounts are minor units in the
/// benchmark set's currency.
#[derive(Debug, Clone, PartialEq)]
pub struct Comparison {
    pub category_key: String,
    pub period: String,
    pub currency: String,
    /// Your spend for the category/period, minor units.
    pub yours_minor: i64,
    pub median_minor: i64,
    pub p25_minor: i64,
    pub p75_minor: i64,
    /// `yours - median` (positive = you spend more than the cohort median).
    pub delta_minor: i64,
    /// `yours / median`, absent when the cohort median is zero.
    pub ratio_to_median: Option<f64>,
    pub position: QuartilePosition,
    /// Contributions behind the stat — always >= the pack's k-floor.
    pub sample_size: u64,
}

/// Compare your per-category spend against a cohort's stats for one period.
///
/// `spend_minor` maps common taxonomy keys (e.g. `"groceries"`) to your own
/// total for the period, minor units. Categories missing on either side are
/// skipped — no imputation. Output follows the pack's stat order.
pub fn compare(
    set: &BenchmarkSet,
    period: &str,
    spend_minor: &BTreeMap<String, i64>,
) -> Vec<Comparison> {
    set.stats
        .iter()
        .filter(|stat| stat.period == period)
        .filter_map(|stat| {
            let yours = *spend_minor.get(&stat.category_key)?;
            Some(compare_one(set, stat, yours))
        })
        .collect()
}

fn compare_one(set: &BenchmarkSet, stat: &BenchmarkStat, yours_minor: i64) -> Comparison {
    let position = if yours_minor < stat.p25_minor {
        QuartilePosition::BelowP25
    } else if yours_minor > stat.p75_minor {
        QuartilePosition::AboveP75
    } else {
        QuartilePosition::Typical
    };
    let ratio_to_median =
        (stat.median_minor != 0).then(|| yours_minor as f64 / stat.median_minor as f64);
    Comparison {
        category_key: stat.category_key.clone(),
        period: stat.period.clone(),
        currency: set.currency.clone(),
        yours_minor,
        median_minor: stat.median_minor,
        p25_minor: stat.p25_minor,
        p75_minor: stat.p75_minor,
        delta_minor: yours_minor - stat.median_minor,
        ratio_to_median,
        position,
        sample_size: stat.sample_size,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::BenchmarkCohort;

    fn set() -> BenchmarkSet {
        BenchmarkSet {
            cohort: BenchmarkCohort {
                region: "ZA".into(),
                household_size: 2,
                income_band: "C".into(),
            },
            currency: "ZAR".into(),
            k_floor: 25,
            stats: vec![
                BenchmarkStat {
                    category_key: "groceries".into(),
                    period: "2026-06".into(),
                    sample_size: 412,
                    p25_minor: 310_000,
                    median_minor: 485_000, // R 4,850.00
                    p75_minor: 702_500,
                    mean_minor: Some(512_300),
                },
                BenchmarkStat {
                    category_key: "transport".into(),
                    period: "2026-06".into(),
                    sample_size: 380,
                    p25_minor: 90_000,
                    median_minor: 160_000,
                    p75_minor: 260_000,
                    mean_minor: None,
                },
                BenchmarkStat {
                    category_key: "gifts-donations".into(),
                    period: "2026-06".into(),
                    sample_size: 55,
                    p25_minor: 0,
                    median_minor: 0,
                    p75_minor: 15_000,
                    mean_minor: None,
                },
                BenchmarkStat {
                    category_key: "groceries".into(),
                    period: "2026-05".into(),
                    sample_size: 398,
                    p25_minor: 300_000,
                    median_minor: 470_000,
                    p75_minor: 690_000,
                    mean_minor: None,
                },
            ],
        }
    }

    fn spend(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn comparison_math_is_exact() {
        let out = compare(
            &set(),
            "2026-06",
            &spend(&[("groceries", 606_250), ("transport", 80_000)]),
        );
        assert_eq!(out.len(), 2);

        let groceries = &out[0];
        assert_eq!(groceries.category_key, "groceries");
        assert_eq!(groceries.delta_minor, 606_250 - 485_000);
        assert_eq!(groceries.ratio_to_median, Some(1.25));
        assert_eq!(groceries.position, QuartilePosition::Typical);
        assert_eq!(groceries.currency, "ZAR");
        assert_eq!(groceries.sample_size, 412);

        let transport = &out[1];
        assert_eq!(transport.position, QuartilePosition::BelowP25);
        assert_eq!(transport.delta_minor, -80_000);
        assert_eq!(transport.ratio_to_median, Some(0.5));
    }

    #[test]
    fn quartile_edges_are_inclusive() {
        let one = |amount| {
            compare(&set(), "2026-06", &spend(&[("groceries", amount)]))
                .pop()
                .unwrap()
                .position
        };
        assert_eq!(one(310_000), QuartilePosition::Typical, "p25 is typical");
        assert_eq!(one(702_500), QuartilePosition::Typical, "p75 is typical");
        assert_eq!(one(309_999), QuartilePosition::BelowP25);
        assert_eq!(one(702_501), QuartilePosition::AboveP75);
    }

    #[test]
    fn zero_median_has_no_ratio() {
        let out = compare(&set(), "2026-06", &spend(&[("gifts-donations", 5_000)]));
        assert_eq!(out[0].ratio_to_median, None);
        assert_eq!(out[0].delta_minor, 5_000);
        assert_eq!(out[0].position, QuartilePosition::Typical);
    }

    #[test]
    fn period_filter_and_missing_categories_skip() {
        // 2026-05 has only groceries; your transport spend has no stat there.
        let out = compare(
            &set(),
            "2026-05",
            &spend(&[("groceries", 470_000), ("eating-out", 90_000)]),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].period, "2026-05");
        assert_eq!(out[0].delta_minor, 0);
        assert_eq!(out[0].ratio_to_median, Some(1.0));

        assert!(compare(&set(), "2027-01", &spend(&[("groceries", 1)])).is_empty());
    }
}
