//! Getting a pack **here** — the fetch half of "share the smarts, not the
//! data".
//!
//! # The one idea
//!
//! **The same signed bytes over any transport, because the signature is what
//! is trusted, not the channel.** A pack that arrived over HTTPS, out of a
//! git remote, off a USB stick, or from a file a friend emailed you is the
//! identical byte sequence, and it is checked the identical way. No transport
//! grants any authority: every one of them ends at a [`FetchedBundle`], whose
//! only exit is [`FetchedBundle::verify`] — that is, [`crate::verify_detached`]
//! — and the installer still accepts nothing but a
//! [`VerifiedPack`](crate::VerifiedPack). Nothing in this module touches a
//! database, and nothing in it can produce installed state.
//!
//! # Why the layout looks like this
//!
//! Borrowed wholesale from FlowStock's folder sync
//! (`backend/internal/sync/folder.go`): **each writer owns its own files, so
//! a file-sync service never has a conflict to resolve.** A publisher owns a
//! directory named for their key fingerprint and writes only inside it:
//!
//! ```text
//! <source root>/
//!   index.json                       # optional; may just `includes` the rest
//!   ab12-cd34-ef56-7890/             # one publisher, named by key fingerprint
//!     signer.pub                     # their ed25519 public key (hex)
//!     index.json                     # their own catalogue, append-only
//!     za-personal-1.2.0.pack.json      # the exact signed bytes
//!     za-personal-1.2.0.pack.json.sig  # detached signature (hex)
//! ```
//!
//! Two publishers sharing one Dropbox folder, Syncthing share or USB stick
//! never write the same path. A given `<id>-<version>.pack.json` is
//! write-once — a version's bytes never change — so even a re-publish is not
//! an edit. Dropping three loose files (`x.pack.json`, `x.pack.json.sig`,
//! `x.pack.json.pub`) into the root works too; that is the "someone handed me
//! a stick" case, and it needs no index at all.
//!
//! # Indexes are hints, never authority
//!
//! Kerf's distributed Workshop calls its catalogue "derived, never
//! authoritative", and the same rule holds here: an `index.json` only says
//! *what to fetch*. Every fact a user is shown — id, version, kind, region,
//! signer — comes from the verified payload afterwards, and an index that
//! misdescribes what it points at is a [`PackError::IndexMismatch`] refusal,
//! not a cosmetic disagreement. `includes` lets a shared root aggregate
//! per-publisher indexes by reference, so adding a publisher appends one line
//! instead of rewriting anyone else's catalogue.
//!
//! # No registry, no default endpoint
//!
//! There is no built-in source, anywhere, at any layer: [`SourceStore`] starts
//! empty and this crate contains no URL. A fresh install makes zero network
//! calls until the user names a source themselves — asserted by
//! [`SourceStore`]'s own tests, and by the fact that the only network
//! transport ([`https`]) needs a caller-supplied [`PackHttp`] that a default
//! flow has no way to obtain.
//!
//! # Adding a transport later (p2p, DMTAP, whatever)
//!
//! Implement [`BlobStore`] — "read this relative name", "list the names you
//! have". That is the entire seam. Discovery, index parsing, sidecar
//! resolution, size limits, verification and installation are written once,
//! above it, and none of them know which transport they are standing on.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{PackError, PackResult};
use crate::hex;
use crate::verify::{key_fingerprint, verify_detached, VerifiedPack};

mod git;
mod https;
mod local;
mod plan;
mod source_store;

pub use git::{GitCheckout, GIT_CACHE_DIR};
pub use https::{HttpBlob, HttpsDir, PackHttp};
pub use local::LocalDir;
pub use plan::{
    install_bundle, install_verified, pinned_signer, plan, plan_bundle, signer_label,
    signer_status, PackPlan, PlannedAction, SignerDecision,
};
pub use source_store::{PackSourceRow, SourceStore};

/// Catalogue file name, at a source root and/or inside a publisher directory.
pub const INDEX_FILE: &str = "index.json";
/// Suffix that marks a blob as a pack document.
pub const DOCUMENT_SUFFIX: &str = ".pack.json";
/// Detached-signature sidecar suffix, appended to the document name.
pub const SIGNATURE_SUFFIX: &str = ".sig";
/// Public-key sidecar suffix, appended to the document name.
pub const KEY_SUFFIX: &str = ".pub";
/// Per-publisher public key, shared by every document beside it.
pub const SIGNER_KEY_FILE: &str = "signer.pub";

/// Hard ceiling on one pack document. Packs are taxonomies and rules; nothing
/// legitimate is anywhere near this, and a transport must not be able to make
/// us allocate without bound.
pub const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
/// Hard ceiling on one index file.
pub const MAX_INDEX_BYTES: usize = 4 * 1024 * 1024;
/// Hard ceiling on how many blob names one source may present.
pub const MAX_BLOB_NAMES: usize = 10_000;
/// How deep a listable source is walked. Root, publisher dir, and one more.
pub const MAX_LIST_DEPTH: usize = 3;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/// Which transport a source speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    /// One pack document on this machine, with its sidecars.
    File,
    /// A directory in the layout above — a synced folder, a NAS mount, a USB
    /// stick. The sneakernet case.
    Folder,
    /// A git remote, cloned/pulled into a local cache and then read as a
    /// folder. Distribution over anything that hosts a repo.
    Git,
    /// An HTTPS base URL. Cannot be listed, so it needs an `index.json`.
    Https,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceKind::File => "file",
            SourceKind::Folder => "folder",
            SourceKind::Git => "git",
            SourceKind::Https => "https",
        }
    }

    /// Whether reading this source can put packets on a network. Used to keep
    /// the "zero network calls until you name a source" promise checkable
    /// rather than merely asserted.
    pub fn is_network(self) -> bool {
        matches!(self, SourceKind::Git | SourceKind::Https)
    }
}

/// A place packs come from, exactly as the user named it.
///
/// Parsing is deliberately **pure and explicit**: no filesystem probing, no
/// guessing a bare string into a scheme, no default. A source exists because
/// somebody typed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackSource {
    kind: SourceKind,
    location: String,
    /// Git ref (branch/tag/commit) from a `#fragment`; `None` = remote HEAD.
    git_ref: Option<String>,
}

impl PackSource {
    /// Parse one of the four accepted forms:
    ///
    /// ```text
    /// file:<path>          one document, sidecars beside it
    /// folder:<path>        a directory in the pack layout
    /// git:<url>[#ref]      a git remote (any URL git itself accepts)
    /// https://<host>/...   an HTTPS base URL
    /// ```
    ///
    /// `http://` is refused. The signature is what is trusted, so plaintext
    /// could not forge a pack — but it does broadcast which packs you run,
    /// and that is data about you, which is the thing this product exists not
    /// to leak.
    ///
    /// A URL that **embeds a password** (`user:pass@host`) is refused too, and
    /// for the same reason core refuses one on the FX endpoint: a source URI
    /// is stored as ordinary metadata and printed back by `pack source list`,
    /// so a secret in it would be a secret in a listing. Front a private host
    /// with network-level auth, or use `git:` over SSH — a bare `git@host`
    /// username carries no secret and is accepted.
    pub fn parse(raw: &str) -> PackResult<Self> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(PackError::UnknownScheme(String::new()));
        }
        if let Some(path) = raw.strip_prefix("file:") {
            return Self::local(SourceKind::File, path, raw);
        }
        if let Some(path) = raw.strip_prefix("folder:") {
            return Self::local(SourceKind::Folder, path, raw);
        }
        if let Some(url) = raw.strip_prefix("git:") {
            let (url, git_ref) = split_fragment(url);
            if url.is_empty() {
                return Err(PackError::UnknownScheme(raw.to_string()));
            }
            if url.starts_with("http://") {
                return Err(PackError::InsecureUrl(url.to_string()));
            }
            reject_embedded_password(url)?;
            return Ok(Self {
                kind: SourceKind::Git,
                location: url.to_string(),
                git_ref,
            });
        }
        if raw.starts_with("https://") {
            reject_embedded_password(raw)?;
            return Ok(Self {
                kind: SourceKind::Https,
                location: raw.trim_end_matches('/').to_string(),
                git_ref: None,
            });
        }
        if raw.starts_with("http://") {
            return Err(PackError::InsecureUrl(raw.to_string()));
        }
        Err(PackError::UnknownScheme(raw.to_string()))
    }

    fn local(kind: SourceKind, path: &str, raw: &str) -> PackResult<Self> {
        let path = path.trim();
        if path.is_empty() {
            return Err(PackError::UnknownScheme(raw.to_string()));
        }
        Ok(Self {
            kind,
            location: path.to_string(),
            git_ref: None,
        })
    }

    pub fn kind(&self) -> SourceKind {
        self.kind
    }

    /// The path or URL, without the scheme.
    pub fn location(&self) -> &str {
        &self.location
    }

    pub fn git_ref(&self) -> Option<&str> {
        self.git_ref.as_deref()
    }

    /// Whether opening this source can put packets on a network.
    pub fn is_network(&self) -> bool {
        self.kind.is_network()
    }

    /// Canonical form — round-trips through [`PackSource::parse`].
    pub fn uri(&self) -> String {
        match self.kind {
            SourceKind::File => format!("file:{}", self.location),
            SourceKind::Folder => format!("folder:{}", self.location),
            SourceKind::Git => match &self.git_ref {
                Some(r) => format!("git:{}#{}", self.location, r),
                None => format!("git:{}", self.location),
            },
            SourceKind::Https => self.location.clone(),
        }
    }
}

/// Refuse a URL whose authority carries `user:pass@`.
///
/// **The error never echoes the URL** — it is the thing that contains the
/// password. A bare `user@host` (an SSH login name) is fine and is allowed;
/// only a colon *before* the `@` marks a password.
fn reject_embedded_password(url: &str) -> PackResult<()> {
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let Some((userinfo, _)) = authority.rsplit_once('@') else {
        return Ok(());
    };
    if userinfo.contains(':') {
        return Err(PackError::Validation(
            "a pack source URL must not embed a password (user:pass@host): the URI is \
             stored as plain metadata and printed back by `pack source list`. Front a \
             private host with network-level auth, or use git: over SSH"
                .into(),
        ));
    }
    Ok(())
}

fn split_fragment(raw: &str) -> (&str, Option<String>) {
    match raw.split_once('#') {
        Some((url, frag)) if !frag.trim().is_empty() => (url, Some(frag.trim().to_string())),
        Some((url, _)) => (url, None),
        None => (raw, None),
    }
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/// A source reduced to the two things any transport can do: hand back the
/// bytes under a relative name, and (sometimes) say which names exist.
///
/// **This is the entire extension point.** A future p2p / content-addressed
/// transport implements these two methods and inherits discovery, index
/// handling, sidecar resolution, size limits, signature verification, TOFU
/// pinning and installation unchanged.
///
/// Implementations must reject traversal (`..`, absolute names) themselves —
/// [`safe_relative`] is provided for that and is used by every transport
/// here, because blob names come out of untrusted index files.
pub trait BlobStore {
    /// Read one blob. `Err(PackError::Io)` with `NotFound` means "absent",
    /// which callers treat as absence rather than failure where the layout
    /// says a blob is optional.
    fn read(&self, name: &str) -> PackResult<Vec<u8>>;

    /// Relative names this source offers, or
    /// [`PackError::SourceUnlistable`] for transports that cannot enumerate.
    fn list(&self) -> PackResult<Vec<String>>;

    /// Human-readable origin, shown next to fetched packs.
    fn describe(&self) -> String;
}

/// Reject a blob name that could escape the source root. Names arrive from
/// index files, which are untrusted input.
pub fn safe_relative(name: &str) -> PackResult<&str> {
    let trimmed = name.trim();
    let bad = trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.contains('\\')
        || trimmed.contains("//")
        || trimmed
            .split('/')
            .any(|seg| seg == ".." || seg == "." || seg.is_empty())
        || trimmed.contains(':');
    if bad {
        return Err(PackError::UnsafePayloadPath(name.to_string()));
    }
    Ok(trimmed)
}

/// Everything a transport needs that this crate will not invent for itself:
/// where a git checkout may be cached, and how to perform an HTTPS GET.
///
/// Both are `None` by default, and both stay `None` unless a surface supplies
/// them. That is the mechanism behind "no default endpoint": with no
/// [`PackHttp`], the HTTPS transport cannot be opened at all.
#[derive(Clone, Default)]
pub struct TransportContext {
    cache_dir: Option<PathBuf>,
    http: Option<Arc<dyn PackHttp>>,
}

impl std::fmt::Debug for TransportContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransportContext")
            .field("cache_dir", &self.cache_dir)
            .field("http", &self.http.is_some())
            .finish()
    }
}

impl TransportContext {
    pub fn new() -> Self {
        Self::default()
    }

    /// Where git checkouts are cached. Without it, `git:` sources refuse
    /// rather than picking a directory on the user's behalf.
    pub fn with_cache_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cache_dir = Some(dir.into());
        self
    }

    /// Supply the HTTPS GET. Without it, `https:` sources refuse.
    pub fn with_http(mut self, http: Arc<dyn PackHttp>) -> Self {
        self.http = Some(http);
        self
    }

    pub fn cache_dir(&self) -> Option<&std::path::Path> {
        self.cache_dir.as_deref()
    }

    pub fn http(&self) -> Option<&Arc<dyn PackHttp>> {
        self.http.as_ref()
    }
}

/// Open a source as a [`BlobStore`].
///
/// This is where a `git:` source is cloned or pulled, and the only place in
/// the crate where a network transport is constructed. It refuses rather than
/// improvising: a `git:` source with no cache directory and an `https:` source
/// with no [`PackHttp`] both fail loudly.
pub fn open(source: &PackSource, ctx: &TransportContext) -> PackResult<Box<dyn BlobStore>> {
    match source.kind {
        SourceKind::File => Ok(Box::new(LocalDir::single_file(&source.location)?)),
        SourceKind::Folder => Ok(Box::new(LocalDir::directory(&source.location))),
        SourceKind::Git => {
            let cache = ctx.cache_dir.as_ref().ok_or_else(|| {
                PackError::Transport(
                    "git sources need a cache directory; none was configured".into(),
                )
            })?;
            let checkout = GitCheckout::sync(&source.location, source.git_ref(), cache)?;
            Ok(Box::new(checkout.into_store()))
        }
        SourceKind::Https => {
            let http = ctx.http.as_ref().ok_or_else(|| {
                PackError::Transport(
                    "https sources need an HTTP transport; none was supplied \
                     (this crate ships none, and has no default endpoint)"
                        .into(),
                )
            })?;
            Ok(Box::new(HttpsDir::new(&source.location, Arc::clone(http))))
        }
    }
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/// One pack a source offers, as the source *claims* it.
///
/// Every field except the blob names is a hint from an untrusted catalogue.
/// The install path re-derives all of it from the verified payload and
/// refuses on disagreement ([`PackError::IndexMismatch`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogEntry {
    /// Claimed pack id.
    pub id: String,
    /// Claimed version.
    pub version: String,
    /// Claimed display name.
    pub name: Option<String>,
    /// Claimed kind. A free string on purpose — a transport carries **any**
    /// pack kind, including kinds this build has never heard of, and it is
    /// the payload parser's job to accept or reject one.
    pub kind: Option<String>,
    /// Claimed region.
    pub region: Option<String>,
    /// Blob name of the signed document.
    pub document: String,
    /// Blob name of the detached signature.
    pub signature: String,
    /// Blob name of the publisher key, when the layout names one.
    pub public_key_blob: Option<String>,
    /// Publisher key inline in the index (hex), when the index carries one.
    pub public_key_hex: Option<String>,
}

impl CatalogEntry {
    /// The entry a bare `<name>.pack.json` implies: sidecar signature, and a
    /// key from either its own sidecar or the publisher directory's.
    fn from_document_blob(document: &str) -> Self {
        let stem = document
            .strip_suffix(DOCUMENT_SUFFIX)
            .unwrap_or(document)
            .rsplit('/')
            .next()
            .unwrap_or(document);
        let (id, version) = split_id_version(stem);
        Self {
            id,
            version,
            name: None,
            kind: None,
            region: None,
            document: document.to_string(),
            signature: format!("{document}{SIGNATURE_SUFFIX}"),
            public_key_blob: None,
            public_key_hex: None,
        }
    }

    fn dir(&self) -> &str {
        match self.document.rfind('/') {
            Some(i) => &self.document[..i],
            None => "",
        }
    }
}

/// `za-personal-1.2.0` -> `("za-personal", "1.2.0")`. A file name is a hint,
/// so a name that does not carry a version simply claims none.
fn split_id_version(stem: &str) -> (String, String) {
    match stem.rsplit_once('-') {
        Some((id, version))
            if !id.is_empty()
                && version.split('.').count() == 3
                && version
                    .split('.')
                    .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) =>
        {
            (id.to_string(), version.to_string())
        }
        _ => (stem.to_string(), String::new()),
    }
}

/// A publisher's catalogue file. Optional everywhere it is possible to list.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PackIndex {
    /// Format marker. Present on files this crate writes; not required on
    /// files it reads, so a hand-written index stays valid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slipscan_pack_index: Option<u32>,
    /// Other index files to fold in — one line per publisher, so a shared
    /// root aggregates by reference and no publisher rewrites another's file.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub includes: Vec<String>,
    /// Default publisher key (hex) for entries that name none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer: Option<String>,
    #[serde(default)]
    pub entries: Vec<IndexEntry>,
}

/// One line of a catalogue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexEntry {
    pub id: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    pub document: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
}

/// Every pack a source offers, newest-looking first is *not* promised — the
/// order is stable (by document blob name) so two runs agree.
///
/// A listable source is walked; a non-listable one (HTTPS) is read through
/// its root `index.json`, and the absence of that index is the
/// [`PackError::SourceUnlistable`] refusal, not an empty catalogue.
pub fn discover(store: &dyn BlobStore) -> PackResult<Vec<CatalogEntry>> {
    let mut entries: Vec<CatalogEntry> = Vec::new();
    let mut seen_docs: std::collections::BTreeSet<String> = Default::default();

    let names = match store.list() {
        Ok(names) => Some(names),
        Err(PackError::SourceUnlistable(_)) => None,
        Err(e) => return Err(e),
    };

    // Indexes first: they carry the metadata a bare file name cannot.
    let index_paths: Vec<String> = match &names {
        Some(names) => names
            .iter()
            .filter(|n| *n == INDEX_FILE || n.ends_with(&format!("/{INDEX_FILE}")))
            .cloned()
            .collect(),
        None => vec![INDEX_FILE.to_string()],
    };
    // `includes` is followed breadth-wise with a per-index depth, so a root
    // that aggregates fifty publishers gets all fifty — the limit is on how
    // deep an index may point through others, never on how many it may name.
    let mut pending: Vec<(String, usize)> = index_paths.into_iter().map(|p| (p, 0)).collect();
    let mut loaded: std::collections::BTreeSet<String> = Default::default();
    while let Some((path, depth)) = pending.pop() {
        if !loaded.insert(path.clone()) {
            continue;
        }
        let bytes = match store.read(&path) {
            Ok(bytes) => bytes,
            // A root index that is simply absent is fine on a listable
            // source; on an unlistable one it is the whole catalogue.
            Err(PackError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                if names.is_none() {
                    return Err(PackError::SourceUnlistable(format!(
                        "{}/{path}",
                        store.describe()
                    )));
                }
                continue;
            }
            Err(e) => return Err(e),
        };
        if bytes.len() > MAX_INDEX_BYTES {
            return Err(PackError::InvalidIndex {
                path: path.clone(),
                message: format!(
                    "index is {} bytes; the limit is {MAX_INDEX_BYTES}",
                    bytes.len()
                ),
            });
        }
        let index: PackIndex =
            serde_json::from_slice(&bytes).map_err(|e| PackError::InvalidIndex {
                path: path.clone(),
                message: e.to_string(),
            })?;
        let dir = match path.rfind('/') {
            Some(i) => &path[..i],
            None => "",
        };
        if depth < MAX_LIST_DEPTH {
            for include in &index.includes {
                pending.push((join(dir, safe_relative(include)?), depth + 1));
            }
        }
        for entry in index.entries {
            let document = join(dir, safe_relative(&entry.document)?);
            let signature = match &entry.signature {
                Some(sig) => join(dir, safe_relative(sig)?),
                None => format!("{document}{SIGNATURE_SUFFIX}"),
            };
            if !seen_docs.insert(document.clone()) {
                continue;
            }
            entries.push(CatalogEntry {
                id: entry.id,
                version: entry.version,
                name: entry.name,
                kind: entry.kind,
                region: entry.region,
                document,
                signature,
                public_key_blob: None,
                public_key_hex: entry.public_key.or_else(|| index.signer.clone()),
            });
        }
    }

    // Then any loose documents the indexes did not mention — the "three files
    // on a USB stick" case, which is the whole point of sneakernet.
    if let Some(names) = &names {
        for name in names {
            if !name.ends_with(DOCUMENT_SUFFIX) || seen_docs.contains(name) {
                continue;
            }
            seen_docs.insert(name.clone());
            entries.push(CatalogEntry::from_document_blob(name));
        }
    }

    entries.sort_by(|a, b| a.document.cmp(&b.document));
    Ok(entries)
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/// Raw bytes off a transport. **Not verified, and not verifiable-by-being-here.**
///
/// This type deliberately has no accessor that hands the document to anything
/// but [`FetchedBundle::verify`]: the exit from every transport is a
/// signature check, and there is no second door.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedBundle {
    document: Vec<u8>,
    signature: Vec<u8>,
    public_key: Vec<u8>,
    origin: String,
    claimed: CatalogEntry,
}

impl FetchedBundle {
    /// Where these bytes came from, for display beside the pack.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// What the source's catalogue claimed. Only ever shown next to the
    /// verified truth, never instead of it.
    pub fn claimed(&self) -> &CatalogEntry {
        &self.claimed
    }

    /// Fingerprint of the key the source handed over — before anything is
    /// verified. Shown at the "do you accept this signer?" prompt, and equal
    /// to the verified signer's fingerprint exactly when the signature holds.
    pub fn offered_fingerprint(&self) -> String {
        key_fingerprint(&hex::encode(&self.public_key))
    }

    /// The **only** exit from a transport: check the detached signature over
    /// the exact bytes, then cross-check the catalogue's claims against the
    /// payload. A catalogue that misdescribes what it points at is refused,
    /// so a source cannot make a pack look like a different pack in a listing
    /// and install as something else.
    pub fn verify(&self) -> PackResult<VerifiedPack> {
        let verified = verify_detached(&self.document, &self.signature, &self.public_key)?;
        let meta = &verified.payload().meta;
        if !self.claimed.id.is_empty() && self.claimed.id != meta.id {
            return Err(PackError::IndexMismatch {
                claimed: self.claimed.id.clone(),
                actual: meta.id.clone(),
            });
        }
        if !self.claimed.version.is_empty() && self.claimed.version != meta.version {
            return Err(PackError::IndexMismatch {
                claimed: format!("{} {}", self.claimed.id, self.claimed.version),
                actual: format!("{} {}", meta.id, meta.version),
            });
        }
        Ok(verified)
    }
}

/// Pull one catalogue entry's bytes off a source. Performs no verification —
/// that is [`FetchedBundle::verify`], and it is not optional anywhere.
pub fn fetch(store: &dyn BlobStore, entry: &CatalogEntry) -> PackResult<FetchedBundle> {
    let document = store.read(safe_relative(&entry.document)?)?;
    if document.len() > MAX_DOCUMENT_BYTES {
        return Err(PackError::Validation(format!(
            "pack document is {} bytes; the limit is {MAX_DOCUMENT_BYTES}",
            document.len()
        )));
    }
    let signature = decode_material(&store.read(safe_relative(&entry.signature)?)?, 64)
        .ok_or(PackError::InvalidSignature)?;
    let public_key = read_public_key(store, entry)?;

    Ok(FetchedBundle {
        document,
        signature,
        public_key,
        origin: format!("{} ({})", store.describe(), entry.document),
        claimed: entry.clone(),
    })
}

/// The publisher key, in the order the layout defines: inline in the index,
/// then a per-document `.pub` sidecar, then the publisher directory's
/// `signer.pub`. A directory named for a fingerprint must agree with the key
/// it contains — a self-check that costs nothing and catches a mis-filed key.
fn read_public_key(store: &dyn BlobStore, entry: &CatalogEntry) -> PackResult<Vec<u8>> {
    if let Some(hex_key) = &entry.public_key_hex {
        return decode_material(hex_key.as_bytes(), 32).ok_or(PackError::InvalidPublicKey);
    }
    if let Some(blob) = &entry.public_key_blob {
        return decode_material(&store.read(safe_relative(blob)?)?, 32)
            .ok_or(PackError::InvalidPublicKey);
    }
    let sidecar = format!("{}{KEY_SUFFIX}", entry.document);
    match store.read(&sidecar) {
        Ok(bytes) => return decode_material(&bytes, 32).ok_or(PackError::InvalidPublicKey),
        Err(PackError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }

    let dir = entry.dir();
    let signer_path = join(dir, SIGNER_KEY_FILE);
    let bytes = store.read(&signer_path).map_err(|e| match e {
        PackError::Io(io) if io.kind() == std::io::ErrorKind::NotFound => {
            PackError::Transport(format!(
                "{} has no publisher key beside it ({sidecar} or {signer_path})",
                entry.document
            ))
        }
        other => other,
    })?;
    let key = decode_material(&bytes, 32).ok_or(PackError::InvalidPublicKey)?;

    // The publisher directory is named for the key's fingerprint. If both
    // exist and disagree, someone filed a key in the wrong place — say so
    // rather than fetching under a fingerprint that is not this key's.
    let dir_name = dir.rsplit('/').next().unwrap_or("");
    let actual = key_fingerprint(&hex::encode(&key));
    if !dir_name.is_empty() && looks_like_fingerprint(dir_name) && dir_name != actual {
        return Err(PackError::Transport(format!(
            "publisher directory {dir_name:?} does not match the key it holds ({actual})"
        )));
    }
    Ok(key)
}

fn looks_like_fingerprint(name: &str) -> bool {
    name.len() == 19
        && name
            .split('-')
            .all(|g| g.len() == 4 && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Accept key material as hex (the form a publisher publishes and a human
/// compares) or as raw bytes (the form a signing tool writes). Trailing
/// newlines are tolerated — every text editor adds one.
fn decode_material(bytes: &[u8], expect: usize) -> Option<Vec<u8>> {
    if bytes.len() == expect {
        return Some(bytes.to_vec());
    }
    let text = std::str::from_utf8(bytes).ok()?.trim();
    let decoded = hex::decode(&text.to_ascii_lowercase())?;
    (decoded.len() == expect).then_some(decoded)
}

// ---------------------------------------------------------------------------
// Publishing (the writer side of the same layout)
// ---------------------------------------------------------------------------

/// What [`publish`] wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishReport {
    pub pack_id: String,
    pub version: String,
    /// Fingerprint of the publishing key — also the directory name.
    pub fingerprint: String,
    /// Paths written, relative to the source root.
    pub written: Vec<String>,
    /// True when the document already existed with identical bytes. A
    /// version's bytes never change, so re-publishing is a no-op, not an
    /// edit — which is what keeps a synced folder conflict-free.
    pub unchanged: bool,
}

/// Write a verified pack into a folder source, in the layout the readers
/// above expect: a directory named for the publisher's fingerprint, holding
/// their key, their append-only index, and one write-once file per version.
///
/// This takes a [`VerifiedPack`] and the signature bytes rather than raw
/// input, so nothing unverified can be published into a shared folder under
/// a publisher's name.
pub fn publish(
    root: &std::path::Path,
    verified: &VerifiedPack,
    signature: &[u8],
    public_key: &[u8],
) -> PackResult<PublishReport> {
    if verified.signer() != hex::encode(public_key) {
        return Err(PackError::Validation(
            "public key does not match the verified pack's signer".into(),
        ));
    }
    let meta = &verified.payload().meta;
    let fingerprint = verified.fingerprint();
    let dir = root.join(&fingerprint);
    std::fs::create_dir_all(&dir)?;

    let doc_name = format!("{}-{}{DOCUMENT_SUFFIX}", meta.id, meta.version);
    let doc_path = dir.join(&doc_name);
    let bytes = verified.pack().payload_bytes();

    let unchanged = match std::fs::read(&doc_path) {
        Ok(existing) if existing == bytes => true,
        Ok(_) => {
            return Err(PackError::Validation(format!(
                "{doc_name} already exists here with different bytes; a version's \
                 bytes never change — publish a new version instead"
            )))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.into()),
    };

    let mut written = Vec::new();
    if !unchanged {
        std::fs::write(&doc_path, bytes)?;
        written.push(format!("{fingerprint}/{doc_name}"));
    }
    let sig_name = format!("{doc_name}{SIGNATURE_SUFFIX}");
    std::fs::write(dir.join(&sig_name), hex::encode(signature))?;
    std::fs::write(dir.join(SIGNER_KEY_FILE), hex::encode(public_key))?;
    if !unchanged {
        written.push(format!("{fingerprint}/{sig_name}"));
        written.push(format!("{fingerprint}/{SIGNER_KEY_FILE}"));
    }

    // The publisher's own index, and only theirs — the FlowStock rule that
    // makes a shared folder conflict-free.
    let index_path = dir.join(INDEX_FILE);
    let mut index: PackIndex = match std::fs::read(&index_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| PackError::InvalidIndex {
            path: index_path.display().to_string(),
            message: e.to_string(),
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PackIndex::default(),
        Err(e) => return Err(e.into()),
    };
    index.slipscan_pack_index = Some(1);
    index.signer = Some(verified.signer().to_string());
    index.entries.retain(|e| e.document != doc_name);
    index.entries.push(IndexEntry {
        id: meta.id.clone(),
        version: meta.version.clone(),
        name: Some(meta.name.clone()),
        // Whatever kind this payload is — including a kind this build does
        // not know — is carried through as the payload's own word for it.
        kind: Some(verified.payload().kind().as_str().to_string()),
        region: meta.region.clone(),
        document: doc_name.clone(),
        signature: Some(sig_name),
        public_key: None,
    });
    index.entries.sort_by(|a, b| a.document.cmp(&b.document));
    std::fs::write(&index_path, serde_json::to_vec_pretty(&index)?)?;
    written.push(format!("{fingerprint}/{INDEX_FILE}"));

    Ok(PublishReport {
        pack_id: meta.id.clone(),
        version: meta.version.clone(),
        fingerprint,
        written,
        unchanged,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::format::Pack;
    use crate::model::{MatchKind, MerchantRule, PackCategory, PackMeta, PackPayload};
    use crate::verify::sign_pack;
    use ed25519_dalek::{Signer, SigningKey};

    pub(crate) fn payload(id: &str, version: &str) -> PackPayload {
        PackPayload {
            meta: PackMeta {
                id: id.into(),
                name: format!("{id} pack"),
                version: version.into(),
                region: Some("ZA".into()),
                author: Some("transport tests".into()),
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
                confidence: 0.9,
            }],
            keyword_rules: vec![],
            vat_hints: vec![],
            benchmarks: None,
            mailrules: None,
        }
    }

    /// Sign a payload the way a publisher would: detached signature over the
    /// exact document bytes.
    pub(crate) fn signed(
        id: &str,
        version: &str,
        seed: u8,
    ) -> (VerifiedPack, Vec<u8>, Vec<u8>, Vec<u8>) {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let pack = sign_pack(&Pack::build(&payload(id, version)).unwrap(), &key);
        let document = pack.payload_bytes().to_vec();
        let signature = key.sign(&document).to_bytes().to_vec();
        let public = key.verifying_key().as_bytes().to_vec();
        let verified = verify_detached(&document, &signature, &public).unwrap();
        (verified, document, signature, public)
    }

    #[test]
    fn source_uris_round_trip_and_reject_everything_else() {
        for raw in [
            "file:/tmp/x.pack.json",
            "folder:/Volumes/USB/packs",
            "git:https://example.org/packs.git",
            "https://example.org/packs",
        ] {
            let source = PackSource::parse(raw).unwrap();
            assert_eq!(source.uri(), raw, "{raw}");
            assert_eq!(PackSource::parse(&source.uri()).unwrap(), source);
        }

        let git = PackSource::parse("git:https://example.org/p.git#stable").unwrap();
        assert_eq!(git.kind(), SourceKind::Git);
        assert_eq!(git.git_ref(), Some("stable"));
        assert_eq!(git.uri(), "git:https://example.org/p.git#stable");

        assert!(!PackSource::parse("folder:/x").unwrap().is_network());
        assert!(!PackSource::parse("file:/x").unwrap().is_network());
        assert!(PackSource::parse("https://x.example").unwrap().is_network());
        assert!(PackSource::parse("git:https://x.example/p")
            .unwrap()
            .is_network());

        // Plaintext, bare paths and empty strings are refusals, never guesses.
        assert!(matches!(
            PackSource::parse("http://example.org/packs"),
            Err(PackError::InsecureUrl(_))
        ));
        assert!(matches!(
            PackSource::parse("git:http://example.org/p.git"),
            Err(PackError::InsecureUrl(_))
        ));
        for bad in [
            "",
            "   ",
            "/tmp/packs",
            "example.org/packs",
            "file:",
            "folder: ",
        ] {
            assert!(
                matches!(PackSource::parse(bad), Err(PackError::UnknownScheme(_))),
                "{bad:?} must not parse into a source"
            );
        }
    }

    /// A source URI is stored as plain metadata and printed back by
    /// `pack source list`, so a password in one would be a password in a
    /// listing. Refused — and the refusal must not echo the URL it refused.
    #[test]
    fn a_url_that_embeds_a_password_is_refused_without_echoing_it() {
        for bad in [
            "https://alice:hunter2@packs.example/pub",
            "git:https://alice:hunter2@example.org/packs.git",
            "git:ssh://alice:hunter2@example.org/packs.git",
        ] {
            let err = PackSource::parse(bad).unwrap_err();
            assert!(matches!(err, PackError::Validation(_)), "{bad}: {err}");
            assert!(
                !err.to_string().contains("hunter2"),
                "the refusal leaked the password: {err}"
            );
        }

        // An SSH *username* is not a secret, and refusing it would break the
        // most ordinary private-repo setup there is.
        for good in [
            "git:ssh://git@example.org/team/packs.git",
            "git:git@example.org:team/packs.git",
            "https://packs.example/pub",
        ] {
            assert!(PackSource::parse(good).is_ok(), "{good} must be accepted");
        }
    }

    #[test]
    fn blob_names_cannot_escape_the_source_root() {
        for bad in [
            "../secrets",
            "/etc/passwd",
            "a/../../b",
            "a//b",
            "C:\\x",
            "a\\b",
            "",
            "./a",
        ] {
            assert!(
                safe_relative(bad).is_err(),
                "{bad:?} must be rejected as a blob name"
            );
        }
        assert_eq!(
            safe_relative("ab12-cd34-ef56-7890/x.pack.json").unwrap(),
            "ab12-cd34-ef56-7890/x.pack.json"
        );
    }

    #[test]
    fn publish_then_discover_and_verify_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let (verified, _doc, sig, key) = signed("za-personal", "1.0.0", 7);
        let report = publish(dir.path(), &verified, &sig, &key).unwrap();
        assert_eq!(report.pack_id, "za-personal");
        assert!(!report.unchanged);
        assert_eq!(report.fingerprint, verified.fingerprint());

        let store = LocalDir::directory(dir.path());
        let entries = discover(&store).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "za-personal");
        assert_eq!(entries[0].version, "1.0.0");
        assert_eq!(entries[0].kind.as_deref(), Some("taxonomy"));
        assert_eq!(entries[0].region.as_deref(), Some("ZA"));

        let bundle = fetch(&store, &entries[0]).unwrap();
        assert_eq!(bundle.offered_fingerprint(), verified.fingerprint());
        let out = bundle.verify().unwrap();
        assert_eq!(out.payload(), verified.payload());
        assert_eq!(out.signer(), verified.signer());

        // Re-publishing identical bytes is a no-op, which is what keeps a
        // file-sync service from ever seeing a conflicting write.
        let again = publish(dir.path(), &verified, &sig, &key).unwrap();
        assert!(again.unchanged);
    }

    #[test]
    fn two_publishers_share_one_folder_without_touching_each_others_files() {
        let dir = tempfile::tempdir().unwrap();
        let (alice, _, a_sig, a_key) = signed("za-personal", "1.0.0", 7);
        let (bob, _, b_sig, b_key) = signed("za-personal", "1.0.0", 9);

        let a = publish(dir.path(), &alice, &a_sig, &a_key).unwrap();
        let b = publish(dir.path(), &bob, &b_sig, &b_key).unwrap();
        assert_ne!(a.fingerprint, b.fingerprint);
        // Same pack id, same version, two publishers: no shared path at all.
        assert!(a.written.iter().all(|p| !b.written.contains(p)));

        let entries = discover(&LocalDir::directory(dir.path())).unwrap();
        assert_eq!(entries.len(), 2, "both publishers' copies are offered");
        let mut signers: Vec<String> = entries
            .iter()
            .map(|e| {
                fetch(&LocalDir::directory(dir.path()), e)
                    .unwrap()
                    .verify()
                    .unwrap()
                    .signer()
                    .to_string()
            })
            .collect();
        signers.sort();
        let mut expected = vec![alice.signer().to_string(), bob.signer().to_string()];
        expected.sort();
        assert_eq!(signers, expected);
    }

    #[test]
    fn loose_files_on_a_stick_need_no_index() {
        let dir = tempfile::tempdir().unwrap();
        let (verified, doc, sig, key) = signed("intl-starter", "2.1.0", 3);
        std::fs::write(dir.path().join("intl-starter-2.1.0.pack.json"), &doc).unwrap();
        std::fs::write(
            dir.path().join("intl-starter-2.1.0.pack.json.sig"),
            hex::encode(&sig),
        )
        .unwrap();
        // Raw 32 bytes rather than hex: both forms are accepted.
        std::fs::write(dir.path().join("intl-starter-2.1.0.pack.json.pub"), &key).unwrap();

        let store = LocalDir::directory(dir.path());
        let entries = discover(&store).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "intl-starter");
        assert_eq!(entries[0].version, "2.1.0");
        let out = fetch(&store, &entries[0]).unwrap().verify().unwrap();
        assert_eq!(out.signer(), verified.signer());
    }

    #[test]
    fn a_lying_index_is_refused_rather_than_believed() {
        let dir = tempfile::tempdir().unwrap();
        let (verified, _, sig, key) = signed("za-personal", "1.0.0", 7);
        publish(dir.path(), &verified, &sig, &key).unwrap();

        // Rewrite the publisher's index to claim a different pack entirely.
        let index_path = dir.path().join(verified.fingerprint()).join(INDEX_FILE);
        let mut index: PackIndex =
            serde_json::from_slice(&std::fs::read(&index_path).unwrap()).unwrap();
        index.entries[0].id = "za-business-vat".into();
        std::fs::write(&index_path, serde_json::to_vec_pretty(&index).unwrap()).unwrap();

        let store = LocalDir::directory(dir.path());
        let entries = discover(&store).unwrap();
        assert_eq!(entries[0].id, "za-business-vat", "the claim is carried…");
        assert!(
            matches!(
                fetch(&store, &entries[0]).unwrap().verify(),
                Err(PackError::IndexMismatch { .. })
            ),
            "…and refused the moment it meets the signed payload"
        );
    }

    #[test]
    fn tampered_bytes_never_become_a_verified_pack() {
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
        let entries = discover(&store).unwrap();
        let bundle = fetch(&store, &entries[0]).unwrap();
        assert!(matches!(
            bundle.verify(),
            Err(PackError::VerificationFailed)
        ));
    }

    /// A publisher directory is *named* for its key's fingerprint, so the two
    /// can be checked against each other for free. Built by hand rather than
    /// through `publish`, because `publish` cannot produce this state — which
    /// is the point: only a hand-edited or half-synced share can.
    #[test]
    fn a_key_filed_under_the_wrong_publisher_directory_is_caught() {
        let dir = tempfile::tempdir().unwrap();
        let (verified, doc, sig, _key) = signed("za-personal", "1.0.0", 7);
        let pub_dir = dir.path().join(verified.fingerprint());
        std::fs::create_dir_all(&pub_dir).unwrap();
        std::fs::write(pub_dir.join("za-personal-1.0.0.pack.json"), &doc).unwrap();
        std::fs::write(
            pub_dir.join("za-personal-1.0.0.pack.json.sig"),
            hex::encode(&sig),
        )
        .unwrap();
        // Somebody else's key, under this publisher's fingerprint.
        let other = SigningKey::from_bytes(&[9u8; 32]);
        std::fs::write(
            pub_dir.join(SIGNER_KEY_FILE),
            hex::encode(other.verifying_key().as_bytes()),
        )
        .unwrap();

        let store = LocalDir::directory(dir.path());
        let entries = discover(&store).unwrap();
        let err = fetch(&store, &entries[0]).unwrap_err();
        assert!(
            matches!(&err, PackError::Transport(msg) if msg.contains("does not match")),
            "{err}"
        );
    }

    /// The same directory with the *right* key still works — the check above
    /// is a mis-filing check, not an obstacle.
    #[test]
    fn a_publisher_directory_with_its_own_key_fetches_without_an_index() {
        let dir = tempfile::tempdir().unwrap();
        let (verified, doc, sig, key) = signed("za-personal", "1.0.0", 7);
        let pub_dir = dir.path().join(verified.fingerprint());
        std::fs::create_dir_all(&pub_dir).unwrap();
        std::fs::write(pub_dir.join("za-personal-1.0.0.pack.json"), &doc).unwrap();
        std::fs::write(
            pub_dir.join("za-personal-1.0.0.pack.json.sig"),
            hex::encode(&sig),
        )
        .unwrap();
        std::fs::write(pub_dir.join(SIGNER_KEY_FILE), hex::encode(&key)).unwrap();

        let store = LocalDir::directory(dir.path());
        let entries = discover(&store).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            fetch(&store, &entries[0])
                .unwrap()
                .verify()
                .unwrap()
                .signer(),
            verified.signer()
        );
    }

    #[test]
    fn includes_aggregate_publishers_by_reference() {
        let dir = tempfile::tempdir().unwrap();
        let (alice, _, a_sig, a_key) = signed("za-personal", "1.0.0", 7);
        let (bob, _, b_sig, b_key) = signed("intl-starter", "1.0.0", 9);
        publish(dir.path(), &alice, &a_sig, &a_key).unwrap();
        publish(dir.path(), &bob, &b_sig, &b_key).unwrap();

        // A root index that names the two publisher indexes and nothing else:
        // adding a publisher appends one line, rewriting no one's catalogue.
        let root = PackIndex {
            slipscan_pack_index: Some(1),
            includes: vec![
                format!("{}/{INDEX_FILE}", alice.fingerprint()),
                format!("{}/{INDEX_FILE}", bob.fingerprint()),
            ],
            signer: None,
            entries: vec![],
        };
        std::fs::write(
            dir.path().join(INDEX_FILE),
            serde_json::to_vec_pretty(&root).unwrap(),
        )
        .unwrap();

        let entries = discover(&LocalDir::directory(dir.path())).unwrap();
        let mut ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["intl-starter", "za-personal"]);
    }

    #[test]
    fn a_single_file_source_offers_exactly_that_file() {
        let dir = tempfile::tempdir().unwrap();
        let (verified, doc, sig, key) = signed("za-personal", "1.0.0", 7);
        let doc_path = dir.path().join("za-personal-1.0.0.pack.json");
        std::fs::write(&doc_path, &doc).unwrap();
        std::fs::write(
            dir.path().join("za-personal-1.0.0.pack.json.sig"),
            hex::encode(&sig),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("za-personal-1.0.0.pack.json.pub"),
            hex::encode(&key),
        )
        .unwrap();
        // A second pack in the same directory must NOT be offered by a
        // `file:` source — that is what makes it different from `folder:`.
        let (other, odoc, osig, okey) = signed("intl-starter", "1.0.0", 9);
        std::fs::write(dir.path().join("intl-starter-1.0.0.pack.json"), &odoc).unwrap();
        std::fs::write(
            dir.path().join("intl-starter-1.0.0.pack.json.sig"),
            hex::encode(&osig),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("intl-starter-1.0.0.pack.json.pub"),
            hex::encode(&okey),
        )
        .unwrap();
        let _ = other;

        let source = PackSource::parse(&format!("file:{}", doc_path.display())).unwrap();
        let store = open(&source, &TransportContext::new()).unwrap();
        let entries = discover(store.as_ref()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "za-personal");
        assert_eq!(
            fetch(store.as_ref(), &entries[0])
                .unwrap()
                .verify()
                .unwrap()
                .signer(),
            verified.signer()
        );
    }

    #[test]
    fn network_transports_refuse_rather_than_improvise_a_default() {
        // No HTTP transport supplied: there is no endpoint to fall back to,
        // because this crate contains none.
        let https = PackSource::parse("https://example.org/packs").unwrap();
        assert!(matches!(
            open(&https, &TransportContext::new()),
            Err(PackError::Transport(_))
        ));
        // No cache directory: git will not pick one on the user's behalf.
        let git = PackSource::parse("git:https://example.org/p.git").unwrap();
        assert!(matches!(
            open(&git, &TransportContext::new()),
            Err(PackError::Transport(_))
        ));
    }

    #[test]
    fn publishing_a_second_body_under_a_taken_version_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (v1, _, sig1, key1) = signed("za-personal", "1.0.0", 7);
        publish(dir.path(), &v1, &sig1, &key1).unwrap();

        // Same signer, same id and version, different bytes.
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let mut other = payload("za-personal", "1.0.0");
        other.meta.description = Some("different bytes".into());
        let pack = sign_pack(&Pack::build(&other).unwrap(), &key);
        let doc = pack.payload_bytes().to_vec();
        let sig = key.sign(&doc).to_bytes().to_vec();
        let pubk = key.verifying_key().as_bytes().to_vec();
        let verified = verify_detached(&doc, &sig, &pubk).unwrap();

        assert!(matches!(
            publish(dir.path(), &verified, &sig, &pubk),
            Err(PackError::Validation(_))
        ));
    }

    #[test]
    fn publish_refuses_a_key_that_did_not_sign_the_pack() {
        let dir = tempfile::tempdir().unwrap();
        let (verified, _, sig, _) = signed("za-personal", "1.0.0", 7);
        let wrong = SigningKey::from_bytes(&[9u8; 32])
            .verifying_key()
            .as_bytes()
            .to_vec();
        assert!(matches!(
            publish(dir.path(), &verified, &sig, &wrong),
            Err(PackError::Validation(_))
        ));
    }
}
