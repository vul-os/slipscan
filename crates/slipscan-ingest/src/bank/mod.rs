//! Bank-adapter framework: pull statement lines from *your* bank, on *your*
//! machine (docs/BANK-ADAPTERS.md).
//!
//! One small trait, [`BankAdapter`]: fetch normalised [`StatementLine`]s for
//! a date range. Adapters receive credentials only through the vault's
//! `use_with` handoff ([`crate::vault`]) and may talk to nothing but the
//! bank itself. [`import_statement_lines`] feeds the results into the core
//! transaction pipeline, which dedupes by `(account, provider_txn_id | hash)`
//! — overlapping fetches are always safe.
//!
//! First concrete implementation: [`csv_statement::CsvStatementAdapter`], a
//! file-based adapter over downloaded CSV statements with column-mapping
//! presets for the SA banks (FNB, Standard Bank, Capitec, Nedbank, Absa).

pub mod csv_statement;

use crate::{IngestError, IngestResult};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use slipscan_core::domain::{NewTransaction, Transaction, TransactionSource};
use slipscan_core::{CoreError, CoreService};

/// Inclusive `YYYY-MM-DD` date range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DateRange {
    pub from: String,
    pub to: String,
}

impl DateRange {
    pub fn new(from: impl Into<String>, to: impl Into<String>) -> IngestResult<Self> {
        let range = Self {
            from: from.into(),
            to: to.into(),
        };
        for date in [&range.from, &range.to] {
            if !looks_like_iso_date(date) {
                return Err(IngestError::Parse(format!(
                    "not a YYYY-MM-DD date: {date:?}"
                )));
            }
        }
        if range.from > range.to {
            return Err(IngestError::Parse(format!(
                "range is inverted: {} > {}",
                range.from, range.to
            )));
        }
        Ok(range)
    }

    pub fn contains(&self, date: &str) -> bool {
        // ISO dates compare correctly as strings.
        self.from.as_str() <= date && date <= self.to.as_str()
    }
}

fn looks_like_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| matches!(i, 4 | 7) || c.is_ascii_digit())
}

/// One normalised statement line, ready for the transaction pipeline.
/// Amounts are minor units (cents), **never floats** — money out is
/// negative, money in positive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementLine {
    /// `YYYY-MM-DD`.
    pub posted_date: String,
    pub description: String,
    pub amount_minor: i64,
    /// Running balance after this line, when the statement provides one.
    pub balance_minor: Option<i64>,
    /// The bank's own transaction id — the dedupe anchor when present.
    pub provider_txn_id: Option<String>,
    /// ISO-4217; `None` = the account's currency.
    pub currency: Option<String>,
}

/// A bank adapter: fetch statement lines for a date range.
///
/// Implementations authenticate with credentials handed over by the vault
/// (`use_with`), talk only to the bank's own endpoints, and normalise into
/// [`StatementLine`]s. See docs/BANK-ADAPTERS.md for the audit bar.
///
/// `?Send` to match the rest of the ingestion traits (adapters may borrow
/// the single-threaded core service for cursor state).
#[async_trait(?Send)]
pub trait BankAdapter {
    /// Stable bank id, e.g. `"za-fnb"`.
    fn bank_id(&self) -> &str;

    /// Fetch lines posted within `range` (inclusive), oldest first
    /// preferred but not required — import order does not affect dedup.
    async fn fetch_lines(&mut self, range: &DateRange) -> IngestResult<Vec<StatementLine>>;
}

/// What one statement import contributed.
#[derive(Debug, Default)]
pub struct StatementImportOutcome {
    pub imported: Vec<Transaction>,
    pub duplicates: usize,
}

/// Feed statement lines into the core transaction pipeline. Duplicates
/// (provider id or content hash already present) are counted, not errors —
/// overlapping statement pulls are the normal case.
///
/// Lines without a `provider_txn_id` are numbered per identical
/// (date, amount, currency, description) tuple within the batch, so two
/// genuine identical purchases in one statement both import while a
/// re-import of the same statement still dedupes both.
pub fn import_statement_lines(
    svc: &CoreService,
    book_id: &str,
    account_id: &str,
    source: TransactionSource,
    lines: Vec<StatementLine>,
) -> IngestResult<StatementImportOutcome> {
    let account = svc.account_get(account_id)?;
    let mut outcome = StatementImportOutcome::default();
    let mut occurrences: std::collections::HashMap<(String, i64, String, String), u32> =
        std::collections::HashMap::new();
    for line in lines {
        let currency = line.currency.unwrap_or_else(|| account.currency.clone());
        let dedupe_occurrence = if line.provider_txn_id.is_none() {
            let counter = occurrences
                .entry((
                    line.posted_date.clone(),
                    line.amount_minor,
                    currency.clone(),
                    line.description.clone(),
                ))
                .or_insert(0);
            let occurrence = *counter;
            *counter += 1;
            occurrence
        } else {
            0
        };
        let new = NewTransaction {
            book_id: book_id.to_string(),
            account_id: account_id.to_string(),
            source,
            provider_txn_id: line.provider_txn_id,
            posted_date: line.posted_date,
            amount_minor: line.amount_minor,
            currency,
            merchant: None,
            description: Some(line.description),
            notes: None,
            category_id: None,
            document_id: None,
            dedupe_occurrence,
        };
        match svc.transaction_create(new) {
            Ok(txn) => outcome.imported.push(txn),
            Err(CoreError::DuplicateTransaction { .. }) => outcome.duplicates += 1,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(outcome)
}

/// Fetch + import in one call.
pub async fn sync_bank_adapter(
    svc: &CoreService,
    book_id: &str,
    account_id: &str,
    adapter: &mut dyn BankAdapter,
    range: &DateRange,
) -> IngestResult<StatementImportOutcome> {
    let lines = adapter.fetch_lines(range).await?;
    import_statement_lines(svc, book_id, account_id, TransactionSource::Import, lines)
}

/// Parse a statement amount into minor units without ever touching floats.
///
/// Handles the shapes SA bank exports actually produce: `-123.45`,
/// `1 234,56`, `1,234.56`, `R 123.45`, `(123.45)`, `123.45-`, `123.45 Cr`,
/// `123.45Dr`. `Dr`/parentheses/minus mean money out (negative).
pub fn parse_amount_minor(raw: &str) -> IngestResult<i64> {
    let original = raw;
    let mut s = raw.trim().to_string();
    if s.is_empty() {
        return Err(IngestError::Parse("empty amount".into()));
    }

    let mut negative = false;
    let lower = s.to_ascii_lowercase();
    if let Some(stripped) = lower.strip_suffix("cr") {
        s.truncate(stripped.len());
    } else if let Some(stripped) = lower.strip_suffix("dr") {
        s.truncate(stripped.len());
        negative = true;
    }
    let mut s = s.trim().to_string();
    if s.starts_with('(') && s.ends_with(')') {
        negative = true;
        s = s[1..s.len() - 1].to_string();
    }
    if s.contains('-') {
        negative = true;
    }

    // Everything left that matters: digits and separators.
    let cleaned: String = s
        .chars()
        .filter(|c| c.is_ascii_digit() || matches!(c, '.' | ','))
        .collect();
    if cleaned.chars().filter(|c| c.is_ascii_digit()).count() == 0 {
        return Err(IngestError::Parse(format!(
            "no digits in amount {original:?}"
        )));
    }

    // The last '.' or ',' is the decimal separator iff 1–2 digits follow;
    // otherwise it is a thousands separator ("1,234" == 1234).
    let (major_part, minor_part) = match cleaned.rfind(['.', ',']) {
        Some(idx) if (1..=2).contains(&(cleaned.len() - idx - 1)) => {
            (cleaned[..idx].to_string(), cleaned[idx + 1..].to_string())
        }
        _ => (cleaned.clone(), String::new()),
    };
    let major: String = major_part.chars().filter(char::is_ascii_digit).collect();
    let major: i64 = if major.is_empty() {
        0
    } else {
        major
            .parse()
            .map_err(|_| IngestError::Parse(format!("amount overflow in {original:?}")))?
    };
    let cents: i64 = match minor_part.len() {
        0 => 0,
        1 => 10 * minor_part.parse::<i64>().unwrap_or(0),
        _ => minor_part.parse::<i64>().unwrap_or(0),
    };
    let minor = major
        .checked_mul(100)
        .and_then(|m| m.checked_add(cents))
        .ok_or_else(|| IngestError::Parse(format!("amount overflow in {original:?}")))?;
    Ok(if negative { -minor } else { minor })
}

#[cfg(test)]
mod tests {
    use super::*;
    use slipscan_core::domain::{AccountKind, BookKind, NewAccount, NewBook};
    use slipscan_core::secrets::MemorySecretStore;
    use slipscan_core::Db;

    fn svc_with_account() -> (CoreService, String, String) {
        let svc = CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let book = svc
            .book_create(NewBook {
                name: "Bank".into(),
                kind: BookKind::Personal,
                currency: None,
                country: None,
            })
            .unwrap();
        let account = svc
            .account_create(NewAccount {
                book_id: book.id.clone(),
                name: "Cheque".into(),
                kind: AccountKind::Bank,
                currency: "ZAR".into(),
                institution: Some("FNB".into()),
                account_number_masked: Some("••1234".into()),
                opening_balance_minor: None,
            })
            .unwrap();
        (svc, book.id, account.id)
    }

    fn line(date: &str, desc: &str, amount: i64, provider: Option<&str>) -> StatementLine {
        StatementLine {
            posted_date: date.into(),
            description: desc.into(),
            amount_minor: amount,
            balance_minor: None,
            provider_txn_id: provider.map(str::to_string),
            currency: None,
        }
    }

    #[test]
    fn amount_parsing_covers_sa_bank_shapes() {
        assert_eq!(parse_amount_minor("-123.45").unwrap(), -12345);
        assert_eq!(parse_amount_minor("123.45").unwrap(), 12345);
        assert_eq!(parse_amount_minor("1 234,56").unwrap(), 123456);
        assert_eq!(parse_amount_minor("1,234.56").unwrap(), 123456);
        assert_eq!(parse_amount_minor("R 184.50").unwrap(), 18450);
        assert_eq!(parse_amount_minor("(99.10)").unwrap(), -9910);
        assert_eq!(parse_amount_minor("123.45-").unwrap(), -12345);
        assert_eq!(parse_amount_minor("55.20 Cr").unwrap(), 5520);
        assert_eq!(parse_amount_minor("55.20Dr").unwrap(), -5520);
        assert_eq!(
            parse_amount_minor("1,234").unwrap(),
            123400,
            "thousands sep"
        );
        assert_eq!(parse_amount_minor("5.5").unwrap(), 550);
        assert_eq!(parse_amount_minor("0.07").unwrap(), 7);
        assert!(parse_amount_minor("").is_err());
        assert!(parse_amount_minor("n/a").is_err());
    }

    #[test]
    fn date_range_validates_and_contains() {
        let range = DateRange::new("2026-06-01", "2026-06-30").unwrap();
        assert!(range.contains("2026-06-01"));
        assert!(range.contains("2026-06-30"));
        assert!(!range.contains("2026-07-01"));
        assert!(DateRange::new("2026-07-01", "2026-06-01").is_err());
        assert!(DateRange::new("01/06/2026", "2026-06-30").is_err());
    }

    #[test]
    fn statement_import_dedupes_by_provider_id_and_hash() {
        let (svc, book_id, account_id) = svc_with_account();
        let lines = vec![
            line("2026-06-02", "COFFEE SHOP", -4500, Some("txn-1")),
            line("2026-06-03", "SALARY", 100_000, None),
        ];
        let outcome = import_statement_lines(
            &svc,
            &book_id,
            &account_id,
            TransactionSource::Import,
            lines.clone(),
        )
        .unwrap();
        assert_eq!(outcome.imported.len(), 2);
        assert_eq!(
            outcome.imported[0].currency, "ZAR",
            "account currency inherited"
        );

        // Overlapping re-import: everything is a duplicate.
        let again = import_statement_lines(
            &svc,
            &book_id,
            &account_id,
            TransactionSource::Import,
            lines,
        )
        .unwrap();
        assert!(again.imported.is_empty());
        assert_eq!(again.duplicates, 2);
    }

    #[test]
    fn statement_import_keeps_legitimate_identical_lines() {
        let (svc, book_id, account_id) = svc_with_account();
        // Two identical coffees on the same day, no provider ids — both are
        // real transactions and both must import.
        let lines = vec![
            line("2026-06-02", "GROCERIES SPAR", -45_025, None),
            line("2026-06-02", "GROCERIES SPAR", -45_025, None),
            line("2026-06-02", "COFFEE SHOP", -4_500, None),
        ];
        let outcome = import_statement_lines(
            &svc,
            &book_id,
            &account_id,
            TransactionSource::Import,
            lines.clone(),
        )
        .unwrap();
        assert_eq!(outcome.imported.len(), 3, "identical lines both import");
        assert_eq!(outcome.duplicates, 0);

        // Re-importing the same statement dedupes every line, including
        // both identical ones.
        let again = import_statement_lines(
            &svc,
            &book_id,
            &account_id,
            TransactionSource::Import,
            lines,
        )
        .unwrap();
        assert!(again.imported.is_empty());
        assert_eq!(again.duplicates, 3);
    }

    struct FixtureAdapter(Vec<StatementLine>);

    #[async_trait(?Send)]
    impl BankAdapter for FixtureAdapter {
        fn bank_id(&self) -> &str {
            "za-fixture"
        }

        async fn fetch_lines(&mut self, range: &DateRange) -> IngestResult<Vec<StatementLine>> {
            Ok(self
                .0
                .iter()
                .filter(|l| range.contains(&l.posted_date))
                .cloned()
                .collect())
        }
    }

    #[tokio::test]
    async fn sync_bank_adapter_fetches_range_and_imports() {
        let (svc, book_id, account_id) = svc_with_account();
        let mut adapter = FixtureAdapter(vec![
            line("2026-05-31", "OLD", -100, None),
            line("2026-06-15", "IN RANGE", -200, None),
        ]);
        let range = DateRange::new("2026-06-01", "2026-06-30").unwrap();
        let outcome = sync_bank_adapter(&svc, &book_id, &account_id, &mut adapter, &range)
            .await
            .unwrap();
        assert_eq!(outcome.imported.len(), 1);
        assert_eq!(outcome.imported[0].description.as_deref(), Some("IN RANGE"));
    }
}
