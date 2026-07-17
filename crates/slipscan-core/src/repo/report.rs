use rusqlite::{params, Connection};

use super::col_enum;
use crate::domain::{
    CoaKind, IncomeStatement, IncomeStatementRow, MonthlySpendingRow, SpendingRow,
    TrialBalanceRow, Vat201Row, Vat201Summary, VatRole,
};
use crate::error::CoreResult;

/// Spending by category over an inclusive date range. Only outflows
/// (negative amounts) count; rejected transactions are excluded.
pub fn spending(
    conn: &Connection,
    book_id: &str,
    from_date: &str,
    to_date: &str,
) -> CoreResult<Vec<SpendingRow>> {
    let mut stmt = conn.prepare(
        "SELECT t.category_id AS category_id,
                COALESCE(c.name, 'Uncategorized') AS category_name,
                -SUM(t.amount_minor) AS total_minor
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.book_id = ?1
           AND t.amount_minor < 0
           AND t.status <> 'rejected'
           AND t.posted_date >= ?2
           AND t.posted_date <= ?3
         GROUP BY t.category_id, category_name
         ORDER BY total_minor DESC",
    )?;
    let rows = stmt
        .query_map(params![book_id, from_date, to_date], |row| {
            Ok(SpendingRow {
                category_id: row.get("category_id")?,
                category_name: row.get("category_name")?,
                total_minor: row.get("total_minor")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Spending by category, grouped by calendar month, over an inclusive range.
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
                -SUM(t.amount_minor) AS total_minor
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.book_id = ?1
           AND t.amount_minor < 0
           AND t.status <> 'rejected'
           AND t.posted_date >= ?2
           AND t.posted_date <= ?3
         GROUP BY month, t.category_id, category_name
         ORDER BY month, total_minor DESC",
    )?;
    let rows = stmt
        .query_map(params![book_id, from_date, to_date], |row| {
            Ok(MonthlySpendingRow {
                month: row.get("month")?,
                category_id: row.get("category_id")?,
                category_name: row.get("category_name")?,
                total_minor: row.get("total_minor")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Income statement over an inclusive posted-date range: income accounts by
/// credit balance, expense accounts by debit balance, net profit.
pub fn income_statement(
    conn: &Connection,
    book_id: &str,
    from_date: &str,
    to_date: &str,
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
           AND j.posted_date >= ?2
           AND j.posted_date <= ?3
         GROUP BY a.id, a.code, a.name, a.kind
         HAVING debit_minor <> 0 OR credit_minor <> 0
         ORDER BY a.code",
    )?;
    let mut income = Vec::new();
    let mut expenses = Vec::new();
    let rows = stmt.query_map(params![book_id, from_date, to_date], |row| {
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
        income,
        expenses,
        income_total_minor,
        expense_total_minor,
        net_profit_minor: income_total_minor - expense_total_minor,
    })
}

/// VAT201-style summary: output/input VAT and their bases, per VAT rate, over
/// an inclusive posted-date range. Only VAT-tagged journal lines count.
pub fn vat201(
    conn: &Connection,
    book_id: &str,
    from_date: &str,
    to_date: &str,
) -> CoreResult<Vat201Summary> {
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
        .query_map(params![book_id, from_date, to_date], |row| {
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

    let mut rows: Vec<Vat201Row> = Vec::new();
    for s in slices {
        let row = match rows.iter_mut().find(|r| r.vat_rate_id == s.vat_rate_id) {
            Some(existing) => existing,
            None => {
                rows.push(Vat201Row {
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
        .filter(|r| r.rate_bps == 0 && r.code != "EXE")
        .map(|r| r.output_base_minor)
        .sum();
    let exempt_supplies_minor = rows
        .iter()
        .filter(|r| r.code == "EXE")
        .map(|r| r.output_base_minor)
        .sum();

    Ok(Vat201Summary {
        book_id: book_id.to_string(),
        from_date: from_date.to_string(),
        to_date: to_date.to_string(),
        rows,
        standard_rated_supplies_minor,
        zero_rated_supplies_minor,
        exempt_supplies_minor,
        output_vat_minor,
        input_vat_minor,
        net_vat_minor: output_vat_minor - input_vat_minor,
    })
}

/// Trial balance: total debits/credits per chart-of-accounts entry.
pub fn trial_balance(conn: &Connection, book_id: &str) -> CoreResult<Vec<TrialBalanceRow>> {
    let mut stmt = conn.prepare(
        "SELECT a.id AS coa_id, a.code AS code, a.name AS name, a.kind AS kind,
                COALESCE(SUM(l.debit_minor), 0) AS debit_minor,
                COALESCE(SUM(l.credit_minor), 0) AS credit_minor
         FROM chart_of_accounts a
         LEFT JOIN journal_lines l ON l.coa_id = a.id
         WHERE a.book_id = ?1
         GROUP BY a.id, a.code, a.name, a.kind
         ORDER BY a.code",
    )?;
    let rows = stmt
        .query_map(params![book_id], |row| {
            Ok(TrialBalanceRow {
                coa_id: row.get("coa_id")?,
                code: row.get("code")?,
                name: row.get("name")?,
                kind: col_enum(row, "kind")?,
                debit_minor: row.get("debit_minor")?,
                credit_minor: row.get("credit_minor")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
