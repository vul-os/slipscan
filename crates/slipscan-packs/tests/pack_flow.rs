//! End-to-end pack flow against a real (in-memory) slipscan-core database:
//! sign → verify → trust → install taxonomy into core categories → classify →
//! upgrade → uninstall, plus benchmark install + local comparison, and the
//! rejection paths (unsigned, tampered, untrusted, signer-changed,
//! downgrade).

use std::collections::BTreeMap;

use ed25519_dalek::SigningKey;
use rusqlite::Connection;

use slipscan_core::domain::{Book, BookKind, CategoryKind, MappingSource};
use slipscan_core::repo;
use slipscan_core::util::{new_id, now_iso};
use slipscan_core::Db;

use slipscan_packs::builtin;
use slipscan_packs::{
    compare, key_fingerprint, sign_pack, BenchmarkCohort, BenchmarkSet, BenchmarkStat,
    InstallOutcome, Installer, MatchKind, MerchantRule, Pack, PackCategory, PackError, PackKind,
    PackMeta, PackPayload, Provenance, TrustStatus, TrustStore,
};

fn make_book(conn: &Connection) -> String {
    let now = now_iso();
    let book = Book {
        id: new_id(),
        kind: BookKind::Personal,
        name: "Test book".into(),
        currency: "ZAR".into(),
        country: Some("ZA".into()),
        region: "za".into(),
        locale: "en".into(),
        timezone: "UTC".into(),
        financial_lock_date: None,
        created_at: now.clone(),
        updated_at: now,
    };
    repo::book::insert(conn, &book).unwrap();
    book.id
}

fn signer(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn signer_hex(seed: u8) -> String {
    let key = signer(seed);
    key.verifying_key()
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn taxonomy_payload(version: &str) -> PackPayload {
    PackPayload {
        meta: PackMeta {
            id: "za-test-taxonomy".into(),
            name: "Test taxonomy".into(),
            version: version.into(),
            region: Some("ZA".into()),
            author: Some("tests".into()),
            description: None,
        },
        categories: vec![
            PackCategory {
                key: "groceries".into(),
                name: "Groceries".into(),
                parent_key: None,
                kind: "expense".into(),
                icon: Some("cart".into()),
                color: None,
            },
            PackCategory {
                key: "groceries.supermarket".into(),
                name: "Supermarket".into(),
                parent_key: Some("groceries".into()),
                kind: "expense".into(),
                icon: None,
                color: None,
            },
        ],
        merchant_rules: vec![
            MerchantRule {
                match_kind: MatchKind::Exact,
                pattern: "Woolworths".into(),
                category_key: "groceries.supermarket".into(),
                confidence: 0.95,
            },
            MerchantRule {
                match_kind: MatchKind::Contains,
                pattern: "pick n pay".into(),
                category_key: "groceries".into(),
                confidence: 0.9,
            },
        ],
        keyword_rules: vec![],
        vat_hints: vec![],
        benchmarks: None,
    }
}

fn signed_taxonomy(version: &str, seed: u8) -> slipscan_packs::VerifiedPack {
    sign_pack(
        &Pack::build(&taxonomy_payload(version)).unwrap(),
        &signer(seed),
    )
    .verify()
    .unwrap()
}

#[test]
fn full_taxonomy_flow_installs_into_core_categories() {
    let db = Db::open_in_memory().unwrap();
    let conn = db.conn();
    let book_id = make_book(conn);

    let installer = Installer::open(conn).unwrap();
    let trust_store = TrustStore::open(conn).unwrap();
    let verified = signed_taxonomy("1.0.0", 7);

    // Untrusted signer is rejected before anything is written.
    assert!(matches!(
        installer.install(&book_id, &verified),
        Err(PackError::UntrustedSigner { .. })
    ));

    // TOFU: unknown → fingerprint shown → trusted.
    match trust_store.status(&signer_hex(7)).unwrap() {
        TrustStatus::Unknown { fingerprint } => {
            assert_eq!(fingerprint, key_fingerprint(&signer_hex(7)));
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
    trust_store.trust(&signer_hex(7), "test signer").unwrap();

    let report = installer.install(&book_id, &verified).unwrap();
    assert_eq!(report.outcome, InstallOutcome::Installed);
    assert_eq!(report.categories_created, 2);
    assert_eq!(report.categories_reused, 0);
    assert_eq!(report.rules_installed, 2);

    // Taxonomy landed in core's categories with the hierarchy intact.
    let categories = repo::category::list(conn, &book_id).unwrap();
    assert_eq!(categories.len(), 2);
    let parent = categories.iter().find(|c| c.name == "Groceries").unwrap();
    let child = categories.iter().find(|c| c.name == "Supermarket").unwrap();
    assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(parent.kind, CategoryKind::Expense);
    assert!(!parent.is_system);

    // The key→id map is remembered.
    let map = installer
        .category_map(&book_id, "za-test-taxonomy")
        .unwrap();
    assert_eq!(map["groceries"], parent.id);
    assert_eq!(map["groceries.supermarket"], child.id);

    // Exact rules seeded core's live merchant mappings with source=pack.
    let mapping = repo::category::get_mapping(conn, &book_id, "woolworths")
        .unwrap()
        .unwrap();
    assert_eq!(mapping.category_id, child.id);
    assert_eq!(mapping.source, MappingSource::Pack);

    // The engine classifies through pack rules.
    let classifier = slipscan_packs::engine::Classifier::load(conn, &book_id).unwrap();
    // Exact rule: matches the bare normalized merchant only.
    let hit = classifier.suggest("  WOOLWORTHS ").unwrap();
    assert_eq!(hit.category_id, child.id);
    assert!(classifier.suggest("WOOLWORTHS *123").is_none());
    let hit = classifier.suggest("PICK N PAY FAM KENILWORTH").unwrap();
    assert_eq!(hit.category_id, parent.id);
    assert!(classifier.suggest("unknown merchant").is_none());

    // Install was audited (append-only log, metadata only).
    let audits = repo::audit::list(conn, Some(&book_id), 10).unwrap();
    assert!(audits
        .iter()
        .any(|a| a.entity_type == "pack" && a.action == "pack_install"));
}

#[test]
fn upgrade_keeps_categories_and_user_renames() {
    let db = Db::open_in_memory().unwrap();
    let conn = db.conn();
    let book_id = make_book(conn);
    let installer = Installer::open(conn).unwrap();
    TrustStore::open(conn)
        .unwrap()
        .trust(&signer_hex(7), "t")
        .unwrap();

    installer
        .install(&book_id, &signed_taxonomy("1.0.0", 7))
        .unwrap();
    let map_before = installer
        .category_map(&book_id, "za-test-taxonomy")
        .unwrap();

    // The user renames a pack category.
    conn.execute(
        "UPDATE categories SET name = 'My Groceries' WHERE id = ?1",
        [&map_before["groceries"]],
    )
    .unwrap();

    // Same version again: no-op error.
    assert!(matches!(
        installer.install(&book_id, &signed_taxonomy("1.0.0", 7)),
        Err(PackError::AlreadyInstalled { .. })
    ));
    // Downgrade: rejected.
    assert!(matches!(
        installer.install(&book_id, &signed_taxonomy("0.9.0", 7)),
        Err(PackError::Downgrade { .. })
    ));

    // Upgrade: categories are reused (ids stable), the rename survives.
    let report = installer
        .install(&book_id, &signed_taxonomy("1.1.0", 7))
        .unwrap();
    assert_eq!(
        report.outcome,
        InstallOutcome::Upgraded {
            from: "1.0.0".into()
        }
    );
    assert_eq!(report.categories_created, 0);
    assert_eq!(report.categories_reused, 2);
    let map_after = installer
        .category_map(&book_id, "za-test-taxonomy")
        .unwrap();
    assert_eq!(map_before, map_after);
    let name: String = conn
        .query_row(
            "SELECT name FROM categories WHERE id = ?1",
            [&map_after["groceries"]],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(name, "My Groceries");

    let installed = installer.list(&book_id).unwrap();
    assert_eq!(installed.len(), 1);
    assert_eq!(installed[0].version, "1.1.0");
    assert_eq!(installed[0].kind, PackKind::Taxonomy);
}

#[test]
fn pack_id_is_pinned_to_first_signer() {
    let db = Db::open_in_memory().unwrap();
    let conn = db.conn();
    let book_id = make_book(conn);
    let installer = Installer::open(conn).unwrap();
    let trust_store = TrustStore::open(conn).unwrap();
    trust_store.trust(&signer_hex(7), "first").unwrap();
    trust_store.trust(&signer_hex(9), "second").unwrap();

    installer
        .install(&book_id, &signed_taxonomy("1.0.0", 7))
        .unwrap();

    // A newer version signed by a *different trusted* key is still rejected.
    assert!(matches!(
        installer.install(&book_id, &signed_taxonomy("2.0.0", 9)),
        Err(PackError::SignerChanged { .. })
    ));
    // The original signer can still upgrade.
    installer
        .install(&book_id, &signed_taxonomy("2.0.0", 7))
        .unwrap();
}

#[test]
fn unsigned_and_tampered_packs_never_install() {
    let db = Db::open_in_memory().unwrap();
    let conn = db.conn();
    let _book_id = make_book(conn);
    let _installer = Installer::open(conn).unwrap();

    // Unsigned: cannot even become a VerifiedPack.
    let pack = Pack::build(&taxonomy_payload("1.0.0")).unwrap();
    assert!(matches!(pack.verify(), Err(PackError::Unsigned(_))));

    // Tampered on disk: payload edited after signing.
    let signed = sign_pack(&pack, &signer(7));
    let dir = tempfile::tempdir().unwrap();
    signed.write_dir(dir.path().join("p")).unwrap();
    let payload_path = dir.path().join("p").join("payload.json");
    let text = std::fs::read_to_string(&payload_path)
        .unwrap()
        .replace("\"pick n pay\"", "\"attacker rule\"");
    std::fs::write(&payload_path, text).unwrap();
    assert!(matches!(
        Pack::load_dir(dir.path().join("p")),
        Err(PackError::HashMismatch { .. })
    ));

    // Hash "fixed up" by the attacker: the signature still fails.
    let signed2 = sign_pack(&pack, &signer(7));
    let mut evil_payload = taxonomy_payload("1.0.0");
    evil_payload.merchant_rules[1].pattern = "attacker rule".into();
    let evil = Pack::build(&evil_payload).unwrap();
    let mut manifest = signed2.manifest_toml().unwrap();
    // Graft the genuine signature block onto the attacker's pack.
    let sig_block = manifest.split_off(manifest.find("[signature]").unwrap());
    let evil_manifest = format!("{}{sig_block}", evil.manifest_toml().unwrap());
    let grafted = Pack::from_parts(&evil_manifest, evil.payload_bytes()).unwrap();
    assert!(matches!(
        grafted.verify(),
        Err(PackError::VerificationFailed)
    ));
}

#[test]
fn seed_packs_install_and_classify_sa_merchants() {
    let db = Db::open_in_memory().unwrap();
    let conn = db.conn();
    let book_id = make_book(conn);

    let reports = builtin::install_seed_packs(conn, &book_id).unwrap();
    assert_eq!(reports.len(), 3);
    // Idempotent: second run skips all of them.
    assert!(builtin::install_seed_packs(conn, &book_id)
        .unwrap()
        .is_empty());

    let installer = Installer::open(conn).unwrap();
    let installed = installer.list(&book_id).unwrap();
    assert_eq!(installed.len(), 3);
    for pack in &installed {
        assert_eq!(pack.signer, builtin::seed_public_key_hex());
    }
    // The listing exposes each pack's region: ZA seeds are namespaced to
    // "ZA", the starter pack is global (no region).
    let region_of = |id: &str| {
        installed
            .iter()
            .find(|p| p.pack_id == id)
            .unwrap()
            .region
            .clone()
    };
    assert_eq!(region_of("za-personal").as_deref(), Some("ZA"));
    assert_eq!(region_of("za-business-vat").as_deref(), Some("ZA"));
    assert_eq!(region_of("intl-starter"), None);

    // Seed taxonomies became real core categories.
    let categories = repo::category::list(conn, &book_id).unwrap();
    assert!(categories.iter().any(|c| c.name == "Groceries"));
    assert!(categories.iter().any(|c| c.name == "VAT payments"));

    // Major SA merchants classify.
    let classifier = slipscan_packs::engine::Classifier::load(conn, &book_id).unwrap();
    let personal_map = installer.category_map(&book_id, "za-personal").unwrap();
    let cases = [
        ("CHECKERS SIXTY60 CLAREMONT", "groceries"),
        ("PNP FAM KENILWORTH", "groceries"),
        ("WOOLWORTHS *1234", "groceries"),
        ("UBER EATS ZA", "eating-out.delivery"),
        ("UBER *TRIP", "transport.ride-hailing"),
        ("TAKEALOT.COM", "shopping.online"),
        ("ENGEN WINELANDS 1STOP", "transport.fuel"),
        ("DIS-CHEM PHARMACIES", "medical.pharmacy"),
        ("NETFLIX.COM", "entertainment.streaming"),
        ("MYCITI CAPE TOWN", "transport.public"),
    ];
    for (merchant, expected_key) in cases {
        let hit = classifier
            .suggest(merchant)
            .unwrap_or_else(|| panic!("no suggestion for {merchant}"));
        assert_eq!(
            hit.category_id, personal_map[expected_key],
            "{merchant} should classify as {expected_key}"
        );
    }

    // A user's own mapping is never clobbered by seeds: uninstall drops only
    // pack-seeded mappings.
    assert!(installer.uninstall(&book_id, "za-personal").unwrap());
    assert!(!installer.uninstall(&book_id, "za-personal").unwrap());
    assert_eq!(installer.list(&book_id).unwrap().len(), 2);
    let classifier = slipscan_packs::engine::Classifier::load(conn, &book_id).unwrap();
    assert!(classifier.suggest("CHECKERS SIXTY60").is_none());
    // Categories survive uninstall — history never breaks.
    assert!(repo::category::list(conn, &book_id)
        .unwrap()
        .iter()
        .any(|c| c.name == "Groceries"));
}

/// The global starter pack works in a non-ZA book on its own: it installs,
/// exposes no region, and classifies worldwide merchant strings.
#[test]
fn intl_starter_installs_and_classifies_global_merchants() {
    let db = Db::open_in_memory().unwrap();
    let conn = db.conn();
    let now = now_iso();
    let book = Book {
        id: new_id(),
        kind: BookKind::Personal,
        name: "Berlin book".into(),
        currency: "EUR".into(),
        country: Some("DE".into()),
        region: "generic".into(),
        locale: "de".into(),
        timezone: "UTC".into(),
        financial_lock_date: None,
        created_at: now.clone(),
        updated_at: now,
    };
    repo::book::insert(conn, &book).unwrap();

    let installer = Installer::open(conn).unwrap();
    let intl = builtin::seed_packs()
        .unwrap()
        .into_iter()
        .find(|p| p.pack().id() == "intl-starter")
        .expect("intl-starter is a builtin seed");
    let report = installer.install(&book.id, &intl).unwrap();
    assert_eq!(report.outcome, InstallOutcome::Installed);
    assert_eq!(report.pack.region, None);
    assert_eq!(report.pack.kind, PackKind::Taxonomy);

    let installed = installer.list(&book.id).unwrap();
    assert_eq!(installed.len(), 1);
    assert_eq!(installed[0].pack_id, "intl-starter");
    assert_eq!(installed[0].region, None);

    let map = installer.category_map(&book.id, "intl-starter").unwrap();
    let classifier = slipscan_packs::engine::Classifier::load(conn, &book.id).unwrap();
    let cases = [
        ("AMAZON MKTPLACE PMTS", "shopping.online"),
        ("AMAZON PRIME*MEMBERSHIP", "subscriptions.streaming"),
        ("UBER *TRIP HELP.UBER.COM", "transport.ride-hailing"),
        ("UBER EATS BERLIN", "eating-out.delivery"),
        ("NETFLIX.COM", "subscriptions.streaming"),
        ("SPOTIFY P233194845", "subscriptions.streaming"),
        ("APPLE.COM/BILL", "subscriptions.software"),
        ("GOOGLE *GOOGLE PLAY", "subscriptions.software"),
        ("PAYPAL *DIGITALRIV", "shopping.online"),
        ("AIRBNB * HM2XYZ", "travel"),
        ("MCDONALDS 40123", "eating-out"),
        ("SHELL 6045 HAMBURG", "transport.fuel"),
        ("IKEA DELFT", "home"),
        ("ALDI SUED SAGT DANKE", "groceries"),
        ("LIDL SAGT DANKE", "groceries"),
        ("CARREFOUR MARKET PARIS 11", "groceries"),
        ("TESCO STORES 3297", "groceries"),
        ("WAL-MART SUPERCENTER", "groceries"),
        ("TARGET 00021212", "shopping"),
    ];
    for (merchant, expected_key) in cases {
        let hit = classifier
            .suggest(merchant)
            .unwrap_or_else(|| panic!("no suggestion for {merchant}"));
        assert_eq!(
            hit.category_id, map[expected_key],
            "{merchant} should classify as {expected_key}"
        );
        assert_eq!(hit.pack_id, "intl-starter");
    }
}

/// The optional region travels payload → manifest → install → listing, in
/// both states: set (an ISO code) and absent (global).
#[test]
fn region_field_round_trips_through_manifest_and_install() {
    let db = Db::open_in_memory().unwrap();
    let conn = db.conn();
    let book_id = make_book(conn);
    let installer = Installer::open(conn).unwrap();
    TrustStore::open(conn)
        .unwrap()
        .trust(&signer_hex(7), "t")
        .unwrap();

    let mut regional = taxonomy_payload("1.0.0");
    regional.meta.id = "de-test".into();
    regional.meta.region = Some("DE".into());
    let mut global = taxonomy_payload("1.0.0");
    global.meta.id = "global-test".into();
    global.meta.region = None;

    for payload in [&regional, &global] {
        // Manifest TOML round-trip preserves the region exactly.
        let pack = Pack::build(payload).unwrap();
        let manifest = pack.manifest_toml().unwrap();
        match &payload.meta.region {
            Some(region) => assert!(manifest.contains(&format!("region = \"{region}\""))),
            None => assert!(!manifest.contains("region")),
        }
        let reparsed = Pack::from_parts(&manifest, pack.payload_bytes()).unwrap();
        assert_eq!(reparsed.payload().meta.region, payload.meta.region);

        // Install exposes it on the report, the listing, and the get path.
        let verified = sign_pack(&pack, &signer(7)).verify().unwrap();
        let report = installer.install(&book_id, &verified).unwrap();
        assert_eq!(report.pack.region, payload.meta.region);
        let got = installer.get(&book_id, &payload.meta.id).unwrap().unwrap();
        assert_eq!(got.region, payload.meta.region);
    }

    let regions: Vec<Option<String>> = installer
        .list(&book_id)
        .unwrap()
        .into_iter()
        .map(|p| p.region)
        .collect();
    assert_eq!(regions, [Some("DE".to_string()), None]);
}

/// Databases written before packs carried a region keep working: opening the
/// installer adds the column and backfills it from each install's stored
/// payload, so implicitly-SA installs come out labeled "ZA" and everything
/// else stays global.
#[test]
fn legacy_pack_installs_table_gains_region_on_open() {
    let conn = Connection::open_in_memory().unwrap();
    // The pre-region schema, exactly as older releases created it.
    conn.execute_batch(
        "CREATE TABLE pack_installs (
             book_id      TEXT NOT NULL,
             pack_id      TEXT NOT NULL,
             name         TEXT NOT NULL,
             version      TEXT NOT NULL,
             kind         TEXT NOT NULL CHECK (kind IN ('taxonomy', 'benchmark')),
             signer       TEXT NOT NULL,
             payload_json BLOB NOT NULL,
             installed_at TEXT NOT NULL,
             updated_at   TEXT NOT NULL,
             PRIMARY KEY (book_id, pack_id)
         );",
    )
    .unwrap();
    let insert = |pack_id: &str, payload_json: &str| {
        conn.execute(
            "INSERT INTO pack_installs
                 (book_id, pack_id, name, version, kind, signer, payload_json,
                  installed_at, updated_at)
             VALUES ('b1', ?1, ?1, '1.0.0', 'taxonomy', 'signer',
                     ?2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![pack_id, payload_json.as_bytes()],
        )
        .unwrap();
    };
    insert("za-personal", builtin::ZA_PERSONAL_JSON);
    insert("intl-starter", builtin::INTL_STARTER_JSON);

    // Opening the installer migrates in place (and is idempotent).
    let installer = Installer::open(&conn).unwrap();
    let installed = installer.list("b1").unwrap();
    assert_eq!(installed.len(), 2);
    let region_of = |id: &str| {
        installed
            .iter()
            .find(|p| p.pack_id == id)
            .unwrap()
            .region
            .clone()
    };
    assert_eq!(region_of("za-personal").as_deref(), Some("ZA"));
    assert_eq!(region_of("intl-starter"), None);
    // Idempotent: a second open is a no-op, not a re-migration.
    Installer::open(&conn).unwrap();
}

#[test]
fn benchmark_pack_installs_and_compares_locally() {
    let db = Db::open_in_memory().unwrap();
    let conn = db.conn();
    let book_id = make_book(conn);
    let installer = Installer::open(conn).unwrap();
    TrustStore::open(conn)
        .unwrap()
        .trust(&signer_hex(5), "aggregator")
        .unwrap();

    let payload = PackPayload {
        meta: PackMeta {
            id: "za-bench-hh2-c".into(),
            name: "ZA household-2 band-C benchmarks".into(),
            version: "1.0.0".into(),
            region: Some("ZA".into()),
            author: Some("community aggregator".into()),
            description: None,
        },
        categories: vec![],
        merchant_rules: vec![],
        keyword_rules: vec![],
        vat_hints: vec![],
        benchmarks: Some(BenchmarkSet {
            cohort: BenchmarkCohort {
                region: "ZA".into(),
                household_size: 2,
                income_band: "C".into(),
            },
            currency: "ZAR".into(),
            k_floor: 25,
            stats: vec![BenchmarkStat {
                category_key: "groceries".into(),
                period: "2026-06".into(),
                sample_size: 412,
                p25_minor: 310_000,
                median_minor: 485_000,
                p75_minor: 702_500,
                mean_minor: None,
            }],
        }),
    };
    let verified = sign_pack(&Pack::build(&payload).unwrap(), &signer(5))
        .verify()
        .unwrap();
    assert_eq!(verified.provenance(), Provenance::External);

    let report = installer.install(&book_id, &verified).unwrap();
    assert_eq!(report.pack.kind, PackKind::Benchmark);
    assert_eq!(report.categories_created, 0);
    assert_eq!(report.rules_installed, 0);
    // Benchmark packs create no categories and no rules.
    assert!(repo::category::list(conn, &book_id).unwrap().is_empty());

    // Read side: stats come back out and comparison is pure local math.
    let sets = installer.benchmark_sets(&book_id).unwrap();
    assert_eq!(sets.len(), 1);
    let (pack_id, set) = &sets[0];
    assert_eq!(pack_id, "za-bench-hh2-c");

    let mut spend = BTreeMap::new();
    spend.insert("groceries".to_string(), 727_500i64); // R 7,275 vs R 4,850 median
    let out = compare(set, "2026-06", &spend);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].delta_minor, 242_500);
    assert_eq!(out[0].ratio_to_median, Some(1.5));
    assert_eq!(out[0].position, slipscan_packs::QuartilePosition::AboveP75);
}
