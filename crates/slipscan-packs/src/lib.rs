//! slipscan-packs — signed, versioned community packs.
//!
//! Community sharing moves **rules, never data** (mantra #5): a pack carries
//! a category taxonomy, merchant-classification rules, advisory VAT hints, or
//! anonymous cohort aggregates — there is nowhere in the format to put a
//! transaction, an amount of yours, or a person.
//!
//! * [`format`](mod@format) — the on-disk pack: `pack.toml` manifest + JSON
//!   payload, the payload bytes being exactly what gets ed25519-signed.
//! * [`model`] — the payload: metadata, taxonomy, rules, VAT hints, and
//!   benchmark statistics (strict validation, strict semver).
//! * [`verify`] — signing and verification; signer identity **is** the
//!   public key. Unsigned or tampered packs are rejected on install.
//! * [`trust`] — trust-on-first-use signer store with per-pack-id pinning.
//! * [`install`] — install/upgrade/uninstall into a book: taxonomy keys map
//!   onto local category ids, rules feed the local engine, versions only
//!   move forward.
//! * [`engine`] — the local classification cascade over installed rules, and
//!   the [`PackClassifier`] core consults during categorisation.
//! * [`benchmark`] — read-side peer comparison: pure local math over public
//!   aggregate packs (reading is perfectly private; contribution is a
//!   separate opt-in pipeline that does not live here).
//! * [`mailrules`] — bank-alert email formats as data: sender gates plus
//!   field extractors that turn "your card was used" mail into statement
//!   lines. Applying them lives in `slipscan-ingest`; the format, its
//!   validation and its conservatism contract live here.
//! * [`transport`] — **how a pack gets here**: local file, watched folder or
//!   USB stick, a git remote, plain HTTPS — and the seam a p2p transport
//!   would slot into without reopening anything. The same signed bytes over
//!   any channel, because the signature is what is trusted, not the channel.
//! * [`builtin`] — embedded seed packs: the SA region pair (`za-personal`,
//!   `za-business-vat`, region `ZA`) and the global `intl-starter` (no
//!   region). Regions are data on the pack manifest, never code.
//!
//! # Network
//!
//! Everything except [`transport`] is offline, and [`transport`] ships **no
//! HTTP client and no URL**: its one network verb ([`transport::PackHttp`]) is
//! injected by a surface, and its sources ([`transport::SourceStore`]) start
//! empty and are only ever written by the user. There is no registry, no
//! default endpoint and no discovery — a fresh install makes zero network
//! calls about packs until somebody names a source.

pub mod benchmark;
pub mod builtin;
pub mod compat;
pub mod engine;
pub mod error;
pub mod format;
mod hex;
pub mod install;
pub mod mailrules;
pub mod model;
pub mod transport;
pub mod trust;
pub mod verify;

pub use benchmark::{compare, Comparison, QuartilePosition};
pub use engine::{register_classifier, Classifier, PackClassifier};
pub use error::{PackError, PackResult};
pub use format::{ManifestSignature, Pack};
pub use install::{InstallOutcome, InstallReport, InstalledPack, Installer, LEGACY_SIGNER};
pub use mailrules::{
    AmountSpec, AmountStyle, CurrencySpec, DateSpec, Direction, DirectionSpec, Extractor, MailPart,
    MailRule, MailRuleSet, ReferenceSpec, DEFAULT_MAX_DATE_DRIFT_DAYS,
};
pub use model::{
    BenchmarkCohort, BenchmarkSet, BenchmarkStat, KeywordRule, MatchKind, MerchantRule,
    PackCategory, PackKind, PackMeta, PackPayload, Semver, VatHint,
};
pub use transport::{
    discover, fetch, install_bundle, install_verified, open as open_source, plan, plan_bundle,
    plan_document, publish, BlobStore, CatalogEntry, FetchedBundle, HttpBlob, PackHttp, PackPlan,
    PackSource, PackSourceRow, PlannedAction, PublishReport, SignerDecision, SourceKind,
    SourceStore, TransportContext,
};
pub use trust::{TrustStatus, TrustStore, TrustedSigner};
pub use verify::{key_fingerprint, sign_pack, verify_detached, Provenance, VerifiedPack};

// The legacy flat-manifest file format. Users have these files on disk, so
// they stay readable forever — but they are not a second pipeline: they
// install through the one installer (`verify_detached` converts them), and
// they preflight through the one preflight (`plan_document`).
//
// `verify_pack` is a reader for that one shape, kept for the callers that
// genuinely want the flat manifest back (the installed-packs index reports it)
// — **not** a verify surface. Wiring a user-facing "verify" to it is exactly
// how `slipscan pack verify` came to reject packs `slipscan pack install`
// accepts; use `plan_document` for that.
pub use compat::{verify_pack, MatchType, PackManifest, PackRule};
