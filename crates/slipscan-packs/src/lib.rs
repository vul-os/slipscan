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
//! * [`engine`] — the local classification cascade over installed rules.
//! * [`benchmark`] — read-side peer comparison: pure local math over public
//!   aggregate packs (reading is perfectly private; contribution is a
//!   separate opt-in pipeline that does not live here).
//! * [`builtin`] — embedded seed packs: the SA region pair (`za-personal`,
//!   `za-business-vat`, region `ZA`) and the global `intl-starter` (no
//!   region). Regions are data on the pack manifest, never code.
//!
//! Everything is offline: this crate performs no network access of any kind.
//! Packs are files; fetch them however you like.

pub mod benchmark;
pub mod builtin;
mod compat;
pub mod engine;
pub mod error;
pub mod format;
mod hex;
pub mod install;
pub mod model;
pub mod trust;
pub mod verify;

pub use benchmark::{compare, Comparison, QuartilePosition};
pub use error::{PackError, PackResult};
pub use format::{ManifestSignature, Pack};
pub use install::{InstallOutcome, InstallReport, InstalledPack, Installer};
pub use model::{
    BenchmarkCohort, BenchmarkSet, BenchmarkStat, KeywordRule, MatchKind, MerchantRule,
    PackCategory, PackKind, PackMeta, PackPayload, Semver, VatHint,
};
pub use trust::{TrustStatus, TrustStore, TrustedSigner};
pub use verify::{key_fingerprint, sign_pack, Provenance, VerifiedPack};

// Legacy flat-manifest API, kept for the server ops layer. New code uses
// `Pack` / `VerifiedPack` and the installer.
pub use compat::{verify_pack, MatchType, PackManifest, PackRule};
