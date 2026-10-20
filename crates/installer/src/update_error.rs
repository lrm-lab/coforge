//! Why preparing a version failed. The variants are the failure classes the Computer's
//! `UpdateError` (packages/computer/src/updater.ts) reports, with the same code strings
//! (installer/contract/upgrade-error-codes.json), because a receipt carries the code.
//! `DownloadFailed` has no counterpart there: it keeps a transfer from the feed that failed apart
//! from content the feed served that is invalid.

use std::fmt;

#[derive(Debug, PartialEq, Eq)]
pub enum UpdateError {
    /// A pointer, manifest, or version string that does not follow the feed's rules (its content
    /// was read and judged unusable), or an object a release directory cannot supply.
    FeedInvalid(String),
    /// The feed could not deliver a pointer, a manifest, or an artifact: unreachable (connect or
    /// DNS failure, a reset connection, an idle timeout) or a non-2xx status. Nothing was judged.
    DownloadFailed(String),
    /// Bytes on the feed or on disk do not match the identity recorded for them.
    IntegrityFailed(String),
    /// The manifest has no artifact for this machine's release target.
    UnsupportedTarget(String),
    /// A local file operation failed. The product raises the raw error and reports no code.
    Local(String),
}

impl UpdateError {
    /// The product's error code, or `None` for a failure it reports without one.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::FeedInvalid(_) => Some("UPDATE_FEED_INVALID"),
            Self::DownloadFailed(_) => Some("UPDATE_DOWNLOAD_FAILED"),
            Self::IntegrityFailed(_) => Some("UPDATE_INTEGRITY_FAILED"),
            Self::UnsupportedTarget(_) => Some("UPDATE_UNSUPPORTED_TARGET"),
            Self::Local(_) => None,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::FeedInvalid(message)
            | Self::DownloadFailed(message)
            | Self::IntegrityFailed(message)
            | Self::UnsupportedTarget(message)
            | Self::Local(message) => message,
        }
    }
}

impl fmt::Display for UpdateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for UpdateError {}

#[cfg(test)]
mod tests;
