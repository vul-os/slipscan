//! Quotes, sales orders and invoicing (migration 0014, ROADMAP.md Phase 6.5).
//!
//! Raw SQL only — validation (cross-book scoping, status-transition legality,
//! stock deduction) lives in the service layer, same as every other module
//! here. See the migration's own header for the three-table split this
//! module mirrors exactly: `quote*` and `sales_order*` functions read/write/
//! UPDATE freely (an editable draft); `invoice*` functions only ever INSERT
//! (an issued invoice is a fact) — there is no `invoice_update` here for the
//! identical reason `repo::stock` has no `update`: the schema's own triggers
//! would refuse it.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::domain::{
    AgedBucket, AgedReceivables, AgedReceivablesRow, Invoice, InvoiceItem, InvoicePayment,
    InvoicePaymentStatus, InvoiceTotals, Quote, QuoteItem, SalesOrder, SalesOrderItem,
    SalesOrderTotals,
};
use crate::error::CoreResult;
use crate::util::parse_date;
use crate::vat::vat_on_net;

use super::col_enum;

// ---------------------------------------------------------------------------
// Numbering (shared by both series — "sales_order" and "invoice")
// ---------------------------------------------------------------------------

/// Atomically hand out the next integer for `(book_id, series)` and return it.
///
/// **One statement, and it has to stay one statement.** The increment and the
/// read of the incremented value are a single UPSERT ... RETURNING, so there
/// is no window between them for a second caller to slip into. The obvious
/// shape — UPSERT, then `SELECT next_number` — is *not* equivalent: those are
/// two statements, and two callers interleaving them both read the winner's
/// value and hand out the same number. That version happens to be safe when
/// the caller wraps it in a write transaction (the write lock spans both
/// statements), which makes it the worst kind of correct: it depends on an
/// invariant at every call site, holds today, and fails silently the first
/// time someone allocates outside a transaction. `RETURNING` removes the
/// invariant instead of documenting it. Verified: with the two-statement form
/// restored, moving allocation outside the transaction does *not* turn
/// `service::tests::invoice_numbering_has_no_gap_or_duplicate_under_concurrent_issue`
/// red — the window is real but too narrow for 40 allocations to land in, so
/// no test was ever going to defend that invariant for us.
///
/// `RETURNING next_number - 1` is correct on both arms: the insert arm stores
/// 2 and returns 1; the conflict arm stores `old + 1` and returns `old`.
///
/// **Uniqueness** is this function's guarantee and needs nothing from the
/// caller. **Gaplessness** still does: the number must be stamped onto its row
/// inside the same transaction, so a transaction that rolls back for any other
/// reason rolls the increment back with it. See
/// `CoreService::invoice_issue`/`sales_order_create`.
pub fn allocate_number(conn: &Connection, book_id: &str, series: &str) -> CoreResult<i64> {
    let allocated: i64 = conn.query_row(
        "INSERT INTO number_sequences (book_id, series, next_number) VALUES (?1, ?2, 2)
         ON CONFLICT (book_id, series) DO UPDATE SET next_number = next_number + 1
         RETURNING next_number - 1",
        params![book_id, series],
        |row| row.get(0),
    )?;
    Ok(allocated)
}

// ---------------------------------------------------------------------------
// Sales orders
// ---------------------------------------------------------------------------

fn map_order(row: &Row<'_>) -> rusqlite::Result<SalesOrder> {
    Ok(SalesOrder {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        contact_id: row.get("contact_id")?,
        location_id: row.get("location_id")?,
        number: row.get("number")?,
        order_date: row.get("order_date")?,
        status: col_enum(row, "status")?,
        currency: row.get("currency")?,
        notes: row.get("notes")?,
        confirmed_at: row.get("confirmed_at")?,
        cancelled_at: row.get("cancelled_at")?,
        paid_at: row.get("paid_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn order_insert(conn: &Connection, order: &SalesOrder) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO sales_orders
             (id, book_id, contact_id, location_id, number, order_date, status,
              currency, notes, confirmed_at, cancelled_at, paid_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            order.id,
            order.book_id,
            order.contact_id,
            order.location_id,
            order.number,
            order.order_date,
            order.status.as_str(),
            order.currency,
            order.notes,
            order.confirmed_at,
            order.cancelled_at,
            order.paid_at,
            order.created_at,
            order.updated_at,
        ],
    )?;
    Ok(())
}

pub fn order_get(conn: &Connection, id: &str) -> CoreResult<Option<SalesOrder>> {
    Ok(conn
        .query_row(
            "SELECT * FROM sales_orders WHERE id = ?1",
            params![id],
            map_order,
        )
        .optional()?)
}

/// Every order in the book, most recent first.
pub fn order_list(conn: &Connection, book_id: &str) -> CoreResult<Vec<SalesOrder>> {
    let mut stmt =
        conn.prepare("SELECT * FROM sales_orders WHERE book_id = ?1 ORDER BY number DESC")?;
    let rows = stmt
        .query_map(params![book_id], map_order)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Full-row update. Covers both a header edit (location/date/notes, while
/// still a draft) and a status transition (confirm/cancel/mark-paid) — the
/// service layer decides which fields actually changed and hands back the
/// whole row either way, the same pattern `repo::location::update` uses.
pub fn order_update(conn: &Connection, order: &SalesOrder) -> CoreResult<()> {
    conn.execute(
        "UPDATE sales_orders
         SET contact_id = ?2, location_id = ?3, order_date = ?4, status = ?5,
             currency = ?6, notes = ?7, confirmed_at = ?8, cancelled_at = ?9,
             paid_at = ?10, updated_at = ?11
         WHERE id = ?1",
        params![
            order.id,
            order.contact_id,
            order.location_id,
            order.order_date,
            order.status.as_str(),
            order.currency,
            order.notes,
            order.confirmed_at,
            order.cancelled_at,
            order.paid_at,
            order.updated_at,
        ],
    )?;
    Ok(())
}

/// Hard delete. The service layer only ever calls this on a `draft` order —
/// nothing here re-checks that, the same trust boundary `repo::stock` places
/// on its caller for the invariants it can't express in SQL.
pub fn order_delete(conn: &Connection, id: &str) -> CoreResult<bool> {
    let n = conn.execute("DELETE FROM sales_orders WHERE id = ?1", params![id])?;
    Ok(n > 0)
}

fn map_order_item(row: &Row<'_>) -> rusqlite::Result<SalesOrderItem> {
    Ok(SalesOrderItem {
        id: row.get("id")?,
        sales_order_id: row.get("sales_order_id")?,
        book_id: row.get("book_id")?,
        variant_id: row.get("variant_id")?,
        description: row.get("description")?,
        quantity: row.get("quantity")?,
        unit_price_minor: row.get("unit_price_minor")?,
        tax_rate_bps: row.get("tax_rate_bps")?,
        line_order: row.get("line_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn order_item_insert(conn: &Connection, item: &SalesOrderItem) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO sales_order_items
             (id, sales_order_id, book_id, variant_id, description, quantity,
              unit_price_minor, tax_rate_bps, line_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            item.id,
            item.sales_order_id,
            item.book_id,
            item.variant_id,
            item.description,
            item.quantity,
            item.unit_price_minor,
            item.tax_rate_bps,
            item.line_order,
            item.created_at,
            item.updated_at,
        ],
    )?;
    Ok(())
}

pub fn order_item_get(conn: &Connection, id: &str) -> CoreResult<Option<SalesOrderItem>> {
    Ok(conn
        .query_row(
            "SELECT * FROM sales_order_items WHERE id = ?1",
            params![id],
            map_order_item,
        )
        .optional()?)
}

/// Every line on an order, in the order they were added.
pub fn order_item_list(conn: &Connection, sales_order_id: &str) -> CoreResult<Vec<SalesOrderItem>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM sales_order_items WHERE sales_order_id = ?1
         ORDER BY line_order, created_at, id",
    )?;
    let rows = stmt
        .query_map(params![sales_order_id], map_order_item)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn order_item_update(conn: &Connection, item: &SalesOrderItem) -> CoreResult<()> {
    conn.execute(
        "UPDATE sales_order_items
         SET description = ?2, quantity = ?3, unit_price_minor = ?4,
             tax_rate_bps = ?5, updated_at = ?6
         WHERE id = ?1",
        params![
            item.id,
            item.description,
            item.quantity,
            item.unit_price_minor,
            item.tax_rate_bps,
            item.updated_at,
        ],
    )?;
    Ok(())
}

pub fn order_item_delete(conn: &Connection, id: &str) -> CoreResult<bool> {
    let n = conn.execute("DELETE FROM sales_order_items WHERE id = ?1", params![id])?;
    Ok(n > 0)
}

/// `subtotal + tax == total`. VAT is computed per line (never on the summed
/// subtotal — two lines at different rates would give a different, wrong,
/// answer that way) and the whole thing is derived at query time from the
/// order's own items, never stored. See `SalesOrder`'s header note.
pub fn order_totals(conn: &Connection, sales_order_id: &str) -> CoreResult<SalesOrderTotals> {
    let items = order_item_list(conn, sales_order_id)?;
    line_totals(
        items
            .iter()
            .map(|i| (i.quantity, i.unit_price_minor, i.tax_rate_bps)),
    )
}

/// `pub(crate)` rather than private: migration `0017_recurring`'s
/// `CoreService::recurring_preview_summary` reuses this exact math for an
/// `Invoice`-kind schedule's line items rather than re-deriving it — the
/// same subtotal/tax/total shape whether the lines belong to a sales order,
/// an invoice, or a schedule template.
pub(crate) fn line_totals(
    lines: impl Iterator<Item = (i64, i64, i64)>,
) -> CoreResult<SalesOrderTotals> {
    let mut subtotal_minor = 0i64;
    let mut tax_minor = 0i64;
    for (quantity, unit_price_minor, tax_rate_bps) in lines {
        let line_subtotal = quantity * unit_price_minor;
        subtotal_minor += line_subtotal;
        tax_minor += vat_on_net(line_subtotal, tax_rate_bps);
    }
    Ok(SalesOrderTotals {
        subtotal_minor,
        tax_minor,
        total_minor: subtotal_minor + tax_minor,
    })
}

// ---------------------------------------------------------------------------
// Quotes — an even-earlier editable draft than a sales order. Same shape,
// same UPDATE-freely treatment as `sales_order*` above; `quote_accept`
// (service layer) is the only function that ever reads a quote's items back
// out to copy them into a new `sales_orders` row.
// ---------------------------------------------------------------------------

fn map_quote(row: &Row<'_>) -> rusqlite::Result<Quote> {
    Ok(Quote {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        contact_id: row.get("contact_id")?,
        number: row.get("number")?,
        quote_date: row.get("quote_date")?,
        expiry_date: row.get("expiry_date")?,
        status: col_enum(row, "status")?,
        currency: row.get("currency")?,
        notes: row.get("notes")?,
        sent_at: row.get("sent_at")?,
        accepted_at: row.get("accepted_at")?,
        declined_at: row.get("declined_at")?,
        expired_at: row.get("expired_at")?,
        converted_sales_order_id: row.get("converted_sales_order_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn quote_insert(conn: &Connection, quote: &Quote) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO quotes
             (id, book_id, contact_id, number, quote_date, expiry_date, status, currency,
              notes, sent_at, accepted_at, declined_at, expired_at, converted_sales_order_id,
              created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            quote.id,
            quote.book_id,
            quote.contact_id,
            quote.number,
            quote.quote_date,
            quote.expiry_date,
            quote.status.as_str(),
            quote.currency,
            quote.notes,
            quote.sent_at,
            quote.accepted_at,
            quote.declined_at,
            quote.expired_at,
            quote.converted_sales_order_id,
            quote.created_at,
            quote.updated_at,
        ],
    )?;
    Ok(())
}

pub fn quote_get(conn: &Connection, id: &str) -> CoreResult<Option<Quote>> {
    Ok(conn
        .query_row("SELECT * FROM quotes WHERE id = ?1", params![id], map_quote)
        .optional()?)
}

/// Every quote in the book, most recently numbered first.
pub fn quote_list(conn: &Connection, book_id: &str) -> CoreResult<Vec<Quote>> {
    let mut stmt = conn.prepare("SELECT * FROM quotes WHERE book_id = ?1 ORDER BY number DESC")?;
    let rows = stmt
        .query_map(params![book_id], map_quote)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Full-row update — a header edit (date/expiry/notes, while still a draft)
/// or a status transition, the same pattern `order_update` uses above.
pub fn quote_update(conn: &Connection, quote: &Quote) -> CoreResult<()> {
    conn.execute(
        "UPDATE quotes
         SET contact_id = ?2, quote_date = ?3, expiry_date = ?4, status = ?5, currency = ?6,
             notes = ?7, sent_at = ?8, accepted_at = ?9, declined_at = ?10, expired_at = ?11,
             converted_sales_order_id = ?12, updated_at = ?13
         WHERE id = ?1",
        params![
            quote.id,
            quote.contact_id,
            quote.quote_date,
            quote.expiry_date,
            quote.status.as_str(),
            quote.currency,
            quote.notes,
            quote.sent_at,
            quote.accepted_at,
            quote.declined_at,
            quote.expired_at,
            quote.converted_sales_order_id,
            quote.updated_at,
        ],
    )?;
    Ok(())
}

/// Hard delete. The service layer only ever calls this on a `draft` quote.
pub fn quote_delete(conn: &Connection, id: &str) -> CoreResult<bool> {
    let n = conn.execute("DELETE FROM quotes WHERE id = ?1", params![id])?;
    Ok(n > 0)
}

fn map_quote_item(row: &Row<'_>) -> rusqlite::Result<QuoteItem> {
    Ok(QuoteItem {
        id: row.get("id")?,
        quote_id: row.get("quote_id")?,
        book_id: row.get("book_id")?,
        variant_id: row.get("variant_id")?,
        description: row.get("description")?,
        quantity: row.get("quantity")?,
        unit_price_minor: row.get("unit_price_minor")?,
        tax_rate_bps: row.get("tax_rate_bps")?,
        line_order: row.get("line_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn quote_item_insert(conn: &Connection, item: &QuoteItem) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO quote_items
             (id, quote_id, book_id, variant_id, description, quantity,
              unit_price_minor, tax_rate_bps, line_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            item.id,
            item.quote_id,
            item.book_id,
            item.variant_id,
            item.description,
            item.quantity,
            item.unit_price_minor,
            item.tax_rate_bps,
            item.line_order,
            item.created_at,
            item.updated_at,
        ],
    )?;
    Ok(())
}

pub fn quote_item_get(conn: &Connection, id: &str) -> CoreResult<Option<QuoteItem>> {
    Ok(conn
        .query_row(
            "SELECT * FROM quote_items WHERE id = ?1",
            params![id],
            map_quote_item,
        )
        .optional()?)
}

/// Every line on a quote, in the order they were added.
pub fn quote_item_list(conn: &Connection, quote_id: &str) -> CoreResult<Vec<QuoteItem>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM quote_items WHERE quote_id = ?1
         ORDER BY line_order, created_at, id",
    )?;
    let rows = stmt
        .query_map(params![quote_id], map_quote_item)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn quote_item_update(conn: &Connection, item: &QuoteItem) -> CoreResult<()> {
    conn.execute(
        "UPDATE quote_items
         SET description = ?2, quantity = ?3, unit_price_minor = ?4,
             tax_rate_bps = ?5, updated_at = ?6
         WHERE id = ?1",
        params![
            item.id,
            item.description,
            item.quantity,
            item.unit_price_minor,
            item.tax_rate_bps,
            item.updated_at,
        ],
    )?;
    Ok(())
}

pub fn quote_item_delete(conn: &Connection, id: &str) -> CoreResult<bool> {
    let n = conn.execute("DELETE FROM quote_items WHERE id = ?1", params![id])?;
    Ok(n > 0)
}

/// `subtotal + tax == total`, derived at query time from the quote's own
/// items — identical rule to `order_totals` above, reusing its
/// `SalesOrderTotals` return type since the shape does not differ.
pub fn quote_totals(conn: &Connection, quote_id: &str) -> CoreResult<SalesOrderTotals> {
    let items = quote_item_list(conn, quote_id)?;
    line_totals(
        items
            .iter()
            .map(|i| (i.quantity, i.unit_price_minor, i.tax_rate_bps)),
    )
}

// ---------------------------------------------------------------------------
// Invoices — insert-only. See this module's own header and the migration's.
// ---------------------------------------------------------------------------

fn map_invoice(row: &Row<'_>) -> rusqlite::Result<Invoice> {
    Ok(Invoice {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        contact_id: row.get("contact_id")?,
        sales_order_id: row.get("sales_order_id")?,
        series: row.get("series")?,
        number: row.get("number")?,
        issue_date: row.get("issue_date")?,
        due_date: row.get("due_date")?,
        currency: row.get("currency")?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
    })
}

pub fn invoice_insert(conn: &Connection, invoice: &Invoice) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO invoices
             (id, book_id, contact_id, sales_order_id, series, number,
              issue_date, due_date, currency, notes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            invoice.id,
            invoice.book_id,
            invoice.contact_id,
            invoice.sales_order_id,
            invoice.series,
            invoice.number,
            invoice.issue_date,
            invoice.due_date,
            invoice.currency,
            invoice.notes,
            invoice.created_at,
        ],
    )?;
    Ok(())
}

pub fn invoice_get(conn: &Connection, id: &str) -> CoreResult<Option<Invoice>> {
    Ok(conn
        .query_row(
            "SELECT * FROM invoices WHERE id = ?1",
            params![id],
            map_invoice,
        )
        .optional()?)
}

/// Every invoice in the book, most recently issued first.
pub fn invoice_list(conn: &Connection, book_id: &str) -> CoreResult<Vec<Invoice>> {
    let mut stmt =
        conn.prepare("SELECT * FROM invoices WHERE book_id = ?1 ORDER BY series, number DESC")?;
    let rows = stmt
        .query_map(params![book_id], map_invoice)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn map_invoice_item(row: &Row<'_>) -> rusqlite::Result<InvoiceItem> {
    Ok(InvoiceItem {
        id: row.get("id")?,
        invoice_id: row.get("invoice_id")?,
        book_id: row.get("book_id")?,
        variant_id: row.get("variant_id")?,
        description: row.get("description")?,
        quantity: row.get("quantity")?,
        unit_price_minor: row.get("unit_price_minor")?,
        tax_rate_bps: row.get("tax_rate_bps")?,
        line_order: row.get("line_order")?,
        created_at: row.get("created_at")?,
    })
}

pub fn invoice_item_insert(conn: &Connection, item: &InvoiceItem) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO invoice_items
             (id, invoice_id, book_id, variant_id, description, quantity,
              unit_price_minor, tax_rate_bps, line_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            item.id,
            item.invoice_id,
            item.book_id,
            item.variant_id,
            item.description,
            item.quantity,
            item.unit_price_minor,
            item.tax_rate_bps,
            item.line_order,
            item.created_at,
        ],
    )?;
    Ok(())
}

pub fn invoice_item_list(conn: &Connection, invoice_id: &str) -> CoreResult<Vec<InvoiceItem>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM invoice_items WHERE invoice_id = ?1 ORDER BY line_order, created_at, id",
    )?;
    let rows = stmt
        .query_map(params![invoice_id], map_invoice_item)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn map_invoice_payment(row: &Row<'_>) -> rusqlite::Result<InvoicePayment> {
    Ok(InvoicePayment {
        id: row.get("id")?,
        invoice_id: row.get("invoice_id")?,
        book_id: row.get("book_id")?,
        amount_minor: row.get("amount_minor")?,
        paid_at: row.get("paid_at")?,
        method: row.get("method")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
    })
}

pub fn invoice_payment_insert(conn: &Connection, payment: &InvoicePayment) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO invoice_payments
             (id, invoice_id, book_id, amount_minor, paid_at, method, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            payment.id,
            payment.invoice_id,
            payment.book_id,
            payment.amount_minor,
            payment.paid_at,
            payment.method,
            payment.note,
            payment.created_at,
        ],
    )?;
    Ok(())
}

/// Every payment recorded against an invoice, oldest first.
pub fn invoice_payment_list(
    conn: &Connection,
    invoice_id: &str,
) -> CoreResult<Vec<InvoicePayment>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM invoice_payments WHERE invoice_id = ?1 ORDER BY paid_at, created_at, id",
    )?;
    let rows = stmt
        .query_map(params![invoice_id], map_invoice_payment)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn invoice_paid_minor(conn: &Connection, invoice_id: &str) -> CoreResult<i64> {
    let total: i64 = conn.query_row(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM invoice_payments WHERE invoice_id = ?1",
        params![invoice_id],
        |row| row.get(0),
    )?;
    Ok(total)
}

/// `subtotal + tax == total`, `paid + due == total`, `status` derived from
/// the two. See `InvoiceTotals`'s header note on why none of this is stored.
pub fn invoice_totals(conn: &Connection, invoice_id: &str) -> CoreResult<InvoiceTotals> {
    let items = invoice_item_list(conn, invoice_id)?;
    let SalesOrderTotals {
        subtotal_minor,
        tax_minor,
        total_minor,
    } = line_totals(
        items
            .iter()
            .map(|i| (i.quantity, i.unit_price_minor, i.tax_rate_bps)),
    )?;
    let paid_minor = invoice_paid_minor(conn, invoice_id)?;
    let due_minor = total_minor - paid_minor;
    let status = if paid_minor <= 0 {
        InvoicePaymentStatus::Unpaid
    } else if due_minor <= 0 {
        InvoicePaymentStatus::Paid
    } else {
        InvoicePaymentStatus::PartlyPaid
    };
    Ok(InvoiceTotals {
        subtotal_minor,
        tax_minor,
        total_minor,
        paid_minor,
        due_minor,
        status,
    })
}

// ---------------------------------------------------------------------------
// Aged receivables (PARITY.md's #2-ranked gap: "Contacts, then bills, then
// aged AR/AP — a chain")
// ---------------------------------------------------------------------------

/// Every invoice in the book with an outstanding balance as of `as_of`,
/// bucketed by contact and by how many days past `due_date` they are.
/// `O(invoices)`: each invoice's totals are computed the same way
/// `invoice_totals` does it (there is no cached total to sum instead of
/// deriving) — fine at small-business scale, and correct is worth more than
/// fast until it demonstrably isn't.
pub fn aged_receivables(
    conn: &Connection,
    book_id: &str,
    as_of: &str,
) -> CoreResult<AgedReceivables> {
    let mut stmt = conn.prepare(
        "SELECT id, contact_id, due_date FROM invoices WHERE book_id = ?1 ORDER BY due_date",
    )?;
    let outstanding: Vec<(String, String, String)> = stmt
        .query_map(params![book_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<Result<_, _>>()?;

    let mut by_contact: std::collections::BTreeMap<String, AgedBucket> =
        std::collections::BTreeMap::new();
    let as_of_date = parse_date(as_of)?;

    for (invoice_id, contact_id, due_date) in outstanding {
        let totals = invoice_totals(conn, &invoice_id)?;
        if totals.due_minor <= 0 {
            continue;
        }
        let age_days = (as_of_date - parse_date(&due_date)?).whole_days();
        let bucket = by_contact.entry(contact_id).or_default();
        bucket.total_minor += totals.due_minor;
        if age_days <= 0 {
            bucket.current_minor += totals.due_minor;
        } else if age_days <= 30 {
            bucket.overdue_1_30_minor += totals.due_minor;
        } else if age_days <= 60 {
            bucket.overdue_31_60_minor += totals.due_minor;
        } else if age_days <= 90 {
            bucket.overdue_61_90_minor += totals.due_minor;
        } else {
            bucket.overdue_90_plus_minor += totals.due_minor;
        }
    }

    let mut rows = Vec::with_capacity(by_contact.len());
    let mut grand_total = AgedBucket::default();
    for (contact_id, buckets) in by_contact {
        grand_total.current_minor += buckets.current_minor;
        grand_total.overdue_1_30_minor += buckets.overdue_1_30_minor;
        grand_total.overdue_31_60_minor += buckets.overdue_31_60_minor;
        grand_total.overdue_61_90_minor += buckets.overdue_61_90_minor;
        grand_total.overdue_90_plus_minor += buckets.overdue_90_plus_minor;
        grand_total.total_minor += buckets.total_minor;
        let contact_name = super::contact::get(conn, &contact_id)?
            .map(|c| c.name)
            .unwrap_or_else(|| "(unknown contact)".to_string());
        rows.push(AgedReceivablesRow {
            contact_id,
            contact_name,
            buckets,
        });
    }
    rows.sort_by(|a, b| a.contact_name.cmp(&b.contact_name));

    Ok(AgedReceivables {
        as_of: as_of.to_string(),
        rows,
        totals: grand_total,
    })
}
