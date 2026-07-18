//! Region profiles: everything country-specific as **data**, never code.
//!
//! Contract (docs/ARCHITECTURE.md, "Global by default — regions are data,
//! not code"): core logic is region-neutral. A profile carries the
//! chart-of-accounts seeds, the tax rate table, and the tax-report labels —
//! "VAT201" is the South African profile's *label* for the generic
//! tax-period summary, never a concept core knows about. Adding a country
//! means adding a profile here, never branching in core logic.
//!
//! Every profile must keep the well-known chart-of-accounts codes stable
//! (bank `1000`, tax input control `1400`, tax output control `2100`, the
//! personal/business fallback income and expense codes) — automatic journal
//! generation relies on those codes across every seed set.

use serde::{Deserialize, Serialize};

use crate::domain::{CoaKind, TaxBoxLabels};

/// The region used when book creation does not specify one.
pub const DEFAULT_REGION_ID: &str = "generic";

/// The South African profile's id — the first fully-supported region.
pub const ZA_REGION_ID: &str = "za";

/// `(code, name, kind)` chart-of-accounts seed row.
pub type CoaSeed = (&'static str, &'static str, CoaKind);

/// One tax rate in a profile's rate table.
#[derive(Debug, Clone, Copy)]
pub struct TaxRateSeed {
    pub code: &'static str,
    pub label: &'static str,
    /// Basis points (1500 = 15.00%). `None` marks a configurable
    /// placeholder: the actual rate is supplied at book creation and stays
    /// 0 until configured.
    pub rate_bps: Option<i64>,
    /// Supplies at this rate report as exempt rather than zero-rated.
    pub exempt: bool,
}

/// Display metadata for the tax-period summary report, straight from the
/// profile — core never labels tax reports itself.
#[derive(Debug, Clone, Copy)]
pub struct TaxReportMeta {
    /// Report display name — "VAT201" for za, "Tax summary" for generic.
    pub report_name: &'static str,
    pub standard_rated_supplies: &'static str,
    pub zero_rated_supplies: &'static str,
    pub exempt_supplies: &'static str,
    pub output_tax: &'static str,
    pub input_tax: &'static str,
    pub net_tax: &'static str,
}

impl TaxReportMeta {
    /// Owned, serializable box labels for report payloads.
    pub fn box_labels(&self) -> TaxBoxLabels {
        TaxBoxLabels {
            standard_rated_supplies: self.standard_rated_supplies.to_string(),
            zero_rated_supplies: self.zero_rated_supplies.to_string(),
            exempt_supplies: self.exempt_supplies.to_string(),
            output_tax: self.output_tax.to_string(),
            input_tax: self.input_tax.to_string(),
            net_tax: self.net_tax.to_string(),
        }
    }
}

/// A region profile: the selectable data bundle that makes a book
/// country-specific.
#[derive(Debug, Clone, Copy)]
pub struct RegionProfile {
    /// Stable lowercase id stored on books ("za", "generic").
    pub id: &'static str,
    pub display_name: &'static str,
    /// ISO 3166-1 alpha-2 country; `None` for the generic profile.
    pub country: Option<&'static str>,
    /// Book currency used only when creation omits an explicit one. Profile
    /// data, not a core assumption — callers should pass the currency.
    pub default_currency: Option<&'static str>,
    pub personal_coa: &'static [CoaSeed],
    pub business_coa: &'static [CoaSeed],
    pub tax_rates: &'static [TaxRateSeed],
    pub tax_report: TaxReportMeta,
}

impl RegionProfile {
    /// Whether `code` is one of this profile's exempt-supply rate codes.
    pub fn is_exempt_code(&self, code: &str) -> bool {
        self.tax_rates.iter().any(|r| r.exempt && r.code == code)
    }
}

/// Serializable profile summary for pickers (IPC/HTTP surfaces).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegionInfo {
    pub id: String,
    pub display_name: String,
    pub country: Option<String>,
    pub default_currency: Option<String>,
    pub tax_report_name: String,
}

// ---------------------------------------------------------------------------
// Profile data. Only data below this line — no logic branches on a region id.
// ---------------------------------------------------------------------------

/// Minimal personal chart of accounts (neutral names, shared by profiles
/// that need nothing country-specific for personal books).
const GENERIC_PERSONAL_COA: &[CoaSeed] = &[
    ("1000", "Bank", CoaKind::Asset),
    ("1100", "Cash", CoaKind::Asset),
    ("1500", "Other Assets", CoaKind::Asset),
    ("2000", "Credit Card", CoaKind::Liability),
    ("2500", "Other Liabilities", CoaKind::Liability),
    ("3000", "Opening Balances", CoaKind::Equity),
    ("4000", "Salary & Wages", CoaKind::Income),
    ("4100", "Other Income", CoaKind::Income),
    ("6000", "Living Expenses", CoaKind::Expense),
    ("6100", "Bank Fees", CoaKind::Expense),
];

/// Neutral international small-business chart of accounts. Same code scheme
/// as the za business chart so the well-known fallback codes hold.
const GENERIC_BUSINESS_COA: &[CoaSeed] = &[
    ("1000", "Bank", CoaKind::Asset),
    ("1050", "Petty Cash", CoaKind::Asset),
    ("1100", "Accounts Receivable", CoaKind::Asset),
    ("1200", "Inventory", CoaKind::Asset),
    ("1400", "Tax Input Control", CoaKind::Asset),
    ("1500", "Office Equipment", CoaKind::Asset),
    ("1510", "Computer Equipment", CoaKind::Asset),
    ("1600", "Accumulated Depreciation", CoaKind::Asset),
    ("2000", "Accounts Payable", CoaKind::Liability),
    ("2100", "Tax Output Control", CoaKind::Liability),
    ("2150", "Tax Authority Settlement", CoaKind::Liability),
    ("2200", "Payroll Taxes Payable", CoaKind::Liability),
    ("2300", "Loans Payable", CoaKind::Liability),
    ("3000", "Owner's Capital", CoaKind::Equity),
    ("3100", "Owner's Drawings", CoaKind::Equity),
    ("3200", "Retained Earnings", CoaKind::Equity),
    ("4000", "Sales", CoaKind::Income),
    ("4100", "Interest Received", CoaKind::Income),
    ("4200", "Other Income", CoaKind::Income),
    ("5000", "Cost of Sales", CoaKind::Expense),
    ("6000", "Accounting Fees", CoaKind::Expense),
    ("6050", "Advertising & Marketing", CoaKind::Expense),
    ("6100", "Bank Fees", CoaKind::Expense),
    ("6200", "Computer & Internet", CoaKind::Expense),
    ("6250", "Depreciation", CoaKind::Expense),
    ("6300", "Entertainment", CoaKind::Expense),
    ("6350", "Insurance", CoaKind::Expense),
    ("6400", "Motor Vehicle Expenses", CoaKind::Expense),
    ("6450", "Office Supplies & Stationery", CoaKind::Expense),
    ("6500", "Rent", CoaKind::Expense),
    ("6550", "Repairs & Maintenance", CoaKind::Expense),
    ("6600", "Salaries & Wages", CoaKind::Expense),
    ("6650", "Subscriptions", CoaKind::Expense),
    ("6700", "Telephone", CoaKind::Expense),
    ("6750", "Travel", CoaKind::Expense),
    ("6800", "Utilities", CoaKind::Expense),
    ("6900", "General Expenses", CoaKind::Expense),
];

/// South-African small-business chart of accounts, incl. VAT control
/// accounts and the SARS settlement account.
const ZA_BUSINESS_COA: &[CoaSeed] = &[
    ("1000", "Bank", CoaKind::Asset),
    ("1050", "Petty Cash", CoaKind::Asset),
    ("1100", "Accounts Receivable", CoaKind::Asset),
    ("1200", "Inventory", CoaKind::Asset),
    ("1400", "VAT Input Control", CoaKind::Asset),
    ("1500", "Office Equipment", CoaKind::Asset),
    ("1510", "Computer Equipment", CoaKind::Asset),
    ("1600", "Accumulated Depreciation", CoaKind::Asset),
    ("2000", "Accounts Payable", CoaKind::Liability),
    ("2100", "VAT Output Control", CoaKind::Liability),
    ("2150", "VAT Control (SARS settlement)", CoaKind::Liability),
    ("2200", "PAYE & UIF Payable", CoaKind::Liability),
    ("2300", "Loans Payable", CoaKind::Liability),
    ("3000", "Owner's Capital", CoaKind::Equity),
    ("3100", "Owner's Drawings", CoaKind::Equity),
    ("3200", "Retained Earnings", CoaKind::Equity),
    ("4000", "Sales", CoaKind::Income),
    ("4100", "Interest Received", CoaKind::Income),
    ("4200", "Other Income", CoaKind::Income),
    ("5000", "Cost of Sales", CoaKind::Expense),
    ("6000", "Accounting Fees", CoaKind::Expense),
    ("6050", "Advertising & Marketing", CoaKind::Expense),
    ("6100", "Bank Fees", CoaKind::Expense),
    ("6200", "Computer & Internet", CoaKind::Expense),
    ("6250", "Depreciation", CoaKind::Expense),
    ("6300", "Entertainment", CoaKind::Expense),
    ("6350", "Insurance", CoaKind::Expense),
    ("6400", "Motor Vehicle Expenses", CoaKind::Expense),
    ("6450", "Office Supplies & Stationery", CoaKind::Expense),
    ("6500", "Rent", CoaKind::Expense),
    ("6550", "Repairs & Maintenance", CoaKind::Expense),
    ("6600", "Salaries & Wages", CoaKind::Expense),
    ("6650", "Subscriptions", CoaKind::Expense),
    ("6700", "Telephone", CoaKind::Expense),
    ("6750", "Travel", CoaKind::Expense),
    ("6800", "Utilities", CoaKind::Expense),
    ("6900", "General Expenses", CoaKind::Expense),
];

/// ZA VAT rate table.
const ZA_TAX_RATES: &[TaxRateSeed] = &[
    TaxRateSeed {
        code: "STD",
        label: "Standard rate (15%)",
        rate_bps: Some(1500),
        exempt: false,
    },
    TaxRateSeed {
        code: "ZER",
        label: "Zero-rated (0%)",
        rate_bps: Some(0),
        exempt: false,
    },
    TaxRateSeed {
        code: "EXE",
        label: "Exempt",
        rate_bps: Some(0),
        exempt: true,
    },
];

/// Generic single standard rate: a placeholder whose percentage is
/// configured at book creation.
const GENERIC_TAX_RATES: &[TaxRateSeed] = &[TaxRateSeed {
    code: "STD",
    label: "Standard tax rate",
    rate_bps: None,
    exempt: false,
}];

/// All built-in profiles. The generic profile makes SlipScan usable in any
/// country before a dedicated profile exists.
const PROFILES: &[RegionProfile] = &[
    RegionProfile {
        id: DEFAULT_REGION_ID,
        display_name: "Generic (international)",
        country: None,
        default_currency: Some("USD"),
        personal_coa: GENERIC_PERSONAL_COA,
        business_coa: GENERIC_BUSINESS_COA,
        tax_rates: GENERIC_TAX_RATES,
        tax_report: TaxReportMeta {
            report_name: "Tax summary",
            standard_rated_supplies: "Standard-rated sales",
            zero_rated_supplies: "Zero-rated sales",
            exempt_supplies: "Exempt sales",
            output_tax: "Output tax",
            input_tax: "Input tax",
            net_tax: "Net tax payable (refundable if negative)",
        },
    },
    RegionProfile {
        id: ZA_REGION_ID,
        display_name: "South Africa",
        country: Some("ZA"),
        default_currency: Some("ZAR"),
        // The personal chart needs nothing SA-specific; the business chart
        // carries the VAT control and SARS settlement accounts.
        personal_coa: GENERIC_PERSONAL_COA,
        business_coa: ZA_BUSINESS_COA,
        tax_rates: ZA_TAX_RATES,
        tax_report: TaxReportMeta {
            report_name: "VAT201",
            standard_rated_supplies: "Standard-rated supplies",
            zero_rated_supplies: "Zero-rated supplies",
            exempt_supplies: "Exempt supplies",
            output_tax: "Output VAT",
            input_tax: "Input VAT",
            net_tax: "Net VAT payable (refundable if negative)",
        },
    },
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/// All built-in region profiles.
pub fn profiles() -> &'static [RegionProfile] {
    PROFILES
}

/// Profile by id (case-insensitive).
pub fn profile(id: &str) -> Option<&'static RegionProfile> {
    PROFILES.iter().find(|p| p.id.eq_ignore_ascii_case(id))
}

/// Profile by id, falling back to the generic profile for unknown ids —
/// a book stored with a region this build does not know keeps working.
pub fn profile_or_generic(id: &str) -> &'static RegionProfile {
    profile(id)
        .unwrap_or_else(|| profile(DEFAULT_REGION_ID).expect("generic profile is always present"))
}

/// Profile whose target country matches (case-insensitive) — used to map
/// legacy `country`-only book creation onto a region.
pub fn for_country(country: Option<&str>) -> Option<&'static RegionProfile> {
    let country = country?;
    PROFILES
        .iter()
        .find(|p| p.country.is_some_and(|c| c.eq_ignore_ascii_case(country)))
}

/// Serializable summaries of every profile, for region pickers.
pub fn region_infos() -> Vec<RegionInfo> {
    PROFILES
        .iter()
        .map(|p| RegionInfo {
            id: p.id.to_string(),
            display_name: p.display_name.to_string(),
            country: p.country.map(str::to_string),
            default_currency: p.default_currency.map(str::to_string),
            tax_report_name: p.tax_report.report_name.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_selection_by_id_and_country() {
        assert_eq!(profile("za").unwrap().display_name, "South Africa");
        assert_eq!(profile("ZA").unwrap().id, "za");
        assert_eq!(profile("generic").unwrap().country, None);
        assert!(profile("atlantis").is_none());
        assert_eq!(profile_or_generic("atlantis").id, "generic");
        assert_eq!(for_country(Some("ZA")).unwrap().id, "za");
        assert_eq!(for_country(Some("za")).unwrap().id, "za");
        assert!(for_country(Some("FR")).is_none());
        assert!(for_country(None).is_none());
    }

    #[test]
    fn za_profile_labels_and_rates() {
        let za = profile("za").unwrap();
        assert_eq!(za.tax_report.report_name, "VAT201");
        assert_eq!(za.tax_report.output_tax, "Output VAT");
        assert_eq!(za.default_currency, Some("ZAR"));
        let std = za.tax_rates.iter().find(|r| r.code == "STD").unwrap();
        assert_eq!(std.rate_bps, Some(1500));
        assert!(za.is_exempt_code("EXE"));
        assert!(!za.is_exempt_code("ZER"));
        // SA business chart keeps the VAT control accounts.
        assert!(za
            .business_coa
            .iter()
            .any(|&(code, name, _)| code == "1400" && name.contains("VAT")));
    }

    #[test]
    fn generic_profile_is_neutral() {
        let generic = profile("generic").unwrap();
        assert_eq!(generic.tax_report.report_name, "Tax summary");
        // Single configurable standard rate placeholder.
        assert_eq!(generic.tax_rates.len(), 1);
        assert_eq!(generic.tax_rates[0].rate_bps, None);
        // No jurisdiction-specific account names anywhere.
        for &(_, name, _) in generic
            .personal_coa
            .iter()
            .chain(generic.business_coa.iter())
        {
            for term in ["VAT", "SARS", "PAYE", "UIF"] {
                assert!(!name.contains(term), "{name:?} leaks {term}");
            }
        }
    }

    #[test]
    fn every_profile_keeps_the_wellknown_codes() {
        for p in profiles() {
            for coa in [p.personal_coa, p.business_coa] {
                assert!(
                    coa.iter().any(|&(code, _, _)| code == "1000"),
                    "{} missing bank code 1000",
                    p.id
                );
            }
            for code in ["1400", "2100", "6900", "4200"] {
                assert!(
                    p.business_coa.iter().any(|&(c, _, _)| c == code),
                    "{} business chart missing well-known code {code}",
                    p.id
                );
            }
            for code in ["6000", "4100"] {
                assert!(
                    p.personal_coa.iter().any(|&(c, _, _)| c == code),
                    "{} personal chart missing well-known code {code}",
                    p.id
                );
            }
        }
    }
}
