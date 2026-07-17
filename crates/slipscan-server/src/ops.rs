//! Operations composed on top of slipscan-core's public services, shared by
//! the HTTP routes and the CLI: signed pack installation and the VAT summary
//! report.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use slipscan_core::domain::{
    CategoryKind, CategoryNode, NewCategory, TrialBalanceRow, VatRate,
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

/// VAT summary: configured rates plus the trial-balance position of the VAT
/// control accounts (accounts whose name contains "VAT").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VatReport {
    pub rates: Vec<VatRate>,
    pub accounts: Vec<TrialBalanceRow>,
    /// Net VAT position in minor units: credits minus debits over the VAT
    /// control accounts. Positive = owed to the revenue service.
    pub net_minor: i64,
}

pub fn report_vat(service: &CoreService, book_id: &str) -> Result<VatReport, OpsError> {
    service.book_get(book_id)?;
    let rates = service.vat_rate_list(book_id)?;
    let accounts: Vec<TrialBalanceRow> = service
        .report_trial_balance(book_id)?
        .into_iter()
        .filter(|row| row.name.to_lowercase().contains("vat"))
        .collect();
    let net_minor = accounts
        .iter()
        .map(|r| r.credit_minor - r.debit_minor)
        .sum();
    Ok(VatReport {
        rates,
        accounts,
        net_minor,
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
                    },
                    NewJournalLine {
                        coa_id: vat.id.clone(),
                        debit_minor: 0,
                        credit_minor: 15_000,
                        currency: "ZAR".into(),
                        description: None,
                    },
                ],
            })
            .unwrap();

        let report = report_vat(&service, &book_id).unwrap();
        assert_eq!(report.rates.len(), 1);
        assert_eq!(report.rates[0].rate_bps, 1500);
        assert_eq!(report.accounts.len(), 1);
        assert_eq!(report.accounts[0].code, "2100");
        assert_eq!(report.net_minor, 15_000);
    }

    #[test]
    fn vat_report_unknown_book_is_not_found() {
        let service = svc();
        assert!(matches!(
            report_vat(&service, "missing"),
            Err(OpsError::Core(CoreError::NotFound { .. }))
        ));
    }
}
