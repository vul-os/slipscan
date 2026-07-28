//! The `https:` transport — a base URL that serves the same layout.
//!
//! This crate ships **no HTTP client and no URL**. The GET is an injected
//! [`PackHttp`], exactly as `slipscan-core` injects `FxTransport` rather than
//! linking a client itself, and for the same two reasons:
//!
//! 1. the pack format, its verification and its trust model stay testable
//!    without a socket in sight; and
//! 2. **there is no default endpoint that could exist.** A surface that never
//!    supplies a [`PackHttp`] cannot make an outbound pack request at all —
//!    the failure is a refusal from [`super::open`], not a silent fetch of
//!    somebody's idea of an official registry. "Zero network calls until the
//!    user names a source" is therefore a property of the wiring, not a
//!    promise in a comment.
//!
//! An HTTPS source cannot be enumerated (there is no directory listing over
//! plain HTTP semantics), so it needs an `index.json` at its base. That index
//! may be nothing but `includes`, pointing at one append-only catalogue per
//! publisher — the shared-folder property, preserved over the wire.

use std::sync::Arc;

use crate::error::{PackError, PackResult};

use super::{safe_relative, BlobStore, INDEX_FILE, MAX_DOCUMENT_BYTES};

/// One HTTP response: status plus body. Mirrors core's `FxHttpResponse`, so a
/// surface that already has an HTTP client has nothing new to learn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpBlob {
    pub status: u16,
    pub body: Vec<u8>,
}

/// The single verb the HTTPS transport needs.
///
/// Implementations are only ever handed URLs derived from a base the **user
/// configured**; this crate never constructs one from anything else. A
/// blocking signature is deliberate: pack fetching is a rare, explicitly
/// requested action, and the rest of this crate (rusqlite, verification,
/// installation) is synchronous — one blocking call keeps the whole path on
/// one thread with no runtime requirement, and leaves any async plumbing to
/// the implementor, who already has a runtime.
pub trait PackHttp: Send + Sync {
    /// GET `url`, following redirects as the implementation sees fit, and
    /// return the status and body. Transport-level failures are `Err`; an
    /// HTTP error status is `Ok` with that status, so the layout above can
    /// tell "absent" (404) from "unreachable".
    fn get(&self, url: &str) -> Result<HttpBlob, String>;
}

/// An HTTPS base URL serving the pack layout.
pub struct HttpsDir {
    base: String,
    http: Arc<dyn PackHttp>,
}

impl std::fmt::Debug for HttpsDir {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpsDir")
            .field("base", &self.base)
            .finish()
    }
}

impl HttpsDir {
    pub fn new(base: impl Into<String>, http: Arc<dyn PackHttp>) -> Self {
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            http,
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }
}

impl BlobStore for HttpsDir {
    fn read(&self, name: &str) -> PackResult<Vec<u8>> {
        let rel = safe_relative(name)?;
        let url = format!("{}/{rel}", self.base);
        let blob = self.http.get(&url).map_err(PackError::Transport)?;
        match blob.status {
            200..=299 => {
                if blob.body.len() > MAX_DOCUMENT_BYTES {
                    return Err(PackError::Validation(format!(
                        "{url} returned {} bytes; the limit is {MAX_DOCUMENT_BYTES}",
                        blob.body.len()
                    )));
                }
                Ok(blob.body)
            }
            // Absence is absence, so the layout's optional blobs (a `.pub`
            // sidecar, a per-publisher index) behave the same over HTTPS as
            // they do on a filesystem.
            404 | 410 => Err(PackError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("{url} is not there ({})", blob.status),
            ))),
            status => Err(PackError::Transport(format!("{url} answered {status}"))),
        }
    }

    fn list(&self) -> PackResult<Vec<String>> {
        // Deliberately not "empty": an unlistable source with no index is a
        // refusal that names the missing file, never a source that silently
        // offers nothing.
        Err(PackError::SourceUnlistable(format!(
            "{} (an {INDEX_FILE} is required)",
            self.base
        )))
    }

    fn describe(&self) -> String {
        self.base.clone()
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    /// A scripted [`PackHttp`] that records every URL it was asked for — so a
    /// test can assert not only what was fetched but that nothing else was.
    #[derive(Default)]
    pub struct ScriptedHttp {
        routes: Mutex<BTreeMap<String, HttpBlob>>,
        pub seen: Mutex<Vec<String>>,
    }

    impl ScriptedHttp {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn route(self, url: &str, status: u16, body: impl Into<Vec<u8>>) -> Self {
            self.routes.lock().unwrap().insert(
                url.to_string(),
                HttpBlob {
                    status,
                    body: body.into(),
                },
            );
            self
        }

        pub fn urls(&self) -> Vec<String> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl PackHttp for ScriptedHttp {
        fn get(&self, url: &str) -> Result<HttpBlob, String> {
            self.seen.lock().unwrap().push(url.to_string());
            match self.routes.lock().unwrap().get(url) {
                Some(blob) => Ok(blob.clone()),
                None => Ok(HttpBlob {
                    status: 404,
                    body: Vec::new(),
                }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::ScriptedHttp;
    use super::*;
    use crate::hex;
    use crate::transport::{discover, fetch, tests::signed, IndexEntry, PackIndex};

    #[test]
    fn an_https_source_without_an_index_refuses_and_names_the_missing_file() {
        let http = Arc::new(ScriptedHttp::new());
        let store = HttpsDir::new(
            "https://packs.example/pub",
            Arc::clone(&http) as Arc<dyn PackHttp>,
        );
        let err = discover(&store).unwrap_err();
        assert!(matches!(&err, PackError::SourceUnlistable(_)), "{err}");
        assert!(
            err.to_string().contains(INDEX_FILE),
            "the refusal names the file that is missing: {err}"
        );
        assert_eq!(
            http.urls(),
            vec!["https://packs.example/pub/index.json"],
            "exactly one request, to the user's own base URL"
        );
    }

    #[test]
    fn https_fetch_verifies_the_same_bytes_as_every_other_transport() {
        let (verified, doc, sig, key) = signed("za-personal", "1.4.0", 7);
        let fp = verified.fingerprint();
        let index = PackIndex {
            slipscan_pack_index: Some(1),
            includes: vec![format!("{fp}/index.json")],
            signer: None,
            entries: vec![],
        };
        let publisher = PackIndex {
            slipscan_pack_index: Some(1),
            includes: vec![],
            signer: Some(hex::encode(&key)),
            entries: vec![IndexEntry {
                id: "za-personal".into(),
                version: "1.4.0".into(),
                name: Some("ZA personal".into()),
                kind: Some("taxonomy".into()),
                region: Some("ZA".into()),
                document: "za-personal-1.4.0.pack.json".into(),
                signature: Some("za-personal-1.4.0.pack.json.sig".into()),
                public_key: None,
            }],
        };
        let base = "https://packs.example/pub";
        let http = Arc::new(
            ScriptedHttp::new()
                .route(
                    &format!("{base}/index.json"),
                    200,
                    serde_json::to_vec(&index).unwrap(),
                )
                .route(
                    &format!("{base}/{fp}/index.json"),
                    200,
                    serde_json::to_vec(&publisher).unwrap(),
                )
                .route(
                    &format!("{base}/{fp}/za-personal-1.4.0.pack.json"),
                    200,
                    doc.clone(),
                )
                .route(
                    &format!("{base}/{fp}/za-personal-1.4.0.pack.json.sig"),
                    200,
                    hex::encode(&sig),
                ),
        );
        let store = HttpsDir::new(base, Arc::clone(&http) as Arc<dyn PackHttp>);

        let entries = discover(&store).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "za-personal");
        let out = fetch(&store, &entries[0]).unwrap().verify().unwrap();
        assert_eq!(out.signer(), verified.signer());
        assert_eq!(out.pack().payload_bytes(), doc);

        // Every request went to the configured base and nowhere else.
        assert!(
            http.urls().iter().all(|u| u.starts_with(base)),
            "{:?}",
            http.urls()
        );
    }

    #[test]
    fn a_server_error_is_not_mistaken_for_absence() {
        let base = "https://packs.example/pub";
        let http = Arc::new(ScriptedHttp::new().route(&format!("{base}/index.json"), 500, "boom"));
        let store = HttpsDir::new(base, http as Arc<dyn PackHttp>);
        assert!(matches!(discover(&store), Err(PackError::Transport(_)),));
    }

    #[test]
    fn an_oversized_body_is_refused_before_it_is_parsed() {
        let base = "https://packs.example/pub";
        let http = Arc::new(ScriptedHttp::new().route(
            &format!("{base}/index.json"),
            200,
            vec![b'x'; MAX_DOCUMENT_BYTES + 1],
        ));
        let store = HttpsDir::new(base, http as Arc<dyn PackHttp>);
        assert!(matches!(discover(&store), Err(PackError::Validation(_))));
    }
}
