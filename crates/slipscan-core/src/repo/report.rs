use rusqlite::{params, Connection};

use super::col_enum;
use crate::domain::{
    BalanceSheet, BalanceSheetRow, CoaKind, IncomeStatement, IncomeStatementRow,
    MonthlySpendingRow, SpendingRow, TaxPeriodSummary, TaxSummaryRow, TrialBalanceRow, VatRole,
};
use crate::error::CoreResult;

/// Spending by (category, currency) over an inclusive date range. Only
/// outflows (negative amounts) count; rejected transactions are excluded.
/// Amounts in different currencies are never summed together — each currency
/// gets its own row.
pub fn spending(
    conn: &Connection,
    book_id: &str,
    from_date: &str,
    to_date: &str,
) -> CoreResult<Vec<SpendingRow>> {
    let mut stmt = conn.prepare(
        "SELECT t.category_id AS category_id,
                COALESCE(c.name, 'Uncategorized') AS category_name,
                t.currency AS currency,
                -SUM(t.amount_minor) AS total_minor
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.book_id = ?1
           AND t.amount_minor < 0
           AND t.status <> 'rejected'
           AND t.posted_date >= ?2
           AND t.posted_date <= ?3
         GROUP BY t.category_id, category_name, t.currency
         ORDER BY total_minor DESC",
    )?;
    let rows = stmt
        .query_map(params![book_id, from_date, to_date], |row| {
            Ok(SpendingRow {
                category_id: row.get("category_id")?,
                category_name: row.get("category_name")?,
                currency: row.get("currency")?,
                total_minor: row.get("total_minor")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Spending by (category, currency), grouped by calendar month, over an
/// inclusive range.
pub fn spending_by_month(
    conn: &Connection,
    book_id: &str,
    from_date: &str,
    to_date: &str,
) -> CoreResult<Vec<MonthlySpendingRow>> {
    let mut stmt = conn.prepare(
        "SELECT substr(t.posted_date, 1, 7) AS month,
                t.category_id AS category_id,
                COALESCE(c.name, 'Uncategorized') AS category_name,
                t.currency AS currency,
                -SUM(t.amount_minor) AS total_minor
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.book_id = ?1
           AND t.amount_minor < 0
           AND t.status <> 'rejected'
           AND t.posted_date >= ?2
           AND t.posted_date <= ?3
         GROUP BY month, t.category_id, category_name, t.currency
         ORDER BY month, total_minor DESC",
    )?;
    let rows = stmt
        .query_map(params![book_id, from_date, to_date], |row| {
            Ok(MonthlySpendingRow {
                month: row.get("month")?,
                category_id: row.get("category_id")?,
                category_name: row.get("category_name")?,
                currency: row.get("currency")?,
                total_minor: row.get("total_minor")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Income statement over an inclusive posted-date range: income accounts by
/// credit balance, expense accounts by debit balance, net profit.
///
/// Single-currency by construction: only journal lines in `currency` (the
/// book's base currency) are aggregated. Mixing currencies into one sum would
/// produce meaningless statements; foreign-currency lines stay visible per
/// currency on the trial balance until FX translation exists.
pub fn income_statement(
    conn: &Connection,
    book_id: &str,
    from_date: &str,
    to_date: &str,
    currency: &str,
) -> CoreResult<IncomeStatement> {
    let mut stmt = conn.prepare(
        "SELECT a.id AS coa_id, a.code AS code, a.name AS name, a.kind AS kind,
                COALESCE(SUM(l.debit_minor), 0) AS debit_minor,
                COALESCE(SUM(l.credit_minor), 0) AS credit_minor
         FROM chart_of_accounts a
         JOIN journal_lines l ON l.coa_id = a.id
         JOIN journals j ON j.id = l.journal_id
         WHERE a.book_id = ?1
           AND a.kind IN ('income', 'expense')
           AND l.currency = ?4
           AND j.posted_date >= ?2
           AND j.posted_date <= ?3
         GROUP BY a.id, a.code, a.name, a.kind
         HAVING debit_minor <> 0 OR credit_minor <> 0
         ORDER BY a.code",
    )?;
    let mut income = Vec::new();
    let mut expenses = Vec::new();
    let rows = stmt.query_map(params![book_id, from_date, to_date, currency], |row| {
        let kind: CoaKind = col_enum(row, "kind")?;
        let debit: i64 = row.get("debit_minor")?;
        let credit: i64 = row.get("credit_minor")?;
        Ok(IncomeStatementRow {
            coa_id: row.get("coa_id")?,
            code: row.get("code")?,
            name: row.get("name")?,
            kind,
            amount_minor: match kind {
                CoaKind::Income => credit - debit,
                _ => debit - credit,
            },
        })
    })?;
    for row in rows {
        let row = row?;
        match row.kind {
            CoaKind::Income => income.push(row),
            _ => expenses.push(row),
        }
    }
    let income_total_minor: i64 = income.iter().map(|r| r.amount_minor).sum();
    let expense_total_minor: i64 = expenses.iter().map(|r| r.amount_minor).sum();
    Ok(IncomeStatement {
        book_id: book_id.to_string(),
        from_date: from_date.to_string(),
        to_date: to_date.to_string(),
        currency: currency.to_string(),
        income,
        expenses,
        income_total_minor,
        expense_total_minor,
        net_profit_minor: income_total_minor - expense_total_minor,
    })
}

/// Tax-period summary: output/input tax and their bases, per tax rate, over
/// an inclusive posted-date range. Only tax-tagged journal lines count, and
/// only lines in `currency` (the book's base currency) — a return is filed
/// in one currency. Labels come from the region profile (za labels this
/// report "VAT201").
pub fn tax_period_summary(
    conn: &Connection,
    book_id: &str,
    from_date: &str,
    to_date: &str,
    currency: &str,
    profile: &crate::region::RegionProfile,
) -> CoreResult<TaxPeriodSummary> {
    let mut stmt = conn.prepare(
        "SELECT l.vat_rate_id AS vat_rate_id,
                COALESCE(r.code, '') AS code,
                COALESCE(r.name, 'Unspecified rate') AS name,
                COALESCE(r.rate_bps, 0) AS rate_bps,
                l.vat_role AS vat_role,
                SUM(l.debit_minor) AS debit_minor,
                SUM(l.credit_minor) AS credit_minor
         FROM journal_lines l
         JOIN journals j ON j.id = l.journal_id
         LEFT JOIN vat_rates r ON r.id = l.vat_rate_id
         WHERE l.book_id = ?1
           AND l.vat_role IS NOT NULL
           AND l.currency = ?4
           AND j.posted_date >= ?2
           AND j.posted_date <= ?3
         GROUP BY l.vat_rate_id, l.vat_role
         ORDER BY rate_bps DESC, code",
    )?;
    struct Slice {
        vat_rate_id: Option<String>,
        code: String,
        name: String,
        rate_bps: i64,
        role: VatRole,
        debit_minor: i64,
        credit_minor: i64,
    }
    let slices = stmt
        .query_map(params![book_id, from_date, to_date, currency], |row| {
            Ok(Slice {
                vat_rate_id: row.get("vat_rate_id")?,
                code: row.get("code")?,
                name: row.get("name")?,
                rate_bps: row.get("rate_bps")?,
                role: col_enum(row, "vat_role")?,
                debit_minor: row.get("debit_minor")?,
                credit_minor: row.get("credit_minor")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut rows: Vec<TaxSummaryRow> = Vec::new();
    for s in slices {
        let row = match rows.iter_mut().find(|r| r.vat_rate_id == s.vat_rate_id) {
            Some(existing) => existing,
            None => {
                rows.push(TaxSummaryRow {
                    vat_rate_id: s.vat_rate_id.clone(),
                    code: s.code.clone(),
                    name: s.name.clone(),
                    rate_bps: s.rate_bps,
                    output_base_minor: 0,
                    output_vat_minor: 0,
                    input_base_minor: 0,
                    input_vat_minor: 0,
                });
                rows.last_mut().expect("just pushed")
            }
        };
        // Output-side amounts are credit-natured; input-side debit-natured.
        match s.role {
            VatRole::OutputVat => row.output_vat_minor += s.credit_minor - s.debit_minor,
            VatRole::OutputBase => row.output_base_minor += s.credit_minor - s.debit_minor,
            VatRole::InputVat => row.input_vat_minor += s.debit_minor - s.credit_minor,
            VatRole::InputBase => row.input_base_minor += s.debit_minor - s.credit_minor,
        }
    }

    let output_vat_minor: i64 = rows.iter().map(|r| r.output_vat_minor).sum();
    let input_vat_minor: i64 = rows.iter().map(|r| r.input_vat_minor).sum();
    let standard_rated_supplies_minor = rows
        .iter()
        .filter(|r| r.rate_bps > 0)
        .map(|r| r.output_base_minor)
        .sum();
    let zero_rated_supplies_minor = rows
        .iter()
        .filter(|r| r.rate_bps == 0 && !profile.is_exempt_code(&r.code))
        .map(|r| r.output_base_minor)
        .sum();
    let exempt_supplies_minor = rows
        .iter()
        .filter(|r| profile.is_exempt_code(&r.code))
        .map(|r| r.output_base_minor)
        .sum();

    Ok(TaxPeriodSummary {
        book_id: book_id.to_string(),
        from_date: from_date.to_string(),
        to_date: to_date.to_string(),
        currency: currency.to_string(),
        report_name: profile.tax_report.report_name.to_string(),
        labels: profile.tax_report.box_labels(),
        rows,
        standard_rated_supplies_minor,
        zero_rated_supplies_minor,
        exempt_supplies_minor,
        output_vat_minor,
        input_vat_minor,
        net_vat_minor: output_vat_minor - input_vat_minor,
    })
}

/// Balance sheet as of an inclusive date. Asset / liability / equity account
/// balances at their natural side; income − expense movements up to the date
/// are folded into retained earnings so the statement balances.
///
/// Single-currency by construction: only lines in `currency` (the book's
/// base currency) are aggregated — see [`income_statement`].
pub fn balance_sheet(
    conn: &Connection,
    book_id: &str,
    as_of_date: &str,
    currency: &str,
) -> CoreResult<BalanceSheet> {
    let mut stmt = conn.prepare(
        "SELECT a.id AS coa_id, a.code AS code, a.name AS name, a.kind AS kind,
                COALESCE(SUM(x.debit_minor), 0) AS debit_minor,
                COALESCE(SUM(x.credit_minor), 0) AS credit_minor
         FROM chart_of_accounts a
         LEFT JOIN (
             SELECT l.coa_id, l.debit_minor, l.credit_minor
             FROM journal_lines l
             JOIN journals j ON j.id = l.journal_id
             WHERE j.posted_date <= ?2 AND l.currency = ?3
         ) x ON x.coa_id = a.id
         WHERE a.book_id = ?1
         GROUP BY a.id, a.code, a.name, a.kind
         ORDER BY a.code",
    )?;

    let mut assets = Vec::new();
    let mut liabilities = Vec::new();
    let mut equity = Vec::new();
    let mut retained_earnings_minor: i64 = 0;

    let rows = stmt.query_map(params![book_id, as_of_date, currency], |row| {
        let kind: CoaKind = col_enum(row, "kind")?;
        let debit: i64 = row.get("debit_minor")?;
        let credit: i64 = row.get("credit_minor")?;
        Ok((
            kind,
            BalanceSheetRow {
                coa_id: row.get("coa_id")?,
                code: row.get("code")?,
                name: row.get("name")?,
                kind,
                amount_minor: match kind {
                    CoaKind::Asset => debit - credit,
                    _ => credit - debit,
                },
            },
        ))
    })?;
    for row in rows {
        let (kind, row) = row?;
        match kind {
            // Income and expenses roll into equity as retained earnings.
            CoaKind::Income | CoaKind::Expense => retained_earnings_minor += row.amount_minor,
            _ if row.amount_minor == 0 => {}
            CoaKind::Asset => assets.push(row),
            CoaKind::Liability => liabilities.push(row),
            CoaKind::Equity => equity.push(row),
        }
    }

    let assets_total_minor: i64 = assets.iter().map(|r| r.amount_minor).sum();
    let liabilities_total_minor: i64 = liabilities.iter().map(|r| r.amount_minor).sum();
    let equity_total_minor: i64 =
        equity.iter().map(|r| r.amount_minor).sum::<i64>() + retained_earnings_minor;

    Ok(BalanceSheet {
        book_id: book_id.to_string(),
        as_of_date: as_of_date.to_string(),
        currency: currency.to_string(),
        assets,
        liabilities,
        equity,
        retained_earnings_minor,
        assets_total_minor,
        liabilities_total_minor,
        equity_total_minor,
    })
}

/// Trial balance: total debits/credits per (chart-of-accounts entry,
/// currency). Accounts with no postings yet appear once with zero totals in
/// `book_currency`; accounts posted in several currencies get one row per
/// currency — sums never mix currencies.
pub fn trial_balance(
    conn: &Connection,
    book_id: &str,
    book_currency: &str,
) -> CoreResult<Vec<TrialBalanceRow>> {
    let mut stmt = conn.prepare(
        "SELECT a.id AS coa_id, a.code AS code, a.name AS name, a.kind AS kind,
                COALESCE(l.currency, ?2) AS currency,
                COALESCE(SUM(l.debit_minor), 0) AS debit_minor,
                COALESCE(SUM(l.credit_minor), 0) AS credit_minor
         FROM chart_of_accounts a
         LEFT JOIN journal_lines l ON l.coa_id = a.id
         WHERE a.book_id = ?1
         GROUP BY a.id, a.code, a.name, a.kind, l.currency
         ORDER BY a.code, currency",
    )?;
    let rows = stmt
        .query_map(params![book_id, book_currency], |row| {
            Ok(TrialBalanceRow {
                coa_id: row.get("coa_id")?,
                code: row.get("code")?,
                name: row.get("name")?,
                kind: col_enum(row, "kind")?,
                currency: row.get("currency")?,
                debit_minor: row.get("debit_minor")?,
                credit_minor: row.get("credit_minor")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
