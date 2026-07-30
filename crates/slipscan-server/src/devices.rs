//! Device identity for the server and CLI: a thin owning handle over
//! slipscan-core's [`slipscan_core::device::Devices`], exactly as
//! [`crate::vault::VaultHandle`] wraps the credential vault.
//!
//! Core's `Devices` borrows a SQLite connection and the OS keychain (the
//! private key lives in the vault, so the keychain is required);
//! [`DeviceHandle`] owns both so HTTP routes and CLI commands have a
//! self-contained way in.
//!
//! **Nothing here syncs anything** — see `docs/NODES.md`. This is identity
//! and pairing only. The signed operation log is [`crate::oplog`], and it does
//! not sync anything either: there is no transport and no endpoint.
//!
//! ## What crosses HTTP, and what does not
//!
//! One rule, the same one the vault and payment endpoints already follow:
//! **an operation that would put key material or a claim token on the wire
//! is local-only.** `slipscan-server` terminates no TLS and may be bound to
//! a LAN, so:
//!
//! * **served** — reading this device's identity, listing peers and invite
//!   metadata, and revoking or forgetting a peer. None of it is secret, and
//!   revocation being remotely reachable is the point of a self-hosted box.
//! * **local-only** — `init`, `rotate`, `reset` (they create or destroy the
//!   private key) and the whole pairing ceremony (invites carry a single-use
//!   claim token, and the key-name comparison needs a human in front of the
//!   device). On a headless box you run those over ssh with the CLI, which
//!   is where the human is anyway.

use std::path::Path;

use slipscan_core::device::pairing::{
    KeynameCheck, PairingAcceptance, PairingInvite, PairingInviteMeta,
};
use slipscan_core::device::{DeviceIdentity, DevicePeer, DeviceRotation, Devices};
use slipscan_core::secrets::{KeyringSecretStore, SecretStore};
use slipscan_core::{CoreResult, Db};

/// An owning handle: one SQLite connection + one keychain, yielding a core
/// `Devices` on demand.
pub struct DeviceHandle {
    db: Db,
    keychain: Box<dyn SecretStore>,
}

impl std::fmt::Debug for DeviceHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceHandle").finish_non_exhaustive()
    }
}

impl DeviceHandle {
    /// Open device state inside the database at `path` with the real OS
    /// keychain — the same file and the same keychain the core service and
    /// the vault use.
    pub fn open(path: impl AsRef<Path>) -> CoreResult<Self> {
        Ok(Self::new(
            Db::open(path)?,
            Box::new(KeyringSecretStore::default()),
        ))
    }

    /// Assemble from parts (tests use an in-memory db + mock keychain).
    pub fn new(db: Db, keychain: Box<dyn SecretStore>) -> Self {
        Self { db, keychain }
    }

    fn devices(&self) -> Devices<'_> {
        Devices::new(self.db.conn(), &*self.keychain)
    }

    // -- Served over HTTP -------------------------------------------------

    /// This device's identity, or `None` if it has none yet.
    pub fn identity(&self) -> CoreResult<Option<DeviceIdentity>> {
        self.devices().identity()
    }

    /// Pinned peers, tombstones included.
    pub fn peer_list(&self) -> CoreResult<Vec<DevicePeer>> {
        self.devices().peer_list()
    }

    /// One pinned peer by device id.
    pub fn peer_get(&self, public_key: &str) -> CoreResult<Option<DevicePeer>> {
        self.devices().peer_get(public_key)
    }

    /// Revoke a peer. The pin becomes a tombstone so the key cannot silently
    /// re-pair.
    pub fn peer_revoke(&self, public_key: &str) -> CoreResult<DevicePeer> {
        self.devices().peer_revoke(public_key)
    }

    /// Drop a pin entirely — the deliberate local reset for one peer.
    pub fn peer_forget(&self, public_key: &str) -> CoreResult<bool> {
        self.devices().peer_forget(public_key)
    }

    /// Invite metadata. Never carries a claim token.
    pub fn invite_list(&self) -> CoreResult<Vec<PairingInviteMeta>> {
        self.devices().invite_list()
    }

    /// The rotation chain for this device's own key.
    pub fn rotations(&self) -> CoreResult<Vec<DeviceRotation>> {
        self.devices().rotations()
    }

    // -- Local-only (CLI / desktop IPC), never routed ---------------------

    pub fn initialize(&self, label: &str) -> CoreResult<DeviceIdentity> {
        self.devices().initialize(label)
    }

    pub fn rotate(&self) -> CoreResult<(DeviceIdentity, DeviceRotation)> {
        self.devices().rotate()
    }

    pub fn reset(&self) -> CoreResult<()> {
        self.devices().reset()
    }

    pub fn invite_create(&self, label: &str, ttl_seconds: i64) -> CoreResult<PairingInvite> {
        self.devices().invite_create(label, ttl_seconds)
    }

    pub fn invite_cancel(&self, id: &str) -> CoreResult<bool> {
        self.devices().invite_cancel(id)
    }

    pub fn pair_accept(
        &self,
        blob: &str,
        check: KeynameCheck<'_>,
    ) -> CoreResult<PairingAcceptance> {
        self.devices().pair_accept(blob, check)
    }

    pub fn pair_confirm(&self, blob: &str, check: KeynameCheck<'_>) -> CoreResult<DevicePeer> {
        self.devices().pair_confirm(blob, check)
    }
}
