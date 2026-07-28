//! The `git:` transport — a remote repository, cloned or pulled into a local
//! cache and then read exactly like a folder.
//!
//! **This shells out to the user's own `git`.** That is deliberate rather than
//! lazy: it means SlipScan inherits, and never re-implements, the credential
//! helpers, SSH agent, proxy settings, host-key policy and corporate CA store
//! the user already has working — and it adds no dependency to a workspace
//! that must build from a bare clone with `--offline --locked`.
//!
//! What it deliberately does *not* do: no git config is written, no
//! credentials are prompted for (`GIT_TERMINAL_PROMPT=0`, so a private repo
//! fails fast rather than hanging on a hidden password prompt), no hooks run
//! (`core.hooksPath=/dev/null`), and nothing is ever pushed. A pack repo is
//! read-only to this code path.
//!
//! Trust is unchanged and unaffected: git is a *transport*. A repository
//! cannot vouch for a pack, and nothing that arrives through one skips the
//! signature check, the trust-on-first-use prompt, or the signer pin.

use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};

use crate::error::{PackError, PackResult};
use crate::hex;

use super::LocalDir;

/// Directory name, under the caller-supplied cache root, that holds git
/// checkouts. One level so the whole cache is one obvious thing to delete.
pub const GIT_CACHE_DIR: &str = "pack-git";

/// A synced local checkout of a remote pack repository.
#[derive(Debug, Clone)]
pub struct GitCheckout {
    dir: PathBuf,
    remote: String,
}

impl GitCheckout {
    /// Clone or update `remote` into a deterministic directory under
    /// `cache_root`, then hand back the checkout.
    ///
    /// The cache path is derived from the remote URL's hash, so two sources
    /// never share a working tree and a URL change is a different checkout
    /// rather than a confusing in-place mutation.
    pub fn sync(remote: &str, git_ref: Option<&str>, cache_root: &Path) -> PackResult<Self> {
        let dir = cache_root.join(GIT_CACHE_DIR).join(cache_key(remote));
        std::fs::create_dir_all(dir.parent().unwrap_or(cache_root))?;

        if dir.join(".git").is_dir() {
            fetch_into(&dir, git_ref)?;
        } else {
            // A leftover non-repo directory (an interrupted clone) must not
            // be read as if it were a checkout.
            if dir.exists() {
                std::fs::remove_dir_all(&dir)?;
            }
            clone_into(remote, git_ref, &dir)?;
        }
        Ok(Self {
            dir,
            remote: remote.to_string(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.dir
    }

    pub fn remote(&self) -> &str {
        &self.remote
    }

    /// Read the checkout as an ordinary folder source. Git is transport only:
    /// past this point nothing knows or cares where the bytes came from.
    pub fn into_store(self) -> LocalDir {
        LocalDir::directory(self.dir)
    }
}

fn cache_key(remote: &str) -> String {
    // Prefix with a readable slug so a human can tell the directories apart,
    // and disambiguate with the hash so two remotes never collide.
    let slug: String = remote
        .chars()
        .rev()
        .take_while(|c| *c != '/')
        .collect::<String>()
        .chars()
        .rev()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    let digest = hex::encode(&Sha256::digest(remote.as_bytes())[..8]);
    if slug.is_empty() {
        digest
    } else {
        format!("{slug}-{digest}")
    }
}

/// `git` with every interactive and hook-running behaviour disabled. A pack
/// fetch must never hang on a prompt or run code out of a repository.
fn git(dir: Option<&Path>) -> Command {
    let mut cmd = Command::new("git");
    if let Some(dir) = dir {
        cmd.arg("-C").arg(dir);
    }
    cmd.arg("-c")
        .arg("core.hooksPath=/dev/null")
        .arg("-c")
        .arg("advice.detachedHead=false")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("GCM_INTERACTIVE", "never");
    cmd
}

fn run(mut cmd: Command, what: &str) -> PackResult<String> {
    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            PackError::Transport("git is not installed or not on PATH; git: sources need it".into())
        } else {
            PackError::Transport(format!("{what}: {e}"))
        }
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(PackError::Transport(format!(
            "{what} failed: {}",
            stderr.trim().lines().last().unwrap_or("no output")
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn clone_into(remote: &str, git_ref: Option<&str>, dir: &Path) -> PackResult<()> {
    let mut cmd = git(None);
    cmd.arg("clone").arg("--depth").arg("1");
    if let Some(r) = git_ref {
        cmd.arg("--branch").arg(r);
    }
    cmd.arg("--").arg(remote).arg(dir);
    run(cmd, "git clone")?;
    Ok(())
}

fn fetch_into(dir: &Path, git_ref: Option<&str>) -> PackResult<()> {
    let mut cmd = git(Some(dir));
    cmd.arg("fetch").arg("--depth").arg("1").arg("origin");
    if let Some(r) = git_ref {
        cmd.arg(r);
    }
    run(cmd, "git fetch")?;

    // Hard reset onto what was just fetched. The working tree is a cache we
    // own; it holds nothing of the user's, so there is nothing to preserve
    // and a merge would only invent conflicts.
    let mut cmd = git(Some(dir));
    cmd.arg("reset").arg("--hard").arg("FETCH_HEAD");
    run(cmd, "git reset")?;

    // Remove anything the remote dropped, so a withdrawn pack stops being
    // offered instead of lingering in the cache forever.
    let mut cmd = git(Some(dir));
    cmd.arg("clean").arg("-fdx");
    run(cmd, "git clean")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{discover, fetch, BlobStore};

    fn have_git() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn cache_keys_are_stable_readable_and_collision_free() {
        let a = cache_key("https://example.org/team/packs.git");
        let b = cache_key("https://other.example/team/packs.git");
        assert_eq!(a, cache_key("https://example.org/team/packs.git"));
        assert_ne!(a, b, "same repo name, different host: different checkout");
        assert!(a.starts_with("packsgit-"), "readable slug: {a}");
        assert!(!a.contains('/') && !a.contains(".."), "path-safe: {a}");
    }

    /// A real clone from a real local remote, then discovery + verification
    /// straight out of the checkout. Skips **loudly** when git is missing,
    /// with the coverage count the guard contract requires.
    #[test]
    fn clone_then_pull_serves_packs_out_of_the_checkout() {
        if !have_git() {
            eprintln!(
                "SKIPPED clone_then_pull_serves_packs_out_of_the_checkout: \
                 git is not on PATH; 0 of 2 git transport rounds covered"
            );
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        run(
            {
                let mut c = git(Some(&origin));
                c.arg("init").arg("--quiet").arg("--initial-branch=main");
                c
            },
            "git init",
        )
        .unwrap();
        for (k, v) in [("user.email", "t@example.org"), ("user.name", "t")] {
            run(
                {
                    let mut c = git(Some(&origin));
                    c.arg("config").arg(k).arg(v);
                    c
                },
                "git config",
            )
            .unwrap();
        }

        // Publish one pack into the origin working tree and commit it.
        let (verified, _, sig, key) = crate::transport::tests::signed("za-personal", "1.0.0", 7);
        crate::transport::publish(&origin, &verified, &sig, &key).unwrap();
        let commit = |msg: &str| {
            run(
                {
                    let mut c = git(Some(&origin));
                    c.arg("add").arg("-A");
                    c
                },
                "git add",
            )
            .unwrap();
            run(
                {
                    let mut c = git(Some(&origin));
                    c.arg("commit").arg("--quiet").arg("-m").arg(msg);
                    c
                },
                "git commit",
            )
            .unwrap();
        };
        commit("first pack");

        let cache = tmp.path().join("cache");
        let checkout = GitCheckout::sync(origin.to_str().unwrap(), Some("main"), &cache).unwrap();
        let store = checkout.clone().into_store();
        let entries = discover(&store).unwrap();
        assert_eq!(entries.len(), 1, "cloned catalogue: {entries:?}");
        let out = fetch(&store, &entries[0]).unwrap().verify().unwrap();
        assert_eq!(out.signer(), verified.signer());
        assert!(store.describe().contains("pack-git"));

        // A second pack lands upstream; the same source picks it up on the
        // next sync, through the fetch/reset path rather than a fresh clone.
        let (v2, _, sig2, key2) = crate::transport::tests::signed("intl-starter", "1.0.0", 9);
        crate::transport::publish(&origin, &v2, &sig2, &key2).unwrap();
        commit("second pack");

        let again = GitCheckout::sync(origin.to_str().unwrap(), Some("main"), &cache).unwrap();
        assert_eq!(again.path(), checkout.path(), "same cache directory reused");
        let entries = discover(&again.into_store()).unwrap();
        assert_eq!(
            entries.len(),
            2,
            "the pull is what added the second: {entries:?}"
        );
    }

    #[test]
    fn a_missing_remote_fails_loudly_and_never_hangs_on_a_prompt() {
        if !have_git() {
            eprintln!(
                "SKIPPED a_missing_remote_fails_loudly_and_never_hangs_on_a_prompt: \
                 git is not on PATH; 0 of 1 git failure paths covered"
            );
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope");
        let err = GitCheckout::sync(missing.to_str().unwrap(), None, &tmp.path().join("cache"))
            .unwrap_err();
        assert!(matches!(err, PackError::Transport(_)), "{err}");
    }
}
