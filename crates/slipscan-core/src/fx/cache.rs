//! `fx_rates` cache: raw SQL, latest rate per pair, decimal stored as TEXT.
//!
//! Repo conventions apply — functions take a `&Connection`, no business
//! rules here. Staleness is *surfaced* by the service layer, never acted on:
//! a cached rate is served as-is with its `as_of`/`fetched_at` provenance,
//! and refreshing is always an explicit user action.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::CoreResult;

/// One cached pair, exactly as stored. `rate` stays a decimal string here;
/// the service layer parses it on use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FxRateRow {
    pub from_currency: String,
    pub to_currency: String,
    pub rate: String,
    pub as_of: String,
    pub grade: String,
    pub fetched_at: String,
}

fn map_row(row: &Row<'_>) -> rusqlite::Result<FxRateRow> {
    Ok(FxRateRow {
        from_currency: row.get("from_currency")?,
        to_currency: row.get("to_currency")?,
        rate: row.get("rate")?,
        as_of: row.get("as_of")?,
        grade: row.get("grade")?,
        fetched_at: row.get("fetched_at")?,
    })
}

/// Insert or replace the cached rate for a pair (latest-only cache).
pub fn upsert(conn: &Connection, row: &FxRateRow) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO fx_rates (from_currency, to_currency, rate, as_of, grade, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (from_currency, to_currency) DO UPDATE SET
             rate = excluded.rate,
             as_of = excluded.as_of,
             grade = excluded.grade,
             fetched_at = excluded.fetched_at",
        params![
            row.from_currency,
            row.to_currency,
            row.rate,
            row.as_of,
            row.grade,
            row.fetched_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, from: &str, to: &str) -> CoreResult<Option<FxRateRow>> {
    Ok(conn
        .query_row(
            "SELECT * FROM fx_rates WHERE from_currency = ?1 AND to_currency = ?2",
            params![from, to],
            map_row,
        )
        .optional()?)
}

pub fn list(conn: &Connection) -> CoreResult<Vec<FxRateRow>> {
    let mut stmt = conn.prepare("SELECT * FROM fx_rates ORDER BY from_currency, to_currency")?;
    let rows = stmt
        .query_map([], map_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn row(from: &str, to: &str, rate: &str) -> FxRateRow {
        FxRateRow {
            from_currency: from.into(),
            to_currency: to.into(),
            rate: rate.into(),
            as_of: "2026-07-17T16:00:00Z".into(),
            grade: "A".into(),
            fetched_at: "2026-07-18T08:00:00Z".into(),
        }
    }

    #[test]
    fn upsert_get_roundtrip_preserves_the_decimal_text() {
        let db = Db::open_in_memory().unwrap();
        let stored = row("USD", "ZAR", "18.074219053000000001");
        upsert(db.conn(), &stored).unwrap();
        let loaded = get(db.conn(), "USD", "ZAR").unwrap().unwrap();
        assert_eq!(loaded, stored);
        assert!(get(db.conn(), "ZAR", "USD").unwrap().is_none());
    }

    #[test]
    fn upsert_replaces_the_pair_latest_only() {
        let db = Db::open_in_memory().unwrap();
        upsert(db.conn(), &row("USD", "ZAR", "18.0")).unwrap();
        let mut newer = row("USD", "ZAR", "18.5");
        newer.grade = "B".into();
        upsert(db.conn(), &newer).unwrap();
        assert_eq!(list(db.conn()).unwrap(), vec![newer]);
    }

    #[test]
    fn list_orders_by_pair() {
        let db = Db::open_in_memory().unwrap();
        upsert(db.conn(), &row("USD", "ZAR", "18")).unwrap();
        upsert(db.conn(), &row("EUR", "ZAR", "20")).unwrap();
        let pairs: Vec<(String, String)> = list(db.conn())
            .unwrap()
            .into_iter()
            .map(|r| (r.from_currency, r.to_currency))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("EUR".to_string(), "ZAR".to_string()),
                ("USD".to_string(), "ZAR".to_string())
            ]
        );
    }
}
