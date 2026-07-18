//! Statement-preset catalog: region-profile **data, not code**
//! (docs/ARCHITECTURE.md "Global by default — regions are data, not code").
//!
//! Every preset carries its region, a bank/layout display name, and the
//! [`CsvMapping`] that parses the export. Preset ids are namespaced by
//! region (`za-fnb`, `generic-mdy`). Surfaces list the catalog **grouped by
//! region** via [`statement_presets_by_region`]; nothing here is
//! jurisdiction-specific logic — adding a country's banks means adding rows
//! to this catalog (and eventually shipping them inside that country's
//! region profile), never touching core.
//!
//! Three tiers of coverage:
//! 1. **Region presets** — today the five SA banks, byte-for-byte the same
//!    mappings as [`SaBankPreset`] (the typed handle stays supported).
//! 2. **The `generic` family** — common single-format layouts
//!    (date/description/amount signed, date/description/debit/credit) in the
//!    widespread date + decimal conventions (ISO, DMY, US MDY, EU
//!    dotted-DMY with decimal comma and `;` delimiter).
//! 3. **Custom** — [`super::csv_statement::CustomMappingSpec`] for any
//!    other bank in the world, day one.

use super::csv_statement::{
    AmountMapping, CsvMapping, CsvStatementAdapter, DateFormat, SaBankPreset,
};
use super::DecimalStyle;
use crate::IngestResult;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Region code and display label of the generic (worldwide) preset family.
pub const GENERIC_REGION: &str = "generic";
const GENERIC_REGION_NAME: &str = "Generic (any bank)";

/// One catalog entry: a named, region-tagged CSV column mapping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementPreset {
    /// Stable preset id, namespaced by region: `za-fnb`, `generic-mdy`.
    pub id: String,
    /// Region code (`za`, …) or [`GENERIC_REGION`].
    pub region: String,
    /// Human region label ("South Africa").
    pub region_name: String,
    /// Bank or layout display name ("FNB"; "Date, description, amount —
    /// MM/DD/YYYY, 1,234.56").
    pub bank_name: String,
    pub mapping: CsvMapping,
}

impl StatementPreset {
    /// Adapter over a statement file with this preset's mapping; the
    /// preset id doubles as the adapter's bank id.
    pub fn adapter_for_path(&self, path: &Path) -> IngestResult<CsvStatementAdapter> {
        CsvStatementAdapter::from_path(self.id.clone(), self.mapping.clone(), path)
    }

    /// Adapter over already-loaded statement bytes.
    pub fn adapter_for_content(&self, content: Vec<u8>) -> CsvStatementAdapter {
        CsvStatementAdapter::new(self.id.clone(), self.mapping.clone(), content)
    }
}

/// Presets of one region, in catalog order — the shape surfaces display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegionPresetGroup {
    pub region: String,
    pub region_name: String,
    pub presets: Vec<StatementPreset>,
}

/// The full preset catalog, in display order: concrete regions first (SA is
/// the first region profile), the `generic` family last.
pub fn statement_presets() -> Vec<StatementPreset> {
    let mut presets: Vec<StatementPreset> = SaBankPreset::ALL
        .iter()
        .map(|bank| StatementPreset {
            id: bank.bank_id().to_string(),
            region: "za".to_string(),
            region_name: "South Africa".to_string(),
            bank_name: bank.display_name().to_string(),
            mapping: bank.mapping(),
        })
        .collect();
    presets.extend(generic_presets());
    presets
}

/// Look a preset up by its namespaced id (`za-fnb`, `generic-eu`).
pub fn statement_preset(id: &str) -> Option<StatementPreset> {
    statement_presets().into_iter().find(|p| p.id == id)
}

/// The catalog grouped by region, preserving catalog order (regions in
/// order of first appearance; `generic` last). This is the preset listing
/// API for CLI/server/desktop surfaces.
pub fn statement_presets_by_region() -> Vec<RegionPresetGroup> {
    let mut groups: Vec<RegionPresetGroup> = Vec::new();
    for preset in statement_presets() {
        match groups.iter_mut().find(|g| g.region == preset.region) {
            Some(group) => group.presets.push(preset),
            None => groups.push(RegionPresetGroup {
                region: preset.region.clone(),
                region_name: preset.region_name.clone(),
                presets: vec![preset],
            }),
        }
    }
    groups
}

/// The `generic` family: common single-format layouts for banks without a
/// dedicated preset. Signed-amount and debit/credit variants of the
/// widespread date + decimal conventions.
fn generic_presets() -> Vec<StatementPreset> {
    // (id suffix, date label, date format, decimal style, delimiter)
    let conventions: [(&str, &str, DateFormat, DecimalStyle, u8); 4] = [
        (
            "iso",
            "YYYY-MM-DD",
            DateFormat::IsoYmd,
            DecimalStyle::Point,
            b',',
        ),
        (
            "dmy",
            "DD/MM/YYYY",
            DateFormat::SlashDmy,
            DecimalStyle::Point,
            b',',
        ),
        (
            "mdy",
            "MM/DD/YYYY",
            DateFormat::SlashMdy,
            DecimalStyle::Point,
            b',',
        ),
        (
            "eu",
            "DD.MM.YYYY",
            DateFormat::DotDmy,
            DecimalStyle::Comma,
            b';',
        ),
    ];
    let mut presets = Vec::with_capacity(conventions.len() * 2);
    for (suffix, date_label, date_format, decimal, delimiter) in conventions {
        let decimal_label = match decimal {
            DecimalStyle::Comma => "1.234,56",
            _ => "1,234.56",
        };
        let base = CsvMapping {
            delimiter,
            skip_rows: 0,
            has_header: true,
            date_col: 0,
            date_format,
            description_col: 1,
            amount: AmountMapping::Signed { col: 2 },
            balance_col: None,
            reference_col: None,
            currency: None,
            decimal,
        };
        presets.push(StatementPreset {
            id: format!("generic-{suffix}"),
            region: GENERIC_REGION.to_string(),
            region_name: GENERIC_REGION_NAME.to_string(),
            bank_name: format!("Date, description, amount — {date_label}, {decimal_label}"),
            mapping: base.clone(),
        });
        presets.push(StatementPreset {
            id: format!("generic-{suffix}-debit-credit"),
            region: GENERIC_REGION.to_string(),
            region_name: GENERIC_REGION_NAME.to_string(),
            bank_name: format!("Date, description, debit, credit — {date_label}, {decimal_label}"),
            mapping: CsvMapping {
                amount: AmountMapping::DebitCredit {
                    debit_col: 2,
                    credit_col: 3,
                },
                ..base
            },
        });
    }
    presets
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bank::StatementLine;

    fn parse_with(preset_id: &str, csv: &str) -> Vec<StatementLine> {
        statement_preset(preset_id)
            .unwrap_or_else(|| panic!("preset {preset_id} missing"))
            .adapter_for_content(csv.as_bytes().to_vec())
            .parse_all()
            .unwrap()
    }

    #[test]
    fn sa_presets_are_byte_for_byte_the_legacy_enum_mappings() {
        // Regression: restructuring presets into region data must not move
        // a single column for the SA five.
        for bank in SaBankPreset::ALL {
            let preset = statement_preset(bank.bank_id())
                .unwrap_or_else(|| panic!("{} missing from catalog", bank.bank_id()));
            assert_eq!(preset.mapping, bank.mapping(), "{}", bank.bank_id());
            assert_eq!(preset.region, "za");
            assert_eq!(preset.bank_name, bank.display_name());
        }
    }

    #[test]
    fn preset_ids_are_region_namespaced_and_unique() {
        let presets = statement_presets();
        for preset in &presets {
            assert!(
                preset.id.starts_with(&format!("{}-", preset.region)),
                "{} not namespaced under {}",
                preset.id,
                preset.region
            );
        }
        let mut ids: Vec<_> = presets.iter().map(|p| p.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), presets.len(), "duplicate preset ids");
    }

    #[test]
    fn listing_groups_by_region_with_generic_last() {
        let groups = statement_presets_by_region();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].region, "za");
        assert_eq!(groups[0].region_name, "South Africa");
        assert_eq!(groups[0].presets.len(), 5);
        assert_eq!(groups[1].region, GENERIC_REGION);
        assert_eq!(groups[1].presets.len(), 8);
        // Every catalog preset appears in exactly one group.
        let grouped: usize = groups.iter().map(|g| g.presets.len()).sum();
        assert_eq!(grouped, statement_presets().len());
    }

    #[test]
    fn generic_mdy_parses_a_us_style_statement() {
        let csv = "\
Date,Description,Amount
06/15/2026,ACME PAYROLL,\"2,345.67\"
06/16/2026,COFFEE HOUSE,-4.50
";
        let lines = parse_with("generic-mdy", csv);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].posted_date, "2026-06-15", "month-first date");
        assert_eq!(lines[0].amount_minor, 234_567);
        assert_eq!(lines[1].amount_minor, -450);
    }

    #[test]
    fn generic_eu_parses_semicolons_dotted_dates_and_decimal_comma() {
        let csv = "\
Datum;Beschreibung;Betrag
15.06.2026;MIETE JUNI;-1.234,56
16.06.2026;GEHALT;2.500,00
";
        let lines = parse_with("generic-eu", csv);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].posted_date, "2026-06-15");
        assert_eq!(lines[0].amount_minor, -123_456, "1.234,56 is 1234.56");
        assert_eq!(lines[1].amount_minor, 250_000, "2.500,00 is 2500.00");
    }

    #[test]
    fn generic_dmy_debit_credit_parses_a_uk_style_statement() {
        let csv = "\
Date,Description,Debit,Credit
15/06/2026,TESCO STORES,45.60,
16/06/2026,SALARY,,\"2,100.00\"
";
        let lines = parse_with("generic-dmy-debit-credit", csv);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].posted_date, "2026-06-15", "day-first date");
        assert_eq!(lines[0].amount_minor, -4560, "debit is money out");
        assert_eq!(lines[1].amount_minor, 210_000, "credit is money in");
    }

    #[test]
    fn generic_iso_signed_and_debit_credit_share_the_convention() {
        let signed = parse_with(
            "generic-iso",
            "Date,Description,Amount\n2026-06-01,SHOP,-10.00\n",
        );
        assert_eq!(signed[0].amount_minor, -1000);
        let dc = parse_with(
            "generic-iso-debit-credit",
            "Date,Description,Debit,Credit\n2026-06-01,SHOP,10.00,\n",
        );
        assert_eq!(dc[0].amount_minor, -1000);
    }

    #[test]
    fn lookup_misses_return_none() {
        assert!(statement_preset("zz-nowhere").is_none());
    }
}
