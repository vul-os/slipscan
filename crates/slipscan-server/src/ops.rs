//! Operations composed on top of slipscan-core's public services, shared by
//! the HTTP routes and the CLI: signed pack installation and the ledger
//! reports (VAT summary, profit & loss, balance sheet).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use slipscan_core::domain::{
    CategoryKind, CategoryNode, CoaKind, NewCategory, TrialBalanceRow, VatRate,
};
use slipscan_core::util::now_iso;
use slipscan_core::{CoreError, CoreService};
use slipscan_packs::{verify_pack, PackError, PackManifest};

/// Settings key holding the JSON index of installed packs. Packs move rules,
/// never data (mantra #5): the index stores manifests only.
pub const INSTALLED_PACKS_SETTING: &str = "packs.installed";

#[derive(Debug, thiserror::Error)]
pub enum OpsError {
    #[error(transparent)]
    Core(#[from] CoreError),

    #[error("pack rejected: {0}")]
    Pack(#[from] PackError),

    #[error("validation error: {0}")]
    Validation(String),
}

/// One installed pack, as stored in the settings index.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstalledPackEntry {
    pub book_id: String,
    pub installed_at: String,
    pub manifest: PackManifest,
}

/// What `pack_install` did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackInstallResult {
    pub pack_id: String,
    pub name: String,
    pub version: String,
    pub book_id: String,
    pub categories_created: u32,
    pub categories_existing: u32,
    pub rules: u32,
}

/// Verify a signed pack and install it into a book: the category taxonomy is
/// created (existing categories with the same name + parent are reused) and
/// the manifest is recorded in the installed-packs index. Classification
/// rules are stored with the manifest for the classify engine; they are never
/// applied retroactively here.
pub fn pack_install(
    service: &CoreService,
    book_id: &str,
    manifest_bytes: &[u8],
    signature: &[u8],
    public_key: &[u8],
) -> Result<PackInstallResult, OpsError> {
    let manifest = verify_pack(manifest_bytes, signature, public_key)?;
    service.book_get(book_id)?;

    // Existing categories: (parent_id, name) -> id.
    let mut existing: HashMap<(Option<String>, String), String> = HashMap::new();
    fn flatten(
        nodes: &[CategoryNode],
        parent: Option<&str>,
        into: &mut HashMap<(Option<String>, String), String>,
    ) {
        for node in nodes {
            into.insert(
                (parent.map(str::to_string), node.category.name.clone()),
                node.category.id.clone(),
            );
            flatten(&node.children, Some(&node.category.id), into);
        }
    }
    flatten(&service.category_tree(book_id)?, None, &mut existing);

    // Resolve pack categories parents-first.
    let mut key_to_id: HashMap<String, String> = HashMap::new();
    let mut created: u32 = 0;
    let mut reused: u32 = 0;
    let mut pending: Vec<_> = manifest.categories.clone();
    while !pending.is_empty() {
        let before = pending.len();
        let mut next = Vec::new();
        for cat in pending {
            let parent_id = match cat.parent_key.as_deref() {
                None => None,
                Some(key) => match key_to_id.get(key) {
                    Some(id) => Some(id.clone()),
                    None => {
                        next.push(cat);
                        continue;
                    }
                },
            };
            let slot = (parent_id.clone(), cat.name.clone());
            let id = match existing.get(&slot) {
                Some(id) => {
                    reused += 1;
                    id.clone()
                }
                None => {
                    let kind: CategoryKind = cat.kind.parse()?;
                    let created_cat = service.category_create(NewCategory {
                        book_id: book_id.to_string(),
                        parent_id,
                        name: cat.name.clone(),
                        kind,
                        icon: cat.icon.clone(),
                        color: cat.color.clone(),
                    })?;
                    created += 1;
                    existing.insert(slot, created_cat.id.clone());
                    created_cat.id
                }
            };
            key_to_id.insert(cat.key.clone(), id);
        }
        if next.len() == before {
            let keys: Vec<_> = next.iter().map(|c| c.key.as_str()).collect();
            return Err(OpsError::Validation(format!(
                "pack has unresolved or cyclic parent keys: {}",
                keys.join(", ")
            )));
        }
        pending = next;
    }

    // Upsert into the installed-packs index.
    let mut installed = pack_list(service)?;
    installed.retain(|e| !(e.manifest.id == manifest.id && e.book_id == book_id));
    let result = PackInstallResult {
        pack_id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        book_id: book_id.to_string(),
        categories_created: created,
        categories_existing: reused,
        rules: manifest.rules.len() as u32,
    };
    installed.push(InstalledPackEntry {
        book_id: book_id.to_string(),
        installed_at: now_iso(),
        manifest,
    });
    service.settings_set(
        INSTALLED_PACKS_SETTING,
        &serde_json::to_string(&installed).map_err(CoreError::from)?,
        false,
    )?;
    Ok(result)
}

/// All installed packs (across books).
pub fn pack_list(service: &CoreService) -> Result<Vec<InstalledPackEntry>, OpsError> {
    match service.settings_get(INSTALLED_PACKS_SETTING)? {
        None => Ok(Vec::new()),
        Some(json) => Ok(serde_json::from_str(&json).map_err(CoreError::from)?),
    }
}

/// Well-known tax control account codes, stable across every region profile
/// (contract in `slipscan_core::region`): tax input control, tax output
/// control, and the tax-authority settlement account.
const TAX_CONTROL_CODES: [&str; 3] = ["1400", "2100", "2150"];

/// Tax summary: configured rates plus the trial-balance position of the tax
/// control accounts, in the book's base currency — a return is filed in one
/// currency, so other-currency rows are excluded rather than mixed into the
/// net position. The report is named by the book's region profile ("VAT201"
/// for za, "Tax summary" for generic) — never hardcoded here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaxReport {
    /// Region-profile display name for this report (e.g. "VAT201").
    pub report_name: String,
    pub currency: String,
    pub rates: Vec<VatRate>,
    pub accounts: Vec<TrialBalanceRow>,
    /// Net tax position in minor units: credits minus debits over the tax
    /// control accounts. Positive = owed to the revenue service.
    pub net_minor: i64,
}

/// Deprecated alias — the report was renamed to [`TaxReport`]; "VAT" is
/// jurisdiction wording that belongs to region profiles.
#[deprecated(note = "renamed to TaxReport")]
pub type VatReport = TaxReport;

pub fn report_tax(service: &CoreService, book_id: &str) -> Result<TaxReport, OpsError> {
    let book = service.book_get(book_id)?;
    let profile = slipscan_core::region::profile_or_generic(&book.region);
    let rates = service.vat_rate_list(book_id)?;
    // Tax control accounts: the well-known codes every profile keeps, plus
    // (for older/custom charts) anything the user named as a VAT account.
    let accounts: Vec<TrialBalanceRow> = service
        .report_trial_balance(book_id)?
        .into_iter()
        .filter(|row| {
            row.currency == book.currency
                && (TAX_CONTROL_CODES.contains(&row.code.as_str())
                    || row.name.to_lowercase().contains("vat"))
        })
        .collect();
    let net_minor = accounts
        .iter()
        .map(|r| r.credit_minor - r.debit_minor)
        .sum();
    Ok(TaxReport {
        report_name: profile.tax_report.report_name.to_string(),
        currency: book.currency,
        rates,
        accounts,
        net_minor,
    })
}

/// Deprecated alias for [`report_tax`].
#[deprecated(note = "renamed to report_tax")]
pub fn report_vat(service: &CoreService, book_id: &str) -> Result<TaxReport, OpsError> {
    report_tax(service, book_id)
}

/// One ledger account's contribution to a derived report, in minor units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportRow {
    pub coa_id: String,
    pub code: String,
    pub name: String,
    pub amount_minor: i64,
}

/// Profit & loss derived from all posted journals to date, in the book's
/// base currency (foreign-currency lines are excluded, never mixed into the
/// totals). Income accounts contribute credits − debits; expense accounts
/// debits − credits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfitAndLoss {
    pub book_id: String,
    pub currency: String,
    pub income: Vec<ReportRow>,
    pub expenses: Vec<ReportRow>,
    pub income_total_minor: i64,
    pub expense_total_minor: i64,
    pub net_profit_minor: i64,
}

/// Balance sheet derived from all posted journals to date, in the book's
/// base currency. Retained earnings (net profit not yet closed to equity)
/// is reported separately so the statement balances.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BalanceSheet {
    pub book_id: String,
    pub currency: String,
    pub assets: Vec<ReportRow>,
    pub liabilities: Vec<ReportRow>,
    pub equity: Vec<ReportRow>,
    pub assets_total_minor: i64,
    pub liabilities_total_minor: i64,
    pub equity_total_minor: i64,
    pub retained_earnings_minor: i64,
    pub balanced: bool,
}

/// Trial-balance rows of one kind in one currency, folded into report rows.
/// The currency filter is what keeps every derived total single-currency.
fn tb_rows(
    tb: &[TrialBalanceRow],
    kind: CoaKind,
    currency: &str,
    credit_normal: bool,
) -> (Vec<ReportRow>, i64) {
    let rows: Vec<ReportRow> = tb
        .iter()
        .filter(|r| r.kind == kind && r.currency == currency)
        .map(|r| ReportRow {
            coa_id: r.coa_id.clone(),
            code: r.code.clone(),
            name: r.name.clone(),
            amount_minor: if credit_normal {
                r.credit_minor - r.debit_minor
            } else {
                r.debit_minor - r.credit_minor
            },
        })
        .filter(|r| r.amount_minor != 0)
        .collect();
    let total = rows.iter().map(|r| r.amount_minor).sum();
    (rows, total)
}

pub fn report_profit_loss(service: &CoreService, book_id: &str) -> Result<ProfitAndLoss, OpsError> {
    let book = service.book_get(book_id)?;
    let tb = service.report_trial_balance(book_id)?;
    let (income, income_total_minor) = tb_rows(&tb, CoaKind::Income, &book.currency, true);
    let (expenses, expense_total_minor) = tb_rows(&tb, CoaKind::Expense, &book.currency, false);
    Ok(ProfitAndLoss {
        book_id: book_id.to_string(),
        currency: book.currency,
        income,
        expenses,
        net_profit_minor: income_total_minor - expense_total_minor,
        income_total_minor,
        expense_total_minor,
    })
}

pub fn report_balance_sheet(
    service: &CoreService,
    book_id: &str,
) -> Result<BalanceSheet, OpsError> {
    let book = service.book_get(book_id)?;
    let tb = service.report_trial_balance(book_id)?;
    let cur = book.currency.as_str();
    let (assets, assets_total_minor) = tb_rows(&tb, CoaKind::Asset, cur, false);
    let (liabilities, liabilities_total_minor) = tb_rows(&tb, CoaKind::Liability, cur, true);
    let (equity, equity_total_minor) = tb_rows(&tb, CoaKind::Equity, cur, true);
    let (_, income_total) = tb_rows(&tb, CoaKind::Income, cur, true);
    let (_, expense_total) = tb_rows(&tb, CoaKind::Expense, cur, false);
    let retained_earnings_minor = income_total - expense_total;
    Ok(BalanceSheet {
        book_id: book_id.to_string(),
        currency: book.currency.clone(),
        balanced: assets_total_minor
            == liabilities_total_minor + equity_total_minor + retained_earnings_minor,
        assets,
        liabilities,
        equity,
        assets_total_minor,
        liabilities_total_minor,
        equity_total_minor,
        retained_earnings_minor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use slipscan_core::domain::{BookKind, NewBook, NewJournal, NewJournalLine};
    use slipscan_core::secrets::MemorySecretStore;
    use slipscan_core::Db;
    use slipscan_packs::{MatchType, PackCategory, PackRule};

    fn svc() -> CoreService {
        CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        )
    }

    fn make_book(service: &CoreService) -> String {
        service
            .book_create(NewBook {
                name: "Test".into(),
                kind: BookKind::Business,
                currency: None,
                country: Some("ZA".into()),
                region: None,
            })
            .unwrap()
            .id
    }

    fn manifest() -> PackManifest {
        PackManifest {
            id: "za-groceries".into(),
            name: "SA groceries".into(),
            version: "1.0.0".into(),
            description: None,
            author: None,
            created_at: None,
            categories: vec![
                PackCategory {
                    key: "food".into(),
                    name: "Food".into(),
                    parent_key: None,
                    kind: "expense".into(),
                    icon: None,
                    color: None,
                },
                PackCategory {
                    key: "food.groceries".into(),
                    name: "Groceries".into(),
                    parent_key: Some("food".into()),
                    kind: "expense".into(),
                    icon: None,
                    color: None,
                },
            ],
            rules: vec![PackRule {
                match_type: MatchType::MerchantContains,
                pattern: "pick n pay".into(),
                category_key: "food.groceries".into(),
                confidence: 0.9,
            }],
        }
    }

    fn signed(m: &PackManifest) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let bytes = serde_json::to_vec(m).unwrap();
        let key = SigningKey::from_bytes(&[3u8; 32]);
        let sig = key.sign(&bytes).to_bytes().to_vec();
        (bytes, sig, key.verifying_key().as_bytes().to_vec())
    }

    #[test]
    fn pack_install_creates_categories_and_is_idempotent() {
        let service = svc();
        let book_id = make_book(&service);
        let (bytes, sig, pubkey) = signed(&manifest());

        let first = pack_install(&service, &book_id, &bytes, &sig, &pubkey).unwrap();
        assert_eq!(first.categories_created, 2);
        assert_eq!(first.categories_existing, 0);
        assert_eq!(first.rules, 1);

        let tree = service.category_tree(&book_id).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].category.name, "Food");
        assert_eq!(tree[0].children[0].category.name, "Groceries");

        // Reinstall: nothing new is created, index has one entry.
        let second = pack_install(&service, &book_id, &bytes, &sig, &pubkey).unwrap();
        assert_eq!(second.categories_created, 0);
        assert_eq!(second.categories_existing, 2);
        let installed = pack_list(&service).unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].manifest.id, "za-groceries");
        assert_eq!(installed[0].manifest.rules.len(), 1);
    }

    #[test]
    fn pack_install_rejects_bad_signature_and_unknown_kind() {
        let service = svc();
        let book_id = make_book(&service);
        let (bytes, sig, pubkey) = signed(&manifest());

        let mut tampered = bytes.clone();
        let idx = tampered.len() - 2;
        tampered[idx] ^= 1;
        assert!(matches!(
            pack_install(&service, &book_id, &tampered, &sig, &pubkey),
            Err(OpsError::Pack(PackError::VerificationFailed))
        ));
        assert!(pack_list(&service).unwrap().is_empty());

        let mut bad = manifest();
        bad.categories[0].kind = "sideways".into();
        let (bytes, sig, pubkey) = signed(&bad);
        assert!(matches!(
            pack_install(&service, &book_id, &bytes, &sig, &pubkey),
            Err(OpsError::Core(CoreError::InvalidEnum { .. }))
        ));
    }

    #[test]
    fn pack_install_rejects_cyclic_parents() {
        let service = svc();
        let book_id = make_book(&service);
        let mut m = manifest();
        m.categories[0].parent_key = Some("food.groceries".into());
        let (bytes, sig, pubkey) = signed(&m);
        assert!(matches!(
            pack_install(&service, &book_id, &bytes, &sig, &pubkey),
            Err(OpsError::Validation(_))
        ));
    }

    #[test]
    fn vat_report_covers_control_accounts_and_rates() {
        let service = svc();
        let book_id = make_book(&service);
        let coa = service.coa_seed(&book_id).unwrap();
        let vat = coa.iter().find(|c| c.code == "2100").unwrap();
        let bank = coa.iter().find(|c| c.code == "1000").unwrap();

        // Collect R150 output VAT.
        service
            .journal_post(NewJournal {
                book_id: book_id.clone(),
                posted_date: "2026-07-01".into(),
                narrative: Some("Sale VAT".into()),
                reference: None,
                source_type: slipscan_core::domain::JournalSourceType::Manual,
                source_id: None,
                lines: vec![
                    NewJournalLine {
                        coa_id: bank.id.clone(),
                        debit_minor: 15_000,
                        credit_minor: 0,
                        currency: "ZAR".into(),
                        description: None,
                        vat_rate_id: None,
                        vat_role: None,
                    },
                    NewJournalLine {
                        coa_id: vat.id.clone(),
                        debit_minor: 0,
                        credit_minor: 15_000,
                        currency: "ZAR".into(),
                        description: None,
                        vat_rate_id: None,
                        vat_role: None,
                    },
                ],
            })
            .unwrap();

        let report = report_tax(&service, &book_id).unwrap();
        // The za profile names the report after its return form.
        assert_eq!(report.report_name, "VAT201");
        // Core seeds the ZA rate set; the standard 15% rate must be there.
        assert!(!report.rates.is_empty());
        assert!(report
            .rates
            .iter()
            .any(|r| r.code == "STD" && r.rate_bps == 1500));
        // All VAT control accounts surface; the posted output VAT nets out.
        assert!(report.accounts.iter().any(|a| a.code == "2100"));
        assert!(report
            .accounts
            .iter()
            .all(|a| a.name.to_lowercase().contains("vat")));
        assert_eq!(report.net_minor, 15_000);
    }

    #[test]
    fn tax_report_is_region_neutral_for_a_generic_book() {
        let service = svc();
        // A generic-region book: control accounts are named "Tax …", not
        // "VAT …" — the report must find them by the well-known codes.
        let book_id = service
            .book_create(NewBook {
                name: "Global".into(),
                kind: BookKind::Business,
                currency: Some("EUR".into()),
                country: None,
                region: Some("generic".into()),
            })
            .unwrap()
            .id;
        let coa = service.coa_seed(&book_id).unwrap();
        let id_of = |code: &str| coa.iter().find(|c| c.code == code).unwrap().id.clone();
        service
            .journal_post(NewJournal {
                book_id: book_id.clone(),
                posted_date: "2026-07-01".into(),
                narrative: Some("Output tax".into()),
                reference: None,
                source_type: slipscan_core::domain::JournalSourceType::Manual,
                source_id: None,
                lines: vec![
                    NewJournalLine {
                        coa_id: id_of("1000"),
                        debit_minor: 2_000,
                        credit_minor: 0,
                        currency: "EUR".into(),
                        description: None,
                        vat_rate_id: None,
                        vat_role: None,
                    },
                    NewJournalLine {
                        coa_id: id_of("2100"),
                        debit_minor: 0,
                        credit_minor: 2_000,
                        currency: "EUR".into(),
                        description: None,
                        vat_rate_id: None,
                        vat_role: None,
                    },
                ],
            })
            .unwrap();

        let report = report_tax(&service, &book_id).unwrap();
        assert_eq!(report.report_name, "Tax summary");
        assert_eq!(report.currency, "EUR");
        assert!(report.accounts.iter().any(|a| a.code == "2100"));
        assert_eq!(report.net_minor, 2_000);
    }

    #[test]
    fn tax_report_unknown_book_is_not_found() {
        let service = svc();
        assert!(matches!(
            report_tax(&service, "missing"),
            Err(OpsError::Core(CoreError::NotFound { .. }))
        ));
    }

    /// Post one cash sale (R100 + R15 VAT) and one bank-fee expense (R20).
    fn seed_trading_book(service: &CoreService) -> String {
        let book_id = make_book(service);
        let coa = service.coa_seed(&book_id).unwrap();
        let id_of = |code: &str| coa.iter().find(|c| c.code == code).unwrap().id.clone();
        let line = |coa_id: String, debit: i64, credit: i64| NewJournalLine {
            coa_id,
            debit_minor: debit,
            credit_minor: credit,
            currency: "ZAR".into(),
            description: None,
            vat_rate_id: None,
            vat_role: None,
        };
        let post = |narrative: &str, lines: Vec<NewJournalLine>| {
            service
                .journal_post(NewJournal {
                    book_id: book_id.clone(),
                    posted_date: "2026-07-01".into(),
                    narrative: Some(narrative.into()),
                    reference: None,
                    source_type: slipscan_core::domain::JournalSourceType::Manual,
                    source_id: None,
                    lines,
                })
                .unwrap()
        };
        post(
            "Cash sale",
            vec![
                line(id_of("1000"), 11_500, 0),
                line(id_of("4000"), 0, 10_000),
                line(id_of("2100"), 0, 1_500),
            ],
        );
        post(
            "Bank fees",
            vec![line(id_of("6100"), 2_000, 0), line(id_of("1000"), 0, 2_000)],
        );
        book_id
    }

    #[test]
    fn profit_loss_from_ledger() {
        let service = svc();
        let book_id = seed_trading_book(&service);

        let pl = report_profit_loss(&service, &book_id).unwrap();
        assert_eq!(pl.income.len(), 1);
        assert_eq!(pl.income[0].code, "4000");
        assert_eq!(pl.income_total_minor, 10_000);
        assert_eq!(pl.expenses.len(), 1);
        assert_eq!(pl.expenses[0].code, "6100");
        assert_eq!(pl.expense_total_minor, 2_000);
        assert_eq!(pl.net_profit_minor, 8_000);
    }

    #[test]
    fn balance_sheet_balances_with_retained_earnings() {
        let service = svc();
        let book_id = seed_trading_book(&service);

        let bs = report_balance_sheet(&service, &book_id).unwrap();
        assert_eq!(bs.assets_total_minor, 9_500); // 11_500 in, 2_000 out
        assert_eq!(bs.liabilities_total_minor, 1_500); // VAT payable
        assert_eq!(bs.equity_total_minor, 0);
        assert_eq!(bs.retained_earnings_minor, 8_000);
        assert!(bs.balanced);
        // Zero-balance accounts stay out of the statement.
        assert!(bs.assets.iter().all(|r| r.amount_minor != 0));
    }

    #[test]
    fn derived_reports_unknown_book_is_not_found() {
        let service = svc();
        assert!(matches!(
            report_profit_loss(&service, "missing"),
            Err(OpsError::Core(CoreError::NotFound { .. }))
        ));
        assert!(matches!(
            report_balance_sheet(&service, "missing"),
            Err(OpsError::Core(CoreError::NotFound { .. }))
        ));
    }
}
