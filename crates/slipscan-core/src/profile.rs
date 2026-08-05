//! Book profiles (Phase 6.0 — the flowstock fold, entry point).
//!
//! One data model, three presentations. Every Phase 6 table (`locations`,
//! `contacts`, `product_categories`, `products`, `product_variants`) is
//! per-book and nullable, so personal / business / business-multi-location
//! is progressive disclosure over one schema — never a "business edition",
//! never a separate database, never a migration that moves a book between
//! tiers (ROADMAP.md "Phase 6" decision #1). [`resolve`] is the single place
//! that turns a book's `kind`, its `locations` row count, and its stored
//! override into the capability groups a UI should show. CLI, HTTP and the
//! desktop app all reach it through `CoreService::book_profile` rather than
//! re-deriving the rule at each surface — that duplication is exactly how
//! the three would drift out of step with each other and with reality.
//!
//! What is deliberately not modelled here: which *screens* exist for each
//! group (that is Phase 6.9, not built) and whether a group's underlying
//! rows are non-empty (a business book with zero contacts still shows the
//! Contacts screen — hiding it because it is empty would be a second, worse
//! kind of drift, and emptying it is one keystroke away from wrong: `book
//! set-kind personal` must never look at row counts to decide the answer).

use serde::{Deserialize, Serialize};

use crate::domain::BookKind;

/// The resolved shape of a book: which capability groups a UI should show,
/// and the inputs that decided it. Every field here is a *display* fact —
/// nothing in this struct ever gates a service-layer write; a personal book
/// whose UI has no Contacts screen can still be handed a `NewContact` and
/// core will accept it (Phase 6 decision #1: hiding is a screen concern, not
/// a schema one).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookProfile {
    pub kind: BookKind,

    /// Rows currently in `locations` for this book (archived included — see
    /// `repo::location::count`). Surfaced so a caller can explain *why*
    /// `multi_location` came out the way it did, not just what it is.
    pub location_count: i64,
    /// The book's stored override, verbatim: `None` when nobody has pinned
    /// one (the common case — the flag is left to derive), `Some(_)` when a
    /// business explicitly pinned it either way through Settings.
    pub multi_location_override: Option<bool>,
    /// The resolved flag: `multi_location_override.unwrap_or(location_count
    /// > 1)`. This, not `multi_location_override`, is what a UI branches on.
    pub multi_location: bool,

    // Personal-book groups. Always visible regardless of kind — a business
    // is a personal book plus more, never a personal book minus these.
    pub show_accounts: bool,
    pub show_transactions: bool,
    pub show_budgets: bool,
    pub show_members: bool,

    // Business-only groups (`BookKind::Business`).
    pub show_contacts: bool,
    pub show_catalogue: bool,
    pub show_purchasing: bool,
    pub show_sales: bool,
    /// The fixed-asset register (migration 0016, PARITY.md "Fixed assets") —
    /// a business capitalises and depreciates equipment, a personal book
    /// does not track this axis at all, same gating call as the other three
    /// business-only groups above.
    pub show_assets: bool,

    /// The location axis: business *and* multi-location. A single-location
    /// business runs one book against one implicit "everywhere", the same
    /// as a personal book — the location picker/column only earns its
    /// keep once there is more than one to distinguish (or the override
    /// says there will be).
    pub show_locations: bool,
}

/// Derive a [`BookProfile`] from a book's kind, its current `locations` row
/// count, and its stored override. Pure and total — no I/O, so every caller
/// (`CoreService::book_profile`, and any test) gets the identical answer for
/// the identical inputs, which is the whole point of centralising this
/// rather than letting three surfaces each write their own `if kind ==
/// "business"`.
pub fn resolve(
    kind: BookKind,
    location_count: i64,
    multi_location_override: Option<bool>,
) -> BookProfile {
    let multi_location = multi_location_override.unwrap_or(location_count > 1);
    let is_business = matches!(kind, BookKind::Business);
    BookProfile {
        kind,
        location_count,
        multi_location_override,
        multi_location,
        show_accounts: true,
        show_transactions: true,
        show_budgets: true,
        show_members: true,
        show_contacts: is_business,
        show_catalogue: is_business,
        show_purchasing: is_business,
        show_sales: is_business,
        show_assets: is_business,
        show_locations: is_business && multi_location,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personal_book_hides_every_business_group_regardless_of_locations_or_override() {
        let p = resolve(BookKind::Personal, 0, None);
        assert_eq!(p.kind, BookKind::Personal);
        assert!(p.show_accounts && p.show_transactions && p.show_budgets && p.show_members);
        assert!(
            !p.show_contacts
                && !p.show_catalogue
                && !p.show_purchasing
                && !p.show_sales
                && !p.show_assets
        );
        assert!(!p.show_locations);
        assert!(!p.multi_location);

        // Even a stray override or a nonzero location count on a personal
        // book (e.g. after a downgrade — decision #1: downgrading hides
        // screens, it never deletes rows) does not resurrect business
        // groups. Only `kind` gates them.
        let p = resolve(BookKind::Personal, 5, Some(true));
        assert!(!p.show_contacts && !p.show_catalogue && !p.show_assets);
        assert!(!p.show_locations, "locations need BookKind::Business too");
    }

    #[test]
    fn business_book_with_zero_or_one_location_hides_the_location_axis() {
        let zero = resolve(BookKind::Business, 0, None);
        assert!(
            zero.show_contacts
                && zero.show_catalogue
                && zero.show_purchasing
                && zero.show_sales
                && zero.show_assets
        );
        assert!(!zero.multi_location && !zero.show_locations);

        let one = resolve(BookKind::Business, 1, None);
        assert!(!one.multi_location && !one.show_locations);
    }

    #[test]
    fn multi_location_is_derived_from_more_than_one_location_row() {
        let two = resolve(BookKind::Business, 2, None);
        assert!(two.multi_location && two.show_locations);

        let many = resolve(BookKind::Business, 40, None);
        assert!(many.multi_location && many.show_locations);
    }

    #[test]
    fn override_wins_over_derivation_in_both_directions() {
        // The documented escape hatch: a business setting up its first
        // branch wants the axis before a second `locations` row exists.
        let early = resolve(BookKind::Business, 1, Some(true));
        assert!(early.multi_location && early.show_locations);

        // And the reverse: two locations but the flag pinned off (e.g. one
        // is about to close and the owner does not want the axis flapping
        // on and off around that).
        let pinned_off = resolve(BookKind::Business, 2, Some(false));
        assert!(!pinned_off.multi_location && !pinned_off.show_locations);
    }

    #[test]
    fn resolve_is_a_pure_function_of_its_three_inputs() {
        assert_eq!(
            resolve(BookKind::Business, 3, None),
            resolve(BookKind::Business, 3, None)
        );
    }
}
