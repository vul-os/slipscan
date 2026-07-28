//! Operations composed on top of slipscan-core's public services, shared by
//! the HTTP routes and the CLI: signed pack installation and the ledger
//! reports (VAT summary, profit & loss, balance sheet).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use slipscan_core::domain::{CategoryNode, CoaKind, TrialBalanceRow, VatRate};
use slipscan_core::{CoreError, CoreService};
use slipscan_packs::{
    benchmark, builtin, engine, verify_detached, BenchmarkCohort, Comparison, InstallReport,
    Installer, PackError, PackManifest, TrustStatus, TrustStore,
};

/// Settings key of the **pre-installer** index of installed packs: one JSON
/// blob of manifests under a single key, which is how packs were recorded
/// before `pack_rules`/`pack_categories` existed. Nothing writes it any more;
/// it is read, migrated into the pack tables on first use, and then kept
/// verbatim as the historical record (see [`adopt_legacy_index`]).
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

/// One installed pack, reported in the legacy manifest shape the CLI, the
/// HTTP route and the desktop client already read.
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

/// Verify a signed pack and install it into a book, through
/// `slipscan_packs::Installer` — the one install path.
///
/// The three inputs are the ones a user holds: the pack document, its
/// detached signature, and the publisher's public key. Both pack document
/// shapes are accepted (current payload JSON, and the legacy flat manifest —
/// see [`slipscan_packs::verify_detached`]), so pack files already on disk
/// keep installing.
///
/// What installing now means, all of it inside one SQLite transaction:
///
/// * **trust-on-first-use.** Passing a public key *is* the trust decision, so
///   a key seen for the first time is recorded in the trust store — after
///   which that publisher's packs verify against a stored key, and the pack
///   id is **pinned** to it. A later version of the same pack signed by a
///   different key is rejected, which is precisely what the old path, holding
///   no key at all, could not do.
/// * **versions only move forward.** Re-installing the version already
///   installed is an error (`already installed`), and downgrades are
///   rejected. This is a change from the old behaviour, where re-installing
///   was a silent no-op.
/// * **rules become live.** The taxonomy maps onto local category ids and the
///   rules land in `pack_rules`, where the classifier reads them; exact
///   merchant rules also seed core's `merchant_mappings` with `source =
///   'pack'`, which never overwrites a user's own mapping.
/// * the install is recorded in the append-only audit log.
///
/// Rules are still not applied retroactively: they classify transactions
/// imported from here on, not the ones already in the book.
pub fn pack_install(
    service: &CoreService,
    book_id: &str,
    manifest_bytes: &[u8],
    signature: &[u8],
    public_key: &[u8],
) -> Result<PackInstallResult, OpsError> {
    let verified = verify_detached(manifest_bytes, signature, public_key)?;
    service.book_get(book_id)?;
    // Installing a pack is also where this process picks up the classifier:
    // from here on core consults the rules being written (engine docs).
    engine::register_classifier();

    let label = verified
        .payload()
        .meta
        .author
        .as_deref()
        .map(str::trim)
        .filter(|author| !author.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("publisher {}", verified.fingerprint()));

    service.with_connection(|conn| {
        let installer = Installer::open(conn)?;
        // Migrate first: a pack the old path installed must become an upgrade
        // of the same row, not a second copy of the same taxonomy.
        adopt_legacy_index(service, &installer)?;

        let trust = TrustStore::open(conn)?;
        if let TrustStatus::Unknown { .. } = trust.status(verified.signer())? {
            trust.trust(verified.signer(), &label)?;
        }

        let report = installer.install(book_id, &verified)?;
        Ok(install_result(book_id, &report))
    })
}

/// Install the builtin seed packs into a book. **Opt-in** — no surface calls
/// this on book creation, and the reasoning is in docs/PACKS.md: which
/// taxonomy a book should start from is the user's (or their region
/// profile's) decision, not something core can make on their behalf, and core
/// cannot call it anyway — slipscan-packs depends on core, never the reverse.
///
/// Idempotent: a seed already installed at the same version is skipped, and
/// categories the user already has are adopted by (parent, name) rather than
/// duplicated, so nothing of theirs is clobbered.
pub fn pack_install_seeds(
    service: &CoreService,
    book_id: &str,
) -> Result<Vec<PackInstallResult>, OpsError> {
    service.book_get(book_id)?;
    engine::register_classifier();
    service.with_connection(|conn| {
        Ok(builtin::install_seed_packs(conn, book_id)?
            .iter()
            .map(|report| install_result(book_id, report))
            .collect())
    })
}

/// All installed packs (across books), newest index first for a book.
///
/// Reads the pack tables, and folds in anything the pre-installer settings
/// index still holds that the tables could not take over — an install that
/// happened never disappears from the record.
pub fn pack_list(service: &CoreService) -> Result<Vec<InstalledPackEntry>, OpsError> {
    let books = service.book_list()?;
    service.with_connection(|conn| {
        let installer = if service.is_read_only() {
            // Listing must not create or migrate anything while the data
            // folder is being moved.
            Installer::open_readonly(conn)?
        } else {
            let installer = Installer::open(conn)?;
            adopt_legacy_index(service, &installer)?;
            Some(installer)
        };

        let mut entries: Vec<InstalledPackEntry> = Vec::new();
        if let Some(installer) = &installer {
            for book in &books {
                for pack in installer.list(&book.id)? {
                    let payload = installer.payload(&book.id, &pack.pack_id)?;
                    entries.push(InstalledPackEntry {
                        book_id: pack.book_id,
                        installed_at: pack.installed_at,
                        manifest: PackManifest::from_payload(&payload, None),
                    });
                }
            }
        }

        for entry in legacy_index(service)? {
            let pack_id = legacy_pack_id(&entry.manifest);
            let adopted = entries
                .iter()
                .any(|e| e.book_id == entry.book_id && e.manifest.id == pack_id);
            if !adopted {
                entries.push(entry);
            }
        }
        Ok(entries)
    })
}

/// Remove an installed pack's rules and its registration from a book.
///
/// Categories the pack created are **kept** — they are ordinary local
/// categories now and transactions point at them, so history never breaks.
/// The signer pin is kept too: the pack id stays bound to the key that first
/// signed it even after the pack is gone. Pack-seeded merchant mappings that
/// point at the pack's categories are dropped; the user's own mappings are
/// not. Returns whether a pack was actually removed.
pub fn pack_uninstall(
    service: &CoreService,
    book_id: &str,
    pack_id: &str,
) -> Result<bool, OpsError> {
    service.book_get(book_id)?;
    service.with_connection(|conn| Ok(Installer::open(conn)?.uninstall(book_id, pack_id)?))
}

/// One installed benchmark pack, compared against this book's own spend for
/// one calendar month.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BenchmarkReport {
    pub pack_id: String,
    /// Calendar month `YYYY-MM` that was compared.
    pub period: String,
    /// The pack's currency. Never converted — see `skipped`.
    pub currency: String,
    pub cohort: BenchmarkCohort,
    /// The k-anonymity floor the pack's aggregator enforced.
    pub k_floor: u64,
    /// Why nothing was compared, when nothing was. `None` on a real
    /// comparison (which may still be empty, if the pack has no stat for the
    /// period).
    pub skipped: Option<String>,
    pub comparisons: Vec<Comparison>,
    /// Taxonomy keys the pack has a stat for that no installed pack maps to a
    /// local category. Listed rather than dropped silently, so "why is
    /// groceries missing?" has an answer.
    pub unmapped_keys: Vec<String>,
}

/// Compare this book's spend for `period` against every installed benchmark
/// pack — the read side of anonymous peer comparison, and the only thing
/// SlipScan does with benchmark packs today.
///
/// **Reading is perfectly private** (docs/BENCHMARKS.md): a benchmark pack is
/// a public file of cohort aggregates, the comparison runs entirely here, and
/// nothing is transmitted. Contribution (the write side, with the
/// differential privacy the design calls for) does not exist — this op cannot
/// send anything anywhere.
///
/// How your side of the comparison is computed:
///
/// * spend is core's own [`CoreService::report_spending`] for the month, so a
///   category's figure is exactly what the spending report shows;
/// * a pack's taxonomy key resolves to local category ids through
///   `pack_category_map` — the same map installs write — and the total
///   **includes descendant categories**, so a `transport` stat counts
///   `transport.fuel` too. Ids are de-duplicated, so two packs mapping the
///   same key onto the same category cannot double-count;
/// * only transactions in the pack's own currency are counted, and no FX
///   conversion is applied. A pack in a currency the book does not use comes
///   back with `skipped` set rather than a fabricated zero.
pub fn pack_benchmark(
    service: &CoreService,
    book_id: &str,
    period: &str,
) -> Result<Vec<BenchmarkReport>, OpsError> {
    if !is_calendar_month(period) {
        return Err(OpsError::Validation(format!(
            "period {period:?} must be a calendar month, YYYY-MM"
        )));
    }
    let book = service.book_get(book_id)?;
    // `-01`..`-31` spans any month: posted dates are ISO strings compared
    // lexicographically, so a 30-day month simply has no `-31` row.
    let spending =
        service.report_spending(book_id, &format!("{period}-01"), &format!("{period}-31"))?;
    let subtrees = subtree_ids(&service.category_tree(book_id)?);

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
        let installer = if service.is_read_only() {
            Installer::open_readonly(conn)?
        } else {
            let installer = Installer::open(conn)?;
            adopt_legacy_index(service, &installer)?;
            Some(installer)
        };
        let Some(installer) = installer else {
            return Ok(Vec::new());
        };
        let sets = installer.benchmark_sets(book_id)?;
        if sets.is_empty() {
            return Ok(Vec::new());
        }

        // Taxonomy key -> local category ids, pooled across every installed
        // pack: benchmark packs declare no categories of their own, so the
        // keys they cite are resolved through the taxonomy packs.
        let mut key_to_ids: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for pack in installer.list(book_id)? {
            for (key, category_id) in installer.category_map(book_id, &pack.pack_id)? {
                key_to_ids.entry(key).or_default().insert(category_id);
            }
        }

        let mut reports = Vec::new();
        for (pack_id, set) in sets {
            let mut report = BenchmarkReport {
                pack_id,
                period: period.to_string(),
                currency: set.currency.clone(),
                cohort: set.cohort.clone(),
                k_floor: set.k_floor,
                skipped: None,
                comparisons: Vec::new(),
                unmapped_keys: Vec::new(),
            };
            let Some(spend_by_category) = by_currency.get(&set.currency) else {
                if set.currency != book.currency {
                    report.skipped = Some(format!(
                        "pack is in {} and this book is in {} — no conversion is applied",
                        set.currency, book.currency
                    ));
                } else {
                    report.skipped =
                        Some(format!("no {} spend recorded in {period}", set.currency));
                }
                reports.push(report);
                continue;
            };

            let mut spend_minor: BTreeMap<String, i64> = BTreeMap::new();
            for stat in set.stats.iter().filter(|stat| stat.period == period) {
                let Some(ids) = key_to_ids.get(&stat.category_key) else {
                    report.unmapped_keys.push(stat.category_key.clone());
                    continue;
                };
                // De-duplicate first: two packs may map the same key onto the
                // same category, or a category onto one of its own ancestors.
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
            report.comparisons = benchmark::compare(&set, period, &spend_minor);
            reports.push(report);
        }
        Ok(reports)
    })
}

/// `YYYY-MM`, with a month in 01..=12. An impossible month like `2026-13`
/// would compare against nothing and silently report "no stats" forever, so
/// it is a validation error rather than an empty result.
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

fn install_result(book_id: &str, report: &InstallReport) -> PackInstallResult {
    PackInstallResult {
        pack_id: report.pack.pack_id.clone(),
        name: report.pack.name.clone(),
        version: report.pack.version.clone(),
        book_id: book_id.to_string(),
        categories_created: report.categories_created as u32,
        categories_existing: report.categories_reused as u32,
        rules: report.rules_installed as u32,
    }
}

/// The pre-installer index, verbatim.
fn legacy_index(service: &CoreService) -> Result<Vec<InstalledPackEntry>, OpsError> {
    match service.settings_get(INSTALLED_PACKS_SETTING)? {
        None => Ok(Vec::new()),
        Some(json) => Ok(serde_json::from_str(&json).map_err(CoreError::from)?),
    }
}

/// The id a legacy manifest installs under (the payload charset is narrower
/// than the legacy format's; see `PackManifest::into_payload`).
fn legacy_pack_id(manifest: &PackManifest) -> String {
    manifest
        .clone()
        .into_payload()
        .map(|payload| payload.meta.id)
        .unwrap_or_else(|_| manifest.id.clone())
}

/// Migrate the pre-installer index into the pack tables, once.
///
/// Existing books must not lose their packs when the install path changes
/// under them, so every entry the old path wrote is adopted: its categories
/// are matched to the ones it created (by parent + name, never duplicated)
/// and its rules become live rules like any other pack's.
///
/// Non-destructive and idempotent. The settings key is never rewritten or
/// cleared — it is the only record of what that path installed. Entries
/// already in the tables are skipped, and one that cannot be converted (a
/// manifest that no longer validates) is left alone rather than failing the
/// whole call; [`pack_list`] still reports it from the index.
///
/// Nothing is verified, trusted or pinned on the way in: that index stored no
/// signature and no public key, so there is nothing to check and nothing
/// honest to pin — see `Installer::adopt_legacy`.
fn adopt_legacy_index(service: &CoreService, installer: &Installer<'_>) -> Result<(), OpsError> {
    for entry in legacy_index(service)? {
        // A book deleted since has nothing to adopt into.
        if service.book_get(&entry.book_id).is_err() {
            continue;
        }
        let Ok(payload) = entry.manifest.into_payload() else {
            continue;
        };
        installer.adopt_legacy(&entry.book_id, &payload, &entry.installed_at)?;
    }
    Ok(())
}

/// Well-known tax control account codes, stable across every region profile
/// (contract in `slipscan_core::region`): tax input control, tax output
/// control, and the tax-authority settlement account.
const TAX_CONTROL_CODES: [&str; 3] = ["1400", "2100", "2150"];

/// Whether an account *name* marks a tax control account (fallback for
/// older/custom charts that renamed the well-known codes). Matches the word
/// "vat" only — whole-word, so "Private Drawings" ("pri-vat-e") never
/// pollutes the net tax position. Localized names are covered by the
/// well-known codes above, never by wording heuristics.
fn name_marks_tax_control(name: &str) -> bool {
    name.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| word.eq_ignore_ascii_case("vat"))
}

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
                    || name_marks_tax_control(&row.name))
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
    use slipscan_core::domain::{
        AccountKind, BookKind, CategoryKind, NewAccount, NewBook, NewCategory, NewJournal,
        NewJournalLine, NewTransaction, TransactionSource,
    };
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

    fn signed_by(bytes: &[u8], seed: u8) -> (Vec<u8>, Vec<u8>) {
        let key = SigningKey::from_bytes(&[seed; 32]);
        (
            key.sign(bytes).to_bytes().to_vec(),
            key.verifying_key().as_bytes().to_vec(),
        )
    }

    /// A legacy flat manifest, signed: the file format users already have.
    fn signed(m: &PackManifest) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let bytes = serde_json::to_vec(m).unwrap();
        let (sig, key) = signed_by(&bytes, 3);
        (bytes, sig, key)
    }

    fn versioned(version: &str) -> PackManifest {
        PackManifest {
            version: version.into(),
            ..manifest()
        }
    }

    /// A benchmark pack: cohort aggregates and nothing else (the format
    /// forbids a pack from carrying both a taxonomy and benchmarks). Its
    /// stats cite `food` and `food.groceries`, the keys `manifest()`'s
    /// taxonomy maps onto local categories.
    fn benchmark_pack(currency: &str) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        use slipscan_packs::{BenchmarkCohort, BenchmarkSet, BenchmarkStat, PackMeta, PackPayload};

        let payload = PackPayload {
            meta: PackMeta {
                id: "za-cohort".into(),
                name: "SA cohort 2026".into(),
                version: "1.0.0".into(),
                region: Some("ZA".into()),
                author: None,
                description: None,
            },
            categories: Vec::new(),
            merchant_rules: Vec::new(),
            keyword_rules: Vec::new(),
            vat_hints: Vec::new(),
            benchmarks: Some(BenchmarkSet {
                cohort: BenchmarkCohort {
                    region: "ZA".into(),
                    household_size: 2,
                    income_band: "C".into(),
                },
                currency: currency.into(),
                k_floor: 25,
                stats: vec![
                    BenchmarkStat {
                        category_key: "food".into(),
                        period: "2026-07".into(),
                        sample_size: 412,
                        p25_minor: 310_000,
                        median_minor: 485_000,
                        p75_minor: 702_500,
                        mean_minor: None,
                    },
                    BenchmarkStat {
                        // No pack maps this key: it must be reported as
                        // unmapped, not silently dropped.
                        category_key: "pet-care".into(),
                        period: "2026-07".into(),
                        sample_size: 90,
                        p25_minor: 10_000,
                        median_minor: 20_000,
                        p75_minor: 30_000,
                        mean_minor: None,
                    },
                ],
            }),
        };
        let bytes = serde_json::to_vec(&payload).unwrap();
        let (sig, key) = signed_by(&bytes, 9);
        (bytes, sig, key)
    }

    #[test]
    fn pack_uninstall_removes_rules_but_keeps_categories() {
        let service = svc();
        let book_id = make_book(&service);
        let (bytes, sig, pubkey) = signed(&manifest());
        pack_install(&service, &book_id, &bytes, &sig, &pubkey).unwrap();
        assert_eq!(pack_list(&service).unwrap().len(), 1);

        assert!(pack_uninstall(&service, &book_id, "za-groceries").unwrap());
        assert!(pack_list(&service).unwrap().is_empty());
        // The categories it created are ordinary local categories now, so
        // transactions that point at them still resolve.
        let tree = service.category_tree(&book_id).unwrap();
        assert_eq!(tree[0].category.name, "Food");
        assert_eq!(tree[0].children[0].category.name, "Groceries");

        // Removing what is not installed is `false`, not an error.
        assert!(!pack_uninstall(&service, &book_id, "za-groceries").unwrap());
        assert!(matches!(
            pack_uninstall(&service, "no-such-book", "za-groceries"),
            Err(OpsError::Core(_))
        ));
    }

    /// The read side of peer comparison, end to end through the op: a book's
    /// own spend against a public cohort pack, with the parent-key rollup and
    /// the unmapped-key reporting the surfaces rely on.
    #[test]
    fn pack_benchmark_compares_local_spend_against_an_installed_cohort() {
        let service = svc();
        let book_id = make_book(&service);
        let (bytes, sig, pubkey) = signed(&manifest());
        pack_install(&service, &book_id, &bytes, &sig, &pubkey).unwrap();
        let (bench, bsig, bkey) = benchmark_pack("ZAR");
        pack_install(&service, &book_id, &bench, &bsig, &bkey).unwrap();

        let tree = service.category_tree(&book_id).unwrap();
        let groceries = tree[0].children[0].category.id.clone();
        let account = service
            .account_create(NewAccount {
                book_id: book_id.clone(),
                name: "Cheque".into(),
                kind: AccountKind::Bank,
                currency: "ZAR".into(),
                institution: None,
                account_number_masked: None,
                opening_balance_minor: None,
            })
            .unwrap();
        let spend = |date: &str, amount: i64, category: &str, occurrence: u32| {
            service
                .transaction_create(NewTransaction {
                    book_id: book_id.clone(),
                    account_id: account.id.clone(),
                    source: TransactionSource::Import,
                    provider_txn_id: None,
                    posted_date: date.into(),
                    amount_minor: amount,
                    currency: "ZAR".into(),
                    merchant: None,
                    description: None,
                    notes: None,
                    category_id: Some(category.to_string()),
                    document_id: None,
                    dedupe_occurrence: occurrence,
                })
                .unwrap()
        };
        // Booked to the CHILD category: the stat is on the parent key `food`,
        // so this only shows up if the rollup works.
        spend("2026-07-03", -400_000, &groceries, 0);
        spend("2026-07-28", -206_250, &groceries, 1);
        // Out of the period entirely.
        spend("2026-08-01", -999_999, &groceries, 2);

        let reports = pack_benchmark(&service, &book_id, "2026-07").unwrap();
        assert_eq!(reports.len(), 1, "only the benchmark pack is compared");
        let report = &reports[0];
        assert_eq!(report.pack_id, "za-cohort");
        assert_eq!(report.skipped, None);
        assert_eq!(report.cohort.household_size, 2);
        assert_eq!(report.unmapped_keys, vec!["pet-care".to_string()]);

        assert_eq!(report.comparisons.len(), 1);
        let food = &report.comparisons[0];
        assert_eq!(food.category_key, "food");
        assert_eq!(
            food.yours_minor, 606_250,
            "child spend rolls into the parent"
        );
        assert_eq!(food.delta_minor, 606_250 - 485_000);
        assert_eq!(food.ratio_to_median, Some(1.25));
        assert_eq!(food.position, slipscan_packs::QuartilePosition::Typical);
        assert_eq!(food.sample_size, 412);
        assert_eq!(food.currency, "ZAR");

        // A month with no stats compares nothing but is not an error; a month
        // that cannot exist is rejected rather than silently empty.
        assert!(pack_benchmark(&service, &book_id, "2026-06")
            .unwrap()
            .iter()
            .all(|r| r.comparisons.is_empty()));
        assert!(matches!(
            pack_benchmark(&service, &book_id, "2026-13"),
            Err(OpsError::Validation(_))
        ));
        assert!(matches!(
            pack_benchmark(&service, &book_id, "july"),
            Err(OpsError::Validation(_))
        ));
    }

    /// No pack installed, or a pack in a currency the book does not use:
    /// neither may fabricate a comparison. Currency is never converted.
    #[test]
    fn pack_benchmark_reports_nothing_rather_than_guessing() {
        let service = svc();
        let book_id = make_book(&service);
        assert!(pack_benchmark(&service, &book_id, "2026-07")
            .unwrap()
            .is_empty());

        let (bytes, sig, pubkey) = signed(&manifest());
        pack_install(&service, &book_id, &bytes, &sig, &pubkey).unwrap();
        // A taxonomy pack alone is not something to compare against.
        assert!(pack_benchmark(&service, &book_id, "2026-07")
            .unwrap()
            .is_empty());

        let (bench, bsig, bkey) = benchmark_pack("EUR");
        pack_install(&service, &book_id, &bench, &bsig, &bkey).unwrap();
        let reports = pack_benchmark(&service, &book_id, "2026-07").unwrap();
        assert_eq!(reports.len(), 1);
        assert!(reports[0].comparisons.is_empty());
        let reason = reports[0].skipped.as_deref().unwrap();
        assert!(
            reason.contains("EUR") && reason.contains("no conversion"),
            "the reason must name the mismatch, not report a fake zero: {reason}"
        );
    }

    #[test]
    fn pack_install_creates_categories_and_versions_move_forward() {
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

        // The same version again is refused rather than silently redone.
        assert!(matches!(
            pack_install(&service, &book_id, &bytes, &sig, &pubkey),
            Err(OpsError::Pack(PackError::AlreadyInstalled { .. }))
        ));
        // Downgrades too.
        let (older, sig_old, key_old) = {
            let bytes = serde_json::to_vec(&versioned("0.9.0")).unwrap();
            let (sig, key) = signed_by(&bytes, 3);
            (bytes, sig, key)
        };
        assert!(matches!(
            pack_install(&service, &book_id, &older, &sig_old, &key_old),
            Err(OpsError::Pack(PackError::Downgrade { .. }))
        ));

        // An upgrade reuses the categories it already mapped.
        let newer = serde_json::to_vec(&versioned("1.1.0")).unwrap();
        let (sig_new, key_new) = signed_by(&newer, 3);
        let upgraded = pack_install(&service, &book_id, &newer, &sig_new, &key_new).unwrap();
        assert_eq!(upgraded.categories_created, 0);
        assert_eq!(upgraded.categories_existing, 2);
        assert_eq!(upgraded.version, "1.1.0");
        assert_eq!(service.category_tree(&book_id).unwrap().len(), 1);

        // One index entry, reported in the shape clients already read.
        let installed = pack_list(&service).unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].manifest.id, "za-groceries");
        assert_eq!(installed[0].manifest.version, "1.1.0");
        assert_eq!(installed[0].manifest.rules.len(), 1);
        assert_eq!(installed[0].book_id, book_id);

        // The install is in the append-only audit log.
        let audits = service.audit_list(Some(&book_id), 50).unwrap();
        assert!(audits
            .iter()
            .any(|a| a.entity_type == "pack" && a.action == "pack_install"));
        assert!(audits
            .iter()
            .any(|a| a.entity_type == "pack" && a.action == "pack_upgrade"));
    }

    #[test]
    fn pack_install_takes_the_current_payload_format_too() {
        let service = svc();
        let book_id = make_book(&service);
        // The modern two-part pack, distributed as payload + detached
        // signature: same three inputs, same installer.
        let payload = manifest().into_payload().unwrap();
        let bytes = serde_json::to_vec_pretty(&payload).unwrap();
        let (sig, pubkey) = signed_by(&bytes, 4);

        let result = pack_install(&service, &book_id, &bytes, &sig, &pubkey).unwrap();
        assert_eq!(result.pack_id, "za-groceries");
        assert_eq!(result.categories_created, 2);
        assert_eq!(result.rules, 1);
    }

    #[test]
    fn pack_install_trusts_the_key_on_first_use_and_pins_it() {
        let service = svc();
        let book_id = make_book(&service);
        let (bytes, sig, pubkey) = signed(&manifest());
        pack_install(&service, &book_id, &bytes, &sig, &pubkey).unwrap();

        // Passing the key was the trust decision; it is recorded, so the pack
        // id is now bound to it.
        let signers = service
            .with_connection(|conn| TrustStore::open(conn)?.list())
            .unwrap();
        assert_eq!(signers.len(), 1);
        assert_eq!(signers[0].public_key, hex_key(3));

        // A "newer" version of the same pack from a different key: rejected,
        // which the old settings-key path could not do at all.
        let newer = serde_json::to_vec(&versioned("2.0.0")).unwrap();
        let (other_sig, other_key) = signed_by(&newer, 9);
        assert!(matches!(
            pack_install(&service, &book_id, &newer, &other_sig, &other_key),
            Err(OpsError::Pack(PackError::SignerChanged { .. }))
        ));
    }

    fn hex_key(seed: u8) -> String {
        SigningKey::from_bytes(&[seed; 32])
            .verifying_key()
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
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
            Err(OpsError::Pack(PackError::Validation(_)))
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
            Err(OpsError::Pack(PackError::Validation(_)))
        ));
    }

    /// Legacy manifests declared children before parents freely — the payload
    /// requires the other order, so conversion fixes it instead of rejecting
    /// a file that used to install.
    #[test]
    fn pack_install_accepts_children_declared_before_parents() {
        let service = svc();
        let book_id = make_book(&service);
        let mut m = manifest();
        m.categories.reverse();
        let (bytes, sig, pubkey) = signed(&m);

        let result = pack_install(&service, &book_id, &bytes, &sig, &pubkey).unwrap();
        assert_eq!(result.categories_created, 2);
        let tree = service.category_tree(&book_id).unwrap();
        assert_eq!(tree[0].category.name, "Food");
        assert_eq!(tree[0].children[0].category.name, "Groceries");
    }

    #[test]
    fn installed_pack_rules_classify_new_transactions() {
        let service = svc();
        let book_id = make_book(&service);
        let (bytes, sig, pubkey) = signed(&manifest());
        pack_install(&service, &book_id, &bytes, &sig, &pubkey).unwrap();
        let groceries = service.category_tree(&book_id).unwrap()[0].children[0]
            .category
            .id
            .clone();

        let account = service
            .account_create(NewAccount {
                book_id: book_id.clone(),
                name: "Cheque".into(),
                kind: AccountKind::Bank,
                currency: "ZAR".into(),
                institution: None,
                account_number_masked: None,
                opening_balance_minor: None,
            })
            .unwrap();
        let import = |merchant: &str, occurrence: u32| {
            service
                .transaction_create(NewTransaction {
                    book_id: book_id.clone(),
                    account_id: account.id.clone(),
                    source: TransactionSource::Import,
                    provider_txn_id: None,
                    posted_date: "2026-07-01".into(),
                    amount_minor: -12_345,
                    currency: "ZAR".into(),
                    merchant: Some(merchant.to_string()),
                    description: None,
                    notes: None,
                    category_id: None,
                    document_id: None,
                    dedupe_occurrence: occurrence,
                })
                .unwrap()
        };

        // A `merchant_contains` rule — never expressible as a mapping — now
        // categorises on import.
        let txn = import("PICK N PAY FAM KENILWORTH", 0);
        assert_eq!(txn.category_id.as_deref(), Some(groceries.as_str()));
        // A merchant no rule matches stays uncategorised, as before.
        assert!(import("SOME UNKNOWN PLACE", 0).category_id.is_none());

        // The user's judgement still wins: a correction on that merchant
        // overrides the pack rule for every later import of it.
        let food = service.category_tree(&book_id).unwrap()[0]
            .category
            .id
            .clone();
        service.transaction_categorize(&txn.id, &food).unwrap();
        let after = import("PICK N PAY FAM KENILWORTH", 1);
        assert_eq!(after.category_id.as_deref(), Some(food.as_str()));
    }

    #[test]
    fn legacy_settings_index_is_adopted_and_never_dropped() {
        let service = svc();
        let book_id = make_book(&service);

        // Exactly what the pre-installer path left behind: the manifest under
        // one settings key, and the categories it created.
        let food = service
            .category_create(NewCategory {
                book_id: book_id.clone(),
                parent_id: None,
                name: "Food".into(),
                kind: CategoryKind::Expense,
                icon: None,
                color: None,
            })
            .unwrap();
        let groceries = service
            .category_create(NewCategory {
                book_id: book_id.clone(),
                parent_id: Some(food.id.clone()),
                name: "Groceries".into(),
                kind: CategoryKind::Expense,
                icon: None,
                color: None,
            })
            .unwrap();
        let legacy = vec![InstalledPackEntry {
            book_id: book_id.clone(),
            installed_at: "2026-01-01T00:00:00Z".into(),
            manifest: manifest(),
        }];
        service
            .settings_set(
                INSTALLED_PACKS_SETTING,
                &serde_json::to_string(&legacy).unwrap(),
                false,
            )
            .unwrap();

        // Listing adopts it into the tables: still one entry, still its
        // original install date, and the categories are matched, not
        // duplicated.
        let installed = pack_list(&service).unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].manifest.id, "za-groceries");
        assert_eq!(installed[0].installed_at, "2026-01-01T00:00:00Z");
        let tree = service.category_tree(&book_id).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].category.id, groceries.id);

        // And its rules are live now, which they never were under the old
        // path — that is the point of migrating rather than just listing.
        let suggestion = service
            .with_connection(|conn| {
                Ok::<_, PackError>(
                    slipscan_packs::Classifier::load(conn, &book_id)?
                        .suggest("PICK N PAY FAM KENILWORTH"),
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(suggestion.category_id, groceries.id);

        // Idempotent, and the settings key is kept verbatim as the record.
        assert_eq!(pack_list(&service).unwrap().len(), 1);
        assert!(service
            .settings_get(INSTALLED_PACKS_SETTING)
            .unwrap()
            .is_some());
    }

    #[test]
    fn legacy_entries_that_cannot_be_adopted_are_still_listed() {
        let service = svc();
        let book_id = make_book(&service);
        // A manifest no longer installable (its version was never semver).
        let mut broken = manifest();
        broken.version = "one".into();
        let legacy = vec![InstalledPackEntry {
            book_id,
            installed_at: "2026-01-01T00:00:00Z".into(),
            manifest: broken,
        }];
        service
            .settings_set(
                INSTALLED_PACKS_SETTING,
                &serde_json::to_string(&legacy).unwrap(),
                false,
            )
            .unwrap();

        let installed = pack_list(&service).unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].manifest.version, "one");
    }

    #[test]
    fn seed_packs_install_on_request_and_are_idempotent() {
        let service = svc();
        let book_id = make_book(&service);

        let first = pack_install_seeds(&service, &book_id).unwrap();
        assert_eq!(first.len(), 3);
        assert!(first.iter().any(|r| r.pack_id == "za-personal"));
        assert!(first.iter().any(|r| r.pack_id == "intl-starter"));
        assert!(!service.category_tree(&book_id).unwrap().is_empty());

        // Second call: every seed is already at its version, so nothing is
        // installed and nothing is duplicated.
        assert!(pack_install_seeds(&service, &book_id).unwrap().is_empty());
        assert_eq!(pack_list(&service).unwrap().len(), 3);
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
    fn tax_control_name_matching_is_whole_word() {
        // Regression: the old substring check classified "Private Drawings"
        // as a VAT account ("pri-VAT-e").
        assert!(name_marks_tax_control("VAT Input Control"));
        assert!(name_marks_tax_control("Output VAT"));
        assert!(name_marks_tax_control("vat control (settlement)"));
        assert!(!name_marks_tax_control("Private Drawings"));
        assert!(!name_marks_tax_control("Elevated Costs"));
        assert!(!name_marks_tax_control("Motivation Fund"));
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
