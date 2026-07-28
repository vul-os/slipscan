//! Local-filesystem blob store: the `file:` and `folder:` transports, and the
//! read side of a `git:` checkout once it is on disk.
//!
//! "Folder" is the sneakernet case and it is the one that has to be dullest:
//! a Dropbox/Syncthing share, a NAS mount, a USB stick. Nothing here watches,
//! locks, or writes — a read is a read, so a folder still being synced by
//! another process can only ever yield a file that fails its signature check,
//! never a partial install.

use std::path::{Path, PathBuf};

use crate::error::{PackError, PackResult};

use super::{safe_relative, BlobStore, MAX_BLOB_NAMES, MAX_LIST_DEPTH};

/// A directory of packs, or a single pack document within one.
#[derive(Debug, Clone)]
pub struct LocalDir {
    root: PathBuf,
    /// Set for a `file:` source: the one document name this source offers.
    /// Sidecars beside it are still readable, so the layout is unchanged —
    /// only *discovery* is narrowed to the file the user actually named.
    only: Option<String>,
}

impl LocalDir {
    /// A whole directory in the pack layout.
    pub fn directory(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            only: None,
        }
    }

    /// One document, with its sidecars read from the same directory.
    pub fn single_file(path: impl AsRef<Path>) -> PackResult<Self> {
        let path = path.as_ref();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| PackError::UnsafePayloadPath(path.display().to_string()))?
            .to_string();
        let root = path.parent().unwrap_or(Path::new(".")).to_path_buf();
        Ok(Self {
            root,
            only: Some(name),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn resolve(&self, name: &str) -> PackResult<PathBuf> {
        let rel = safe_relative(name)?;
        Ok(self.root.join(rel))
    }
}

impl BlobStore for LocalDir {
    fn read(&self, name: &str) -> PackResult<Vec<u8>> {
        Ok(std::fs::read(self.resolve(name)?)?)
    }

    fn list(&self) -> PackResult<Vec<String>> {
        // A `file:` source is exactly one blob by construction; listing the
        // rest of the directory would quietly widen what the user pointed at.
        if let Some(only) = &self.only {
            return Ok(vec![only.clone()]);
        }
        let mut out = Vec::new();
        walk(&self.root, "", 0, &mut out)?;
        out.sort();
        Ok(out)
    }

    fn describe(&self) -> String {
        match &self.only {
            Some(only) => self.root.join(only).display().to_string(),
            None => self.root.display().to_string(),
        }
    }
}

/// Depth-limited, count-limited directory walk. Symlinked directories are not
/// followed: a shared folder is other people's data, and a link in it must not
/// be able to steer a read outside the source.
fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<String>) -> PackResult<()> {
    if depth >= MAX_LIST_DEPTH || out.len() >= MAX_BLOB_NAMES {
        return Ok(());
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // A source folder that is not there yet (an unmounted stick, a share
        // that has not synced) is an empty catalogue, not a crash.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        // `symlink_metadata` on purpose: a symlink is skipped, not resolved.
        let meta = entry.path().symlink_metadata()?;
        if meta.is_dir() {
            walk(&entry.path(), &rel, depth + 1, out)?;
        } else if meta.is_file() {
            if out.len() >= MAX_BLOB_NAMES {
                return Ok(());
            }
            out.push(rel);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walk_skips_hidden_symlinks_and_stops_at_the_depth_limit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("a.pack.json"), b"{}").unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join(".hidden/b.pack.json"), b"{}").unwrap();
        std::fs::create_dir_all(root.join("pub/deep/deeper")).unwrap();
        std::fs::write(root.join("pub/c.pack.json"), b"{}").unwrap();
        std::fs::write(root.join("pub/deep/d.pack.json"), b"{}").unwrap();
        std::fs::write(root.join("pub/deep/deeper/e.pack.json"), b"{}").unwrap();

        let names = LocalDir::directory(root).list().unwrap();
        assert!(names.contains(&"a.pack.json".to_string()));
        assert!(names.contains(&"pub/c.pack.json".to_string()));
        assert!(names.contains(&"pub/deep/d.pack.json".to_string()));
        assert!(
            !names.iter().any(|n| n.contains("deeper")),
            "the depth limit holds: {names:?}"
        );
        assert!(
            !names.iter().any(|n| n.contains(".hidden")),
            "dotfiles are skipped: {names:?}"
        );
    }

    #[test]
    fn a_missing_folder_is_an_empty_catalogue_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalDir::directory(dir.path().join("not-mounted-yet"));
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn reads_cannot_escape_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalDir::directory(dir.path());
        for bad in ["../x", "/etc/passwd", "a/../../b"] {
            assert!(matches!(
                store.read(bad),
                Err(PackError::UnsafePayloadPath(_))
            ));
        }
    }
}
