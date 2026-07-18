//! CSV export for the typed reports. No external crate: RFC 4180 quoting,
//! `\n` line endings, header row first. Amounts are exported in minor units —
//! exact integers, no float formatting surprises.

use crate::domain::{
    IncomeStatement, MonthlySpendingRow, SpendingRow, TaxPeriodSummary, TrialBalanceRow,
};

/// Quote a CSV field per RFC 4180 when it contains a comma, quote, or newline.
fn field(raw: &str) -> String {
    if raw.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", raw.replace('"', "\"\""))
    } else {
        raw.to_string()
    }
}

fn row(fields: &[&str]) -> String {
    let mut out = String::new();
    for (i, f) in fields.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&field(f));
    }
    out.push('\n');
    out
}

pub fn spending_csv(rows: &[SpendingRow]) -> String {
    let mut out = row(&["category_id", "category_name", "currency", "total_minor"]);
    for r in rows {
        out.push_str(&row(&[
            r.category_id.as_deref().unwrap_or(""),
            &r.category_name,
            &r.currency,
            &r.total_minor.to_string(),
        ]));
    }
    out
}

pub fn spending_by_month_csv(rows: &[MonthlySpendingRow]) -> String {
    let mut out = row(&[
        "month",
        "category_id",
        "category_name",
        "currency",
        "total_minor",
    ]);
    for r in rows {
        out.push_str(&row(&[
            &r.month,
            r.category_id.as_deref().unwrap_or(""),
            &r.category_name,
            &r.currency,
            &r.total_minor.to_string(),
        ]));
    }
    out
}

pub fn trial_balance_csv(rows: &[TrialBalanceRow]) -> String {
    let mut out = row(&[
        "code",
        "name",
        "kind",
        "currency",
        "debit_minor",
        "credit_minor",
    ]);
    for r in rows {
        out.push_str(&row(&[
            &r.code,
            &r.name,
            r.kind.as_str(),
            &r.currency,
            &r.debit_minor.to_string(),
            &r.credit_minor.to_string(),
        ]));
    }
    out
}

pub fn income_statement_csv(statement: &IncomeStatement) -> String {
    let mut out = row(&["section", "code", "name", "currency", "amount_minor"]);
    let currency = statement.currency.as_str();
    for r in &statement.income {
        out.push_str(&row(&[
            "income",
            &r.code,
            &r.name,
            currency,
            &r.amount_minor.to_string(),
        ]));
    }
    for r in &statement.expenses {
        out.push_str(&row(&[
            "expense",
            &r.code,
            &r.name,
            currency,
            &r.amount_minor.to_string(),
        ]));
    }
    out.push_str(&row(&[
        "total",
        "",
        "Total income",
        currency,
        &statement.income_total_minor.to_string(),
    ]));
    out.push_str(&row(&[
        "total",
        "",
        "Total expenses",
        currency,
        &statement.expense_total_minor.to_string(),
    ]));
    out.push_str(&row(&[
        "total",
        "",
        "Net profit",
        currency,
        &statement.net_profit_minor.to_string(),
    ]));
    out
}

/// Tax-period summary as CSV. Total-row wording comes from the summary's
/// region-profile labels (e.g. "Output VAT" for za, "Output tax" for
/// generic); column names stay stable machine-readable identifiers.
pub fn tax_summary_csv(summary: &TaxPeriodSummary) -> String {
    let mut out = row(&[
        "code",
        "name",
        "rate_bps",
        "currency",
        "output_base_minor",
        "output_vat_minor",
        "input_base_minor",
        "input_vat_minor",
        "net_vat_minor",
    ]);
    let currency = summary.currency.as_str();
    for r in &summary.rows {
        out.push_str(&row(&[
            &r.code,
            &r.name,
            &r.rate_bps.to_string(),
            currency,
            &r.output_base_minor.to_string(),
            &r.output_vat_minor.to_string(),
            &r.input_base_minor.to_string(),
            &r.input_vat_minor.to_string(),
            "",
        ]));
    }
    out.push_str(&row(&[
        "",
        &format!("Total {}", summary.labels.output_tax),
        "",
        currency,
        "",
        &summary.output_vat_minor.to_string(),
        "",
        "",
        "",
    ]));
    out.push_str(&row(&[
        "",
        &format!("Total {}", summary.labels.input_tax),
        "",
        currency,
        "",
        "",
        "",
        &summary.input_vat_minor.to_string(),
        "",
    ]));
    // Net tax gets its own column — summing the input_vat_minor column must
    // yield input tax only, never input + net double-counted.
    out.push_str(&row(&[
        "",
        &summary.labels.net_tax,
        "",
        currency,
        "",
        "",
        "",
        "",
        &summary.net_vat_minor.to_string(),
    ]));
    out
}

/// Deprecated alias for [`tax_summary_csv`] — "VAT201" is the SA region
/// profile's label for the generic tax-period summary.
#[deprecated(note = "renamed to tax_summary_csv — VAT201 is the SA profile's report label")]
pub fn vat201_csv(summary: &TaxPeriodSummary) -> String {
    tax_summary_csv(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::CoaKind;

    #[test]
    fn fields_are_quoted_when_needed() {
        assert_eq!(field("plain"), "plain");
        assert_eq!(field("has,comma"), "\"has,comma\"");
        assert_eq!(field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(field("two\nlines"), "\"two\nlines\"");
    }

    #[test]
    fn spending_csv_has_header_and_rows() {
        let csv = spending_csv(&[SpendingRow {
            category_id: Some("cat-1".into()),
            category_name: "Groceries, snacks".into(),
            currency: "ZAR".into(),
            total_minor: 12_345,
        }]);
        let mut lines = csv.lines();
        assert_eq!(
            lines.next(),
            Some("category_id,category_name,currency,total_minor")
        );
        assert_eq!(lines.next(), Some("cat-1,\"Groceries, snacks\",ZAR,12345"));
        assert_eq!(lines.next(), None);
    }

    #[test]
    fn tax_summary_csv_puts_net_tax_in_its_own_column() {
        // Regression: the net-tax total used to land in the input_vat_minor
        // column, so summing that column double-counted input + net.
        let csv = tax_summary_csv(&TaxPeriodSummary {
            book_id: "b".into(),
            from_date: "2026-07-01".into(),
            to_date: "2026-07-31".into(),
            currency: "ZAR".into(),
            report_name: crate::region::profile_or_generic("za")
                .tax_report
                .report_name
                .into(),
            labels: crate::region::profile_or_generic("za")
                .tax_report
                .box_labels(),
            rows: vec![],
            standard_rated_supplies_minor: 10_000,
            zero_rated_supplies_minor: 0,
            exempt_supplies_minor: 0,
            output_vat_minor: 1_500,
            input_vat_minor: 300,
            net_vat_minor: 1_200,
        });
        let lines: Vec<&str> = csv.lines().collect();
        let header: Vec<&str> = lines[0].split(',').collect();
        assert_eq!(header[7], "input_vat_minor");
        assert_eq!(header[8], "net_vat_minor");
        let net_row: Vec<&str> = lines
            .iter()
            .find(|l| l.contains("Net VAT payable"))
            .expect("net VAT row")
            .split(',')
            .collect();
        assert_eq!(net_row.len(), 9);
        assert_eq!(net_row[7], "", "input_vat_minor column must stay empty");
        assert_eq!(net_row[8], "1200", "net VAT belongs in net_vat_minor");
        // Summing the input column yields input VAT only.
        let input_total: i64 = lines[1..]
            .iter()
            .filter_map(|l| {
                let cells: Vec<&str> = l.split(',').collect();
                (cells.len() == 9)
                    .then(|| cells[7].parse::<i64>().ok())
                    .flatten()
            })
            .sum();
        assert_eq!(input_total, 300);
    }

    #[test]
    fn trial_balance_csv_renders_kinds_and_currency() {
        let csv = trial_balance_csv(&[TrialBalanceRow {
            coa_id: "x".into(),
            code: "1000".into(),
            name: "Bank".into(),
            kind: CoaKind::Asset,
            currency: "ZAR".into(),
            debit_minor: 100,
            credit_minor: 0,
        }]);
        assert!(csv.contains("1000,Bank,asset,ZAR,100,0\n"));
    }
}
