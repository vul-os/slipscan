//! Regenerate `tests/schema_baseline.sql` from the migrations as they stand.
//!
//! The baseline is compared byte-for-byte by
//! `db::tests::schema_matches_the_pre_fold_baseline_byte_for_byte`, so it must
//! be produced by the same SQLite build the tests use — a system `sqlite3`
//! renders `sqlite_master` differently and silently produces a file that can
//! never match. Run with `cargo run -p slipscan-core --example
//! bless_schema_baseline` only when a schema change is intended, and read the
//! resulting diff before committing it.
fn main() {
    let db = slipscan_core::db::Db::open_in_memory().expect("open");
    let mut stmt = db
        .conn()
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        .expect("prepare");
    let rows: Vec<(String, String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("collect");
    let mut out = String::new();
    for (ty, name, sql) in &rows {
        out.push_str(&format!(
            "-- {ty} {name}\n{};\n\n",
            sql.clone().unwrap_or_default()
        ));
    }
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/schema_baseline.sql");
    std::fs::write(path, &out).expect("write");
    eprintln!("wrote {} objects to {path}", rows.len());
}
