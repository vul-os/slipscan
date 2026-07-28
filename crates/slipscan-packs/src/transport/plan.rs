//! From fetched bytes to installed state — the one road, with the gates in
//! the one order.
//!
//! Everything a surface needs to fetch a pack lives here so that no surface
//! re-implements a gate. There are exactly two entry points:
//!
//! * [`plan`] — what installing this verified pack *would* do, including
//!   refusing, computed from the installer's own rules and worded in the
//!   installer's own errors. Writes nothing.
//! * [`install_bundle`] — do it. Same gates, same order, then
//!   [`Installer::install`].
//!
//! # The order, and why it is this order
//!
//! 1. **Signature** ([`FetchedBundle::verify`]) — before any of this. Bytes
//!    that do not verify never become a [`VerifiedPack`], so nothing below is
//!    even reachable for them.
//! 2. **The pin.** A pack id belongs to the key that first signed it. A
//!    different key offering "a newer version" is refused *before* the trust
//!    decision, so a signer change cannot leave a newly-trusted key behind as
//!    a souvenir of a failed install. There is no flag, on any surface, that
//!    overrides this.
//! 3. **The signer.** Trust-on-first-use — but "first use" means *the user
//!    saw the fingerprint and said yes*, not "it showed up". A pack that
//!    arrives over a transport was not hand-carried with its key the way
//!    `pack install <file> --public-key <hex>` is, so an unknown signer is
//!    [`PackError::SignerNotAccepted`] until the caller passes the very
//!    fingerprint it is being asked about. Naming a source is not consent to
//!    everything that source will ever serve.
//! 4. **Versions** — forward only, enforced by the installer itself.
//!
//! [`FetchedBundle::verify`]: super::FetchedBundle::verify

use rusqlite::Connection;

use crate::error::{PackError, PackResult};
use crate::install::{InstallReport, Installer};
use crate::trust::{self, TrustStatus, TrustStore};
use crate::verify::{key_fingerprint, VerifiedPack};

use super::FetchedBundle;

/// What installing a pack would do to a book.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlannedAction {
    /// Not installed here yet.
    Install,
    /// Installed at an older version, which this replaces.
    Upgrade { from: String },
    /// It will not be installed. [`PackPlan::refusal`] says why, in the
    /// installer's own words.
    Refuse,
}

impl PlannedAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            PlannedAction::Install => "install",
            PlannedAction::Upgrade { .. } => "upgrade",
            PlannedAction::Refuse => "refuse",
        }
    }
}

/// The preflight for one pack: what it is, who signed it, and what would
/// happen. Metadata only — no payload, no secret, nothing of the user's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackPlan {
    pub pack_id: String,
    pub name: String,
    pub version: String,
    /// The payload's own word for what it is. Carried as a string on purpose:
    /// a transport and a preflight handle **any** pack kind, including one a
    /// later release adds, without either of them enumerating kinds.
    pub kind: String,
    pub region: Option<String>,
    pub author: Option<String>,
    /// Fingerprint to check against the publisher's own channel.
    pub signer_fingerprint: String,
    /// The trust store's label, if this key is already trusted here.
    pub trusted_as: Option<String>,
    /// The fingerprint this pack id is pinned to, if it has ever been
    /// installed. Differs from `signer_fingerprint` exactly when the
    /// publisher key changed — which is a refusal, never a silent re-pin.
    pub pinned_fingerprint: Option<String>,
    pub installed_version: Option<String>,
    pub categories: usize,
    pub merchant_rules: usize,
    pub keyword_rules: usize,
    pub action: PlannedAction,
    /// Set exactly when `action` is [`PlannedAction::Refuse`].
    pub refusal: Option<String>,
    /// Where the bytes came from, when they came from a transport.
    pub origin: Option<String>,
}

impl PackPlan {
    /// Whether the signer is unknown here and would need explicit acceptance.
    pub fn needs_signer_acceptance(&self) -> bool {
        self.trusted_as.is_none() && self.pinned_fingerprint.is_none()
    }
}

/// How the caller has resolved the trust-on-first-use question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignerDecision<'a> {
    /// Install only if this signer is already trusted (or already pinned to
    /// this pack id). An unknown signer refuses. This is the default and the
    /// one a batch/automated path may use.
    RequireKnown,
    /// The user has compared this fingerprint against the publisher's own
    /// channel and accepts it. Must equal the fingerprint of the key that
    /// actually signed the bytes, or the install refuses — so "yes" always
    /// means yes *to the thing that was shown*.
    Accept(&'a str),
}

/// Compute the preflight for a verified pack against a book.
///
/// Reads only. Safe to call on a connection that has never seen a pack: the
/// tables are not created by looking.
pub fn plan(
    conn: &Connection,
    book_id: &str,
    verified: &VerifiedPack,
    origin: Option<&str>,
) -> PackResult<PackPlan> {
    let payload = verified.payload();
    let meta = &payload.meta;
    let offered = meta.semver()?;

    let (trusted_as, pinned, installed_version) = match Installer::open_readonly(conn)? {
        // Nothing installed here ever: nothing trusted, nothing pinned.
        None => (None, None, None),
        Some(installer) => {
            let trust = TrustStore::open(conn)?;
            let trusted_as = match trust.status(verified.signer()) {
                Ok(TrustStatus::Trusted { label }) => Some(label),
                // A non-key signer id (builtin, dev override, legacy
                // adoption) is not a trust-store row and never will be. That
                // is "no label", not an error.
                Ok(TrustStatus::Unknown { .. }) | Err(_) => None,
            };
            (
                trusted_as,
                trust.pinned_signer(&meta.id)?,
                installer.get(book_id, &meta.id)?.map(|p| p.version),
            )
        }
    };

    // Gate 2 (the pin) then gate 4 (versions), in the installer's order, so
    // the preflight can never promise something the attempt then refuses.
    let mut refusal: Option<PackError> = None;
    if let Some(pinned) = pinned.as_deref().filter(|k| *k != verified.signer()) {
        refusal = Some(PackError::SignerChanged {
            pack_id: meta.id.clone(),
            pinned_fingerprint: key_fingerprint(pinned),
        });
    } else if trusted_as.is_none() && verified.signer() == crate::builtin::seed_public_key_hex() {
        refusal = Some(PackError::SignerNotTrustable);
    } else if let Some(installed) = installed_version.as_deref() {
        let current = installed.parse()?;
        if offered == current {
            refusal = Some(PackError::AlreadyInstalled {
                pack_id: meta.id.clone(),
                version: installed.to_string(),
            });
        } else if offered < current {
            refusal = Some(PackError::Downgrade {
                pack_id: meta.id.clone(),
                installed: installed.to_string(),
                offered: offered.to_string(),
            });
        }
    }

    let action = match (&refusal, &installed_version) {
        (Some(_), _) => PlannedAction::Refuse,
        (None, Some(from)) => PlannedAction::Upgrade { from: from.clone() },
        (None, None) => PlannedAction::Install,
    };

    Ok(PackPlan {
        pack_id: meta.id.clone(),
        name: meta.name.clone(),
        version: offered.to_string(),
        kind: payload.kind().as_str().to_string(),
        region: meta.region.clone(),
        author: meta.author.clone(),
        signer_fingerprint: verified.fingerprint(),
        trusted_as,
        pinned_fingerprint: pinned.as_deref().map(key_fingerprint),
        installed_version,
        categories: payload.categories.len(),
        merchant_rules: payload.merchant_rules.len(),
        keyword_rules: payload.keyword_rules.len(),
        action,
        refusal: refusal.map(|e| e.to_string()),
        origin: origin.map(str::to_string),
    })
}

/// Preflight a bundle that came off a transport, without installing it.
pub fn plan_bundle(
    conn: &Connection,
    book_id: &str,
    bundle: &FetchedBundle,
) -> PackResult<PackPlan> {
    let verified = bundle.verify()?;
    plan(conn, book_id, &verified, Some(bundle.origin()))
}

/// Verify a fetched bundle and install it, applying every gate in order.
///
/// The signature is checked *here*, on the bytes, before this function has
/// touched the database at all — and the installer downstream still accepts
/// nothing but the [`VerifiedPack`] this produced. There is no path from a
/// transport to installed state that skips either.
pub fn install_bundle(
    conn: &Connection,
    book_id: &str,
    bundle: &FetchedBundle,
    decision: SignerDecision<'_>,
) -> PackResult<InstallReport> {
    // Gate 1: the signature, plus the catalogue cross-check.
    let verified = bundle.verify()?;
    install_verified(conn, book_id, &verified, decision)
}

/// The gates, over an already-verified pack. Shared by the transport path and
/// by any surface that holds a [`VerifiedPack`] some other way.
pub fn install_verified(
    conn: &Connection,
    book_id: &str,
    verified: &VerifiedPack,
    decision: SignerDecision<'_>,
) -> PackResult<InstallReport> {
    let installer = Installer::open(conn)?;
    let trust = TrustStore::open(conn)?;
    let pack_id = &verified.payload().meta.id;

    // Gate 2: the pin, *before* any trust is recorded. A key change must not
    // leave a newly-trusted signer behind on its way out the door.
    if let Some(pinned) = trust
        .pinned_signer(pack_id)?
        .filter(|k| k != verified.signer())
    {
        return Err(PackError::SignerChanged {
            pack_id: pack_id.clone(),
            pinned_fingerprint: key_fingerprint(&pinned),
        });
    }

    // Gate 3: trust-on-first-use, where "use" is a decision the user made.
    if let TrustStatus::Unknown { fingerprint } = trust.status(verified.signer())? {
        match decision {
            SignerDecision::Accept(accepted) if accepted.eq_ignore_ascii_case(&fingerprint) => {
                trust.trust(verified.signer(), &signer_label(verified))?;
            }
            _ => {
                return Err(PackError::SignerNotAccepted {
                    pack_id: pack_id.clone(),
                    fingerprint,
                })
            }
        }
    }

    // Gate 4 and everything else: the one installer, unchanged.
    installer.install(book_id, verified)
}

/// The label a first-use trust decision is recorded under: the pack's own
/// author when it declares one, else the signer's fingerprint. Same rule
/// every surface uses, so a book reads the same wherever it is opened.
pub fn signer_label(verified: &VerifiedPack) -> String {
    verified
        .payload()
        .meta
        .author
        .as_deref()
        .map(str::trim)
        .filter(|author| !author.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("publisher {}", verified.fingerprint()))
}

/// Whether a signer is already trusted on this connection — the question a
/// surface asks before deciding whether to prompt.
pub fn signer_status(conn: &Connection, signer: &str) -> PackResult<TrustStatus> {
    TrustStore::open(conn)?.status(signer)
}

/// The signer a pack id is pinned to here, if any.
pub fn pinned_signer(conn: &Connection, pack_id: &str) -> PackResult<Option<String>> {
    trust::pinned_signer(conn, pack_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::tests::signed;
    use crate::transport::{discover, fetch, publish, LocalDir};
    use crate::verify::verify_detached;
    use ed25519_dalek::{Signer as _, SigningKey};

    /// A real (in-memory) core database with one book in it. The `Db` is
    /// returned so the caller keeps it alive for as long as the connection.
    fn book(name: &str) -> (slipscan_core::Db, String) {
        use slipscan_core::domain::{Book, BookKind};
        use slipscan_core::util::{new_id, now_iso};

        let db = slipscan_core::Db::open_in_memory().unwrap();
        let now = now_iso();
        let book = Book {
            id: new_id(),
            kind: BookKind::Personal,
            name: name.to_string(),
            currency: "ZAR".into(),
            country: Some("ZA".into()),
            region: "za".into(),
            locale: "en".into(),
            timezone: "UTC".into(),
            financial_lock_date: None,
            created_at: now.clone(),
            updated_at: now,
        };
        slipscan_core::repo::book::insert(db.conn(), &book).unwrap();
        (db, book.id)
    }

    #[test]
    fn a_fetched_pack_with_an_unknown_signer_refuses_until_the_user_says_yes() {
        let dir = tempfile::tempdir().unwrap();
        let (verified, _, sig, key) = signed("za-personal", "1.0.0", 7);
        publish(dir.path(), &verified, &sig, &key).unwrap();
        let store = LocalDir::directory(dir.path());
        let bundle = fetch(&store, &discover(&store).unwrap()[0]).unwrap();

        let (db, book_id) = book("fetch");
        let conn = db.conn();

        // The preflight says plainly that this signer is new here.
        let preview = plan_bundle(conn, &book_id, &bundle).unwrap();
        assert_eq!(preview.action, PlannedAction::Install);
        assert!(preview.needs_signer_acceptance());
        assert_eq!(preview.signer_fingerprint, verified.fingerprint());
        assert!(preview.origin.unwrap().contains("za-personal-1.0.0"));

        // Naming a source is not consent: arriving is not accepting.
        assert!(matches!(
            install_bundle(conn, &book_id, &bundle, SignerDecision::RequireKnown),
            Err(PackError::SignerNotAccepted { .. })
        ));
        // A "yes" to a different fingerprint is not a yes to this one.
        assert!(matches!(
            install_bundle(
                conn,
                &book_id,
                &bundle,
                SignerDecision::Accept("0000-0000-0000-0000")
            ),
            Err(PackError::SignerNotAccepted { .. })
        ));
        assert!(
            Installer::open(conn)
                .unwrap()
                .list(&book_id)
                .unwrap()
                .is_empty(),
            "a refusal installs nothing"
        );

        // Accepting the fingerprint that was actually shown works, and is
        // remembered — the second install of the same publisher is silent.
        let report = install_bundle(
            conn,
            &book_id,
            &bundle,
            SignerDecision::Accept(&verified.fingerprint()),
        )
        .unwrap();
        assert_eq!(report.pack.pack_id, "za-personal");
        assert_eq!(report.pack.signer, verified.signer());

        let after = plan_bundle(conn, &book_id, &bundle).unwrap();
        assert_eq!(after.action, PlannedAction::Refuse);
        assert!(after
            .refusal
            .as_deref()
            .unwrap()
            .contains("already installed"));
        assert!(!after.needs_signer_acceptance());
        assert_eq!(after.trusted_as.as_deref(), Some("transport tests"));
    }

    /// The refusal the whole pinning design exists for, proved end to end
    /// over a transport: same pack id, higher version, different publisher.
    #[test]
    fn a_signer_change_is_refused_and_leaves_no_trace() {
        let dir = tempfile::tempdir().unwrap();
        let (alice, _, a_sig, a_key) = signed("za-personal", "1.0.0", 7);
        publish(dir.path(), &alice, &a_sig, &a_key).unwrap();
        let store = LocalDir::directory(dir.path());
        let first = fetch(&store, &discover(&store).unwrap()[0]).unwrap();

        let (db, book_id) = book("pin");
        let conn = db.conn();
        install_bundle(
            conn,
            &book_id,
            &first,
            SignerDecision::Accept(&alice.fingerprint()),
        )
        .unwrap();

        // Mallory publishes "2.0.0" of the same id into the same folder.
        let (mallory, _, m_sig, m_key) = signed("za-personal", "2.0.0", 9);
        publish(dir.path(), &mallory, &m_sig, &m_key).unwrap();
        let entry = discover(&store)
            .unwrap()
            .into_iter()
            .find(|e| e.version == "2.0.0")
            .expect("the newer version is offered");
        let hostile = fetch(&store, &entry).unwrap();
        assert_ne!(mallory.signer(), alice.signer());

        // The preflight refuses, naming the key the id belongs to.
        let preview = plan_bundle(conn, &book_id, &hostile).unwrap();
        assert_eq!(preview.action, PlannedAction::Refuse);
        assert_eq!(
            preview.pinned_fingerprint.as_deref(),
            Some(alice.fingerprint().as_str())
        );
        assert_eq!(preview.signer_fingerprint, mallory.fingerprint());
        let refusal = preview.refusal.unwrap();
        assert!(refusal.contains("different key"), "{refusal}");

        // And so does the attempt — including when the user is talked into
        // "accepting" Mallory's fingerprint. There is no override.
        for decision in [
            SignerDecision::RequireKnown,
            SignerDecision::Accept(&mallory.fingerprint()),
        ] {
            assert!(matches!(
                install_bundle(conn, &book_id, &hostile, decision),
                Err(PackError::SignerChanged { .. })
            ));
        }

        // Nothing moved: still Alice's 1.0.0, and Mallory's key was never
        // recorded as trusted on the way through.
        let installed = Installer::open(conn).unwrap().list(&book_id).unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].version, "1.0.0");
        assert_eq!(installed[0].signer, alice.signer());
        assert!(matches!(
            signer_status(conn, mallory.signer()).unwrap(),
            TrustStatus::Unknown { .. }
        ));
    }

    #[test]
    fn upgrades_from_the_pinned_signer_go_through_and_downgrades_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let (v1, _, sig1, key1) = signed("za-personal", "1.0.0", 7);
        let (v2, _, sig2, key2) = signed("za-personal", "1.2.0", 7);
        publish(dir.path(), &v1, &sig1, &key1).unwrap();
        publish(dir.path(), &v2, &sig2, &key2).unwrap();
        let store = LocalDir::directory(dir.path());
        let entries = discover(&store).unwrap();
        let get = |version: &str| {
            fetch(
                &store,
                entries.iter().find(|e| e.version == version).unwrap(),
            )
            .unwrap()
        };

        let (db, book_id) = book("upgrade");
        let conn = db.conn();
        install_bundle(
            conn,
            &book_id,
            &get("1.0.0"),
            SignerDecision::Accept(&v1.fingerprint()),
        )
        .unwrap();

        // Same publisher: no further prompt, and the plan says "upgrade".
        let preview = plan_bundle(conn, &book_id, &get("1.2.0")).unwrap();
        assert_eq!(
            preview.action,
            PlannedAction::Upgrade {
                from: "1.0.0".into()
            }
        );
        assert!(!preview.needs_signer_acceptance());
        let report =
            install_bundle(conn, &book_id, &get("1.2.0"), SignerDecision::RequireKnown).unwrap();
        assert_eq!(report.pack.version, "1.2.0");

        // Backwards is refused, on the plan and on the attempt.
        let back = plan_bundle(conn, &book_id, &get("1.0.0")).unwrap();
        assert_eq!(back.action, PlannedAction::Refuse);
        assert!(matches!(
            install_bundle(conn, &book_id, &get("1.0.0"), SignerDecision::RequireKnown),
            Err(PackError::Downgrade { .. })
        ));
    }

    #[test]
    fn tampered_bytes_are_refused_before_the_database_is_opened_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let (verified, _, sig, key) = signed("za-personal", "1.0.0", 7);
        publish(dir.path(), &verified, &sig, &key).unwrap();
        let doc_path = dir
            .path()
            .join(verified.fingerprint())
            .join("za-personal-1.0.0.pack.json");
        let mut bytes = std::fs::read(&doc_path).unwrap();
        let idx = bytes.len() - 2;
        bytes[idx] ^= 0x01;
        std::fs::write(&doc_path, &bytes).unwrap();

        let store = LocalDir::directory(dir.path());
        let bundle = fetch(&store, &discover(&store).unwrap()[0]).unwrap();
        let (db, book_id) = book("tamper");
        let conn = db.conn();

        assert!(matches!(
            plan_bundle(conn, &book_id, &bundle),
            Err(PackError::VerificationFailed)
        ));
        assert!(matches!(
            install_bundle(
                conn,
                &book_id,
                &bundle,
                SignerDecision::Accept(&verified.fingerprint())
            ),
            Err(PackError::VerificationFailed)
        ));
        // Not even the pack tables were created: an unverified pack has no
        // reach into the database whatsoever.
        assert!(Installer::open_readonly(conn).unwrap().is_none());
    }

    /// A pack that is **not** a taxonomy travels the same road and installs
    /// the same way. Nothing in `transport` enumerates kinds — a catalogue
    /// entry's `kind` is an untrusted free string and a plan's is whatever
    /// the verified payload calls itself — so a kind added later (mailrules,
    /// and whatever comes after it) needs no transport change at all.
    #[test]
    fn any_pack_kind_rides_the_same_road() {
        use crate::model::{BenchmarkCohort, BenchmarkSet, BenchmarkStat, PackMeta, PackPayload};

        let key = SigningKey::from_bytes(&[11u8; 32]);
        let payload = PackPayload {
            meta: PackMeta {
                id: "za-cohort".into(),
                name: "ZA cohort".into(),
                version: "1.0.0".into(),
                region: Some("ZA".into()),
                author: Some("aggregator".into()),
                description: None,
            },
            categories: vec![],
            merchant_rules: vec![],
            keyword_rules: vec![],
            vat_hints: vec![],
            mailrules: None,
            benchmarks: Some(BenchmarkSet {
                cohort: BenchmarkCohort {
                    region: "ZA".into(),
                    household_size: 2,
                    income_band: "C".into(),
                },
                currency: "ZAR".into(),
                k_floor: 50,
                stats: vec![BenchmarkStat {
                    category_key: "groceries".into(),
                    period: "2026-07".into(),
                    sample_size: 500,
                    p25_minor: 100_000,
                    median_minor: 200_000,
                    p75_minor: 300_000,
                    mean_minor: None,
                }],
            }),
        };
        let pack = crate::verify::sign_pack(&crate::format::Pack::build(&payload).unwrap(), &key);
        let doc = pack.payload_bytes().to_vec();
        let sig = key.sign(&doc).to_bytes().to_vec();
        let pubk = key.verifying_key().as_bytes().to_vec();
        let verified = verify_detached(&doc, &sig, &pubk).unwrap();

        let dir = tempfile::tempdir().unwrap();
        publish(dir.path(), &verified, &sig, &pubk).unwrap();
        let store = LocalDir::directory(dir.path());
        let entries = discover(&store).unwrap();
        assert_eq!(
            entries[0].kind.as_deref(),
            Some("benchmark"),
            "the catalogue carries whatever the payload calls itself"
        );

        let bundle = fetch(&store, &entries[0]).unwrap();
        let (db, book_id) = book("kinds");
        let conn = db.conn();
        let preview = plan_bundle(conn, &book_id, &bundle).unwrap();
        assert_eq!(preview.kind, "benchmark");
        assert_eq!(preview.categories, 0);
        install_bundle(
            conn,
            &book_id,
            &bundle,
            SignerDecision::Accept(&verified.fingerprint()),
        )
        .unwrap();
        assert_eq!(
            Installer::open(conn).unwrap().list(&book_id).unwrap()[0].pack_id,
            "za-cohort"
        );
    }
}
