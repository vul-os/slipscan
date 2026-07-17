//! [`SecretString`]: the only container secret material travels in.

use zeroize::{Zeroize, ZeroizeOnDrop};

/// A secret value (password, token, API key) with enforced memory hygiene:
///
/// * zeroized on drop (heap buffer wiped before deallocation)
/// * `Debug`/`Display` print `[REDACTED]` — the material can never reach a
///   log line or error message through formatting
/// * deliberately **no** serde impls, so it can never ride an IPC response
///   or land in a JSON blob by accident
///
/// Read the material only via [`SecretString::expose_secret`], inside the
/// smallest possible scope (e.g. a [`super::Vault::use_with`] closure).
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Borrow the secret material. Keep the borrow as short-lived as
    /// possible and never store, format, or log the result.
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretString([REDACTED])")
    }
}

impl std::fmt::Display for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_and_display_are_redacted() {
        let s = SecretString::new("hunter2-material");
        assert_eq!(format!("{s:?}"), "SecretString([REDACTED])");
        assert_eq!(format!("{s}"), "[REDACTED]");
        assert!(!format!("{s:?}{s}").contains("hunter2"));
        // The material is still reachable on purpose — but only via expose.
        assert_eq!(s.expose_secret(), "hunter2-material");
    }
}
