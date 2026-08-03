//! slip/scan desktop shell.
//!
//! IPC commands are thin adapters: parse → call slipscan-core services →
//! serialize (see `commands.rs`). All durable data (SQLite database +
//! documents store) lives in ONE movable folder resolved through core's
//! shared `datadir` pointer — the same one the CLI and server follow; the
//! frontend's typed client falls back to mock data only when a command is
//! not wired at all (plain `vite dev` in a browser).

mod commands;
mod datadir;
mod dto;
mod state;

use serde::Serialize;
use tauri::Manager;

use state::AppState;

#[derive(Serialize)]
struct Health {
    status: &'static str,
    version: &'static str,
    tauri: &'static str,
}

/// Liveness probe for the frontend: confirms IPC is up and reports versions.
#[tauri::command]
fn health() -> Health {
    Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        tauri: tauri::VERSION,
    }
}

/// Wire installed pack rules into core's categorisation, for this whole
/// process.
///
/// `slipscan_packs::register_classifier`'s own contract is "call it once at
/// startup, in every binary that imports transactions" — and this binary
/// imports them (`document_import`, and every categorisation that follows).
/// Registering only inside `commands::pack_install` would mean a session that
/// has not installed a pack — i.e. essentially every session — skipped every
/// `contains`, `regex` and `keyword` rule already in the database. Exact
/// rules would still fire, because installing seeds those into core's own
/// `merchant_mappings`, which made the gap quiet rather than absent.
///
/// Idempotent (the first registration in a process wins) and free until a
/// book actually has pack rules. Returns whether this call registered.
pub fn register_pack_classifier() -> bool {
    slipscan_packs::register_classifier()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    register_pack_classifier();
    tauri::Builder::default()
        .setup(|app| {
            // Core's shared resolver: pointer in the fixed per-OS config
            // dir, default data in the per-OS app-data dir — the exact
            // folders the CLI and server resolve too.
            let resolver =
                slipscan_core::datadir::DataDirResolver::system().map_err(std::io::Error::other)?;
            let state = AppState::open(resolver).map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            commands::data_status,
            commands::data_move,
            commands::book_create,
            commands::book_list,
            commands::book_profile,
            commands::book_set_kind,
            commands::book_set_multi_location_override,
            commands::location_list,
            commands::location_create,
            commands::location_update,
            commands::location_delete,
            // Purchasing (Phase 6.4). No screen calls these yet (ROADMAP.md
            // 6.9) — wired now so the IPC layer is not the surface left
            // waiting on a UI, the same posture the CLI and HTTP routes take.
            // Catalogue (Phase 6.3a). Wired late for the same reason as
            // contacts below — an order line could name a variant_id that
            // nothing on any surface could create.
            commands::product_category_create,
            commands::product_category_get,
            commands::product_category_list,
            commands::product_category_rename,
            commands::product_category_delete,
            commands::product_create,
            commands::product_get,
            commands::product_list,
            commands::product_update,
            commands::product_delete,
            commands::product_variant_add,
            commands::product_variant_get,
            commands::product_variant_list,
            commands::product_variant_list_for_book,
            commands::product_variant_update,
            commands::product_variant_delete,
            // Contacts (Phase 6.2). Wired late — the model shipped with 6.2
            // but nothing on any surface could create one, which is what made
            // purchasing and sales unusable end to end.
            commands::contact_add,
            commands::contact_get,
            commands::contact_list,
            commands::contact_list_customers,
            commands::contact_list_suppliers,
            commands::contact_update,
            commands::contact_remove,
            commands::po_create,
            commands::po_get,
            commands::po_list,
            commands::po_update,
            commands::po_set_status,
            commands::po_delete,
            commands::po_item_add,
            commands::po_item_get,
            commands::po_item_list,
            commands::po_item_update,
            commands::po_item_delete,
            commands::po_receive,
            commands::po_receipts_for_item,
            commands::po_receipts_for_po,
            commands::po_item_received_qty,
            commands::po_item_receiving_status,
            commands::po_items_with_receiving,
            commands::po_receiving_status,
            commands::sales_order_create,
            commands::sales_order_get,
            commands::sales_order_list,
            commands::sales_order_update,
            commands::sales_order_delete,
            commands::sales_order_item_add,
            commands::sales_order_items_list,
            commands::sales_order_item_update,
            commands::sales_order_item_remove,
            commands::sales_order_confirm,
            commands::sales_order_cancel,
            commands::sales_order_mark_paid,
            commands::sales_order_totals,
            commands::invoice_issue,
            commands::invoice_get,
            commands::invoice_list,
            commands::invoice_items_list,
            commands::invoice_totals,
            commands::invoice_payment_record,
            commands::invoice_payments_list,
            commands::report_aged_receivables,
            commands::account_list,
            commands::networth_capture,
            commands::networth_backfill,
            commands::networth_series,
            commands::transaction_list,
            commands::transaction_categorize,
            commands::category_list,
            commands::member_list,
            commands::member_add,
            commands::member_update,
            commands::member_remove,
            commands::transaction_attribute,
            commands::transaction_splits_list,
            commands::transaction_split_set,
            commands::report_member_expense,
            commands::report_member_contribution,
            commands::report_member_category,
            commands::report_settle_up,
            commands::budget_list,
            commands::budget_upsert,
            commands::document_list,
            commands::document_get,
            commands::document_import,
            commands::ledger_account_list,
            commands::journal_list,
            commands::journal_post,
            commands::recon_suggest,
            commands::recon_confirm,
            commands::report_spending,
            commands::report_income_expense,
            commands::report_vat_summary,
            commands::report_trial_balance,
            commands::region_list,
            commands::vat_rate_list,
            commands::vat_rate_set_bps,
            commands::pay_watch_list,
            commands::pay_watch_add,
            commands::pay_watch_remove,
            commands::pay_watch_set_enabled,
            commands::pay_endpoint_list,
            commands::pay_endpoint_add,
            commands::pay_endpoint_rotate_secret,
            commands::pay_endpoint_remove,
            commands::pay_endpoint_set_enabled,
            commands::pay_match_list,
            commands::pay_delivery_list,
            commands::pay_deliver_due,
            commands::fx_status,
            commands::fx_configure,
            commands::fx_fetch_rate,
            commands::fx_convert,
            commands::pack_list,
            commands::pack_verify,
            commands::pack_install,
            commands::pack_install_seeds,
            commands::pack_uninstall,
            commands::pack_source_add,
            commands::pack_source_remove,
            commands::pack_source_list,
            commands::pack_source_fetch,
            commands::pack_source_install,
            commands::pack_benchmark,
            commands::settings_get,
            commands::settings_set,
            commands::vault_list,
            commands::vault_set,
            commands::vault_replace,
            commands::vault_revoke,
            // Device identity and pairing. The first five mirror routes the
            // server serves; the rest are local-only there and refuse over
            // HTTP — they create or destroy the private key, or they carry a
            // single-use claim token and need a human in front of the screen.
            // IPC is a local channel, so this surface has both halves (the
            // same reason `vault_set` lives here with no route).
            commands::device_status,
            commands::device_list,
            commands::device_get,
            commands::device_invite_list,
            commands::device_rotations,
            commands::device_revoke,
            commands::device_init,
            commands::device_rotate,
            commands::device_reset,
            commands::device_forget,
            commands::device_pair_invite,
            commands::device_pair_accept,
            commands::device_pair_confirm,
            commands::device_invite_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running slip/scan");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_reports_ok_with_versions() {
        let h = health();
        assert_eq!(h.status, "ok");
        assert_eq!(h.version, env!("CARGO_PKG_VERSION"));
        assert!(!h.tauri.is_empty());
    }

    #[test]
    fn health_serializes_to_contract_shape() {
        let json = serde_json::to_value(health()).expect("serialize");
        assert_eq!(json["status"], "ok");
        assert!(json["version"].is_string());
        assert!(json["tauri"].is_string());
    }
}
