//! Tauri IPC commands — thin adapters: parse → call core service → serialize.
//!
//! Command names match the contract in docs/ARCHITECTURE.md and the typed
//! client in `src/lib/api/client.ts` (`book_list`, `transaction_categorize`,
//! `document_import`, `recon_confirm`, …). Errors cross IPC as plain strings;
//! secret material never crosses IPC in any response — with exactly one
//! sanctioned exception: `pay_endpoint_add` / `pay_endpoint_rotate_secret`
//! return the just-generated webhook signing secret once (core's
//! [`slipscan_core::domain::PayEndpointWithSecret`] single-display contract,
//! needed so the receiver operator can configure verification), after which
//! it exists only in the vault.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use base64::Engine as _;
use sha2::{Digest, Sha256};
use tauri::State;

use slipscan_core::device::pairing::{KeynameCheck, PairingInviteMeta, DEFAULT_INVITE_TTL_SECONDS};
use slipscan_core::device::{DeviceIdentity, DevicePeer, DeviceRotation};
use slipscan_core::domain::{
    self as core, CategoryNode, DocumentKind, DocumentSource, JournalSourceType, NewDocument,
    NewJournal, NewJournalLine, TransactionFilter,
};
use slipscan_core::profile::BookProfile;
use slipscan_core::secrets::{SecretStore, SecretString, Vault};
use slipscan_core::util::{new_id, now_iso, today};
use slipscan_core::CoreService;

use crate::dto::{self, *};
use crate::state::AppState;

/// Settings key for the desktop UI's provider/appearance blob. Holds
/// keychain entry *names* at most — never secret material.
const UI_SETTINGS_KEY: &str = "desktop.settings";
/// Settings key for the vault's human-readable labels (metadata only).
const VAULT_LABELS_KEY: &str = "desktop.vault.labels";

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn book_by_id(service: &CoreService, book_id: &str) -> Result<core::Book, String> {
    service.book_get(book_id).map_err(err)
}

/// (id → name) lookup over the category tree.
type CategoryNames = HashMap<String, String>;
/// (id → kind) lookup over the category tree.
type CategoryKinds = HashMap<String, String>;

/// Flat (id → name) and (id → kind) lookups over the category tree.
fn category_maps(
    service: &CoreService,
    book_id: &str,
) -> Result<(CategoryNames, CategoryKinds), String> {
    fn walk(
        nodes: &[CategoryNode],
        names: &mut HashMap<String, String>,
        kinds: &mut HashMap<String, String>,
    ) {
        for n in nodes {
            names.insert(n.category.id.clone(), n.category.name.clone());
            kinds.insert(n.category.id.clone(), n.category.kind.as_str().to_string());
            walk(&n.children, names, kinds);
        }
    }
    let tree = service.category_tree(book_id).map_err(err)?;
    let mut names = HashMap::new();
    let mut kinds = HashMap::new();
    walk(&tree, &mut names, &mut kinds);
    Ok((names, kinds))
}

fn coa_names(service: &CoreService, book_id: &str) -> Result<HashMap<String, String>, String> {
    Ok(service
        .coa_list(book_id)
        .map_err(err)?
        .into_iter()
        .map(|c| (c.id, c.name))
        .collect())
}

// ---------------------------------------------------------------------------
// books / accounts
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn book_list(state: State<'_, AppState>) -> Result<Vec<BookDto>, String> {
    let service = state.service()?;
    let db_path = slipscan_core::datadir::db_path(&state.data_dir()?);
    let books = service.book_list().map_err(err)?;
    Ok(books.iter().map(|b| dto::book_dto(b, &db_path)).collect())
}

/// Create a book, then seed it the way a fresh install's book is seeded.
///
/// The payload is core's own [`core::NewBook`], so region and currency are
/// whatever the caller picked out of `region_list` — nothing jurisdictional
/// is decided here or anywhere below. Core rejects an unknown region id, and
/// falls back to the *generic* profile (never a country) when neither
/// `region` nor `country` is given; the currency comes from the chosen
/// profile's data when omitted.
///
/// Unlike the HTTP route of the same name, this also runs
/// [`crate::state::seed_book_contents`]: the desktop has no `coa_seed`
/// command, so a bare create would leave first-run setup holding a book with
/// no chart of accounts and no categories.
#[tauri::command]
pub async fn book_create(
    state: State<'_, AppState>,
    query: core::NewBook,
) -> Result<BookDto, String> {
    let service = state.service()?;
    let db_path = slipscan_core::datadir::db_path(&state.data_dir()?);
    let book = service.book_create(query).map_err(err)?;
    crate::state::seed_book_contents(&service, &book).map_err(err)?;
    Ok(dto::book_dto(&book, &db_path))
}

#[derive(serde::Deserialize)]
pub struct BookScopedQuery {
    pub book_id: String,
}

/// Resolve which capability groups this book should show right now —
/// personal / business / business-multi-location (Phase 6.0, ROADMAP.md
/// "Phase 6" — Book profiles). The one function Settings and first-run
/// setup both call instead of re-deriving `kind == "business"` themselves.
#[tauri::command]
pub async fn book_profile(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<BookProfile, String> {
    state.service()?.book_profile(&query.book_id).map_err(err)
}

#[derive(serde::Deserialize)]
pub struct BookSetKindQuery {
    pub book_id: String,
    pub kind: core::BookKind,
}

/// Change a book's kind later, in either direction — downgrading only
/// hides screens (see the core service doc comment); it deletes nothing in
/// `locations`, `contacts`, `product_categories`, `products` or
/// `product_variants`.
///
/// **One payload divergence from the HTTP route of the same name:** this
/// returns the resolved [`BookProfile`], not the updated `Book` — the
/// Settings screen that calls this redraws its capability list from the one
/// round trip rather than following up with a second `book_profile` call.
#[tauri::command]
pub async fn book_set_kind(
    state: State<'_, AppState>,
    query: BookSetKindQuery,
) -> Result<BookProfile, String> {
    let service = state.service()?;
    service
        .book_set_kind(&query.book_id, query.kind)
        .map_err(err)?;
    service.book_profile(&query.book_id).map_err(err)
}

#[derive(serde::Deserialize)]
pub struct BookSetMultiLocationOverrideQuery {
    pub book_id: String,
    /// Omitted or `null` clears the override back to derived; `true`/
    /// `false` pins it either way (Phase 6 decision #3).
    #[serde(default)]
    pub multi_location_override: Option<bool>,
}

/// Same payload divergence as `book_set_kind` above, for the same reason:
/// returns the resolved [`BookProfile`].
#[tauri::command]
pub async fn book_set_multi_location_override(
    state: State<'_, AppState>,
    query: BookSetMultiLocationOverrideQuery,
) -> Result<BookProfile, String> {
    let service = state.service()?;
    service
        .book_set_multi_location_override(&query.book_id, query.multi_location_override)
        .map_err(err)?;
    service.book_profile(&query.book_id).map_err(err)
}

// ---------------------------------------------------------------------------
// locations — branches, sites and warehouses (Phase 6.1, the flowstock fold
// foundation). Core's domain types serialize straight across IPC, the same
// pattern as household members.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn location_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::Location>, String> {
    state.service()?.location_list(&query.book_id).map_err(err)
}

#[tauri::command]
pub async fn location_create(
    state: State<'_, AppState>,
    query: core::NewLocation,
) -> Result<core::Location, String> {
    state.service()?.location_create(query).map_err(err)
}

#[tauri::command]
pub async fn location_update(
    state: State<'_, AppState>,
    query: LocationUpdateRequest,
) -> Result<core::Location, String> {
    let id = query.id.clone();
    state
        .service()?
        .location_update(&id, query.into_patch())
        .map_err(err)
}

#[derive(serde::Deserialize)]
pub struct LocationIdQuery {
    pub location_id: String,
}

#[tauri::command]
pub async fn location_delete(
    state: State<'_, AppState>,
    query: LocationIdQuery,
) -> Result<(), String> {
    state
        .service()?
        .location_delete(&query.location_id)
        .map_err(err)
}

// ---------------------------------------------------------------------------
// chart of accounts, journal generation, and the book lock date. Wired late:
// listing and seeding the chart, and posting/reading a journal, were here
// from the start — but nothing could add an account, map an entity to one,
// generate a journal from a transaction or document, reverse a posted
// journal, or set the lock date.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct CoaIdQuery {
    pub id: String,
}

#[derive(serde::Deserialize)]
pub struct CoaMapSetQuery {
    pub book_id: String,
    pub entity_type: core::CoaMapEntity,
    pub entity_id: String,
    pub coa_id: String,
}

#[derive(serde::Deserialize)]
pub struct JournalGenerateTxnQuery {
    pub transaction_id: String,
    #[serde(default)]
    pub vat_rate_id: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct JournalGenerateDocQuery {
    pub document_id: String,
}

#[derive(serde::Deserialize)]
pub struct JournalReverseQuery {
    pub journal_id: String,
    #[serde(default)]
    pub posted_date: Option<String>,
    #[serde(default)]
    pub narrative: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct BookLockDateQuery {
    pub book_id: String,
    #[serde(default)]
    pub lock_date: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct ClosePeriodQuery {
    pub book_id: String,
    pub to_date: String,
}

#[derive(serde::Deserialize)]
pub struct ReopenPeriodQuery {
    pub book_id: String,
    pub reason: String,
    #[serde(default)]
    pub to_date: Option<String>,
}

#[tauri::command]
pub async fn coa_create(
    state: State<'_, AppState>,
    query: core::NewCoaAccount,
) -> Result<LedgerAccountDto, String> {
    let coa = state.service()?.coa_create(query).map_err(err)?;
    Ok(ledger_account_dto(&coa))
}

/// Archive rather than delete — history is preserved, accounts are never
/// removed.
#[tauri::command]
pub async fn coa_archive(
    state: State<'_, AppState>,
    query: CoaIdQuery,
) -> Result<LedgerAccountDto, String> {
    let coa = state.service()?.coa_archive(&query.id).map_err(err)?;
    Ok(ledger_account_dto(&coa))
}

#[tauri::command]
pub async fn coa_map_set(
    state: State<'_, AppState>,
    query: CoaMapSetQuery,
) -> Result<core::CoaMapEntry, String> {
    state
        .service()?
        .coa_map_set(
            &query.book_id,
            query.entity_type,
            &query.entity_id,
            &query.coa_id,
        )
        .map_err(err)
}

#[tauri::command]
pub async fn journal_generate_for_transaction(
    state: State<'_, AppState>,
    query: JournalGenerateTxnQuery,
) -> Result<JournalEntryDto, String> {
    let service = state.service()?;
    let posted = service
        .journal_generate_for_transaction(&query.transaction_id, query.vat_rate_id.as_deref())
        .map_err(err)?;
    let names = coa_names(&service, &posted.journal.book_id)?;
    Ok(journal_entry_dto(&posted, |id| {
        names.get(id).cloned().unwrap_or_default()
    }))
}

#[tauri::command]
pub async fn journal_generate_for_document(
    state: State<'_, AppState>,
    query: JournalGenerateDocQuery,
) -> Result<JournalEntryDto, String> {
    let service = state.service()?;
    let posted = service
        .journal_generate_for_document(&query.document_id)
        .map_err(err)?;
    let names = coa_names(&service, &posted.journal.book_id)?;
    Ok(journal_entry_dto(&posted, |id| {
        names.get(id).cloned().unwrap_or_default()
    }))
}

/// A posted journal is immutable; a correction is a reversal.
#[tauri::command]
pub async fn journal_reverse(
    state: State<'_, AppState>,
    query: JournalReverseQuery,
) -> Result<JournalEntryDto, String> {
    let service = state.service()?;
    let posted = service
        .journal_reverse(
            &query.journal_id,
            query.posted_date.as_deref(),
            query.narrative.as_deref(),
        )
        .map_err(err)?;
    let names = coa_names(&service, &posted.journal.book_id)?;
    Ok(journal_entry_dto(&posted, |id| {
        names.get(id).cloned().unwrap_or_default()
    }))
}

#[tauri::command]
pub async fn book_set_lock_date(
    state: State<'_, AppState>,
    query: BookLockDateQuery,
) -> Result<core::Book, String> {
    state
        .service()?
        .book_set_lock_date(&query.book_id, query.lock_date.as_deref())
        .map_err(err)
}

/// Preview closing the period through `to_date` — every check
/// `close_period` performs, with no mutation whatsoever.
#[tauri::command]
pub async fn close_period_check(
    state: State<'_, AppState>,
    query: ClosePeriodQuery,
) -> Result<core::ClosePeriodReport, String> {
    state
        .service()?
        .close_period_check(&query.book_id, &query.to_date)
        .map_err(err)
}

/// Close the period through `to_date`. Advances the book's financial lock
/// date on success; refuses, naming every reason, when the trial balance
/// does not balance or the range is already closed.
#[tauri::command]
pub async fn close_period(
    state: State<'_, AppState>,
    query: ClosePeriodQuery,
) -> Result<core::ClosePeriodReport, String> {
    state
        .service()?
        .close_period(&query.book_id, &query.to_date)
        .map_err(err)
}

/// Reopen a closed period — a deliberate, audited act. `reason` is
/// required.
#[tauri::command]
pub async fn reopen_period(
    state: State<'_, AppState>,
    query: ReopenPeriodQuery,
) -> Result<core::Book, String> {
    state
        .service()?
        .reopen_period(&query.book_id, query.to_date.as_deref(), &query.reason)
        .map_err(err)
}

// ---------------------------------------------------------------------------
// stock — the append-only movement ledger (Phase 6.3b, the flowstock fold).
// On-hand is ALWAYS `SUM(qty_delta)` over immutable rows, never a stored
// counter, so there is deliberately no "set stock level" command: a
// correction is a new `adjustment` movement. Wired last — 6.3b shipped with
// none of its nine operations on any surface.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct VariantScopedQuery {
    pub variant_id: String,
}

#[derive(serde::Deserialize)]
pub struct StockOnHandQuery {
    pub variant_id: String,
    pub location_id: String,
}

#[derive(serde::Deserialize)]
pub struct LocationScopedQuery {
    pub location_id: String,
}

#[derive(serde::Deserialize)]
pub struct StockRefQuery {
    pub ref_kind: String,
    pub ref_id: String,
}

#[derive(serde::Deserialize)]
pub struct StockTransferQuery {
    pub variant_id: String,
    pub from_location_id: String,
    pub to_location_id: String,
    pub qty: i64,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub created_by: Option<String>,
}

#[tauri::command]
pub async fn stock_movement_record(
    state: State<'_, AppState>,
    query: core::NewStockMovement,
) -> Result<core::StockMovement, String> {
    state.service()?.stock_movement_record(query).map_err(err)
}

#[tauri::command]
pub async fn stock_on_hand(
    state: State<'_, AppState>,
    query: StockOnHandQuery,
) -> Result<i64, String> {
    state
        .service()?
        .stock_on_hand(&query.variant_id, &query.location_id)
        .map_err(err)
}

#[tauri::command]
pub async fn stock_on_hand_by_location(
    state: State<'_, AppState>,
    query: VariantScopedQuery,
) -> Result<Vec<(String, i64)>, String> {
    state
        .service()?
        .stock_on_hand_by_location(&query.variant_id)
        .map_err(err)
}

#[tauri::command]
pub async fn stock_on_hand_total(
    state: State<'_, AppState>,
    query: VariantScopedQuery,
) -> Result<i64, String> {
    state
        .service()?
        .stock_on_hand_total(&query.variant_id)
        .map_err(err)
}

#[tauri::command]
pub async fn stock_movements_for_variant(
    state: State<'_, AppState>,
    query: VariantScopedQuery,
) -> Result<Vec<core::StockMovement>, String> {
    state
        .service()?
        .stock_movements_for_variant(&query.variant_id)
        .map_err(err)
}

#[tauri::command]
pub async fn stock_movements_for_location(
    state: State<'_, AppState>,
    query: LocationScopedQuery,
) -> Result<Vec<core::StockMovement>, String> {
    state
        .service()?
        .stock_movements_for_location(&query.location_id)
        .map_err(err)
}

#[tauri::command]
pub async fn stock_movements_for_ref(
    state: State<'_, AppState>,
    query: StockRefQuery,
) -> Result<Vec<core::StockMovement>, String> {
    state
        .service()?
        .stock_movements_for_ref(&query.ref_kind, &query.ref_id)
        .map_err(err)
}

/// Two movements summing to zero, in one transaction.
#[tauri::command]
pub async fn stock_transfer(
    state: State<'_, AppState>,
    query: StockTransferQuery,
) -> Result<core::TransferResult, String> {
    state
        .service()?
        .stock_transfer(
            &query.variant_id,
            &query.from_location_id,
            &query.to_location_id,
            query.qty,
            query.note,
            query.created_by,
        )
        .map_err(err)
}

#[tauri::command]
pub async fn stock_low_variants(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::LowStockVariant>, String> {
    state
        .service()?
        .stock_low_variants(&query.book_id)
        .map_err(err)
}

// ---------------------------------------------------------------------------
// catalogue — product categories, products, and their variants (Phase 6.3a,
// the flowstock fold). Wired late, like contacts: only
// `product_variant_list_for_book` was on any surface, so an order line could
// name a `variant_id` nothing could create. The variant is the sellable and
// stockable unit — stock movements and order lines reference it, never the
// product.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct CatalogueIdQuery {
    pub id: String,
}

#[derive(serde::Deserialize)]
pub struct ProductCategoryRenameQuery {
    pub id: String,
    pub name: String,
}

#[derive(serde::Deserialize)]
pub struct ProductUpdateQuery {
    pub id: String,
    #[serde(flatten)]
    pub patch: core::ProductPatch,
}

#[derive(serde::Deserialize)]
pub struct ProductIdQuery {
    pub product_id: String,
}

#[derive(serde::Deserialize)]
pub struct ProductVariantUpdateQuery {
    pub id: String,
    #[serde(flatten)]
    pub patch: core::ProductVariantPatch,
}

#[tauri::command]
pub async fn product_category_create(
    state: State<'_, AppState>,
    query: core::NewProductCategory,
) -> Result<core::ProductCategory, String> {
    state.service()?.product_category_create(query).map_err(err)
}

#[tauri::command]
pub async fn product_category_get(
    state: State<'_, AppState>,
    query: CatalogueIdQuery,
) -> Result<core::ProductCategory, String> {
    state
        .service()?
        .product_category_get(&query.id)
        .map_err(err)
}

#[tauri::command]
pub async fn product_category_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::ProductCategory>, String> {
    state
        .service()?
        .product_category_list(&query.book_id)
        .map_err(err)
}

#[tauri::command]
pub async fn product_category_rename(
    state: State<'_, AppState>,
    query: ProductCategoryRenameQuery,
) -> Result<core::ProductCategory, String> {
    state
        .service()?
        .product_category_rename(&query.id, query.name)
        .map_err(err)
}

#[tauri::command]
pub async fn product_category_delete(
    state: State<'_, AppState>,
    query: CatalogueIdQuery,
) -> Result<(), String> {
    state
        .service()?
        .product_category_delete(&query.id)
        .map_err(err)
}

#[tauri::command]
pub async fn product_create(
    state: State<'_, AppState>,
    query: core::NewProduct,
) -> Result<core::Product, String> {
    state.service()?.product_create(query).map_err(err)
}

#[tauri::command]
pub async fn product_get(
    state: State<'_, AppState>,
    query: CatalogueIdQuery,
) -> Result<core::Product, String> {
    state.service()?.product_get(&query.id).map_err(err)
}

#[tauri::command]
pub async fn product_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::Product>, String> {
    state.service()?.product_list(&query.book_id).map_err(err)
}

#[tauri::command]
pub async fn product_update(
    state: State<'_, AppState>,
    query: ProductUpdateQuery,
) -> Result<core::Product, String> {
    state
        .service()?
        .product_update(&query.id, query.patch)
        .map_err(err)
}

#[tauri::command]
pub async fn product_delete(
    state: State<'_, AppState>,
    query: CatalogueIdQuery,
) -> Result<(), String> {
    state.service()?.product_delete(&query.id).map_err(err)
}

/// The sellable/stockable unit — the row that has to exist before a stock
/// movement or an order line can reference anything.
#[tauri::command]
pub async fn product_variant_add(
    state: State<'_, AppState>,
    query: core::NewProductVariant,
) -> Result<core::ProductVariant, String> {
    state.service()?.product_variant_add(query).map_err(err)
}

#[tauri::command]
pub async fn product_variant_get(
    state: State<'_, AppState>,
    query: CatalogueIdQuery,
) -> Result<core::ProductVariant, String> {
    state.service()?.product_variant_get(&query.id).map_err(err)
}

#[tauri::command]
pub async fn product_variant_list(
    state: State<'_, AppState>,
    query: ProductIdQuery,
) -> Result<Vec<core::ProductVariant>, String> {
    state
        .service()?
        .product_variant_list(&query.product_id)
        .map_err(err)
}

/// Every variant in the book, across all products — what a picker needs.
#[tauri::command]
pub async fn product_variant_list_for_book(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::ProductVariant>, String> {
    state
        .service()?
        .product_variant_list_for_book(&query.book_id)
        .map_err(err)
}

#[tauri::command]
pub async fn product_variant_update(
    state: State<'_, AppState>,
    query: ProductVariantUpdateQuery,
) -> Result<core::ProductVariant, String> {
    state
        .service()?
        .product_variant_update(&query.id, query.patch)
        .map_err(err)
}

#[tauri::command]
pub async fn product_variant_delete(
    state: State<'_, AppState>,
    query: CatalogueIdQuery,
) -> Result<(), String> {
    state
        .service()?
        .product_variant_delete(&query.id)
        .map_err(err)
}

// ---------------------------------------------------------------------------
// contacts — customers and suppliers in one table (Phase 6.2, the flowstock
// fold). Wired late: the model shipped with 6.2 but only `contact_list` was
// on any surface, so purchasing and sales could name a `contact_id` that
// nothing on this side could create. See `npm run reachable:check`.
//
// `ContactPatch` travels as-is rather than through a `dto.rs` request shape:
// its nullable fields use the plain JSON convention (omit to leave alone,
// null to clear), which is what `slipscan_core::util::double_option` makes
// work over the wire.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct ContactIdQuery {
    pub id: String,
}

#[derive(serde::Deserialize)]
pub struct ContactUpdateQuery {
    pub id: String,
    #[serde(flatten)]
    pub patch: core::ContactPatch,
}

#[tauri::command]
pub async fn contact_add(
    state: State<'_, AppState>,
    query: core::NewContact,
) -> Result<core::Contact, String> {
    state.service()?.contact_add(query).map_err(err)
}

#[tauri::command]
pub async fn contact_get(
    state: State<'_, AppState>,
    query: ContactIdQuery,
) -> Result<core::Contact, String> {
    state.service()?.contact_get(&query.id).map_err(err)
}

#[tauri::command]
pub async fn contact_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::Contact>, String> {
    state.service()?.contact_list(&query.book_id).map_err(err)
}

/// Customers only — role `customer` or `both`.
#[tauri::command]
pub async fn contact_list_customers(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::Contact>, String> {
    state
        .service()?
        .contact_list_customers(&query.book_id)
        .map_err(err)
}

/// Suppliers only — role `supplier` or `both`.
#[tauri::command]
pub async fn contact_list_suppliers(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::Contact>, String> {
    state
        .service()?
        .contact_list_suppliers(&query.book_id)
        .map_err(err)
}

#[tauri::command]
pub async fn contact_update(
    state: State<'_, AppState>,
    query: ContactUpdateQuery,
) -> Result<core::Contact, String> {
    state
        .service()?
        .contact_update(&query.id, query.patch)
        .map_err(err)
}

/// Hard delete, refused by the database when the contact has any trade
/// history — those FKs are `ON DELETE RESTRICT` on purpose.
#[tauri::command]
pub async fn contact_remove(
    state: State<'_, AppState>,
    query: ContactIdQuery,
) -> Result<(), String> {
    state.service()?.contact_remove(&query.id).map_err(err)
}

// ---------------------------------------------------------------------------
// purchasing — purchase orders, their line items, and goods receipts
// (Phase 6.4, the flowstock fold). No screen calls these yet — that is
// ROADMAP.md 6.9, "Desktop screens" — the same posture `book_profile` and
// the location CRUD above had before first-run setup and Settings needed
// them. `po_receive` is the keystone: it writes a stock movement in the same
// transaction as the receipt (`CoreService::po_receive`'s own doc comment),
// so on-hand and purchasing can never disagree about how much arrived.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn po_create(
    state: State<'_, AppState>,
    query: core::NewPurchaseOrder,
) -> Result<core::PurchaseOrder, String> {
    state.service()?.po_create(query).map_err(err)
}

#[tauri::command]
pub async fn po_get(
    state: State<'_, AppState>,
    query: PoIdQuery,
) -> Result<core::PurchaseOrder, String> {
    state.service()?.po_get(&query.po_id).map_err(err)
}

#[tauri::command]
pub async fn po_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::PurchaseOrder>, String> {
    state.service()?.po_list(&query.book_id).map_err(err)
}

#[tauri::command]
pub async fn po_update(
    state: State<'_, AppState>,
    query: PoUpdateRequest,
) -> Result<core::PurchaseOrder, String> {
    let id = query.id.clone();
    state
        .service()?
        .po_update(&id, query.into_patch())
        .map_err(err)
}

/// `draft -> ordered -> cancelled`, in either terminal direction from
/// `draft`, never reversible — see `CoreService::po_set_status`.
#[tauri::command]
pub async fn po_set_status(
    state: State<'_, AppState>,
    query: PoSetStatusRequest,
) -> Result<core::PurchaseOrder, String> {
    state
        .service()?
        .po_set_status(&query.po_id, query.status)
        .map_err(err)
}

#[tauri::command]
pub async fn po_delete(state: State<'_, AppState>, query: PoIdQuery) -> Result<(), String> {
    state.service()?.po_delete(&query.po_id).map_err(err)
}

#[tauri::command]
pub async fn po_item_add(
    state: State<'_, AppState>,
    query: core::NewPurchaseOrderItem,
) -> Result<core::PurchaseOrderItem, String> {
    state.service()?.po_item_add(query).map_err(err)
}

#[tauri::command]
pub async fn po_item_get(
    state: State<'_, AppState>,
    query: PoItemIdQuery,
) -> Result<core::PurchaseOrderItem, String> {
    state.service()?.po_item_get(&query.item_id).map_err(err)
}

#[tauri::command]
pub async fn po_item_list(
    state: State<'_, AppState>,
    query: PurchaseOrderIdQuery,
) -> Result<Vec<core::PurchaseOrderItem>, String> {
    state
        .service()?
        .po_item_list(&query.purchase_order_id)
        .map_err(err)
}

#[tauri::command]
pub async fn po_item_update(
    state: State<'_, AppState>,
    query: PoItemUpdateRequest,
) -> Result<core::PurchaseOrderItem, String> {
    let id = query.id.clone();
    state
        .service()?
        .po_item_update(&id, query.into_patch())
        .map_err(err)
}

#[tauri::command]
pub async fn po_item_delete(
    state: State<'_, AppState>,
    query: PoItemIdQuery,
) -> Result<(), String> {
    state.service()?.po_item_delete(&query.item_id).map_err(err)
}

/// Record one goods receipt against a line. Writes a stock movement in the
/// same transaction — see the module note above.
#[tauri::command]
pub async fn po_receive(
    state: State<'_, AppState>,
    query: core::NewPoReceipt,
) -> Result<core::PoReceipt, String> {
    state.service()?.po_receive(query).map_err(err)
}

#[tauri::command]
pub async fn po_receipts_for_item(
    state: State<'_, AppState>,
    query: PoItemIdQuery,
) -> Result<Vec<core::PoReceipt>, String> {
    state
        .service()?
        .po_receipts_for_item(&query.item_id)
        .map_err(err)
}

#[tauri::command]
pub async fn po_receipts_for_po(
    state: State<'_, AppState>,
    query: PurchaseOrderIdQuery,
) -> Result<Vec<core::PoReceipt>, String> {
    state
        .service()?
        .po_receipts_for_po(&query.purchase_order_id)
        .map_err(err)
}

#[tauri::command]
pub async fn po_item_received_qty(
    state: State<'_, AppState>,
    query: PoItemIdQuery,
) -> Result<i64, String> {
    state
        .service()?
        .po_item_received_qty(&query.item_id)
        .map_err(err)
}

#[tauri::command]
pub async fn po_item_receiving_status(
    state: State<'_, AppState>,
    query: PoItemIdQuery,
) -> Result<core::PoReceiptStatus, String> {
    state
        .service()?
        .po_item_receiving_status(&query.item_id)
        .map_err(err)
}

#[tauri::command]
pub async fn po_items_with_receiving(
    state: State<'_, AppState>,
    query: PurchaseOrderIdQuery,
) -> Result<Vec<core::PurchaseOrderItemReceiving>, String> {
    state
        .service()?
        .po_items_with_receiving(&query.purchase_order_id)
        .map_err(err)
}

#[tauri::command]
pub async fn po_receiving_status(
    state: State<'_, AppState>,
    query: PurchaseOrderIdQuery,
) -> Result<core::PoReceiptStatus, String> {
    state
        .service()?
        .po_receiving_status(&query.purchase_order_id)
        .map_err(err)
}

// ---------------------------------------------------------------------------
// Sales orders & invoicing (Phase 6.5 — ROADMAP.md "Inventory & trade",
// PARITY.md's single largest Xero-axis gap). See migration `0014_sales`'s
// header for why `sales_order*` is a full CRUD+status-machine surface while
// `invoice*` only ever creates and reads.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sales_order_create(
    state: State<'_, AppState>,
    query: core::NewSalesOrder,
) -> Result<core::SalesOrder, String> {
    state.service()?.sales_order_create(query).map_err(err)
}

#[derive(serde::Deserialize)]
pub struct SalesOrderIdQuery {
    pub id: String,
}

#[tauri::command]
pub async fn sales_order_get(
    state: State<'_, AppState>,
    query: SalesOrderIdQuery,
) -> Result<core::SalesOrder, String> {
    state.service()?.sales_order_get(&query.id).map_err(err)
}

#[tauri::command]
pub async fn sales_order_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::SalesOrder>, String> {
    state
        .service()?
        .sales_order_list(&query.book_id)
        .map_err(err)
}

#[derive(serde::Deserialize)]
pub struct SalesOrderUpdateQuery {
    pub id: String,
    #[serde(flatten)]
    pub patch: core::SalesOrderPatch,
}

#[tauri::command]
pub async fn sales_order_update(
    state: State<'_, AppState>,
    query: SalesOrderUpdateQuery,
) -> Result<core::SalesOrder, String> {
    state
        .service()?
        .sales_order_update(&query.id, query.patch)
        .map_err(err)
}

#[tauri::command]
pub async fn sales_order_delete(
    state: State<'_, AppState>,
    query: SalesOrderIdQuery,
) -> Result<(), String> {
    state.service()?.sales_order_delete(&query.id).map_err(err)
}

#[tauri::command]
pub async fn sales_order_item_add(
    state: State<'_, AppState>,
    query: core::NewSalesOrderItem,
) -> Result<core::SalesOrderItem, String> {
    state.service()?.sales_order_item_add(query).map_err(err)
}

#[derive(serde::Deserialize)]
pub struct SalesOrderIdRefQuery {
    pub sales_order_id: String,
}

#[tauri::command]
pub async fn sales_order_items_list(
    state: State<'_, AppState>,
    query: SalesOrderIdRefQuery,
) -> Result<Vec<core::SalesOrderItem>, String> {
    state
        .service()?
        .sales_order_items_list(&query.sales_order_id)
        .map_err(err)
}

#[derive(serde::Deserialize)]
pub struct SalesOrderItemUpdateQuery {
    pub id: String,
    #[serde(flatten)]
    pub patch: core::SalesOrderItemPatch,
}

#[tauri::command]
pub async fn sales_order_item_update(
    state: State<'_, AppState>,
    query: SalesOrderItemUpdateQuery,
) -> Result<core::SalesOrderItem, String> {
    state
        .service()?
        .sales_order_item_update(&query.id, query.patch)
        .map_err(err)
}

#[tauri::command]
pub async fn sales_order_item_remove(
    state: State<'_, AppState>,
    query: SalesOrderIdQuery,
) -> Result<(), String> {
    state
        .service()?
        .sales_order_item_remove(&query.id)
        .map_err(err)
}

#[tauri::command]
pub async fn sales_order_confirm(
    state: State<'_, AppState>,
    query: SalesOrderIdQuery,
) -> Result<core::SalesOrder, String> {
    state.service()?.sales_order_confirm(&query.id).map_err(err)
}

#[tauri::command]
pub async fn sales_order_cancel(
    state: State<'_, AppState>,
    query: SalesOrderIdQuery,
) -> Result<core::SalesOrder, String> {
    state.service()?.sales_order_cancel(&query.id).map_err(err)
}

#[tauri::command]
pub async fn sales_order_mark_paid(
    state: State<'_, AppState>,
    query: SalesOrderIdQuery,
) -> Result<core::SalesOrder, String> {
    state
        .service()?
        .sales_order_mark_paid(&query.id)
        .map_err(err)
}

#[tauri::command]
pub async fn sales_order_totals(
    state: State<'_, AppState>,
    query: SalesOrderIdQuery,
) -> Result<core::SalesOrderTotals, String> {
    state.service()?.sales_order_totals(&query.id).map_err(err)
}

#[tauri::command]
pub async fn invoice_issue(
    state: State<'_, AppState>,
    query: core::NewInvoice,
) -> Result<core::Invoice, String> {
    state.service()?.invoice_issue(query).map_err(err)
}

#[derive(serde::Deserialize)]
pub struct InvoiceIdQuery {
    pub id: String,
}

#[tauri::command]
pub async fn invoice_get(
    state: State<'_, AppState>,
    query: InvoiceIdQuery,
) -> Result<core::Invoice, String> {
    state.service()?.invoice_get(&query.id).map_err(err)
}

#[tauri::command]
pub async fn invoice_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::Invoice>, String> {
    state.service()?.invoice_list(&query.book_id).map_err(err)
}

#[derive(serde::Deserialize)]
pub struct InvoiceIdRefQuery {
    pub invoice_id: String,
}

#[tauri::command]
pub async fn invoice_items_list(
    state: State<'_, AppState>,
    query: InvoiceIdRefQuery,
) -> Result<Vec<core::InvoiceItem>, String> {
    state
        .service()?
        .invoice_items_list(&query.invoice_id)
        .map_err(err)
}

#[tauri::command]
pub async fn invoice_totals(
    state: State<'_, AppState>,
    query: InvoiceIdQuery,
) -> Result<core::InvoiceTotals, String> {
    state.service()?.invoice_totals(&query.id).map_err(err)
}

#[tauri::command]
pub async fn invoice_payment_record(
    state: State<'_, AppState>,
    query: core::NewInvoicePayment,
) -> Result<core::InvoicePayment, String> {
    state.service()?.invoice_payment_record(query).map_err(err)
}

#[tauri::command]
pub async fn invoice_payments_list(
    state: State<'_, AppState>,
    query: InvoiceIdRefQuery,
) -> Result<Vec<core::InvoicePayment>, String> {
    state
        .service()?
        .invoice_payments_list(&query.invoice_id)
        .map_err(err)
}

#[derive(serde::Deserialize)]
pub struct AgedReceivablesQuery {
    pub book_id: String,
    #[serde(default)]
    pub as_of: Option<String>,
}

#[tauri::command]
pub async fn report_aged_receivables(
    state: State<'_, AppState>,
    query: AgedReceivablesQuery,
) -> Result<core::AgedReceivables, String> {
    state
        .service()?
        .report_aged_receivables(&query.book_id, query.as_of.as_deref())
        .map_err(err)
}

#[tauri::command]
pub async fn account_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<AccountDto>, String> {
    let service = state.service()?;
    let accounts = service.account_list(&query.book_id).map_err(err)?;
    let txns = service
        .transaction_list(&query.book_id, &TransactionFilter::default())
        .map_err(err)?;
    let account_currency: HashMap<&str, &str> = accounts
        .iter()
        .map(|a| (a.id.as_str(), a.currency.as_str()))
        .collect();
    let mut sums: HashMap<&str, i64> = HashMap::new();
    for t in &txns {
        // An account balance is in the account's currency; transactions in
        // any other currency must not be summed into it.
        if account_currency.get(t.account_id.as_str()) != Some(&t.currency.as_str()) {
            continue;
        }
        *sums.entry(t.account_id.as_str()).or_insert(0) += t.amount_minor;
    }
    Ok(accounts
        .iter()
        .map(|a| dto::account_dto(a, sums.get(a.id.as_str()).copied().unwrap_or(0)))
        .collect())
}

// ---------------------------------------------------------------------------
// Net worth — periodic balance snapshots (PARITY.md "Net worth over time").
// Capture and backfill are both idempotent per `(account, date)` in core, so
// the Dashboard calls both on every load without growing the table without
// bound — see `slipscan_core::service::CoreService::networth_capture`.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn networth_capture(
    state: State<'_, AppState>,
    query: NetWorthCaptureQuery,
) -> Result<Vec<core::NetWorthSnapshot>, String> {
    let as_of_date = query.as_of_date.unwrap_or_else(slipscan_core::util::today);
    state
        .service()?
        .networth_capture(&query.book_id, &as_of_date)
        .map_err(err)
}

#[tauri::command]
pub async fn networth_backfill(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::NetWorthSnapshot>, String> {
    state
        .service()?
        .networth_backfill(&query.book_id)
        .map_err(err)
}

#[tauri::command]
pub async fn networth_series(
    state: State<'_, AppState>,
    query: NetWorthSeriesQuery,
) -> Result<core::NetWorthSeries, String> {
    state
        .service()?
        .networth_series(&query.book_id, &query.from, &query.to)
        .map_err(err)
}

// ---------------------------------------------------------------------------
// data folder — movable, per the "Data location & backup" contract. Backup is
// the user's own cloud pointed at this folder; SlipScan ships no backup
// service.
// ---------------------------------------------------------------------------

fn data_status_dto(state: &AppState) -> Result<DataStatusDto, String> {
    // Core's shared resolver computes the status (the CLI and server read
    // the same one); the desktop only adds the cloud-sync display hint.
    let status = slipscan_core::datadir::status(&state.resolver).map_err(err)?;
    let hint = crate::datadir::cloud_sync_hint(std::path::Path::new(&status.data_dir));
    Ok(DataStatusDto {
        cloud_sync_hint: hint.map(str::to_string),
        status,
    })
}

#[tauri::command]
pub async fn data_status(state: State<'_, AppState>) -> Result<DataStatusDto, String> {
    data_status_dto(&state)
}

#[derive(serde::Deserialize)]
pub struct DataMoveRequest {
    /// Target folder as a typed path (no dialog plugin is bundled — adding
    /// tauri-plugin-dialog would enable a native picker later); a leading
    /// `~` expands to the home dir.
    pub target: String,
    /// Adopt a folder that already contains a SlipScan database instead of
    /// copying into it ("open instead" — the current folder is left as-is).
    #[serde(default)]
    pub use_existing: bool,
}

/// Move (or with `use_existing`, switch) the data folder. One await for the
/// whole copy→verify→check→switch→cleanup sequence: the promise resolving IS
/// the completion signal, and while it is pending the app is read-only —
/// every other command blocks on the state locks held by the move.
#[tauri::command]
pub async fn data_move(
    state: State<'_, AppState>,
    query: DataMoveRequest,
) -> Result<DataStatusDto, String> {
    let target = expand_home(query.target.trim());
    if target.as_os_str().is_empty() {
        return Err("enter a destination folder".to_string());
    }
    if !target.is_absolute() {
        return Err(format!(
            "enter an absolute path (got \"{}\")",
            target.display()
        ));
    }
    // The copy is blocking filesystem work; hop off the async workers like
    // fx_fetch_rate does.
    tokio::task::block_in_place(|| state.move_data_dir(&target, query.use_existing))?;
    data_status_dto(&state)
}

/// `~` / `~/…` → the user's home directory. Anything else passes through.
fn expand_home(raw: &str) -> std::path::PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match (raw.strip_prefix("~"), home) {
        (Some(""), Some(home)) => std::path::PathBuf::from(home),
        (Some(rest), Some(home)) if rest.starts_with('/') || rest.starts_with('\\') => {
            std::path::Path::new(&home).join(&rest[1..])
        }
        _ => std::path::PathBuf::from(raw),
    }
}

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn transaction_list(
    state: State<'_, AppState>,
    query: TransactionListQuery,
) -> Result<Vec<TransactionDto>, String> {
    let service = state.service()?;
    let filter = TransactionFilter {
        account_id: query.account_id.clone(),
        category_id: query.category_id.clone(),
        status: None,
        from_date: query.from.clone(),
        to_date: query.to.clone(),
        limit: None,
    };
    let mut rows = service
        .transaction_list(&query.book_id, &filter)
        .map_err(err)?;
    if let Some(search) = query.search.as_deref().filter(|s| !s.is_empty()) {
        let needle = search.to_lowercase();
        rows.retain(|t| {
            t.description
                .as_deref()
                .unwrap_or("")
                .to_lowercase()
                .contains(&needle)
                || t.merchant
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&needle)
        });
    }
    let offset = query.offset.unwrap_or(0).min(rows.len());
    let mut rows = rows.split_off(offset);
    if let Some(limit) = query.limit {
        rows.truncate(limit as usize);
    }
    Ok(rows.iter().map(dto::transaction_dto).collect())
}

#[tauri::command]
pub async fn transaction_categorize(
    state: State<'_, AppState>,
    query: CategorizeQuery,
) -> Result<TransactionDto, String> {
    let service = state.service()?;
    let txn = match query.category_id.as_deref() {
        Some(category_id) => service
            .transaction_categorize(&query.transaction_id, category_id)
            .map_err(err)?,
        // `category_id: null` clears the category (back to Uncategorised).
        None => service
            .transaction_uncategorize(&query.transaction_id)
            .map_err(err)?,
    };
    Ok(dto::transaction_dto(&txn))
}

#[tauri::command]
pub async fn category_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<CategoryDto>, String> {
    let service = state.service()?;
    let tree = service.category_tree(&query.book_id).map_err(err)?;
    Ok(dto::category_dtos(&tree))
}

// ---------------------------------------------------------------------------
// household members & per-person attribution — see ARCHITECTURE.md
// "Household members & per-person attribution". Members are local data, not
// logins; attribution is metadata that never touches debits/credits. Core's
// domain types serialize straight across IPC (same pattern as vat rates / FX
// / payments) — the only translation needed is `MemberUpdateRequest`'s
// clear-flag, because plain JSON can't express nested-Option "explicit null".
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn member_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::Member>, String> {
    state.service()?.member_list(&query.book_id).map_err(err)
}

#[tauri::command]
pub async fn member_add(
    state: State<'_, AppState>,
    query: core::NewMember,
) -> Result<core::Member, String> {
    state.service()?.member_add(query).map_err(err)
}

#[tauri::command]
pub async fn member_update(
    state: State<'_, AppState>,
    query: MemberUpdateRequest,
) -> Result<core::Member, String> {
    let id = query.id.clone();
    state
        .service()?
        .member_update(&id, query.into_patch())
        .map_err(err)
}

#[tauri::command]
pub async fn member_remove(
    state: State<'_, AppState>,
    query: MemberRemoveRequest,
) -> Result<(), String> {
    state
        .service()?
        .member_remove(&query.id, query.reassign_to.as_deref())
        .map_err(err)
}

/// Override (or clear, with `member_id: null`) a transaction's attribution.
/// Metadata only — never touches amount/currency/category.
#[tauri::command]
pub async fn transaction_attribute(
    state: State<'_, AppState>,
    query: TransactionAttributeRequest,
) -> Result<TransactionDto, String> {
    let service = state.service()?;
    let txn = service
        .transaction_attribute(&query.transaction_id, query.member_id.as_deref())
        .map_err(err)?;
    Ok(dto::transaction_dto(&txn))
}

#[tauri::command]
pub async fn transaction_splits_list(
    state: State<'_, AppState>,
    query: TransactionIdQuery,
) -> Result<Vec<core::TransactionSplit>, String> {
    state
        .service()?
        .transaction_splits_list(&query.transaction_id)
        .map_err(err)
}

/// Replace a transaction's split set; an empty `shares` list clears the
/// split (back to single-member attribution / unattributed).
#[tauri::command]
pub async fn transaction_split_set(
    state: State<'_, AppState>,
    query: TransactionSplitSetRequest,
) -> Result<Vec<core::TransactionSplit>, String> {
    state
        .service()?
        .transaction_split_set(&query.transaction_id, query.shares)
        .map_err(err)
}

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct BudgetListQuery {
    pub book_id: String,
    pub month: String,
}

#[tauri::command]
pub async fn budget_list(
    state: State<'_, AppState>,
    query: BudgetListQuery,
) -> Result<Vec<BudgetWithSpendDto>, String> {
    let service = state.service()?;
    let (names, _) = category_maps(&service, &query.book_id)?;
    let status = service
        .budget_status(&query.book_id, &query.month)
        .map_err(err)?;
    // budget_status carries spend vs budget; the stored rows carry the
    // rollover flag and created_at — join them by category.
    let stored: HashMap<String, core::Budget> = service
        .budget_list(&query.book_id, &query.month)
        .map_err(err)?
        .into_iter()
        .map(|b| (b.category_id.clone(), b))
        .collect();
    Ok(status
        .into_iter()
        .map(|s| BudgetWithSpendDto {
            category_name: names
                .get(&s.category_id)
                .cloned()
                .unwrap_or_else(|| "—".to_string()),
            budget: BudgetDto {
                // budget_status is keyed by (category, month); that pair is
                // the stable identity the list UI needs.
                id: format!("{}:{}", s.category_id, s.month),
                book_id: query.book_id.clone(),
                rollover: stored.get(&s.category_id).is_some_and(|b| b.rollover),
                created_at: stored
                    .get(&s.category_id)
                    .map(|b| b.created_at.clone())
                    .unwrap_or_default(),
                category_id: s.category_id,
                month: s.month,
                amount_minor: s.budget_minor,
                currency: s.currency,
            },
            spent_minor: s.spent_minor,
        })
        .collect())
}

#[tauri::command]
pub async fn budget_upsert(
    state: State<'_, AppState>,
    query: core::BudgetUpsert,
) -> Result<BudgetDto, String> {
    let service = state.service()?;
    let budget = service.budget_upsert(query).map_err(err)?;
    Ok(dto::budget_dto(&budget))
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

fn document_with_extraction(
    service: &CoreService,
    doc: &core::Document,
    book_currency: &str,
) -> Result<DocumentDto, String> {
    let payload = match doc.status {
        core::DocumentStatus::Extracted | core::DocumentStatus::Reviewed => service
            .document_current_extraction(&doc.id)
            .map_err(err)?
            .and_then(|e| e.payload),
        _ => None,
    };
    Ok(dto::document_dto(doc, payload.as_deref(), book_currency))
}

#[tauri::command]
pub async fn document_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<DocumentDto>, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    let mut docs = service.document_list(&query.book_id, None).map_err(err)?;
    docs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    docs.iter()
        .map(|d| document_with_extraction(&service, d, &book.currency))
        .collect()
}

#[derive(serde::Deserialize)]
pub struct DocumentGetQuery {
    pub document_id: String,
}

#[tauri::command]
pub async fn document_get(
    state: State<'_, AppState>,
    query: DocumentGetQuery,
) -> Result<DocumentDto, String> {
    let service = state.service()?;
    let doc = service.document_get(&query.document_id).map_err(err)?;
    let book = book_by_id(&service, &doc.book_id)?;
    document_with_extraction(&service, &doc, &book.currency)
}

#[tauri::command]
pub async fn document_import(
    state: State<'_, AppState>,
    query: DocumentImportRequest,
) -> Result<DocumentDto, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;

    let bytes: Vec<u8> = if let Some(b64) = query.bytes_base64.as_deref() {
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("invalid base64 file payload: {e}"))?
    } else if let Some(path) = query.path.as_deref() {
        std::fs::read(path).map_err(|e| format!("cannot read {path}: {e}"))?
    } else {
        return Err("document_import needs bytes_base64 or path".to_string());
    };

    let sha256 = {
        let digest = Sha256::digest(&bytes);
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };

    // Keep the stored name collision-free but recognisable.
    let safe_name: String = query
        .file_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let dest = slipscan_core::datadir::documents_dir(&state.data_dir()?)
        .join(format!("{}-{safe_name}", new_id()));
    std::fs::write(&dest, &bytes).map_err(|e| format!("cannot store document: {e}"))?;

    let lower = query.file_name.to_lowercase();
    let kind = if lower.contains("invoice") {
        DocumentKind::Invoice
    } else if lower.contains("statement") {
        DocumentKind::BankStatement
    } else {
        DocumentKind::Slip
    };

    let imported = service.document_import(NewDocument {
        book_id: query.book_id.clone(),
        source: DocumentSource::Upload,
        kind,
        file_path: dest.display().to_string(),
        mime_type: Some(query.mime_type.clone()),
        size_bytes: Some(bytes.len() as i64),
        original_name: Some(query.file_name.clone()),
        sha256: Some(sha256),
    });
    match imported {
        Ok(doc) => document_with_extraction(&service, &doc, &book.currency),
        Err(e) => {
            let _ = std::fs::remove_file(&dest);
            Err(err(e))
        }
    }
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ledger_account_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<LedgerAccountDto>, String> {
    let service = state.service()?;
    let coa = service.coa_list(&query.book_id).map_err(err)?;
    Ok(coa.iter().map(dto::ledger_account_dto).collect())
}

#[tauri::command]
pub async fn journal_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<JournalEntryDto>, String> {
    let service = state.service()?;
    let names = coa_names(&service, &query.book_id)?;
    let mut journals = service
        .journal_list(&query.book_id, "0000-01-01", "9999-12-31")
        .map_err(err)?;
    journals.sort_by(|a, b| b.journal.posted_date.cmp(&a.journal.posted_date));
    Ok(journals
        .iter()
        .map(|p| {
            dto::journal_entry_dto(p, |id| {
                names.get(id).cloned().unwrap_or_else(|| "—".to_string())
            })
        })
        .collect())
}

#[tauri::command]
pub async fn journal_post(
    state: State<'_, AppState>,
    query: JournalPostRequest,
) -> Result<JournalEntryDto, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    let names = coa_names(&service, &query.book_id)?;
    let (source_type, source_id) = match query.source_document_id.clone() {
        Some(doc_id) => (JournalSourceType::Document, Some(doc_id)),
        None => (JournalSourceType::Manual, None),
    };
    let posted = service
        .journal_post(NewJournal {
            book_id: query.book_id.clone(),
            posted_date: query.entry_date.clone(),
            narrative: Some(query.memo.clone()).filter(|m| !m.is_empty()),
            reference: None,
            source_type,
            source_id,
            lines: query
                .lines
                .iter()
                .map(|l| NewJournalLine {
                    coa_id: l.ledger_account_id.clone(),
                    debit_minor: l.debit_minor,
                    credit_minor: l.credit_minor,
                    currency: book.currency.clone(),
                    description: None,
                    vat_rate_id: None,
                    vat_role: None,
                })
                .collect(),
        })
        .map_err(err)?;
    Ok(dto::journal_entry_dto(&posted, |id| {
        names.get(id).cloned().unwrap_or_else(|| "—".to_string())
    }))
}

// ---------------------------------------------------------------------------
// recon
// ---------------------------------------------------------------------------

fn recon_dto(
    service: &CoreService,
    book_currency: &str,
    m: &core::ReconMatch,
) -> Result<ReconSuggestionDto, String> {
    let txn = service.transaction_get(&m.transaction_id).map_err(err)?;
    let txn_dto = dto::transaction_dto(&txn);
    let (counterpart_id, merchant, total_minor) = if let Some(doc_id) = m.document_id.as_deref() {
        let doc = service.document_get(doc_id).map_err(err)?;
        let dto = document_with_extraction(service, &doc, book_currency)?;
        (
            doc_id.to_string(),
            dto.merchant.unwrap_or(dto.file_name),
            dto.total_minor.unwrap_or_else(|| txn.amount_minor.abs()),
        )
    } else if let Some(journal_id) = m.journal_id.as_deref() {
        let posted = service.journal_get(journal_id).map_err(err)?;
        (
            journal_id.to_string(),
            posted
                .journal
                .narrative
                .clone()
                .unwrap_or_else(|| "Journal entry".to_string()),
            txn.amount_minor.abs(),
        )
    } else {
        (String::new(), "—".to_string(), txn.amount_minor.abs())
    };
    Ok(ReconSuggestionDto {
        id: m.id.clone(),
        book_id: m.book_id.clone(),
        transaction_id: m.transaction_id.clone(),
        document_id: counterpart_id,
        score: m.confidence,
        status: dto::recon_state_str(m.state).to_string(),
        transaction_description: if txn_dto.description.is_empty() {
            txn_dto.merchant.clone().unwrap_or_default()
        } else {
            txn_dto.description
        },
        transaction_amount_minor: txn.amount_minor,
        document_merchant: merchant,
        document_total_minor: total_minor,
        currency: txn.currency.clone(),
        created_at: m.created_at.clone(),
    })
}

#[tauri::command]
pub async fn recon_suggest(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<ReconSuggestionDto>, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    let matches = service.recon_suggest(&query.book_id).map_err(err)?;
    matches
        .iter()
        .map(|m| recon_dto(&service, &book.currency, m))
        .collect()
}

#[tauri::command]
pub async fn recon_confirm(
    state: State<'_, AppState>,
    query: ReconConfirmRequest,
) -> Result<ReconSuggestionDto, String> {
    let service = state.service()?;
    let updated = if query.accept {
        service.recon_confirm(&query.suggestion_id).map_err(err)?
    } else {
        service.recon_reject(&query.suggestion_id).map_err(err)?
    };
    let book = book_by_id(&service, &updated.book_id)?;
    recon_dto(&service, &book.currency, &updated)
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct SpendingQuery {
    pub book_id: String,
    pub from: String,
    pub to: String,
}

#[tauri::command]
pub async fn report_spending(
    state: State<'_, AppState>,
    query: SpendingQuery,
) -> Result<SpendingReportDto, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    // Core rows are per (category, currency); this DTO is single-currency
    // (the book's base), so other-currency rows are excluded, never summed.
    let rows: Vec<_> = service
        .report_spending(&query.book_id, &query.from, &query.to)
        .map_err(err)?
        .into_iter()
        .filter(|r| r.currency == book.currency)
        .collect();
    let total: i64 = rows.iter().map(|r| r.total_minor).sum();
    Ok(SpendingReportDto {
        book_id: query.book_id.clone(),
        from: query.from.clone(),
        to: query.to.clone(),
        currency: book.currency,
        total_spent_minor: total,
        by_category: rows
            .into_iter()
            .map(|r| SpendingByCategoryDto {
                category_id: r.category_id.unwrap_or_else(|| "uncategorized".to_string()),
                category_name: r.category_name,
                amount_minor: r.total_minor,
                share: if total == 0 {
                    0.0
                } else {
                    r.total_minor as f64 / total as f64
                },
            })
            .collect(),
    })
}

#[tauri::command]
pub async fn report_income_expense(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<IncomeExpenseReportDto, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    let (_, kinds) = category_maps(&service, &query.book_id)?;
    let txns = service
        .transaction_list(&query.book_id, &TransactionFilter::default())
        .map_err(err)?;

    // Group by calendar month; transfers between own accounts stay out, and
    // so do transactions in other currencies (the DTO is single-currency).
    let mut by_month: std::collections::BTreeMap<String, (i64, i64)> = Default::default();
    for t in &txns {
        if t.posted_date.len() < 7 || t.currency != book.currency {
            continue;
        }
        let is_transfer = t
            .category_id
            .as_deref()
            .and_then(|id| kinds.get(id))
            .is_some_and(|k| k == "transfer");
        if is_transfer {
            continue;
        }
        let entry = by_month
            .entry(t.posted_date[..7].to_string())
            .or_insert((0, 0));
        if t.amount_minor >= 0 {
            entry.0 += t.amount_minor;
        } else {
            entry.1 += -t.amount_minor;
        }
    }
    let months: Vec<IncomeExpensePointDto> = by_month
        .into_iter()
        .map(|(month, (income, expense))| IncomeExpensePointDto {
            month,
            income_minor: income,
            expense_minor: expense,
        })
        .collect();
    let start = months.len().saturating_sub(6);
    Ok(IncomeExpenseReportDto {
        book_id: query.book_id.clone(),
        currency: book.currency,
        months: months[start..].to_vec(),
    })
}

#[tauri::command]
pub async fn report_vat_summary(
    state: State<'_, AppState>,
    query: MemberReportQuery,
) -> Result<VatSummaryDto, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    let summary = service
        .report_tax_summary(&query.book_id, &query.from, &query.to)
        .map_err(err)?;
    Ok(VatSummaryDto {
        book_id: query.book_id.clone(),
        from: query.from.clone(),
        to: query.to.clone(),
        currency: book.currency,
        // Report name + box labels come from the book's region profile
        // ("VAT201" for za, "Tax summary" generically) — never hardcoded.
        report_name: summary.report_name,
        labels: summary.labels,
        output_vat_minor: summary.output_vat_minor,
        input_vat_minor: summary.input_vat_minor,
        net_vat_minor: summary.net_vat_minor,
    })
}

/// Income statement (profit & loss) over an inclusive posted-date range —
/// core's own `report_income_statement`, passed straight through with no
/// DTO reshaping (its shape is already what the UI needs: per-account rows,
/// totals, and the exact period they cover).
#[tauri::command]
pub async fn report_income_statement(
    state: State<'_, AppState>,
    query: MemberReportQuery,
) -> Result<core::IncomeStatement, String> {
    state
        .service()?
        .report_income_statement(&query.book_id, &query.from, &query.to)
        .map_err(err)
}

/// Balance sheet as of a date — `as_of` defaults to today when omitted.
#[tauri::command]
pub async fn report_balance_sheet(
    state: State<'_, AppState>,
    query: AsOfQuery,
) -> Result<core::BalanceSheet, String> {
    let service = state.service()?;
    let as_of = query.as_of.unwrap_or_else(today);
    service
        .report_balance_sheet(&query.book_id, &as_of)
        .map_err(err)
}

#[tauri::command]
pub async fn report_trial_balance(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<TrialBalanceDto, String> {
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    let rows = service.report_trial_balance(&query.book_id).map_err(err)?;
    // The DTO is single-currency (book base): rows in other currencies are
    // excluded so the debit/credit totals below never mix currencies.
    let rows: Vec<TrialBalanceRowDto> = rows
        .into_iter()
        .filter(|r| r.currency == book.currency)
        .map(|r| TrialBalanceRowDto {
            ledger_account_id: r.coa_id,
            code: r.code,
            name: r.name,
            kind: r.kind.as_str().to_string(),
            debit_minor: r.debit_minor,
            credit_minor: r.credit_minor,
        })
        .collect();
    Ok(TrialBalanceDto {
        book_id: query.book_id.clone(),
        as_of: now_iso().chars().take(10).collect(),
        currency: book.currency,
        total_debit_minor: rows.iter().map(|r| r.debit_minor).sum(),
        total_credit_minor: rows.iter().map(|r| r.credit_minor).sum(),
        rows,
    })
}

/// Per-member outflow (expense) totals over the period, in the book's base
/// currency. Split shares are distributed; unattributed spend rolls into an
/// "Unattributed" row.
#[tauri::command]
pub async fn report_member_expense(
    state: State<'_, AppState>,
    query: MemberReportQuery,
) -> Result<Vec<core::MemberAmountRow>, String> {
    state
        .service()?
        .report_member_expense(&query.book_id, &query.from, &query.to)
        .map_err(err)
}

/// Per-member inflow (contribution) totals over the period — mirrors
/// [`report_member_expense`] for money coming in.
#[tauri::command]
pub async fn report_member_contribution(
    state: State<'_, AppState>,
    query: MemberReportQuery,
) -> Result<Vec<core::MemberAmountRow>, String> {
    state
        .service()?
        .report_member_contribution(&query.book_id, &query.from, &query.to)
        .map_err(err)
}

/// Each member's share of each category's spend over the period.
#[tauri::command]
pub async fn report_member_category(
    state: State<'_, AppState>,
    query: MemberReportQuery,
) -> Result<Vec<core::MemberCategoryRow>, String> {
    state
        .service()?
        .report_member_category(&query.book_id, &query.from, &query.to)
        .map_err(err)
}

/// Net position per member over the period (contributions minus attributed
/// expenses) — "who owes whom".
#[tauri::command]
pub async fn report_settle_up(
    state: State<'_, AppState>,
    query: MemberReportQuery,
) -> Result<Vec<core::MemberSettleRow>, String> {
    state
        .service()?
        .report_settle_up(&query.book_id, &query.from, &query.to)
        .map_err(err)
}

// ---------------------------------------------------------------------------
// regions — profiles are data the user picks, never a hardcoded default
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn region_list() -> Result<Vec<slipscan_core::region::RegionInfo>, String> {
    Ok(slipscan_core::region::region_infos())
}

// ---------------------------------------------------------------------------
// tax rates — listed and configurable per book (the generic profile's
// standard rate is a placeholder until the user sets it)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn vat_rate_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::VatRate>, String> {
    state.service()?.vat_rate_list(&query.book_id).map_err(err)
}

#[derive(serde::Deserialize)]
pub struct VatRateSetQuery {
    pub book_id: String,
    /// Rate code within the book, e.g. "STD".
    pub code: String,
    /// Basis points: 1500 = 15.00%.
    pub rate_bps: i64,
}

#[tauri::command]
pub async fn vat_rate_set_bps(
    state: State<'_, AppState>,
    query: VatRateSetQuery,
) -> Result<core::VatRate, String> {
    state
        .service()?
        .vat_rate_set_bps(&query.book_id, &query.code, query.rate_bps)
        .map_err(err)
}

// ---------------------------------------------------------------------------
// FX (OpenRate) — opt-in. Only `fx_fetch_rate` ever touches the network,
// only on an explicit user action, and only against the configured base URL.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fx_status(state: State<'_, AppState>) -> Result<slipscan_core::fx::FxStatus, String> {
    state.service()?.fx_status().map_err(err)
}

#[derive(serde::Deserialize)]
pub struct FxConfigureQuery {
    /// OpenRate base URL; an empty string clears it (FX off).
    pub base_url: String,
}

#[tauri::command]
pub async fn fx_configure(
    state: State<'_, AppState>,
    query: FxConfigureQuery,
) -> Result<slipscan_core::fx::FxStatus, String> {
    let service = state.service()?;
    service.fx_configure(&query.base_url).map_err(err)?;
    service.fx_status().map_err(err)
}

#[derive(serde::Deserialize)]
pub struct FxPairQuery {
    pub from: String,
    pub to: String,
}

#[tauri::command]
pub async fn fx_fetch_rate(
    state: State<'_, AppState>,
    query: FxPairQuery,
) -> Result<slipscan_core::fx::FxQuote, String> {
    // Core's FX future is `?Send`, so it cannot ride Tauri's async workers
    // directly: hop off the runtime with block_in_place and drive it on a
    // self-contained current-thread runtime. Network happens only here, only
    // because the user clicked, and only to the configured OpenRate URL.
    tokio::task::block_in_place(|| {
        let transport = slipscan_ingest::fx::ReqwestFxTransport::new().map_err(err)?;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("fx runtime: {e}"))?;
        let service = state.service()?;
        rt.block_on(service.fx_fetch_rate(&transport, &query.from, &query.to))
            .map_err(err)
    })
}

#[derive(serde::Deserialize)]
pub struct FxConvertQuery {
    pub from: String,
    pub to: String,
    pub amount_minor: i64,
    /// Optional pinned rate (decimal string): replays a booked conversion at
    /// exactly this rate instead of the current cached one.
    #[serde(default)]
    pub rate: Option<String>,
}

#[tauri::command]
pub async fn fx_convert(
    state: State<'_, AppState>,
    query: FxConvertQuery,
) -> Result<slipscan_core::fx::FxConversion, String> {
    let service = state.service()?;
    match query.rate.as_deref() {
        // Pinned-rate replay — booked conversions reproduce, never re-rate.
        Some(rate) => service
            .fx_convert_at(&query.from, &query.to, query.amount_minor, rate)
            .map_err(err),
        // Cache-only: a missing pair is an error, never a silent fetch.
        None => service
            .fx_convert(&query.from, &query.to, query.amount_minor)
            .map_err(err),
    }
}

// ---------------------------------------------------------------------------
// Payments — watch codes, webhook endpoints, deliveries. Deliberately
// simple: watch codes are a flat list, detection happens in core's
// transaction_create, signing secrets are vault-only. Core's domain
// types serialize straight across IPC (same pattern as vat rates / FX).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pay_watch_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::PayWatch>, String> {
    state.service()?.pay_watch_list(&query.book_id).map_err(err)
}

#[tauri::command]
pub async fn pay_watch_add(
    state: State<'_, AppState>,
    query: core::NewPayWatch,
) -> Result<core::PayWatch, String> {
    state.service()?.pay_watch_add(query).map_err(err)
}

#[derive(serde::Deserialize)]
pub struct PayWatchIdQuery {
    pub watch_id: String,
}

#[tauri::command]
pub async fn pay_watch_remove(
    state: State<'_, AppState>,
    query: PayWatchIdQuery,
) -> Result<(), String> {
    state
        .service()?
        .pay_watch_remove(&query.watch_id)
        .map_err(err)
}

#[derive(serde::Deserialize)]
pub struct PayWatchSetEnabledQuery {
    pub watch_id: String,
    pub enabled: bool,
}

#[tauri::command]
pub async fn pay_watch_set_enabled(
    state: State<'_, AppState>,
    query: PayWatchSetEnabledQuery,
) -> Result<core::PayWatch, String> {
    state
        .service()?
        .pay_watch_set_enabled(&query.watch_id, query.enabled)
        .map_err(err)
}

#[tauri::command]
pub async fn pay_endpoint_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::PayEndpoint>, String> {
    state
        .service()?
        .pay_endpoint_list(&query.book_id)
        .map_err(err)
}

/// The response carries the generated signing secret — the one sanctioned
/// display, exactly once (see the module docs). The frontend shows it in a
/// copy-once reveal and drops it.
#[tauri::command]
pub async fn pay_endpoint_add(
    state: State<'_, AppState>,
    query: core::NewPayEndpoint,
) -> Result<core::PayEndpointWithSecret, String> {
    state.service()?.pay_endpoint_add(query).map_err(err)
}

#[derive(serde::Deserialize)]
pub struct PayEndpointIdQuery {
    pub endpoint_id: String,
}

/// Same single-display contract as [`pay_endpoint_add`]; the old vault
/// ciphertext is overwritten, so the previous secret is gone.
#[tauri::command]
pub async fn pay_endpoint_rotate_secret(
    state: State<'_, AppState>,
    query: PayEndpointIdQuery,
) -> Result<core::PayEndpointWithSecret, String> {
    state
        .service()?
        .pay_endpoint_rotate_secret(&query.endpoint_id)
        .map_err(err)
}

/// Removes the endpoint (queued deliveries cascade) and revokes its
/// vault-held signing secret.
#[tauri::command]
pub async fn pay_endpoint_remove(
    state: State<'_, AppState>,
    query: PayEndpointIdQuery,
) -> Result<(), String> {
    state
        .service()?
        .pay_endpoint_remove(&query.endpoint_id)
        .map_err(err)
}

#[derive(serde::Deserialize)]
pub struct PayEndpointSetEnabledQuery {
    pub endpoint_id: String,
    pub enabled: bool,
}

#[tauri::command]
pub async fn pay_endpoint_set_enabled(
    state: State<'_, AppState>,
    query: PayEndpointSetEnabledQuery,
) -> Result<core::PayEndpoint, String> {
    state
        .service()?
        .pay_endpoint_set_enabled(&query.endpoint_id, query.enabled)
        .map_err(err)
}

#[tauri::command]
pub async fn pay_match_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::PayMatch>, String> {
    state.service()?.pay_match_list(&query.book_id).map_err(err)
}

#[tauri::command]
pub async fn pay_delivery_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<core::PayDelivery>, String> {
    state
        .service()?
        .pay_delivery_list(&query.book_id)
        .map_err(err)
}

/// POST every due pending delivery now. Network happens only here, only on
/// an explicit user action, and only to endpoint URLs the user registered;
/// signing runs inside the vault's `use_with` closure in core. Same
/// `?Send`-future bridge as `fx_fetch_rate`.
#[tauri::command]
pub async fn pay_deliver_due(state: State<'_, AppState>) -> Result<Vec<core::PayDelivery>, String> {
    tokio::task::block_in_place(|| {
        let transport = slipscan_ingest::pay::ReqwestWebhookTransport::new().map_err(err)?;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("pay runtime: {e}"))?;
        let service = state.service()?;
        rt.block_on(service.pay_deliver_due(&transport, &now_iso()))
            .map_err(err)
    })
}

// ---------------------------------------------------------------------------
// classification packs — the one install pipeline (ARCHITECTURE.md
// "Classification packs — one install pipeline").
//
// Every path here goes through `verify_detached` -> `VerifiedPack` ->
// `Installer`, so signature verification, TOFU signer pinning, semver
// ordering, safe category re-mapping and the audit log apply to a pack the
// desktop installs exactly as they do to one the CLI or the HTTP route
// installs. `compat` / `INSTALLED_PACKS_SETTING` are not referenced: the
// desktop reads the `pack_*` tables and nothing else. (A book whose packs
// were recorded by a pre-installer CLI shows them here once that CLI or the
// server adopts its index, which it does on its next pack call.)
//
// The response shapes below live beside their commands rather than in
// dto.rs because they exist only to serialize slipscan-packs types, which
// dto.rs — deliberately core-only — does not know about.
// ---------------------------------------------------------------------------

/// One installed pack. Metadata only: `signer` is a public key, never
/// secret material, and the payload itself is not shipped over IPC.
#[derive(serde::Serialize)]
pub struct InstalledPackDto {
    pub pack_id: String,
    pub book_id: String,
    pub name: String,
    pub version: String,
    /// `taxonomy` or `benchmark`.
    pub kind: String,
    /// ISO 3166-1 alpha-2 the pack targets; `null` = global.
    pub region: Option<String>,
    /// Short human-checkable fingerprint of the signer's key.
    pub signer_fingerprint: String,
    /// The trust store's label for this signer, or `null` if it is not (or
    /// no longer) trusted — a revoked signer's packs stay installed.
    pub signer_label: Option<String>,
    pub installed_at: String,
    pub updated_at: String,
}

/// The preflight for an install: what this signed file is, who signed it,
/// and what installing it would actually do — including refusing.
#[derive(serde::Serialize)]
pub struct PackVerificationDto {
    pub pack_id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub region: Option<String>,
    pub author: Option<String>,
    /// The fingerprint to check out-of-band before accepting the signer.
    pub signer_fingerprint: String,
    /// Trust label if this key is already trusted; `null` on first use.
    pub trusted_as: Option<String>,
    /// Fingerprint the pack id is pinned to, if it has been installed
    /// before. Differs from `signer_fingerprint` exactly when the publisher
    /// key changed — which is a refusal, never a silent success.
    pub pinned_fingerprint: Option<String>,
    /// Version of this pack id currently installed in the book, if any.
    pub installed_version: Option<String>,
    pub categories: usize,
    pub merchant_rules: usize,
    pub keyword_rules: usize,
    /// `install`, `upgrade`, or `refuse`.
    pub action: String,
    /// Set only when `action == "refuse"`: the installer's own wording for
    /// why, so the preflight and the attempt can never disagree.
    pub refusal: Option<String>,
    /// Whether installing needs the user to accept this fingerprint first.
    /// Always false for a file the user picked with its key in hand — passing
    /// the key *is* the decision there. True for a pack that arrived over a
    /// transport, where nothing was hand-carried.
    pub needs_signer_acceptance: bool,
    /// Where the bytes came from, when they came from a source rather than a
    /// file the user picked.
    pub origin: Option<String>,
}

/// What an install did.
#[derive(serde::Serialize)]
pub struct PackInstallDto {
    pub pack_id: String,
    pub name: String,
    pub version: String,
    /// ISO 3166-1 alpha-2 the pack targets; `null` = global. Carried so a
    /// screen can show *which jurisdiction's* chart it just took on —
    /// seeding installs regional taxonomies, and that is not a detail to
    /// leave the user guessing about.
    pub region: Option<String>,
    /// `installed` or `upgraded`.
    pub outcome: String,
    /// The version replaced, when `outcome == "upgraded"`.
    pub upgraded_from: Option<String>,
    pub categories_created: usize,
    pub categories_reused: usize,
    pub rules_installed: usize,
}

/// A signed pack as the user holds it: the document, its detached signature
/// and the publisher's public key — the same three inputs `slipscan pack
/// install` takes.
#[derive(serde::Deserialize)]
pub struct PackDocumentRequest {
    pub book_id: String,
    /// The exact signed bytes of the pack document, base64 for IPC transit.
    /// Base64 is transport encoding only: the bytes are verified as given,
    /// before anything interprets them.
    pub document_base64: String,
    /// Detached ed25519 signature: 128 hex characters, or base64 of 64 bytes.
    pub signature: String,
    /// Publisher public key: 64 hex characters, or base64 of 32 bytes.
    pub public_key: String,
}

#[derive(serde::Deserialize)]
pub struct PackIdRequest {
    pub book_id: String,
    pub pack_id: String,
}

/// Decode a signature or public key in either of the two forms publishers
/// distribute them in — hex (the form humans paste) or base64 (the form a
/// raw key/signature file base64s to). The length is checked here so a
/// truncated paste reports itself as such instead of as a failed signature.
fn decode_key_material(raw: &str, expect: usize, what: &str) -> Result<Vec<u8>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(format!("{what} is required"));
    }
    let bytes = if raw.len() == expect * 2 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        (0..raw.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&raw[i..i + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
            .map_err(|e| format!("invalid hex {what}: {e}"))?
    } else {
        base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map_err(|_| format!("{what} must be {} hex characters or base64", expect * 2))?
    };
    if bytes.len() != expect {
        return Err(format!(
            "{what} must be {expect} bytes; this one is {}",
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// The three byte strings a signed pack arrives as: the document, its detached
/// signature, and the publisher's public key.
struct PackBytes {
    document: Vec<u8>,
    signature: Vec<u8>,
    public_key: Vec<u8>,
}

/// Decode the three inputs. Transport-level only: no signature is checked
/// here, and nothing is parsed.
fn decode_pack_document(query: &PackDocumentRequest) -> Result<PackBytes, String> {
    Ok(PackBytes {
        document: base64::engine::general_purpose::STANDARD
            .decode(query.document_base64.trim())
            .map_err(|e| format!("invalid base64 pack document: {e}"))?,
        signature: decode_key_material(&query.signature, 64, "signature")?,
        public_key: decode_key_material(&query.public_key, 32, "public key")?,
    })
}

/// Verify the three inputs and hand back the pack the installer would take.
fn verify_request(query: &PackDocumentRequest) -> Result<slipscan_packs::VerifiedPack, String> {
    let bytes = decode_pack_document(query)?;
    slipscan_packs::verify_detached(&bytes.document, &bytes.signature, &bytes.public_key)
        .map_err(err)
}

/// The label a first-use trust decision is recorded under. Comes from
/// slipscan-packs so the CLI, the server and this screen record the same
/// thing: the pack's own author when it declares one, else the fingerprint.

#[tauri::command]
pub async fn pack_list(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<InstalledPackDto>, String> {
    use slipscan_packs::{key_fingerprint, Installer, TrustStatus, TrustStore};

    let service = state.service()?;
    book_by_id(&service, &query.book_id)?;
    service.with_connection(|conn| {
        // Nothing to read — and nothing to create on a read path — until a
        // pack has actually been installed into this database.
        let Some(installer) = Installer::open_readonly(conn).map_err(err)? else {
            return Ok(Vec::new());
        };
        let trust = TrustStore::open(conn).map_err(err)?;
        installer
            .list(&query.book_id)
            .map_err(err)?
            .into_iter()
            .map(|pack| {
                let signer_label = match trust.status(&pack.signer) {
                    Ok(TrustStatus::Trusted { label }) => Some(label),
                    // A non-key signer id (builtin seed, dev override,
                    // legacy adoption) is not a trust-store row and never
                    // will be; that is not an error, it is "no label".
                    Ok(TrustStatus::Unknown { .. }) | Err(_) => None,
                };
                Ok(InstalledPackDto {
                    signer_fingerprint: key_fingerprint(&pack.signer),
                    signer_label,
                    pack_id: pack.pack_id,
                    book_id: pack.book_id,
                    name: pack.name,
                    version: pack.version,
                    kind: pack.kind.as_str().to_string(),
                    region: pack.region,
                    installed_at: pack.installed_at,
                    updated_at: pack.updated_at,
                })
            })
            .collect()
    })
}

/// Verify a signed pack **without installing it**: check the signature,
/// surface the signer's fingerprint for the out-of-band check that makes
/// trust-on-first-use mean anything, and report what installing would do.
///
/// The refusals — a changed publisher key, the version already installed, a
/// downgrade — come from `slipscan_packs::plan_document`, the single preflight
/// for bytes the user is holding: the CLI's `pack verify` and this screen call
/// the very same function, and it starts at the same `verify_detached` the
/// installer does. That is what makes "verify then install" honest rather than
/// a coincidence — the set of documents this accepts *is* the set
/// `pack_install` accepts, current payloads and legacy flat manifests alike.
/// (A verify that parsed the file itself was how `slipscan pack verify` came to
/// reject packs its own installer took.)
///
/// A key change is a refusal, not a silent success: the pack id is pinned to
/// the key that first signed it, and no other key can take the id over.
#[tauri::command]
pub async fn pack_verify(
    state: State<'_, AppState>,
    query: PackDocumentRequest,
) -> Result<PackVerificationDto, String> {
    let bytes = decode_pack_document(&query)?;
    let service = state.service()?;
    book_by_id(&service, &query.book_id)?;
    service.with_connection(|conn| {
        let plan = slipscan_packs::plan_document(
            conn,
            &query.book_id,
            &bytes.document,
            &bytes.signature,
            &bytes.public_key,
        )
        .map_err(err)?;
        Ok(PackVerificationDto::from(plan))
    })
}

impl From<slipscan_packs::transport::PackPlan> for PackVerificationDto {
    fn from(plan: slipscan_packs::transport::PackPlan) -> Self {
        Self {
            action: plan.action.as_str().to_string(),
            needs_signer_acceptance: plan.needs_signer_acceptance(),
            pack_id: plan.pack_id,
            name: plan.name,
            version: plan.version,
            kind: plan.kind,
            region: plan.region,
            author: plan.author,
            signer_fingerprint: plan.signer_fingerprint,
            trusted_as: plan.trusted_as,
            pinned_fingerprint: plan.pinned_fingerprint,
            installed_version: plan.installed_version,
            categories: plan.categories,
            merchant_rules: plan.merchant_rules,
            keyword_rules: plan.keyword_rules,
            refusal: plan.refusal,
            origin: plan.origin,
        }
    }
}

/// Verify and install (or upgrade) a signed pack into a book.
///
/// Passing the publisher's key *is* the trust decision — that is what
/// trust-on-first-use means, and `pack_verify` exists so the user makes it
/// having seen the fingerprint. The pack id is then pinned to that key
/// forever; a later version signed by a different key is refused, and there
/// is no flag here that overrides it.
///
/// Rules are not applied retroactively: they classify transactions imported
/// from here on, not the ones already in the book.
#[tauri::command]
pub async fn pack_install(
    state: State<'_, AppState>,
    query: PackDocumentRequest,
) -> Result<PackInstallDto, String> {
    use slipscan_packs::{engine, InstallOutcome};

    let verified = verify_request(&query)?;
    let service = state.service()?;
    book_by_id(&service, &query.book_id)?;
    // Installing a pack is also where this process picks up the classifier:
    // from here on core consults the rules being written.
    engine::register_classifier();

    service.with_connection(|conn| {
        // Same ordering defect as slipscan-server::ops::pack_install had: recording
        // trust before the pin check left a rejected signer trusted for every other
        // pack id after a refused install. install_verified gates in the right order.
        let fingerprint = verified.fingerprint();
        let report = slipscan_packs::transport::install_verified(
            conn,
            &query.book_id,
            &verified,
            slipscan_packs::transport::SignerDecision::Accept(&fingerprint),
        )
        .map_err(err)?;
        let (outcome, upgraded_from) = match report.outcome {
            InstallOutcome::Installed => ("installed", None),
            InstallOutcome::Upgraded { from } => ("upgraded", Some(from)),
        };
        Ok(PackInstallDto {
            pack_id: report.pack.pack_id,
            name: report.pack.name,
            version: report.pack.version,
            region: report.pack.region,
            outcome: outcome.to_string(),
            upgraded_from,
            categories_created: report.categories_created,
            categories_reused: report.categories_reused,
            rules_installed: report.rules_installed,
        })
    })
}

/// Install the built-in seed packs into a book: the SA pair (`za-personal`,
/// `za-business-vat`) and the global `intl-starter`.
///
/// An **explicit user action**, never something book creation does on its
/// own: which taxonomy a book starts from is the user's decision, and
/// auto-installing a ZA chart for someone in Portugal would be wrong.
///
/// Seeds carry [`slipscan_packs::Provenance::Builtin`] — their payload is
/// embedded in this binary, so there is no key to trust on first use and the
/// TOFU store is not touched (`builtin`'s module docs state the trust model
/// plainly). Idempotent and non-clobbering: a seed already installed at the
/// same version is skipped, and categories the user already has are adopted
/// by (parent, name) rather than duplicated.
#[tauri::command]
pub async fn pack_install_seeds(
    state: State<'_, AppState>,
    query: BookScopedQuery,
) -> Result<Vec<PackInstallDto>, String> {
    let service = state.service()?;
    book_by_id(&service, &query.book_id)?;
    // Seeding is also an import path for rules, so make sure this process is
    // consulting them (idempotent — the startup call in lib.rs already did).
    slipscan_packs::engine::register_classifier();
    service.with_connection(|conn| {
        let reports =
            slipscan_packs::builtin::install_seed_packs(conn, &query.book_id).map_err(err)?;
        Ok(reports
            .into_iter()
            .map(|report| {
                let (outcome, upgraded_from) = match report.outcome {
                    slipscan_packs::InstallOutcome::Installed => ("installed", None),
                    slipscan_packs::InstallOutcome::Upgraded { from } => ("upgraded", Some(from)),
                };
                PackInstallDto {
                    pack_id: report.pack.pack_id,
                    name: report.pack.name,
                    version: report.pack.version,
                    region: report.pack.region,
                    outcome: outcome.to_string(),
                    upgraded_from,
                    categories_created: report.categories_created,
                    categories_reused: report.categories_reused,
                    rules_installed: report.rules_installed,
                }
            })
            .collect())
    })
}

/// Remove an installed pack's rules and its registration.
///
/// Categories the pack created are kept — they are ordinary local
/// categories now, and transactions still point at them, so history never
/// breaks. The signer pin is kept too: the pack id stays bound to its
/// original key even after the pack is gone. Returns whether a pack was
/// removed.
#[tauri::command]
pub async fn pack_uninstall(
    state: State<'_, AppState>,
    query: PackIdRequest,
) -> Result<bool, String> {
    let service = state.service()?;
    book_by_id(&service, &query.book_id)?;
    service.with_connection(|conn| {
        slipscan_packs::Installer::open(conn)
            .map_err(err)?
            .uninstall(&query.book_id, &query.pack_id)
            .map_err(err)
    })
}

// ---------------------------------------------------------------------------
// pack sources — the FETCH half (docs/PACKS.md "Getting a pack").
//
// A transport grants no authority. Every path below hands raw bytes to
// `slipscan_packs::transport`, which checks the signature before the database
// is touched, and then to the same `Installer` a hand-picked file goes
// through. There is no second install path and no way to reach one.
//
// Two things this surface exists to make legible, on top of what the install
// screen already shows:
//
// * **arriving is not accepting.** A signer this machine has never seen is
//   refused until the user accepts that exact fingerprint. Naming a source is
//   not consent to everything it will ever serve.
// * **there is no registry.** The source list starts empty and only the user
//   writes to it, so a fresh install makes no outbound pack request at all.
// ---------------------------------------------------------------------------

/// One configured source.
#[derive(serde::Serialize)]
pub struct PackSourceDto {
    pub name: String,
    /// Canonical URI: `file:`, `folder:`, `git:` or `https://`.
    pub uri: String,
    pub kind: String,
    /// Whether reading it can put packets on a network.
    pub network: bool,
    pub added_at: String,
    pub last_synced_at: Option<String>,
}

/// One pack a source offers: the catalogue's claim, plus the verified
/// preflight when the bytes check out. The two are separate fields because
/// only the second is derived from a checked signature.
#[derive(serde::Serialize)]
pub struct PackOfferDto {
    /// Claimed id (catalogue — a hint, not a fact).
    pub pack_id: String,
    /// Claimed version (catalogue).
    pub version: String,
    /// Claimed display name (catalogue).
    pub name: Option<String>,
    /// Blob name within the source; the handle `pack_source_install` takes.
    pub document: String,
    /// The verified preflight, present iff the signature verified.
    pub verified: Option<PackVerificationDto>,
    /// Why this entry could not be verified. One unreadable file in a shared
    /// folder must not hide the rest of the catalogue.
    pub error: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct PackSourceAddRequest {
    pub name: String,
    /// `file:<path>`, `folder:<path>`, `git:<url>[#ref]` or `https://<url>`.
    pub uri: String,
}

#[derive(serde::Deserialize)]
pub struct PackSourceNameRequest {
    pub name: String,
}

#[derive(serde::Deserialize)]
pub struct PackSourceFetchRequest {
    pub book_id: String,
    pub source: String,
}

#[derive(serde::Deserialize)]
pub struct PackSourceInstallRequest {
    pub book_id: String,
    pub source: String,
    pub pack_id: String,
    /// Exact document name from `pack_source_fetch`, when one source offers
    /// the same pack id from more than one publisher.
    #[serde(default)]
    pub document: Option<String>,
    /// The trust-on-first-use answer: the fingerprint the user compared
    /// against the publisher's own channel. Omit and an unknown signer
    /// refuses. Never an override for a changed publisher key.
    #[serde(default)]
    pub accept_signer: Option<String>,
}

/// Transport capabilities for one source read: the git checkout cache (kept
/// inside the user's own data folder, so it is part of the one thing they
/// back up or delete) and the HTTPS client.
///
/// Built per call and only for a pack-source command. It carries no endpoint
/// — slipscan-packs has none — so every request goes to a base URL the user
/// added, and with no source added, none is ever made.
fn pack_transport_context(
    state: &AppState,
) -> Result<slipscan_packs::transport::TransportContext, String> {
    let cache = state.data_dir()?;
    let http = slipscan_ingest::packs::ReqwestPackHttp::new()?;
    Ok(slipscan_packs::transport::TransportContext::new()
        .with_cache_dir(cache)
        .with_http(std::sync::Arc::new(http)))
}

fn to_source_dto(row: slipscan_packs::transport::PackSourceRow) -> PackSourceDto {
    PackSourceDto {
        uri: row.source.uri(),
        kind: row.source.kind().as_str().to_string(),
        network: row.source.is_network(),
        name: row.name,
        added_at: row.added_at,
        last_synced_at: row.last_synced_at,
    }
}

/// Add a pack source. Nothing is contacted by adding one — the source is read
/// when the user asks for it. This is the **only** way a source ever exists.
#[tauri::command]
pub async fn pack_source_add(
    state: State<'_, AppState>,
    query: PackSourceAddRequest,
) -> Result<PackSourceDto, String> {
    use slipscan_packs::transport::{PackSource, SourceStore};

    let source = PackSource::parse(&query.uri).map_err(err)?;
    let service = state.service()?;
    service.with_connection(|conn| {
        let row = SourceStore::open(conn)
            .map_err(err)?
            .add(&query.name, &source)
            .map_err(err)?;
        Ok(to_source_dto(row))
    })
}

/// Forget a source. Installed packs are untouched: where a pack came from is
/// history, not a dependency. `false` = there was no source by that name.
#[tauri::command]
pub async fn pack_source_remove(
    state: State<'_, AppState>,
    query: PackSourceNameRequest,
) -> Result<bool, String> {
    let service = state.service()?;
    service.with_connection(|conn| {
        slipscan_packs::transport::SourceStore::open(conn)
            .map_err(err)?
            .remove(&query.name)
            .map_err(err)
    })
}

/// Configured sources. Empty on a fresh install — and empty is what makes
/// "no outbound request until you name a source" true rather than promised.
#[tauri::command]
pub async fn pack_source_list(state: State<'_, AppState>) -> Result<Vec<PackSourceDto>, String> {
    let service = state.service()?;
    service.with_connection(|conn| {
        // Nothing to read, and nothing to create on a read path, until a
        // source has actually been added.
        let Some(store) =
            slipscan_packs::transport::SourceStore::open_readonly(conn).map_err(err)?
        else {
            return Ok(Vec::new());
        };
        Ok(store
            .list()
            .map_err(err)?
            .into_iter()
            .map(to_source_dto)
            .collect())
    })
}

/// Read a source's catalogue and preflight every pack it offers against the
/// book. **Installs nothing.** This is where a publisher's fingerprint is put
/// in front of the user, before any decision is possible.
#[tauri::command]
pub async fn pack_source_fetch(
    state: State<'_, AppState>,
    query: PackSourceFetchRequest,
) -> Result<Vec<PackOfferDto>, String> {
    use slipscan_packs::transport::{self, SourceStore};

    // Reading a folder, a git remote or an HTTPS base is synchronous and can
    // be slow: hop off Tauri's async workers rather than blocking one, the
    // same way the explicit FX fetch does.
    tokio::task::block_in_place(|| {
        let ctx = pack_transport_context(&state)?;
        let service = state.service()?;
        book_by_id(&service, &query.book_id)?;

        let row = service.with_connection(|conn| {
            SourceStore::open_readonly(conn)
                .map_err(err)?
                .ok_or_else(|| format!("no pack source named {:?}", query.source))?
                .require(&query.source)
                .map_err(err)
        })?;

        let store = transport::open(&row.source, &ctx).map_err(err)?;
        let entries = transport::discover(store.as_ref()).map_err(err)?;

        let mut offers = Vec::with_capacity(entries.len());
        for entry in &entries {
            let (verified, error) = match transport::fetch(store.as_ref(), entry) {
                Ok(bundle) => match service
                    .with_connection(|conn| transport::plan_bundle(conn, &query.book_id, &bundle))
                {
                    Ok(plan) => (Some(PackVerificationDto::from(plan)), None),
                    Err(e) => (None, Some(e.to_string())),
                },
                Err(e) => (None, Some(e.to_string())),
            };
            offers.push(PackOfferDto {
                pack_id: entry.id.clone(),
                version: entry.version.clone(),
                name: entry.name.clone(),
                document: entry.document.clone(),
                verified,
                error,
            });
        }
        service.with_connection(|conn| {
            SourceStore::open(conn)
                .map_err(err)?
                .touch(&row.name)
                .map_err(err)
        })?;
        Ok(offers)
    })
}

/// Fetch one pack from a source and install it.
///
/// The signature is checked on the bytes before the database is touched, and
/// the catalogue's claims are cross-checked against the signed payload, so a
/// source cannot list one pack and deliver another. An unknown signer is
/// refused unless `accept_signer` carries the fingerprint the user was shown
/// and checked — and a pack id whose publisher key has changed is refused
/// regardless of what is passed, because the pin is not overridable.
#[tauri::command]
pub async fn pack_source_install(
    state: State<'_, AppState>,
    query: PackSourceInstallRequest,
) -> Result<PackInstallDto, String> {
    use slipscan_packs::transport::{self, SignerDecision, SourceStore};
    use slipscan_packs::InstallOutcome;

    tokio::task::block_in_place(|| {
        let ctx = pack_transport_context(&state)?;
        let service = state.service()?;
        book_by_id(&service, &query.book_id)?;
        // Installing a pack is also where this process picks up the
        // classifier (idempotent — startup already did it).
        slipscan_packs::engine::register_classifier();

        let row = service.with_connection(|conn| {
            SourceStore::open_readonly(conn)
                .map_err(err)?
                .ok_or_else(|| format!("no pack source named {:?}", query.source))?
                .require(&query.source)
                .map_err(err)
        })?;

        let store = transport::open(&row.source, &ctx).map_err(err)?;
        let entries = transport::discover(store.as_ref()).map_err(err)?;
        let entry = entries
            .iter()
            .find(|e| match query.document.as_deref() {
                Some(doc) => e.document == doc,
                None => e.id == query.pack_id,
            })
            .ok_or_else(|| format!("{} does not offer {:?}", row.name, query.pack_id))?;

        let bundle = transport::fetch(store.as_ref(), entry).map_err(err)?;
        let decision = match query.accept_signer.as_deref() {
            Some(fp) => SignerDecision::Accept(fp),
            None => SignerDecision::RequireKnown,
        };

        let report = service.with_connection(|conn| {
            transport::install_bundle(conn, &query.book_id, &bundle, decision).map_err(err)
        })?;
        let (outcome, upgraded_from) = match report.outcome {
            InstallOutcome::Installed => ("installed", None),
            InstallOutcome::Upgraded { from } => ("upgraded", Some(from)),
        };
        Ok(PackInstallDto {
            pack_id: report.pack.pack_id,
            name: report.pack.name,
            version: report.pack.version,
            region: report.pack.region,
            outcome: outcome.to_string(),
            upgraded_from,
            categories_created: report.categories_created,
            categories_reused: report.categories_reused,
            rules_installed: report.rules_installed,
        })
    })
}

// ---------------------------------------------------------------------------
// benchmark packs — the READ side of anonymous peer comparison, and the only
// thing SlipScan does with benchmark packs at all.
//
// Reading is perfectly private (docs/BENCHMARKS.md): a benchmark pack is a
// public file of cohort aggregates, the comparison is arithmetic performed
// here, and nothing is transmitted. The *contribution* half — and with it the
// local differential privacy the design calls for — is NOT IMPLEMENTED. There
// is no contribution code, no noise generation and no transport anywhere in
// this repo, so this command has nothing to send and nowhere to send it. No
// wording on this surface may imply otherwise.
//
// Semantics mirror `slipscan_server::ops::pack_benchmark` exactly (the desktop
// does not depend on slipscan-server; see this crate's Cargo.toml for why):
// your side is core's own `report_spending` for the month, child categories
// roll into their parent's key with ids de-duplicated, no FX conversion is
// ever applied, and a key nothing maps to is reported rather than dropped.
// ---------------------------------------------------------------------------

/// The cohort a benchmark set describes. Deliberately coarse — region, a
/// household-size bucket and an opaque income band — and about *the pack*,
/// never about this user.
#[derive(serde::Serialize)]
pub struct BenchmarkCohortDto {
    /// ISO 3166-1 alpha-2, e.g. `ZA`.
    pub region: String,
    pub household_size: u32,
    /// Short community-defined band label, e.g. `C`.
    pub income_band: String,
}

/// One category placed against the cohort's quartiles. Amounts are integer
/// minor units in the set's currency — never floats, never converted.
#[derive(serde::Serialize)]
pub struct BenchmarkComparisonDto {
    pub category_key: String,
    pub currency: String,
    /// Your total for the key this period, including descendant categories.
    pub yours_minor: i64,
    pub median_minor: i64,
    pub p25_minor: i64,
    pub p75_minor: i64,
    /// `yours - median`; positive means you spend more than the cohort's
    /// median.
    pub delta_minor: i64,
    /// `yours / median`, `null` when the cohort median is zero (dividing by
    /// it would invent a number).
    pub ratio_to_median: Option<f64>,
    /// `below_p25`, `typical` (inside the interquartile range), or
    /// `above_p75`.
    pub position: String,
    /// Contributions behind the stat — always >= the pack's k-floor.
    pub sample_size: u64,
}

/// One installed benchmark pack compared against this book's own spend for
/// one calendar month.
#[derive(serde::Serialize)]
pub struct BenchmarkReportDto {
    pub pack_id: String,
    /// The installed pack's display name, so a screen showing this need not
    /// re-query `pack_list` to name what it is showing.
    pub pack_name: String,
    /// The calendar month `YYYY-MM` that was compared.
    pub period: String,
    /// The pack's own currency. **Never converted** — see `skipped`.
    pub currency: String,
    pub cohort: BenchmarkCohortDto,
    /// The k-anonymity floor the pack's aggregator enforced.
    pub k_floor: u64,
    /// Why nothing was compared, when nothing was — a currency mismatch, or
    /// no spend at all in the pack's currency. `null` on a real comparison,
    /// which may still be empty if the pack has no stat for the period.
    /// Rendering this as a row of zeroes would be a lie, so it is a reason.
    pub skipped: Option<String>,
    pub comparisons: Vec<BenchmarkComparisonDto>,
    /// Taxonomy keys the pack has a stat for that no installed pack maps to
    /// a local category. Reported rather than silently dropped, so "why is
    /// groceries missing?" has an answer.
    pub unmapped_keys: Vec<String>,
}

#[derive(serde::Deserialize)]
pub struct BenchmarkQuery {
    pub book_id: String,
    /// Calendar month, `YYYY-MM`.
    pub period: String,
}

/// Compare this book's spend for `period` against every installed benchmark
/// pack — computed here, transmitting nothing.
///
/// How your side of the comparison is computed, exactly as the CLI and HTTP
/// surfaces compute it:
///
/// * spend is core's own [`CoreService::report_spending`] for the month, so a
///   figure here is the figure the spending report shows;
/// * a pack's taxonomy key resolves to local category ids through
///   `pack_category_map` — the map installs already write — and the total
///   **includes descendant categories**, so a `transport` stat counts
///   `transport.fuel` too. Ids are de-duplicated first, so two packs mapping
///   the same key onto the same category cannot double-count;
/// * only spend in the pack's own currency is counted and **no FX conversion
///   is applied**: a pack in a currency this book does not use comes back
///   with `skipped` set, not a fabricated zero.
#[tauri::command]
pub async fn pack_benchmark(
    state: State<'_, AppState>,
    query: BenchmarkQuery,
) -> Result<Vec<BenchmarkReportDto>, String> {
    use slipscan_packs::{benchmark, Installer, QuartilePosition};

    if !is_calendar_month(&query.period) {
        return Err(format!(
            "period {:?} must be a calendar month, YYYY-MM",
            query.period
        ));
    }
    let service = state.service()?;
    let book = book_by_id(&service, &query.book_id)?;
    // `-01`..`-31` spans any month: posted dates are ISO strings compared
    // lexicographically, so a 30-day month simply has no `-31` row.
    let spending = service
        .report_spending(
            &query.book_id,
            &format!("{}-01", query.period),
            &format!("{}-31", query.period),
        )
        .map_err(err)?;
    let subtrees = subtree_ids(&service.category_tree(&query.book_id).map_err(err)?);

    // Spend per (currency, category) — never summed across currencies.
    let mut by_currency: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for row in &spending {
        let Some(category_id) = &row.category_id else {
            continue; // uncategorised spend belongs to no taxonomy key
        };
        *by_currency
            .entry(row.currency.clone())
            .or_default()
            .entry(category_id.clone())
            .or_insert(0) += row.total_minor;
    }

    service.with_connection(|conn| {
        // Read path: no pack has ever been installed here, so there is
        // nothing to compare — and nothing to create either.
        let Some(installer) = Installer::open_readonly(conn).map_err(err)? else {
            return Ok(Vec::new());
        };
        let sets = installer.benchmark_sets(&query.book_id).map_err(err)?;
        if sets.is_empty() {
            return Ok(Vec::new());
        }

        // Taxonomy key -> local category ids, pooled across every installed
        // pack: benchmark packs declare no categories of their own, so the
        // keys they cite are resolved through the taxonomy packs.
        let mut names: HashMap<String, String> = HashMap::new();
        let mut key_to_ids: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for pack in installer.list(&query.book_id).map_err(err)? {
            for (key, category_id) in installer
                .category_map(&query.book_id, &pack.pack_id)
                .map_err(err)?
            {
                key_to_ids.entry(key).or_default().insert(category_id);
            }
            names.insert(pack.pack_id, pack.name);
        }

        let mut reports = Vec::new();
        for (pack_id, set) in sets {
            let pack_name = names
                .get(&pack_id)
                .cloned()
                .unwrap_or_else(|| pack_id.clone());
            let mut report = BenchmarkReportDto {
                pack_id,
                pack_name,
                period: query.period.clone(),
                currency: set.currency.clone(),
                cohort: BenchmarkCohortDto {
                    region: set.cohort.region.clone(),
                    household_size: set.cohort.household_size,
                    income_band: set.cohort.income_band.clone(),
                },
                k_floor: set.k_floor,
                skipped: None,
                comparisons: Vec::new(),
                unmapped_keys: Vec::new(),
            };
            let Some(spend_by_category) = by_currency.get(&set.currency) else {
                report.skipped = Some(if set.currency != book.currency {
                    format!(
                        "pack is in {} and this book is in {} — no conversion is applied",
                        set.currency, book.currency
                    )
                } else {
                    format!("no {} spend recorded in {}", set.currency, query.period)
                });
                reports.push(report);
                continue;
            };

            let mut spend_minor: BTreeMap<String, i64> = BTreeMap::new();
            for stat in set.stats.iter().filter(|stat| stat.period == query.period) {
                let Some(ids) = key_to_ids.get(&stat.category_key) else {
                    report.unmapped_keys.push(stat.category_key.clone());
                    continue;
                };
                // De-duplicate first: two packs may map the same key onto
                // the same category, or a category onto one of its own
                // ancestors.
                let covered: BTreeSet<&str> = ids
                    .iter()
                    .flat_map(|id| subtrees.get(id).map(Vec::as_slice).unwrap_or_default())
                    .map(String::as_str)
                    .collect();
                let total = covered
                    .iter()
                    .filter_map(|id| spend_by_category.get(*id))
                    .fold(0i64, |acc, amount| acc.saturating_add(*amount));
                spend_minor.insert(stat.category_key.clone(), total);
            }
            report.unmapped_keys.sort();
            report.unmapped_keys.dedup();
            report.comparisons = benchmark::compare(&set, &query.period, &spend_minor)
                .into_iter()
                .map(|c| BenchmarkComparisonDto {
                    category_key: c.category_key,
                    currency: c.currency,
                    yours_minor: c.yours_minor,
                    median_minor: c.median_minor,
                    p25_minor: c.p25_minor,
                    p75_minor: c.p75_minor,
                    delta_minor: c.delta_minor,
                    ratio_to_median: c.ratio_to_median,
                    position: match c.position {
                        QuartilePosition::BelowP25 => "below_p25",
                        QuartilePosition::Typical => "typical",
                        QuartilePosition::AboveP75 => "above_p75",
                    }
                    .to_string(),
                    sample_size: c.sample_size,
                })
                .collect();
            reports.push(report);
        }
        Ok(reports)
    })
}

/// `YYYY-MM`, with a month in 01..=12. An impossible month like `2026-13`
/// would compare against nothing and report "no stats" forever, so it is a
/// validation error rather than an empty result.
fn is_calendar_month(period: &str) -> bool {
    let bytes = period.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..].iter().all(u8::is_ascii_digit)
        && matches!(period[5..].parse::<u32>(), Ok(1..=12))
}

/// Every category id mapped to itself plus all of its descendants, so a
/// benchmark stat for a parent key counts spend booked to its children.
fn subtree_ids(tree: &[CategoryNode]) -> BTreeMap<String, Vec<String>> {
    fn walk(node: &CategoryNode, out: &mut BTreeMap<String, Vec<String>>) -> Vec<String> {
        let mut ids = vec![node.category.id.clone()];
        for child in &node.children {
            ids.extend(walk(child, out));
        }
        out.insert(node.category.id.clone(), ids.clone());
        ids
    }
    let mut out = BTreeMap::new();
    for node in tree {
        walk(node, &mut out);
    }
    out
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<SettingsDto, String> {
    let service = state.service()?;
    match service.settings_get(UI_SETTINGS_KEY).map_err(err)? {
        None => Ok(SettingsDto::default()),
        Some(json) => serde_json::from_str(&json).map_err(err),
    }
}

#[derive(serde::Deserialize)]
pub struct SettingsSetQuery {
    pub settings: SettingsDto,
}

#[tauri::command]
pub async fn settings_set(
    state: State<'_, AppState>,
    query: SettingsSetQuery,
) -> Result<SettingsDto, String> {
    let service = state.service()?;
    let json = serde_json::to_string(&query.settings).map_err(err)?;
    service
        .settings_set(UI_SETTINGS_KEY, &json, false)
        .map_err(err)?;
    Ok(query.settings)
}

// ---------------------------------------------------------------------------
// credential vault — write-only. Commands return METADATA ONLY; there is no
// IPC path that returns secret material, by construction (core's Vault has
// no `get`, and no DTO in dto.rs carries material).
// ---------------------------------------------------------------------------

type LabelMap = HashMap<String, String>;

fn load_labels(service: &CoreService) -> Result<LabelMap, String> {
    match service.settings_get(VAULT_LABELS_KEY).map_err(err)? {
        None => Ok(LabelMap::new()),
        Some(json) => serde_json::from_str(&json).map_err(err),
    }
}

fn store_labels(service: &CoreService, labels: &LabelMap) -> Result<(), String> {
    let json = serde_json::to_string(labels).map_err(err)?;
    service
        .settings_set(VAULT_LABELS_KEY, &json, false)
        .map_err(err)
}

fn vault_meta_dto(
    meta: slipscan_core::secrets::VaultSecretMeta,
    labels: &LabelMap,
) -> VaultCredentialDto {
    VaultCredentialDto {
        label: labels.get(&meta.name).cloned(),
        name: meta.name,
        version: meta.version,
        fingerprint: meta.fingerprint,
        created_at: meta.created_at,
        rotated_at: meta.rotated_at,
        last_used_at: meta.last_used_at,
    }
}

#[tauri::command]
pub async fn vault_list(state: State<'_, AppState>) -> Result<Vec<VaultCredentialDto>, String> {
    let labels = {
        let service = state.service()?;
        load_labels(&service)?
    };
    let db = state.vault_db()?;
    let vault = Vault::new(db.conn(), &state.keychain as &dyn SecretStore);
    let metas = vault.list_metadata().map_err(err)?;
    Ok(metas
        .into_iter()
        .map(|m| vault_meta_dto(m, &labels))
        .collect())
}

#[tauri::command]
pub async fn vault_set(
    state: State<'_, AppState>,
    query: VaultSetRequest,
) -> Result<VaultCredentialDto, String> {
    if query.secret.is_empty() {
        return Err("secret must not be empty".to_string());
    }
    let meta = {
        let db = state.vault_db()?;
        let vault = Vault::new(db.conn(), &state.keychain as &dyn SecretStore);
        vault
            .set(&query.name, SecretString::new(query.secret))
            .map_err(err)?
    };
    let service = state.service()?;
    let mut labels = load_labels(&service)?;
    if let Some(label) = query.label.clone().filter(|l| !l.trim().is_empty()) {
        labels.insert(query.name.clone(), label.trim().to_string());
        store_labels(&service, &labels)?;
    }
    Ok(vault_meta_dto(meta, &labels))
}

#[tauri::command]
pub async fn vault_replace(
    state: State<'_, AppState>,
    query: VaultReplaceRequest,
) -> Result<VaultCredentialDto, String> {
    if query.secret.is_empty() {
        return Err("secret must not be empty".to_string());
    }
    let meta = {
        let db = state.vault_db()?;
        let vault = Vault::new(db.conn(), &state.keychain as &dyn SecretStore);
        vault
            .replace(&query.name, SecretString::new(query.secret))
            .map_err(err)?
    };
    let service = state.service()?;
    let labels = load_labels(&service)?;
    Ok(vault_meta_dto(meta, &labels))
}

#[tauri::command]
pub async fn vault_revoke(
    state: State<'_, AppState>,
    query: VaultRevokeRequest,
) -> Result<(), String> {
    {
        let db = state.vault_db()?;
        let vault = Vault::new(db.conn(), &state.keychain as &dyn SecretStore);
        vault.revoke(&query.name).map_err(err)?;
    }
    let service = state.service()?;
    let mut labels = load_labels(&service)?;
    if labels.remove(&query.name).is_some() {
        store_labels(&service, &labels)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// device identity and pairing — **identity only; nothing syncs yet**
// (docs/NODES.md). There is no transport, no coordinator and no endpoint.
// Pairing two devices establishes that this key and that key belong together,
// and then does nothing else.
//
// The signed operation log (docs/NODES.md phase 2) has **no desktop surface at
// all** — it is `slipscan sync` on the CLI only. What the desktop would need to
// grow one is small and specific, and is written down here rather than half
// built: IPC adapters over `slipscan_server::oplog::OplogHandle`
// (`sync_status`, `sync_seal`, `sync_log`, `sync_verify`), TypeScript mirrors
// for `SyncStatus`/`SealReport`/`VerifyReport` in
// `apps/desktop/src/lib/api/types.ts`, a `parity.json` regeneration, and a
// screen that can say "N changes recorded, nothing sent anywhere" without
// implying a sync exists. There is no Devices screen either, for the same
// reason: a UI for a capability that does nothing invites the belief that it
// does something.
//
// Every command below goes through `slipscan_server::devices::DeviceHandle`,
// the same handle the CLI drives, so the desktop cannot form its own opinion
// about which operations may leave the machine. That handle's split is:
//
// * **served over HTTP** — reading this device's identity, listing peers,
//   invite metadata and the rotation chain, and revoking or forgetting a peer.
// * **local-only, never routed** — `init`, `rotate`, `reset` (they create or
//   destroy the private key) and the whole pairing ceremony (invites carry a
//   single-use claim token, and the key-name comparison needs a human in front
//   of the device).
//
// Tauri IPC is a local channel, so this file legitimately implements *both*
// halves — the same treatment `vault_set` / `vault_replace` get, which have no
// route either. What it must not do is loosen the ceremony, hence
// `keyname_check` below.
// ---------------------------------------------------------------------------

/// Resolve how the out-of-band key-name comparison was discharged, or
/// **refuse**.
///
/// The comparison is the entire authentication step of pairing: the blobs are
/// self-signed, so a signature proves possession of the key *inside* the blob
/// and nothing about who sent it. An attacker who substitutes the whole blob
/// produces one that verifies perfectly.
///
/// So this fails closed, loudly, with text the caller can act on. It does not
/// fall back to [`KeynameCheck::ConfirmedByHuman`] when nothing was supplied:
/// that variant means "a human was shown the key-name and said yes", and a
/// default is precisely a screen that never asked. There is no `--unverified`
/// equivalent here at all — the CLI has one for scripting; a GUI where the
/// human is already present has no use for it.
fn keyname_check(query: &DevicePairRedeemRequest) -> Result<KeynameCheck<'_>, String> {
    match query.expect_keyname.as_deref().map(str::trim) {
        // Strongest: the user typed what they read off the other screen, and
        // core compares it (checksum first, so a typo says "you typed it
        // wrong" rather than "wrong device").
        Some(typed) if !typed.is_empty() => Ok(KeynameCheck::Expect(typed)),
        _ if query.confirmed_by_human => Ok(KeynameCheck::ConfirmedByHuman),
        _ => Err(
            "pairing needs the key-name check: either pass the key-name shown on the \
                  other device (expect_keyname), or confirm that this screen displayed it \
                  and the person agreed it matched (confirmed_by_human). Comparing the \
                  key-name is what authenticates a pairing — without it a substituted \
                  invite verifies perfectly."
                .to_string(),
        ),
    }
}

// -- served-equivalent reads: public information only ------------------------

/// This device's own identity — public key, key-name, label. `null` when this
/// device has none yet, which is the state a fresh install is in.
#[tauri::command]
pub async fn device_status(state: State<'_, AppState>) -> Result<Option<DeviceIdentity>, String> {
    state.devices()?.identity().map_err(err)
}

/// Pinned peers, revoked tombstones included — a revocation is a tombstone
/// precisely so the key cannot quietly re-pair, so hiding them would hide the
/// reason a re-pair is being refused.
#[tauri::command]
pub async fn device_list(state: State<'_, AppState>) -> Result<Vec<DevicePeer>, String> {
    state.devices()?.peer_list().map_err(err)
}

/// One pinned peer by device id — the lookup for a key-name a user is reading
/// off the other device.
#[tauri::command]
pub async fn device_get(
    state: State<'_, AppState>,
    query: DeviceIdRequest,
) -> Result<DevicePeer, String> {
    state
        .devices()?
        .peer_get(&query.device_id)
        .map_err(err)?
        .ok_or_else(|| format!("no paired device {}", query.device_id))
}

/// Invites this device has minted. **Never carries a claim token** — the clear
/// token exists only in the blob the user already holds.
#[tauri::command]
pub async fn device_invite_list(
    state: State<'_, AppState>,
) -> Result<Vec<PairingInviteMeta>, String> {
    state.devices()?.invite_list().map_err(err)
}

/// The rotation chain of this device's own key: public keys and signatures.
#[tauri::command]
pub async fn device_rotations(state: State<'_, AppState>) -> Result<Vec<DeviceRotation>, String> {
    state.devices()?.rotations().map_err(err)
}

/// Revoke a peer. The pin becomes a tombstone, so that key cannot silently
/// pair again; `device_forget` is the deliberate way back.
#[tauri::command]
pub async fn device_revoke(
    state: State<'_, AppState>,
    query: DeviceIdRequest,
) -> Result<DevicePeer, String> {
    state.devices()?.peer_revoke(&query.device_id).map_err(err)
}

// -- local-only: key material, and the human-in-the-loop ceremony ------------

/// Generate this device's keypair. The private half goes straight into the
/// write-only vault; the public half *is* the device id.
///
/// **Local-only by construction** — the HTTP route of this name refuses and
/// says so. Refused if an identity already exists: replacing the local trust
/// root is `device_rotate` (signed by the outgoing key) or `device_reset` (a
/// deliberate local wipe), never a second init.
#[tauri::command]
pub async fn device_init(
    state: State<'_, AppState>,
    query: DeviceInitRequest,
) -> Result<DeviceIdentity, String> {
    let label = query.label.as_deref().map(str::trim).unwrap_or("");
    let label = if label.is_empty() {
        "this device"
    } else {
        label
    };
    state.devices()?.initialize(label).map_err(err)
}

/// Rotate this device's key, signed by the key it replaces. The device id
/// changes, so peers' pins of *this* device go stale and nothing re-pairs them
/// automatically — there is no transport to do it over.
#[tauri::command]
pub async fn device_rotate(state: State<'_, AppState>) -> Result<DeviceRotateDto, String> {
    let (identity, rotation) = state.devices()?.rotate().map_err(err)?;
    Ok(DeviceRotateDto { identity, rotation })
}

/// Destroy this device's private key and identity row — the deliberate local
/// reset. Peer pins are kept (they are this device's opinions about *other*
/// devices); `device_forget` clears those one at a time.
///
/// `confirm` must be true, mirroring the CLI's required `--yes`: the key
/// cannot be recovered from a backup of the data folder, because the key that
/// decrypts the vault never leaves this machine's keychain.
#[tauri::command]
pub async fn device_reset(
    state: State<'_, AppState>,
    query: DeviceResetRequest,
) -> Result<(), String> {
    if !query.confirm {
        return Err(
            "resetting destroys this device's private key and cannot be undone — \
                    pass confirm to proceed"
                .to_string(),
        );
    }
    state.devices()?.reset().map_err(err)
}

/// Drop a peer's pin entirely, tombstone included: the deliberate local reset
/// that lets a revoked key pair again. Returns whether a pin went away.
#[tauri::command]
pub async fn device_forget(
    state: State<'_, AppState>,
    query: DeviceIdRequest,
) -> Result<bool, String> {
    state.devices()?.peer_forget(&query.device_id).map_err(err)
}

/// Mint a single-use pairing invite (ceremony step 1).
///
/// The returned `blob` **contains a claim token** and is a credential until it
/// is redeemed or expires. Move it out of band — QR, paste, a file on a stick;
/// SlipScan opens no socket to do this and there is no coordinator to route it
/// through.
#[tauri::command]
pub async fn device_pair_invite(
    state: State<'_, AppState>,
    query: DeviceInviteRequest,
) -> Result<PairingInviteDto, String> {
    let label = query.label.as_deref().map(str::trim).unwrap_or("");
    let label = if label.is_empty() { "a device" } else { label };
    let ttl = query.ttl_seconds.unwrap_or(DEFAULT_INVITE_TTL_SECONDS);
    let invite = state.devices()?.invite_create(label, ttl).map_err(err)?;
    Ok(PairingInviteDto {
        id: invite.id,
        blob: invite.blob,
        keyname: invite.keyname,
        expires_at: invite.expires_at,
    })
}

/// Withdraw an unredeemed invite. Returns whether one went away.
///
/// Desktop-only (the CLI's `device cancel-invite`; no HTTP route, because the
/// whole invite lifecycle is local). It earns its place on this surface: an
/// invite blob is a live credential, and "I pasted that into the wrong window"
/// needs an answer other than waiting out the TTL.
#[tauri::command]
pub async fn device_invite_cancel(
    state: State<'_, AppState>,
    query: DeviceInviteIdRequest,
) -> Result<bool, String> {
    state.devices()?.invite_cancel(&query.id).map_err(err)
}

/// Redeem an invite (ceremony step 2): check it, **pin the inviter**, and
/// return the acceptance blob to carry back.
///
/// One of exactly two moments a peer key is ever accepted. The key-name check
/// is mandatory here — see [`keyname_check`].
#[tauri::command]
pub async fn device_pair_accept(
    state: State<'_, AppState>,
    query: DevicePairRedeemRequest,
) -> Result<PairingAcceptanceDto, String> {
    let check = keyname_check(&query)?;
    let acceptance = state
        .devices()?
        .pair_accept(&query.blob, check)
        .map_err(err)?;
    Ok(PairingAcceptanceDto {
        peer: acceptance.peer,
        blob: acceptance.blob,
    })
}

/// Redeem the acceptance blob (ceremony step 4): **burn the single-use claim
/// token** and pin the accepter. The other of the two moments a peer key is
/// accepted; replaying the same blob is refused.
#[tauri::command]
pub async fn device_pair_confirm(
    state: State<'_, AppState>,
    query: DevicePairRedeemRequest,
) -> Result<DevicePeer, String> {
    let check = keyname_check(&query)?;
    state
        .devices()?
        .pair_confirm(&query.blob, check)
        .map_err(err)
}

#[cfg(test)]
mod device_tests {
    use super::*;
    use slipscan_core::secrets::MemorySecretStore;
    use slipscan_core::Db;
    use slipscan_server::devices::DeviceHandle;

    /// A device, exactly as the desktop holds one: `slipscan-server`'s handle
    /// over a database plus a keychain. In-memory here; the real one is the
    /// data folder's database and the OS keychain.
    fn device(label: &str) -> DeviceHandle {
        let handle = DeviceHandle::new(
            Db::open_in_memory().expect("db"),
            Box::new(MemorySecretStore::default()),
        );
        handle.initialize(label).expect("initialize");
        handle
    }

    fn redeem(blob: &str, expect_keyname: Option<&str>) -> DevicePairRedeemRequest {
        DevicePairRedeemRequest {
            blob: blob.to_string(),
            expect_keyname: expect_keyname.map(str::to_string),
            confirmed_by_human: false,
        }
    }

    /// **The guard.** A redeem request that discharges the key-name check
    /// neither way is refused outright — not silently treated as "a human
    /// confirmed it".
    ///
    /// This is the difference between a verification step and a rubber stamp.
    /// The blobs are self-signed, so a substituted invite verifies perfectly;
    /// comparing the key-name against the other device's screen is the only
    /// thing that authenticates the pairing. A default of `ConfirmedByHuman`
    /// would mean a screen that forgot to ask still reported that someone had
    /// agreed.
    #[test]
    fn a_redeem_with_no_keyname_check_is_refused_not_downgraded() {
        let query = redeem("ss-pair1.whatever", None);
        let refusal = keyname_check(&query).expect_err("must refuse");
        // Actionable: it names both ways out.
        assert!(refusal.contains("expect_keyname"), "{refusal}");
        assert!(refusal.contains("confirmed_by_human"), "{refusal}");

        // Whitespace is not a key-name either.
        assert!(keyname_check(&redeem("blob", Some("   "))).is_err());

        // And the refusal must not echo the blob, which is a credential.
        assert!(!refusal.contains("ss-pair1"), "{refusal}");
    }

    #[test]
    fn a_typed_keyname_is_compared_and_an_affirmative_is_accepted() {
        assert!(matches!(
            keyname_check(&redeem("blob", Some("amber-brisk-cedar"))),
            Ok(KeynameCheck::Expect("amber-brisk-cedar"))
        ));
        assert!(matches!(
            keyname_check(&DevicePairRedeemRequest {
                blob: "blob".to_string(),
                expect_keyname: None,
                confirmed_by_human: true,
            }),
            Ok(KeynameCheck::ConfirmedByHuman)
        ));
    }

    /// The whole ceremony as the desktop drives it: two devices, blobs carried
    /// by hand, the key-name typed at both ends. Both sides end up pinned.
    ///
    /// Driven through `keyname_check` + `DeviceHandle` — the exact pair of
    /// things the commands call — rather than through core's `Devices`, so the
    /// desktop's own plumbing is what is under test.
    #[test]
    fn the_pairing_ceremony_pins_both_devices_when_the_keynames_match() {
        let laptop = device("laptop");
        let phone = device("phone");
        let laptop_keyname = laptop.identity().unwrap().unwrap().keyname;
        let phone_keyname = phone.identity().unwrap().unwrap().keyname;

        // 1: the laptop mints an invite; 2: the phone redeems it, typing the
        // key-name it read off the laptop's screen.
        let invite = laptop.invite_create("phone", 600).unwrap();
        let accept_req = redeem(&invite.blob, Some(&laptop_keyname));
        let acceptance = phone
            .pair_accept(&invite.blob, keyname_check(&accept_req).unwrap())
            .unwrap();
        assert_eq!(acceptance.peer.keyname, laptop_keyname);

        // 4: the laptop redeems the acceptance, typing the phone's key-name.
        let confirm_req = redeem(&acceptance.blob, Some(&phone_keyname));
        let peer = laptop
            .pair_confirm(&acceptance.blob, keyname_check(&confirm_req).unwrap())
            .unwrap();
        assert_eq!(peer.keyname, phone_keyname);
        assert!(!peer.is_revoked());

        // Both hold exactly one pin, of the other.
        assert_eq!(laptop.peer_list().unwrap().len(), 1);
        assert_eq!(phone.peer_list().unwrap().len(), 1);

        // The invite is burnt: single-use, so the same acceptance cannot be
        // redeemed twice.
        assert!(laptop.invite_list().unwrap()[0].is_redeemed());
        assert!(laptop
            .pair_confirm(&acceptance.blob, keyname_check(&confirm_req).unwrap())
            .is_err());
    }

    /// A wrong key-name refuses, and refusing pins nothing. This is the case
    /// the human check exists for — a blob substituted in flight.
    #[test]
    fn a_mismatched_keyname_refuses_and_pins_nothing() {
        let laptop = device("laptop");
        let phone = device("phone");
        // A third device's key-name: well-formed (so it passes the checksum
        // gate) but not the inviter's.
        let intruder = device("intruder").identity().unwrap().unwrap().keyname;

        let invite = laptop.invite_create("phone", 600).unwrap();
        let req = redeem(&invite.blob, Some(&intruder));
        let err = phone
            .pair_accept(&invite.blob, keyname_check(&req).unwrap())
            .expect_err("a mismatched key-name must refuse");
        assert!(
            format!("{err}").contains("key-name"),
            "the refusal must name the comparison that failed: {err}"
        );
        assert!(phone.peer_list().unwrap().is_empty(), "nothing was pinned");

        // A mistyped name is a *different* answer from the wrong device, and
        // core distinguishes them — the desktop must not flatten them.
        let typo = redeem(&invite.blob, Some("not-a-key-name"));
        let err = phone
            .pair_accept(&invite.blob, keyname_check(&typo).unwrap())
            .expect_err("a mistyped key-name must refuse");
        assert!(
            format!("{err}").contains("mistyped") || format!("{err}").contains("typed"),
            "{err}"
        );
    }

    /// Rotation and reset are the two local-only key operations. Rotation is
    /// signed by the outgoing key and verifies; reset destroys the identity
    /// but keeps this device's opinions about other devices.
    #[test]
    fn rotate_is_provable_and_reset_keeps_peer_pins() {
        let laptop = device("laptop");
        let phone = device("phone");
        let invite = laptop.invite_create("phone", 600).unwrap();
        let laptop_keyname = laptop.identity().unwrap().unwrap().keyname;
        let acceptance = phone
            .pair_accept(
                &invite.blob,
                keyname_check(&redeem(&invite.blob, Some(&laptop_keyname))).unwrap(),
            )
            .unwrap();
        let phone_keyname = phone.identity().unwrap().unwrap().keyname;
        laptop
            .pair_confirm(
                &acceptance.blob,
                keyname_check(&redeem(&acceptance.blob, Some(&phone_keyname))).unwrap(),
            )
            .unwrap();

        let before = laptop.identity().unwrap().unwrap();
        let (after, rotation) = laptop.rotate().unwrap();
        assert_ne!(after.public_key, before.public_key, "a new device id");
        assert!(rotation.verify(), "the rotation must prove itself");
        assert_eq!(laptop.rotations().unwrap().len(), 1);

        laptop.reset().unwrap();
        assert!(laptop.identity().unwrap().is_none());
        assert_eq!(
            laptop.peer_list().unwrap().len(),
            1,
            "our pins of other devices survive changing our own key"
        );
        assert!(
            laptop.invite_list().unwrap().is_empty(),
            "a reset clears this device's invites"
        );
    }

    /// A revoked peer is a tombstone, and only a deliberate forget clears it.
    /// Both commands exist on this surface for that reason.
    #[test]
    fn revoke_tombstones_and_forget_is_the_only_way_back() {
        let laptop = device("laptop");
        let phone = device("phone");
        let invite = laptop.invite_create("phone", 600).unwrap();
        let laptop_keyname = laptop.identity().unwrap().unwrap().keyname;
        let acceptance = phone
            .pair_accept(
                &invite.blob,
                keyname_check(&redeem(&invite.blob, Some(&laptop_keyname))).unwrap(),
            )
            .unwrap();

        let peer_id = acceptance.peer.public_key.clone();
        assert!(phone.peer_revoke(&peer_id).unwrap().is_revoked());
        assert_eq!(
            phone.peer_list().unwrap().len(),
            1,
            "revocation is a tombstone, not a delete"
        );
        assert!(phone.peer_forget(&peer_id).unwrap());
        assert!(phone.peer_list().unwrap().is_empty());
        assert!(!phone.peer_forget(&peer_id).unwrap());
    }

    /// An invite can be withdrawn while it is unredeemed — the answer to
    /// "that blob went to the wrong window", since the blob is a live
    /// credential until it expires.
    #[test]
    fn an_unredeemed_invite_can_be_withdrawn() {
        let laptop = device("laptop");
        let invite = laptop.invite_create("phone", 600).unwrap();
        assert_eq!(laptop.invite_list().unwrap().len(), 1);
        assert!(laptop.invite_cancel(&invite.id).unwrap());
        assert!(laptop.invite_list().unwrap().is_empty());
        assert!(!laptop.invite_cancel(&invite.id).unwrap());
    }

    /// Invite metadata is what the screen lists, and it must never carry the
    /// claim token — the clear token exists only inside the blob the user
    /// already holds.
    #[test]
    fn invite_metadata_never_carries_the_claim_token() {
        let laptop = device("laptop");
        let invite = laptop.invite_create("phone", 600).unwrap();
        let listed = serde_json::to_string(&laptop.invite_list().unwrap()).unwrap();
        assert!(!listed.contains(&invite.blob));
        // The blob's payload is base64url of JSON containing the token; assert
        // on a long slice of it rather than the whole string.
        let body = invite.blob.trim_start_matches("ss-pair1.");
        assert!(body.len() > 40);
        assert!(!listed.contains(&body[..40]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use slipscan_core::domain::CategoryKind;

    fn node(id: &str, children: Vec<CategoryNode>) -> CategoryNode {
        CategoryNode {
            category: core::Category {
                id: id.to_string(),
                book_id: "b".to_string(),
                parent_id: None,
                name: id.to_string(),
                kind: CategoryKind::Expense,
                icon: None,
                color: None,
                is_system: false,
                created_at: "2026-07-01T00:00:00Z".to_string(),
                updated_at: "2026-07-01T00:00:00Z".to_string(),
            },
            children,
        }
    }

    /// An impossible month must be a validation error, not an empty result:
    /// "2026-13" compared against nothing would report "no stats" forever.
    #[test]
    fn calendar_month_accepts_only_yyyy_mm_with_a_real_month() {
        for good in ["2026-01", "2026-07", "2026-12", "0001-05"] {
            assert!(is_calendar_month(good), "{good} should be accepted");
        }
        for bad in [
            "2026-13",
            "2026-00",
            "2026-7",
            "2026-07-01",
            "july",
            "202607",
            "2026-ab",
            "",
        ] {
            assert!(!is_calendar_month(bad), "{bad:?} should be rejected");
        }
    }

    /// A benchmark stat for a parent key must count spend booked to the
    /// parent's children — otherwise `transport` reads as zero for anyone who
    /// categorises to `transport.fuel`.
    #[test]
    fn subtree_ids_rolls_children_into_their_parent() {
        let tree = vec![
            node(
                "transport",
                vec![
                    node("fuel", vec![node("tolls", vec![])]),
                    node("taxi", vec![]),
                ],
            ),
            node("groceries", vec![]),
        ];
        let subtrees = subtree_ids(&tree);

        let mut transport = subtrees["transport"].clone();
        transport.sort();
        assert_eq!(transport, ["fuel", "taxi", "tolls", "transport"]);

        // Every node is its own subtree root, and a leaf covers only itself.
        assert_eq!(subtrees["groceries"], vec!["groceries".to_string()]);
        assert_eq!(subtrees["tolls"], vec!["tolls".to_string()]);
        let mut fuel = subtrees["fuel"].clone();
        fuel.sort();
        assert_eq!(fuel, vec!["fuel".to_string(), "tolls".to_string()]);
    }

    /// Two packs mapping the same key onto overlapping categories must not
    /// double-count — the op de-duplicates ids before summing, and this pins
    /// the property the de-duplication exists for.
    #[test]
    fn overlapping_subtrees_de_duplicate_before_summing() {
        let tree = vec![node("transport", vec![node("fuel", vec![])])];
        let subtrees = subtree_ids(&tree);
        // One pack maps "transport" -> transport, another -> fuel (a
        // descendant of the first). Pooled, the covered set must be 2 ids.
        let ids: BTreeSet<String> = ["transport".to_string(), "fuel".to_string()].into();
        let covered: BTreeSet<&str> = ids
            .iter()
            .flat_map(|id| subtrees.get(id).map(Vec::as_slice).unwrap_or_default())
            .map(String::as_str)
            .collect();
        assert_eq!(covered.len(), 2, "fuel must not be counted twice");
    }
}
