//! End-to-end: **the same signed bytes over every transport**, against a real
//! (in-memory) slipscan-core database.
//!
//! One pack is published once. It is then fetched back over a watched folder
//! (sneakernet), over a git remote, and over HTTPS — and the three fetches are
//! asserted to yield *byte-identical* documents and the same verified signer,
//! because that is the claim the whole design rests on: the signature is what
//! is trusted, not the channel.
//!
//! Then the refusal the design exists for: a second publisher offering "a
//! newer version" of the same pack id, over each transport in turn, refused
//! every time — with nothing installed, nothing re-pinned, and the attacker's
//! key never recorded as trusted.

use std::sync::{Arc, Mutex};

use ed25519_dalek::{Signer as _, SigningKey};
use rusqlite::Connection;

use slipscan_core::domain::{Book, BookKind};
use slipscan_core::util::{new_id, now_iso};
use slipscan_core::{repo, Db};

use slipscan_packs::transport::{
    self, BlobStore, HttpBlob, PackHttp, PackSource, SignerDecision, SourceStore, TransportContext,
};
use slipscan_packs::{
    sign_pack, verify_detached, Installer, MatchKind, MerchantRule, Pack, PackCategory, PackError,
    PackMeta, PackPayload, TrustStatus, TrustStore, VerifiedPack,
};

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

fn make_book(conn: &Connection) -> String {
    let now = now_iso();
    let book = Book {
        id: new_id(),
        kind: BookKind::Personal,
        name: "Transport test book".into(),
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

fn payload(id: &str, version: &str) -> PackPayload {
    PackPayload {
        meta: PackMeta {
            id: id.into(),
            name: format!("{id} taxonomy"),
            version: version.into(),
            region: Some("ZA".into()),
            author: Some("Transport tests".into()),
            description: None,
        },
        categories: vec![PackCategory {
            key: "groceries".into(),
            name: "Groceries".into(),
            parent_key: None,
            kind: "expense".into(),
            icon: None,
            color: None,
        }],
        merchant_rules: vec![MerchantRule {
            match_kind: MatchKind::Contains,
            pattern: "checkers".into(),
            category_key: "groceries".into(),
            confidence: 0.95,
        }],
        keyword_rules: vec![],
        vat_hints: vec![],
        benchmarks: None,
        mailrules: None,
    }
}

/// A publisher: their verified pack, the exact signed bytes, the detached
/// signature and the public key — the four things every transport moves.
struct Published {
    verified: VerifiedPack,
    document: Vec<u8>,
    signature: Vec<u8>,
    public_key: Vec<u8>,
}

fn publish_pack(id: &str, version: &str, seed: u8) -> Published {
    let key = SigningKey::from_bytes(&[seed; 32]);
    let pack = sign_pack(&Pack::build(&payload(id, version)).unwrap(), &key);
    let document = pack.payload_bytes().to_vec();
    let signature = key.sign(&document).to_bytes().to_vec();
    let public_key = key.verifying_key().as_bytes().to_vec();
    let verified = verify_detached(&document, &signature, &public_key).unwrap();
    Published {
        verified,
        document,
        signature,
        public_key,
    }
}

// ---------------------------------------------------------------------------
// an HTTPS server that is a directory, in a HashMap
// ---------------------------------------------------------------------------

/// A [`PackHttp`] that serves a local directory over pretend-HTTPS, recording
/// every URL. This is the whole HTTPS transport under test: slipscan-packs
/// ships no client, so this *is* the shape a real one plugs into.
struct DirOverHttp {
    base: String,
    root: std::path::PathBuf,
    seen: Mutex<Vec<String>>,
}

impl DirOverHttp {
    fn new(base: &str, root: &std::path::Path) -> Self {
        Self {
            base: base.to_string(),
            root: root.to_path_buf(),
            seen: Mutex::new(Vec::new()),
        }
    }

    fn urls(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

impl PackHttp for DirOverHttp {
    fn get(&self, url: &str) -> Result<HttpBlob, String> {
        self.seen.lock().unwrap().push(url.to_string());
        let Some(rel) = url.strip_prefix(&format!("{}/", self.base)) else {
            return Err(format!("{url} is not on this host"));
        };
        match std::fs::read(self.root.join(rel)) {
            Ok(body) => Ok(HttpBlob { status: 200, body }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HttpBlob {
                status: 404,
                body: Vec::new(),
            }),
            Err(e) => Err(e.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn have_git() -> bool {
    std::process::Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Set up a git remote whose working tree is a published pack folder.
fn git_remote(dir: &std::path::Path) {
    git(dir, &["init", "--quiet", "--initial-branch=main"]);
    git(dir, &["config", "user.email", "t@example.org"]);
    git(dir, &["config", "user.name", "transport tests"]);
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "--quiet", "-m", "packs"]);
}

/// Fetch exactly one pack off a source, by pack id.
fn fetch_one(store: &dyn BlobStore, pack_id: &str) -> transport::FetchedBundle {
    let entries = transport::discover(store).unwrap();
    let entry = entries
        .iter()
        .find(|e| e.id == pack_id)
        .unwrap_or_else(|| panic!("{pack_id} is offered; catalogue was {entries:?}"));
    transport::fetch(store, entry).unwrap()
}

// ---------------------------------------------------------------------------
// the test
// ---------------------------------------------------------------------------

/// Publish once; read back over folder, git and HTTPS; assert the bytes and
/// the verified signer are identical across all three, and that installing
/// through any of them lands in the same place.
#[test]
fn the_same_signed_bytes_arrive_over_every_transport() {
    let tmp = tempfile::tempdir().unwrap();
    let alice = publish_pack("za-personal", "1.0.0", 7);

    // One publish, into one folder. Everything below reads that same folder,
    // directly or through a transport.
    let share = tmp.path().join("share");
    std::fs::create_dir_all(&share).unwrap();
    transport::publish(&share, &alice.verified, &alice.signature, &alice.public_key).unwrap();

    let ctx = TransportContext::new().with_cache_dir(tmp.path().join("cache"));

    // -- transport 1: a watched folder / USB stick --------------------------
    let folder = PackSource::parse(&format!("folder:{}", share.display())).unwrap();
    assert!(!folder.is_network(), "sneakernet touches no network");
    let folder_store = transport::open(&folder, &ctx).unwrap();
    let via_folder = fetch_one(folder_store.as_ref(), "za-personal");

    // -- transport 2: a git remote ------------------------------------------
    let mut transports_covered = 1;
    let via_git = if have_git() {
        git_remote(&share);
        let source = PackSource::parse(&format!("git:{}#main", share.display())).unwrap();
        assert!(source.is_network(), "a git remote is a network transport");
        let store = transport::open(&source, &ctx).unwrap();
        transports_covered += 1;
        Some(fetch_one(store.as_ref(), "za-personal"))
    } else {
        eprintln!(
            "SKIPPED the git transport leg: git is not on PATH. \
             Transports covered by this run: folder + https only."
        );
        None
    };

    // -- transport 3: plain HTTPS -------------------------------------------
    // An HTTPS base cannot be listed, so it needs an index. One line per
    // publisher, which is what keeps a shared root append-only.
    let root_index = serde_json::json!({
        "slipscan_pack_index": 1,
        "includes": [format!("{}/index.json", alice.verified.fingerprint())],
    });
    std::fs::write(
        share.join("index.json"),
        serde_json::to_vec_pretty(&root_index).unwrap(),
    )
    .unwrap();

    let base = "https://packs.example/pub";
    let http = Arc::new(DirOverHttp::new(base, &share));
    let https_ctx = TransportContext::new().with_http(Arc::clone(&http) as Arc<dyn PackHttp>);
    let https = PackSource::parse(base).unwrap();
    assert!(https.is_network());
    let https_store = transport::open(&https, &https_ctx).unwrap();
    let via_https = fetch_one(https_store.as_ref(), "za-personal");
    transports_covered += 1;
    assert!(
        http.urls().iter().all(|u| u.starts_with(base)),
        "every request went to the configured base and nowhere else: {:?}",
        http.urls()
    );

    // -- the claim ----------------------------------------------------------
    // Identical bytes, identical signer, whatever the channel was.
    let mut bundles = vec![("folder", &via_folder), ("https", &via_https)];
    if let Some(b) = &via_git {
        bundles.push(("git", b));
    }
    assert!(
        transports_covered >= 2,
        "at least two transports must be exercised; this run covered {transports_covered}"
    );
    for (name, bundle) in &bundles {
        let verified = bundle.verify().unwrap();
        assert_eq!(
            verified.pack().payload_bytes(),
            alice.document,
            "{name} delivered different bytes"
        );
        assert_eq!(verified.signer(), alice.verified.signer(), "{name} signer");
        assert_eq!(
            bundle.offered_fingerprint(),
            alice.verified.fingerprint(),
            "{name} fingerprint"
        );
    }

    // -- installing through one of them, and only with an explicit yes ------
    let db = Db::open_in_memory().unwrap();
    let conn = db.conn();
    let book_id = make_book(conn);

    assert!(
        matches!(
            transport::install_bundle(conn, &book_id, &via_folder, SignerDecision::RequireKnown),
            Err(PackError::SignerNotAccepted { .. })
        ),
        "a pack does not become trusted by arriving"
    );

    let report = transport::install_bundle(
        conn,
        &book_id,
        &via_folder,
        SignerDecision::Accept(&alice.verified.fingerprint()),
    )
    .unwrap();
    assert_eq!(report.pack.pack_id, "za-personal");
    assert_eq!(report.categories_created, 1);
    assert_eq!(report.rules_installed, 1);

    // The other transports now agree it is already installed — same pack, so
    // the same refusal, because the channel was never part of the identity.
    for (name, bundle) in &bundles {
        let plan = transport::plan_bundle(conn, &book_id, bundle).unwrap();
        assert_eq!(plan.action, transport::PlannedAction::Refuse, "{name}");
        assert!(
            plan.refusal
                .as_deref()
                .unwrap()
                .contains("already installed"),
            "{name}: {plan:?}"
        );
        assert!(
            !plan.needs_signer_acceptance(),
            "{name}: signer now trusted"
        );
    }
}

/// The refusal the pin exists for, proved over every transport at once: a
/// second publisher offering a *higher* version of a pack id that is already
/// bound to somebody else's key.
#[test]
fn a_signer_change_is_refused_over_every_transport() {
    let tmp = tempfile::tempdir().unwrap();
    let alice = publish_pack("za-personal", "1.0.0", 7);
    let mallory = publish_pack("za-personal", "9.9.9", 9);
    assert_ne!(alice.verified.signer(), mallory.verified.signer());

    let share = tmp.path().join("share");
    std::fs::create_dir_all(&share).unwrap();
    transport::publish(&share, &alice.verified, &alice.signature, &alice.public_key).unwrap();

    let db = Db::open_in_memory().unwrap();
    let conn = db.conn();
    let book_id = make_book(conn);
    let ctx = TransportContext::new().with_cache_dir(tmp.path().join("cache"));

    // Alice's pack is installed and her key is now pinned to the id.
    let folder = PackSource::parse(&format!("folder:{}", share.display())).unwrap();
    let store = transport::open(&folder, &ctx).unwrap();
    transport::install_bundle(
        conn,
        &book_id,
        &fetch_one(store.as_ref(), "za-personal"),
        SignerDecision::Accept(&alice.verified.fingerprint()),
    )
    .unwrap();

    // Mallory publishes into the same share. She owns her own directory, so
    // she cannot touch a byte of Alice's — she can only add.
    transport::publish(
        &share,
        &mallory.verified,
        &mallory.signature,
        &mallory.public_key,
    )
    .unwrap();
    assert_eq!(
        std::fs::read(
            share
                .join(alice.verified.fingerprint())
                .join("za-personal-1.0.0.pack.json")
        )
        .unwrap(),
        alice.document,
        "publishing next to somebody never rewrites their files"
    );

    // Build every transport over the share that now holds both copies.
    let root_index = serde_json::json!({
        "slipscan_pack_index": 1,
        "includes": [
            format!("{}/index.json", alice.verified.fingerprint()),
            format!("{}/index.json", mallory.verified.fingerprint()),
        ],
    });
    std::fs::write(
        share.join("index.json"),
        serde_json::to_vec_pretty(&root_index).unwrap(),
    )
    .unwrap();

    let base = "https://packs.example/pub";
    let http = Arc::new(DirOverHttp::new(base, &share));
    let https_ctx = TransportContext::new().with_http(http as Arc<dyn PackHttp>);

    let mut stores: Vec<(&str, Box<dyn BlobStore>)> = vec![
        ("folder", transport::open(&folder, &ctx).unwrap()),
        (
            "https",
            transport::open(&PackSource::parse(base).unwrap(), &https_ctx).unwrap(),
        ),
    ];
    if have_git() {
        git_remote(&share);
        let source = PackSource::parse(&format!("git:{}#main", share.display())).unwrap();
        stores.push(("git", transport::open(&source, &ctx).unwrap()));
    } else {
        eprintln!(
            "SKIPPED the git leg of a_signer_change_is_refused_over_every_transport: \
             git is not on PATH. 2 of 3 transports covered."
        );
    }
    assert!(
        stores.len() >= 2,
        "the refusal must be proved on at least two transports; this run has {}",
        stores.len()
    );

    for (name, store) in &stores {
        let entries = transport::discover(store.as_ref()).unwrap();
        let hostile = entries
            .iter()
            .find(|e| e.id == "za-personal" && e.version == "9.9.9")
            .unwrap_or_else(|| panic!("{name}: the newer version is on offer: {entries:?}"));
        let bundle = transport::fetch(store.as_ref(), hostile).unwrap();

        // It verifies — Mallory really did sign her own bytes. That is
        // exactly why a valid signature is not, on its own, permission.
        let verified = bundle.verify().unwrap();
        assert_eq!(verified.signer(), mallory.verified.signer());

        // The preflight names the key the id belongs to.
        let plan = transport::plan_bundle(conn, &book_id, &bundle).unwrap();
        assert_eq!(plan.action, transport::PlannedAction::Refuse, "{name}");
        assert_eq!(
            plan.pinned_fingerprint.as_deref(),
            Some(alice.verified.fingerprint().as_str()),
            "{name}"
        );
        assert!(
            plan.refusal.as_deref().unwrap().contains("different key"),
            "{name}: {:?}",
            plan.refusal
        );

        // And so does every attempt — including one where the user is talked
        // into accepting Mallory's fingerprint. There is no override.
        for decision in [
            SignerDecision::RequireKnown,
            SignerDecision::Accept(&mallory.verified.fingerprint()),
        ] {
            assert!(
                matches!(
                    transport::install_bundle(conn, &book_id, &bundle, decision),
                    Err(PackError::SignerChanged { .. })
                ),
                "{name}: {decision:?} must not install"
            );
        }
    }

    // Nothing moved. Still Alice's 1.0.0, and Mallory's key was never
    // recorded as trusted on the way through any of it.
    let installed = Installer::open(conn).unwrap().list(&book_id).unwrap();
    assert_eq!(installed.len(), 1);
    assert_eq!(installed[0].version, "1.0.0");
    assert_eq!(installed[0].signer, alice.verified.signer());
    assert!(matches!(
        TrustStore::open(conn)
            .unwrap()
            .status(mallory.verified.signer())
            .unwrap(),
        TrustStatus::Unknown { .. }
    ));
}

/// The privacy contract, end to end: a database nobody has configured has no
/// source, and the only network transports are the ones a source opens.
#[test]
fn a_fresh_database_has_nowhere_to_fetch_from() {
    let db = Db::open_in_memory().unwrap();
    let conn = db.conn();

    // Before anything has created the table at all.
    assert!(SourceStore::open_readonly(conn).unwrap().is_none());

    let sources = SourceStore::open(conn).unwrap();
    assert!(sources.list().unwrap().is_empty());
    assert!(sources.network_sources().unwrap().is_empty());

    // And the network transports refuse rather than improvise: no HTTP
    // client was supplied and this crate contains no URL to fall back to.
    let empty = TransportContext::new();
    for uri in ["https://packs.example/pub", "git:https://example.org/p.git"] {
        let source = PackSource::parse(uri).unwrap();
        assert!(matches!(
            transport::open(&source, &empty),
            Err(PackError::Transport(_))
        ));
    }
}
