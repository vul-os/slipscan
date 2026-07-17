//! slip/scan desktop shell.
//!
//! IPC commands are thin adapters: parse → call slipscan-core services →
//! serialize (see `commands.rs`). The SQLite database lives in the OS app
//! data directory; the frontend's typed client falls back to mock data only
//! when a command is not wired at all (plain `vite dev` in a browser).

mod commands;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = AppState::open(data_dir).map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            commands::book_list,
            commands::account_list,
            commands::transaction_list,
            commands::transaction_categorize,
            commands::category_list,
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
            commands::settings_get,
            commands::settings_set,
            commands::vault_list,
            commands::vault_set,
            commands::vault_replace,
            commands::vault_revoke,
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
