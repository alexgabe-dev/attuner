//! Experimental Windows qualification boundary. No production engine dependency.
//!
//! All ambient access is restricted to minting an owned temporary synthetic root.
//! Windows filesystem apply remains disabled in `attuner-sync-core`.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("unsupported synthetic component")]
    Component,
    #[error("unsafe filesystem entry: {0}")]
    Unsafe(&'static str),
    #[error("concurrent identity or name change")]
    Changed,
    #[error("destination already exists")]
    Exists,
    #[error("filesystem sharing/locking interference (Windows error {0})")]
    Sharing(u32),
    #[error("access denied or read-only entry (Windows error {0})")]
    Access(u32),
    #[error("insufficient disk space")]
    DiskFull,
    #[error("Windows filesystem I/O: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Restricted fixture-only namespace. Full Unicode inventory is an integration gate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Component(String);

impl Component {
    pub fn new(value: &str) -> Result<Self> {
        let stem = value.split('.').next().unwrap_or_default();
        let upper = stem.to_ascii_uppercase();
        if value.is_empty()
            || value.len() > 120
            || value.starts_with('.')
            || value.ends_with('.')
            || !value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
            || matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
            || ((upper.starts_with("COM") || upper.starts_with("LPT"))
                && upper.len() == 4
                && matches!(upper.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(Error::Component);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(windows)]
mod native;
#[cfg(windows)]
pub use native::{Directory, Identity, PinnedFile, SyntheticWorkspace};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_names_cannot_escape_or_alias_devices() {
        for bad in [
            "", ".", "..", "a/b", "a\\b", "C:", "x:stream", "a ", "a.", "CON", "nul.txt",
            "com1.bin", "LPT9", "é", "a\0b", ".hidden",
        ] {
            assert!(Component::new(bad).is_err(), "{bad:?}");
        }
        for good in [
            "Configuration",
            "Addon_1.lua",
            "backup-001.bin",
            "com10.txt",
        ] {
            assert_eq!(Component::new(good).unwrap().as_str(), good);
        }
    }
}
