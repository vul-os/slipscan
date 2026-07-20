//! Household members: CRUD, default-owner lookup, attribution reassignment,
//! and the split table.
//!
//! Raw SQL only — validation (sum invariants, book scoping) and the
//! reassign-or-refuse remove guard live in the service layer.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::domain::{Member, SplitShare, TransactionSplit};
use crate::error::CoreResult;
use crate::util::new_id;

fn map_member(row: &Row<'_>) -> rusqlite::Result<Member> {
    Ok(Member {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        label: row.get("label")?,
        initial: row.get("initial")?,
        colour: row.get("colour")?,
        default_account_id: row.get("default_account_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_split(row: &Row<'_>) -> rusqlite::Result<TransactionSplit> {
    Ok(TransactionSplit {
        id: row.get("id")?,
        transaction_id: row.get("transaction_id")?,
        member_id: row.get("member_id")?,
        share_minor: row.get("share_minor")?,
        created_at: row.get("created_at")?,
    })
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

pub fn insert(conn: &Connection, member: &Member) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO members (id, book_id, label, initial, colour, default_account_id,
                              created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            member.id,
            member.book_id,
            member.label,
            member.initial,
            member.colour,
            member.default_account_id,
            member.created_at,
            member.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<Member>> {
    Ok(conn
        .query_row(
            "SELECT * FROM members WHERE id = ?1",
            params![id],
            map_member,
        )
        .optional()?)
}

pub fn list(conn: &Connection, book_id: &str) -> CoreResult<Vec<Member>> {
    let mut stmt =
        conn.prepare("SELECT * FROM members WHERE book_id = ?1 ORDER BY created_at, id")?;
    let rows = stmt
        .query_map(params![book_id], map_member)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn count(conn: &Connection, book_id: &str) -> CoreResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM members WHERE book_id = ?1",
        params![book_id],
        |row| row.get(0),
    )?)
}

pub fn update(conn: &Connection, member: &Member) -> CoreResult<()> {
    conn.execute(
        "UPDATE members
         SET label = ?2, initial = ?3, colour = ?4, default_account_id = ?5, updated_at = ?6
         WHERE id = ?1",
        params![
            member.id,
            member.label,
            member.initial,
            member.colour,
            member.default_account_id,
            member.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("DELETE FROM members WHERE id = ?1", params![id])?;
    Ok(())
}

/// The member (if any) whose default account is `account_id` — seeds a new
/// transaction's attribution. Ties (two members somehow sharing a default
/// account) are broken deterministically by creation order; the schema does
/// not forbid it, it is just an unusual setup.
pub fn find_default_owner(
    conn: &Connection,
    book_id: &str,
    account_id: &str,
) -> CoreResult<Option<Member>> {
    Ok(conn
        .query_row(
            "SELECT * FROM members WHERE book_id = ?1 AND default_account_id = ?2
             ORDER BY created_at, id LIMIT 1",
            params![book_id, account_id],
            map_member,
        )
        .optional()?)
}

/// Does this member carry any attribution at all — single-attributed
/// transactions or split rows? Backs `member_remove`'s refuse-unless-
/// reassigned guard.
pub fn has_attributions(conn: &Connection, member_id: &str) -> CoreResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM transactions WHERE attributed_member_id = ?1)
          + (SELECT COUNT(*) FROM transaction_splits WHERE member_id = ?1)",
        params![member_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Move every attribution (single `attributed_member_id` and split rows)
/// from `from_id` to `to_id`. Where the target already holds a split row on
/// the same transaction, the source's share is folded into it (summed) and
/// the source row dropped, instead of colliding with the
/// `(transaction_id, member_id)` unique index.
pub fn reassign_attributions(conn: &Connection, from_id: &str, to_id: &str) -> CoreResult<()> {
    conn.execute(
        "UPDATE transactions SET attributed_member_id = ?2 WHERE attributed_member_id = ?1",
        params![from_id, to_id],
    )?;

    let mut stmt = conn.prepare("SELECT * FROM transaction_splits WHERE member_id = ?1")?;
    let splits = stmt
        .query_map(params![from_id], map_split)?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    for split in splits {
        let existing = conn
            .query_row(
                "SELECT * FROM transaction_splits WHERE transaction_id = ?1 AND member_id = ?2",
                params![split.transaction_id, to_id],
                map_split,
            )
            .optional()?;
        match existing {
            Some(target_row) => {
                conn.execute(
                    "UPDATE transaction_splits SET share_minor = share_minor + ?2 WHERE id = ?1",
                    params![target_row.id, split.share_minor],
                )?;
                conn.execute(
                    "DELETE FROM transaction_splits WHERE id = ?1",
                    params![split.id],
                )?;
            }
            None => {
                conn.execute(
                    "UPDATE transaction_splits SET member_id = ?2 WHERE id = ?1",
                    params![split.id, to_id],
                )?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------

pub fn splits_for_transaction(
    conn: &Connection,
    transaction_id: &str,
) -> CoreResult<Vec<TransactionSplit>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM transaction_splits WHERE transaction_id = ?1 ORDER BY created_at, id",
    )?;
    let rows = stmt
        .query_map(params![transaction_id], map_split)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Replace every split row for `transaction_id` with `shares`: delete then
/// insert, inside the caller's transaction. The sum-to-amount invariant is
/// validated by the service layer before this is ever called.
pub fn set_splits(
    conn: &Connection,
    transaction_id: &str,
    book_id: &str,
    shares: &[SplitShare],
    now: &str,
) -> CoreResult<()> {
    conn.execute(
        "DELETE FROM transaction_splits WHERE transaction_id = ?1",
        params![transaction_id],
    )?;
    for share in shares {
        conn.execute(
            "INSERT INTO transaction_splits (id, transaction_id, book_id, member_id,
                                             share_minor, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                new_id(),
                transaction_id,
                book_id,
                share.member_id,
                share.share_minor,
                now,
            ],
        )?;
    }
    Ok(())
}
