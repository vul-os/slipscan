//! Builtin seed packs, compiled into the binary.
//!
//! Three seed packs ship as embedded fixtures — two for the `ZA` region and
//! one global (regions are data, not code; a pack without a region applies
//! anywhere):
//! * `za-personal` (region `ZA`) — personal-finance taxonomy + rules for
//!   major SA merchants;
//! * `za-business-vat` (region `ZA`) — small-business taxonomy with advisory
//!   VAT hints;
//! * `intl-starter` (no region — global) — region-agnostic taxonomy + rules
//!   for worldwide merchants. Its category names deliberately match
//!   `za-personal` where the concepts coincide, so installing both composes
//!   onto one category tree instead of duplicating it.
//!
//! # Trust model, stated plainly
//!
//! Builtin packs are signed at load time with a **well-known development
//! key** whose bytes are in this source file. That signature exercises the
//! exact same verify path as external packs, but it proves nothing by itself
//! — the real integrity guarantee for builtins is that the payload is
//! embedded in the binary you already chose to run. Accordingly:
//!
//! * seed packs install with [`Provenance::Builtin`], skipping the TOFU
//!   store (there is nothing meaningful to trust-on-first-use);
//! * the trust store **refuses** to trust the well-known key for external
//!   packs ([`crate::trust::TrustStore::trust`]), so nobody can dress up an
//!   outside pack as "builtin";
//! * pack ids of seeds are pinned to the well-known key like any other pack,
//!   so an externally-sourced "update" to `za-personal` signed by anyone is
//!   rejected by the pin (and the well-known key itself can never be trusted).

use ed25519_dalek::SigningKey;

use crate::error::PackResult;
use crate::format::Pack;
use crate::hex;
use crate::install::{InstallReport, Installer};
use crate::model::PackPayload;
use crate::verify::{sign_pack, Provenance, VerifiedPack};
use crate::PackError;

/// Embedded payload of the SA personal-finance seed pack.
pub const ZA_PERSONAL_JSON: &str = include_str!("fixtures/za-personal.json");
/// Embedded payload of the SA small-business/VAT seed pack.
pub const ZA_BUSINESS_VAT_JSON: &str = include_str!("fixtures/za-business-vat.json");
/// Embedded payload of the global (region-agnostic) starter seed pack.
pub const INTL_STARTER_JSON: &str = include_str!("fixtures/intl-starter.json");

/// The well-known development signing key for builtin seeds. Deliberately
/// public — see the module docs. **Never** use it to sign a real pack.
const SEED_SIGNING_KEY_BYTES: [u8; 32] = *b"slipscan-seed-dev-signing-key-01";

pub(crate) fn seed_signing_key() -> SigningKey {
    SigningKey::from_bytes(&SEED_SIGNING_KEY_BYTES)
}

/// Lowercase hex public key of the builtin seed signer.
pub fn seed_public_key_hex() -> String {
    hex::encode(seed_signing_key().verifying_key().as_bytes())
}

fn seed_pack(json: &str) -> PackResult<VerifiedPack> {
    let payload: PackPayload = serde_json::from_slice(json.as_bytes())?;
    payload.validate()?;
    let signed = sign_pack(&Pack::build(&payload)?, &seed_signing_key());
    // Run the real verify path, then mark the result as builtin.
    let verified = signed.verify()?;
    Ok(VerifiedPack::new(
        verified.pack().clone(),
        verified.signer().to_string(),
        Provenance::Builtin,
    ))
}

/// The builtin seed packs, verified and ready to install.
pub fn seed_packs() -> PackResult<Vec<VerifiedPack>> {
    Ok(vec![
        seed_pack(ZA_PERSONAL_JSON)?,
        seed_pack(ZA_BUSINESS_VAT_JSON)?,
        seed_pack(INTL_STARTER_JSON)?,
    ])
}

/// Install every seed pack into `book_id`, skipping ones already current.
pub fn install_seed_packs(
    conn: &rusqlite::Connection,
    book_id: &str,
) -> PackResult<Vec<InstallReport>> {
    let installer = Installer::open(conn)?;
    let mut reports = Vec::new();
    for pack in seed_packs()? {
        match installer.install(book_id, &pack) {
            Ok(report) => reports.push(report),
            Err(PackError::AlreadyInstalled { .. }) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(reports)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_packs_parse_validate_and_verify() {
        let packs = seed_packs().unwrap();
        assert_eq!(packs.len(), 3);
        let ids: Vec<&str> = packs.iter().map(|p| p.pack().id()).collect();
        assert_eq!(ids, ["za-personal", "za-business-vat", "intl-starter"]);
        for pack in &packs {
            assert_eq!(pack.provenance(), Provenance::Builtin);
            assert_eq!(pack.signer(), seed_public_key_hex());
            assert!(!pack.payload().categories.is_empty());
            assert!(!pack.payload().merchant_rules.is_empty());
            // Seeds are taxonomy packs; the benchmark section stays empty.
            assert!(pack.payload().benchmarks.is_none());
        }
        // The business pack carries VAT hints; the personal pack does not.
        assert!(!packs[1].payload().vat_hints.is_empty());
        // Regions: ZA seeds declare "ZA"; the starter pack is global (none),
        // and being global it carries no jurisdictional VAT hints either.
        assert_eq!(packs[0].payload().meta.region.as_deref(), Some("ZA"));
        assert_eq!(packs[1].payload().meta.region.as_deref(), Some("ZA"));
        assert_eq!(packs[2].payload().meta.region, None);
        assert!(packs[2].payload().vat_hints.is_empty());
    }
}
