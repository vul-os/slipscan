//! CSV-statement adapter: the first concrete [`BankAdapter`].
//!
//! Every SA bank can export account history as CSV even when it has no API.
//! This adapter parses a downloaded statement file through a configurable
//! [`CsvMapping`] (column positions, date format, signed vs debit/credit
//! amount columns) and yields normalised [`StatementLine`]s. Presets for the
//! big SA banks live in [`SaBankPreset`]; they are defaults, not gospel —
//! banks tweak their exports, and every field of the mapping is
//! user-adjustable in settings.
//!
//! Purely local: reads a file, talks to nothing.

use super::{parse_amount_minor, BankAdapter, DateRange, StatementLine};
use crate::{IngestError, IngestResult};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// How dates are written in the statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DateFormat {
    /// `2026-06-01`
    IsoYmd,
    /// `2026/06/01`
    SlashYmd,
    /// `01/06/2026`
    SlashDmy,
    /// `01-06-2026`
    DashDmy,
    /// `20260601`
    CompactYmd,
    /// `01 Jun 2026` / `1 June 2026`
    DayMonthNameYear,
}

/// Where the amount lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AmountMapping {
    /// One signed column: negative = money out.
    Signed { col: usize },
    /// Separate columns; debits become negative, credits positive.
    DebitCredit { debit_col: usize, credit_col: usize },
}

/// Column mapping for one bank's CSV export. Serializable — stored in
/// settings, shown in the UI for adjustment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CsvMapping {
    /// Field delimiter, usually `,` (`;` for some locales).
    pub delimiter: u8,
    /// Junk lines before the table (account-info preambles).
    pub skip_rows: usize,
    /// Whether the first table row is a header.
    pub has_header: bool,
    pub date_col: usize,
    pub date_format: DateFormat,
    pub description_col: usize,
    pub amount: AmountMapping,
    pub balance_col: Option<usize>,
    /// Column carrying the bank's own transaction reference, when present —
    /// becomes `provider_txn_id`, the dedupe anchor.
    pub reference_col: Option<usize>,
    /// ISO-4217 override; `None` = account currency.
    pub currency: Option<String>,
}

/// Column-mapping presets for the SA banks' CSV exports
/// (docs/BANK-ADAPTERS.md adapter roadmap).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SaBankPreset {
    Fnb,
    StandardBank,
    Capitec,
    Nedbank,
    Absa,
}

impl SaBankPreset {
    /// Stable bank id, matching the adapter roadmap table.
    pub fn bank_id(&self) -> &'static str {
        match self {
            Self::Fnb => "za-fnb",
            Self::StandardBank => "za-standard",
            Self::Capitec => "za-capitec",
            Self::Nedbank => "za-nedbank",
            Self::Absa => "za-absa",
        }
    }

    /// Default mapping for this bank's CSV export.
    pub fn mapping(&self) -> CsvMapping {
        let base = CsvMapping {
            delimiter: b',',
            skip_rows: 0,
            has_header: true,
            date_col: 0,
            date_format: DateFormat::IsoYmd,
            description_col: 1,
            amount: AmountMapping::Signed { col: 2 },
            balance_col: Some(3),
            reference_col: None,
            currency: None,
        };
        match self {
            // FNB: Date, Amount, Balance, Description — dates 2026/06/01.
            Self::Fnb => CsvMapping {
                date_format: DateFormat::SlashYmd,
                description_col: 3,
                amount: AmountMapping::Signed { col: 1 },
                balance_col: Some(2),
                ..base
            },
            // Standard Bank: Date, Description, Amount, Balance — ISO dates.
            Self::StandardBank => base,
            // Capitec: Date, Description, Money In, Money Out, Balance —
            // dates 01/06/2026.
            Self::Capitec => CsvMapping {
                date_format: DateFormat::SlashDmy,
                amount: AmountMapping::DebitCredit {
                    credit_col: 2,
                    debit_col: 3,
                },
                balance_col: Some(4),
                ..base
            },
            // Nedbank: Date, Description, Amount, Balance — "01 Jun 2026".
            Self::Nedbank => CsvMapping {
                date_format: DateFormat::DayMonthNameYear,
                ..base
            },
            // Absa: Date, Description, Amount, Balance — compact 20260601.
            Self::Absa => CsvMapping {
                date_format: DateFormat::CompactYmd,
                ..base
            },
        }
    }

    /// Adapter over a statement file with this preset's default mapping.
    pub fn adapter_for_path(&self, path: &Path) -> IngestResult<CsvStatementAdapter> {
        CsvStatementAdapter::from_path(self.bank_id(), self.mapping(), path)
    }
}

/// [`BankAdapter`] over one CSV statement export.
pub struct CsvStatementAdapter {
    bank_id: String,
    mapping: CsvMapping,
    content: Vec<u8>,
}

impl CsvStatementAdapter {
    pub fn new(bank_id: impl Into<String>, mapping: CsvMapping, content: Vec<u8>) -> Self {
        Self {
            bank_id: bank_id.into(),
            mapping,
            content,
        }
    }

    pub fn from_path(
        bank_id: impl Into<String>,
        mapping: CsvMapping,
        path: &Path,
    ) -> IngestResult<Self> {
        Ok(Self::new(bank_id, mapping, std::fs::read(path)?))
    }

    /// Parse every line in the statement (no range filter).
    pub fn parse_all(&self) -> IngestResult<Vec<StatementLine>> {
        let text = String::from_utf8_lossy(&self.content);
        // Strip preamble lines before handing the table to the CSV parser.
        let table: String = text
            .lines()
            .skip(self.mapping.skip_rows)
            .collect::<Vec<_>>()
            .join("\n");
        let mut reader = csv::ReaderBuilder::new()
            .delimiter(self.mapping.delimiter)
            .has_headers(self.mapping.has_header)
            .flexible(true)
            .trim(csv::Trim::All)
            .from_reader(table.as_bytes());

        let mut lines = Vec::new();
        for record in reader.records() {
            let record = record.map_err(|e| IngestError::Parse(format!("csv: {e}")))?;
            let field = |col: usize| record.get(col).unwrap_or("").trim();

            // A row whose date column doesn't parse is preamble/footer junk
            // (opening-balance rows, totals) — skip it, don't fail the file.
            let Ok(posted_date) =
                parse_statement_date(field(self.mapping.date_col), self.mapping.date_format)
            else {
                continue;
            };

            let amount_minor = match self.mapping.amount {
                AmountMapping::Signed { col } => {
                    let raw = field(col);
                    if raw.is_empty() {
                        continue; // dated but amount-less: opening-balance rows
                    }
                    parse_amount_minor(raw)?
                }
                AmountMapping::DebitCredit {
                    debit_col,
                    credit_col,
                } => {
                    let debit = field(debit_col);
                    let credit = field(credit_col);
                    match (debit.is_empty(), credit.is_empty()) {
                        (true, true) => continue, // e.g. balance-only rows
                        (false, true) => -parse_amount_minor(debit)?.abs(),
                        (true, false) => parse_amount_minor(credit)?.abs(),
                        (false, false) => {
                            // Some exports fill the unused column with 0.
                            let d = parse_amount_minor(debit)?;
                            let c = parse_amount_minor(credit)?;
                            match (d == 0, c == 0) {
                                (true, false) => c.abs(),
                                (false, true) => -d.abs(),
                                (true, true) => continue,
                                (false, false) => {
                                    return Err(IngestError::Parse(format!(
                                        "row {posted_date}: both debit and credit set"
                                    )))
                                }
                            }
                        }
                    }
                }
            };

            lines.push(StatementLine {
                posted_date,
                description: field(self.mapping.description_col).to_string(),
                amount_minor,
                balance_minor: self
                    .mapping
                    .balance_col
                    .and_then(|col| parse_amount_minor(field(col)).ok()),
                provider_txn_id: self
                    .mapping
                    .reference_col
                    .map(|col| field(col).to_string())
                    .filter(|r| !r.is_empty()),
                currency: self.mapping.currency.clone(),
            });
        }
        Ok(lines)
    }
}

#[async_trait(?Send)]
impl BankAdapter for CsvStatementAdapter {
    fn bank_id(&self) -> &str {
        &self.bank_id
    }

    async fn fetch_lines(&mut self, range: &DateRange) -> IngestResult<Vec<StatementLine>> {
        Ok(self
            .parse_all()?
            .into_iter()
            .filter(|l| range.contains(&l.posted_date))
            .collect())
    }
}

/// Parse one statement date into `YYYY-MM-DD`.
pub fn parse_statement_date(raw: &str, format: DateFormat) -> IngestResult<String> {
    let raw = raw.trim();
    let bad = || IngestError::Parse(format!("unparseable date {raw:?}"));
    let (year, month, day): (i32, u32, u32) = match format {
        DateFormat::IsoYmd => split3(raw, '-').ok_or_else(bad)?,
        DateFormat::SlashYmd => split3(raw, '/').ok_or_else(bad)?,
        DateFormat::SlashDmy => {
            let (d, m, y) = split3(raw, '/').ok_or_else(bad)?;
            (y as i32, m, d as u32)
        }
        DateFormat::DashDmy => {
            let (d, m, y) = split3(raw, '-').ok_or_else(bad)?;
            (y as i32, m, d as u32)
        }
        DateFormat::CompactYmd => {
            if raw.len() != 8 || !raw.bytes().all(|b| b.is_ascii_digit()) {
                return Err(bad());
            }
            (
                raw[0..4].parse().map_err(|_| bad())?,
                raw[4..6].parse().map_err(|_| bad())?,
                raw[6..8].parse().map_err(|_| bad())?,
            )
        }
        DateFormat::DayMonthNameYear => {
            let mut parts = raw.split_whitespace();
            let day: u32 = parts.next().ok_or_else(bad)?.parse().map_err(|_| bad())?;
            let month = month_from_name(parts.next().ok_or_else(bad)?).ok_or_else(bad)?;
            let year: i32 = parts.next().ok_or_else(bad)?.parse().map_err(|_| bad())?;
            if parts.next().is_some() {
                return Err(bad());
            }
            (year, month, day)
        }
    };
    if !(1900..=2200).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(bad());
    }
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

/// `a<sep>b<sep>c` as (first, middle, last) numbers.
fn split3(raw: &str, sep: char) -> Option<(i32, u32, u32)> {
    let mut parts = raw.split(sep);
    let a = parts.next()?.trim().parse().ok()?;
    let b = parts.next()?.trim().parse().ok()?;
    let c = parts.next()?.trim().parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((a, b, c))
}

fn month_from_name(name: &str) -> Option<u32> {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let lower = name.to_ascii_lowercase();
    MONTHS
        .iter()
        .position(|m| lower.starts_with(m))
        .map(|i| i as u32 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_for(preset: SaBankPreset, csv: &str) -> Vec<StatementLine> {
        CsvStatementAdapter::new(preset.bank_id(), preset.mapping(), csv.as_bytes().to_vec())
            .parse_all()
            .unwrap()
    }

    #[test]
    fn date_formats_parse_to_iso() {
        assert_eq!(
            parse_statement_date("2026-06-01", DateFormat::IsoYmd).unwrap(),
            "2026-06-01"
        );
        assert_eq!(
            parse_statement_date("2026/06/01", DateFormat::SlashYmd).unwrap(),
            "2026-06-01"
        );
        assert_eq!(
            parse_statement_date("01/06/2026", DateFormat::SlashDmy).unwrap(),
            "2026-06-01"
        );
        assert_eq!(
            parse_statement_date("1 June 2026", DateFormat::DayMonthNameYear).unwrap(),
            "2026-06-01"
        );
        assert_eq!(
            parse_statement_date("20260601", DateFormat::CompactYmd).unwrap(),
            "2026-06-01"
        );
        assert!(parse_statement_date("13/13/2026", DateFormat::SlashDmy).is_err());
        assert!(parse_statement_date("junk", DateFormat::IsoYmd).is_err());
    }

    #[test]
    fn fnb_preset_parses_signed_amounts() {
        let csv = "\
Date,Amount,Balance,Description
2026/06/01,-184.50,10515.50,CARD PURCHASE WOOLWORTHS
2026/06/02,25000.00,35515.50,SALARY ACME PTY LTD
";
        let lines = lines_for(SaBankPreset::Fnb, csv);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].posted_date, "2026-06-01");
        assert_eq!(lines[0].amount_minor, -18450);
        assert_eq!(lines[0].description, "CARD PURCHASE WOOLWORTHS");
        assert_eq!(lines[0].balance_minor, Some(1051550));
        assert_eq!(lines[1].amount_minor, 2_500_000);
    }

    #[test]
    fn capitec_preset_maps_money_in_and_out_columns() {
        let csv = "\
Date,Description,Money In,Money Out,Balance
01/06/2026,GROCERIES SPAR,,450.25,9549.75
02/06/2026,EFT SALARY,12000.00,,21549.75
03/06/2026,MONTHLY FEE,0.00,5.00,21544.75
";
        let lines = lines_for(SaBankPreset::Capitec, csv);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].amount_minor, -45025, "money out is negative");
        assert_eq!(lines[1].amount_minor, 1_200_000, "money in is positive");
        assert_eq!(lines[2].amount_minor, -500, "zero-filled unused column");
    }

    #[test]
    fn nedbank_and_absa_presets_parse_their_date_styles() {
        let ned = "\
Date,Description,Amount,Balance
01 Jun 2026,DEBIT ORDER INSURANCE,-350.00,5650.00
";
        let lines = lines_for(SaBankPreset::Nedbank, ned);
        assert_eq!(lines[0].posted_date, "2026-06-01");
        assert_eq!(lines[0].amount_minor, -35000);

        let absa = "\
Date,Description,Amount,Balance
20260615,POS PURCHASE ENGEN,-500.00,4400.00
";
        let lines = lines_for(SaBankPreset::Absa, absa);
        assert_eq!(lines[0].posted_date, "2026-06-15");
        assert_eq!(lines[0].amount_minor, -50000);
    }

    #[test]
    fn standard_bank_preset_skips_junk_rows_and_keeps_references() {
        let mut mapping = SaBankPreset::StandardBank.mapping();
        mapping.reference_col = Some(4);
        let csv = "\
Date,Description,Amount,Balance,Reference
ACCOUNT 123456789,,,,
2026-06-01,OPENING BALANCE,,,
2026-06-02,CARD PURCHASE CHECKERS,-210.99,8789.01,SB-001
TOTALS,,,,
";
        let adapter = CsvStatementAdapter::new("za-standard", mapping, csv.as_bytes().to_vec());
        let lines = adapter.parse_all().unwrap();
        // Preamble (bad date), opening-balance (no amount), and totals rows
        // are skipped; only the real transaction survives.
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].provider_txn_id.as_deref(), Some("SB-001"));
        assert_eq!(lines[0].amount_minor, -21099);
    }

    #[tokio::test]
    async fn fetch_lines_filters_by_date_range() {
        let csv = "\
Date,Description,Amount,Balance
2026-05-31,BEFORE,-1.00,1.00
2026-06-10,INSIDE,-2.00,2.00
2026-07-01,AFTER,-3.00,3.00
";
        let mut adapter = CsvStatementAdapter::new(
            "za-standard",
            SaBankPreset::StandardBank.mapping(),
            csv.as_bytes().to_vec(),
        );
        let range = DateRange::new("2026-06-01", "2026-06-30").unwrap();
        let lines = adapter.fetch_lines(&range).await.unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].description, "INSIDE");
    }

    #[test]
    fn skip_rows_removes_preamble_before_the_table() {
        let mut mapping = SaBankPreset::Fnb.mapping();
        mapping.skip_rows = 2;
        let csv = "\
FNB Cheque Account
Statement period: 2026-06-01 to 2026-06-30
Date,Amount,Balance,Description
2026/06/03,-99.99,900.01,SUBSCRIPTION
";
        let adapter = CsvStatementAdapter::new("za-fnb", mapping, csv.as_bytes().to_vec());
        let lines = adapter.parse_all().unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].amount_minor, -9999);
    }
}
