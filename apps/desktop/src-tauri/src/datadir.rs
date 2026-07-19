//! Desktop-side complement to `slipscan_core::datadir` (the shared resolver
//! and verified move — see the "Data location & backup" contract in
//! docs/ARCHITECTURE.md). Everything durable is resolved and moved through
//! core; this module only adds a display nicety: a best-effort hint that the
//! folder sits inside a tree a known cloud client syncs, so Settings can show
//! "inside iCloud Drive" next to the backup guidance.

use std::path::Path;

/// Best-effort hint that the folder sits inside a tree a known cloud client
/// syncs — path-component matching only, never a network call. `None` means
/// "not trivially detectable", not "not synced".
pub fn cloud_sync_hint(path: &Path) -> Option<&'static str> {
    for comp in path.components() {
        let name = comp.as_os_str().to_string_lossy();
        // macOS keeps iCloud Drive under ~/Library/Mobile Documents/com~apple~CloudDocs.
        if name == "Mobile Documents" || name.starts_with("com~apple~CloudDocs") {
            return Some("iCloud Drive");
        }
        // Vendor folders often carry suffixes: "Dropbox (Personal)",
        // "OneDrive - Company" — match on the prefix.
        if name.starts_with("Dropbox") {
            return Some("Dropbox");
        }
        if name.starts_with("Google Drive") || name.starts_with("GoogleDrive") {
            return Some("Google Drive");
        }
        if name.starts_with("OneDrive") {
            return Some("OneDrive");
        }
        if name.starts_with("Nextcloud") {
            return Some("Nextcloud");
        }
        if name.starts_with("Syncthing") {
            return Some("Syncthing");
        }
        if name.starts_with("Proton Drive") {
            return Some("Proton Drive");
        }
        if name.starts_with("pCloud") {
            return Some("pCloud");
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_known_cloud_trees() {
        let icloud = Path::new("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/SlipScan");
        assert_eq!(cloud_sync_hint(icloud), Some("iCloud Drive"));
        assert_eq!(
            cloud_sync_hint(Path::new("/Users/x/Dropbox (Personal)/SlipScan")),
            Some("Dropbox")
        );
        assert_eq!(
            cloud_sync_hint(Path::new("/home/x/Nextcloud/finance")),
            Some("Nextcloud")
        );
        // Suffixed vendor folders match on the prefix.
        assert_eq!(
            cloud_sync_hint(Path::new("/Users/x/OneDrive - Contoso/SlipScan")),
            Some("OneDrive")
        );
    }

    #[test]
    fn stays_quiet_for_ordinary_folders() {
        assert_eq!(
            cloud_sync_hint(Path::new("/Users/x/Documents/SlipScan")),
            None
        );
        assert_eq!(
            cloud_sync_hint(Path::new(
                "/Users/x/Library/Application Support/org.vulos.slipscan"
            )),
            None
        );
    }
}
