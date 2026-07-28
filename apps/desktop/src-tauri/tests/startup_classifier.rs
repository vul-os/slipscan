//! The desktop shell must consult installed pack rules from the moment it
//! starts, not only in a session where the user installed a pack.
//!
//! `slipscan_packs::engine::register_classifier`'s own contract is "call it
//! once at startup, in every binary that imports transactions", and for a
//! long time the desktop's only caller was `commands::pack_install`. A
//! session that did not install a pack — essentially every session — skipped
//! every `contains`, `regex` and `keyword` rule already in the database.
//! Exact rules kept working, because installing seeds those into core's own
//! `merchant_mappings`, which is what made the gap quiet rather than absent.
//!
//! This file holds **exactly one test on purpose**. The classifier is a
//! process-wide `OnceLock`, so the "before" half of the proof — an import
//! that stays uncategorised because nothing is registered yet — is only
//! meaningful in a process where nothing else could have registered it. A
//! second test here, or a unit test in the crate that installs a pack, would
//! not make this one fail silently: the `assert!(register_pack_classifier())`
//! would fail loudly instead.

use slipscan_core::domain::{
    AccountKind, BookKind, NewAccount, NewBook, NewTransaction, TransactionSource,
};
use slipscan_core::secrets::MemorySecretStore;
use slipscan_core::{CoreService, Db};

#[test]
fn startup_registration_applies_contains_rules_without_installing_a_pack() {
    let service = CoreService::new(
        Db::open_in_memory().unwrap(),
        Box::new(MemorySecretStore::new()),
    );
    let book = service
        .book_create(NewBook {
            name: "Test".into(),
            kind: BookKind::Personal,
            currency: None,
            country: Some("ZA".into()),
            region: None,
        })
        .unwrap();
    let account = service
        .account_create(NewAccount {
            book_id: book.id.clone(),
            name: "Cheque".into(),
            kind: AccountKind::Bank,
            currency: "ZAR".into(),
            institution: None,
            account_number_masked: None,
            opening_balance_minor: None,
        })
        .unwrap();

    // Rules from some earlier session: written straight through the packs
    // library, which is not an IPC surface and registers nothing.
    service
        .with_connection(|conn| slipscan_packs::builtin::install_seed_packs(conn, &book.id))
        .unwrap();

    let import = |occurrence: u32| {
        service
            .transaction_create(NewTransaction {
                book_id: book.id.clone(),
                account_id: account.id.clone(),
                source: TransactionSource::Import,
                provider_txn_id: None,
                posted_date: "2026-07-01".into(),
                amount_minor: -45_900,
                currency: "ZAR".into(),
                // Matched only by za-personal's `contains "woolworths"` rule.
                // The seed packs declare no `exact` merchant rules at all, so
                // nothing was seeded into `merchant_mappings` to cover for a
                // missing classifier.
                merchant: Some("WOOLWORTHS SANDTON CITY".into()),
                description: None,
                notes: None,
                category_id: None,
                document_id: None,
                dedupe_occurrence: occurrence,
            })
            .unwrap()
    };

    assert!(
        import(0).category_id.is_none(),
        "with no classifier registered, pack rules are invisible to core — \
         this is exactly the bug being guarded"
    );

    // Exactly what `run()` does before the Tauri builder starts.
    assert!(
        slipscan_desktop_lib::register_pack_classifier(),
        "must be the first registration in this process; see this file's docs"
    );

    let categorised = import(1)
        .category_id
        .expect("the contains rule categorises once startup registered the classifier");
    let groceries = service
        .category_tree(&book.id)
        .unwrap()
        .iter()
        .find(|node| node.category.name == "Groceries")
        .map(|node| node.category.id.clone())
        .expect("za-personal declares a top-level Groceries category");
    assert_eq!(categorised, groceries);
}
