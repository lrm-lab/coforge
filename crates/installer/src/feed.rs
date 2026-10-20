//! The release feed client: the `latest` pointer, `<version>/manifest.json`, and the objects a
//! manifest names (`<version>/<target>/coforge-computer.gz`, `<version>/photon_rs_bg.wasm`).
//!
//! This is what `scripts/release/install.sh` does for the Computer's updater (`resolveVersion`,
//! then the manifest and artifact phases) together with `#verifyArtifact` and
//! `#verifyPhotonWasm` (packages/computer/src/updater.ts). Nothing follows a redirect, every
//! object has a size ceiling, and a downloaded object must match its manifest entry exactly, in
//! size and checksum. Downloads are written as ordinary files and never touch `versions/`; the
//! version store places them.

use std::fs;
use std::path::Path;

use crate::contract::{ArtifactIdentity, ComputerArtifact, NamedArtifact, ReleaseManifest};
use crate::fetch::{self, FetchError, FetchErrorCode, FetchReceipt, FetchRequest};
use crate::manifest::parse_release_manifest;
use crate::prepare::ReleaseSource;
use crate::update_error::UpdateError;
use crate::version::is_valid_release_version;

/// `latest` and every other small text object have a fixed ceiling rather than none.
const MAX_POINTER_BYTES: u64 = 4096;
pub(crate) const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// A fixed ceiling for the compressed executable and for the executable it expands to; the exact
/// sizes come from the manifest.
pub(crate) const MAX_BINARY_BYTES: u64 = 512 * 1024 * 1024;
/// Pi's image library is about 1.8 MB.
pub(crate) const MAX_PHOTON_WASM_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) const COMPUTER_BINARY: &str = "coforge-computer";
pub(crate) const COMPUTER_GZIP: &str = "coforge-computer.gz";
pub(crate) const PHOTON_WASM: &str = "photon_rs_bg.wasm";

pub struct Feed {
    base: String,
    agent: ureq::Agent,
}

impl Feed {
    /// A client for the feed at `base_url` (a trailing `/` is optional), using `agent` for every
    /// request: [`fetch::agent`] with [`fetch::Transport::Https`] in production.
    pub fn new(base_url: &str, agent: ureq::Agent) -> Self {
        Self {
            base: base_url.trim_end_matches('/').to_owned(),
            agent,
        }
    }

    /// `latest` (or an empty selection) resolves through the feed's pointer file. Anything else
    /// must already be a valid version string.
    pub fn resolve_version(&self, selection: &str) -> Result<String, UpdateError> {
        if selection != "latest" && !selection.is_empty() {
            return if is_valid_release_version(selection) {
                Ok(selection.to_owned())
            } else {
                Err(UpdateError::FeedInvalid(
                    "version must be latest or a valid version string".into(),
                ))
            };
        }
        let bytes = fetch::fetch_bytes(&self.agent, &self.url("latest"), MAX_POINTER_BYTES)
            .map_err(feed_error)?;
        // Surrounding whitespace is a formatting accident; anything else must be a version.
        let pointer = String::from_utf8(bytes)
            .ok()
            .map(|text| text.trim().to_owned())
            .filter(|text| is_valid_release_version(text))
            .ok_or_else(|| {
                UpdateError::FeedInvalid("latest pointer does not contain a valid version".into())
            })?;
        if pointer == "latest" {
            return Err(UpdateError::FeedInvalid(
                "latest pointer must name a concrete version".into(),
            ));
        }
        Ok(pointer)
    }

    /// `<version>/manifest.json`, validated as the release manifest of exactly that version.
    pub fn manifest(&self, version: &str) -> Result<ReleaseManifest, UpdateError> {
        let url = self.version_url(version, "manifest.json")?;
        let bytes =
            fetch::fetch_bytes(&self.agent, &url, MAX_MANIFEST_BYTES).map_err(feed_error)?;
        parse_release_manifest(&bytes, version)
    }

    /// Downloads `<version>/<target>/coforge-computer.gz`, expands it to `out`, and checks it
    /// against `artifact`: the compressed object's exact size and checksum, the expanded file's
    /// checksum, and an expansion no larger than the recorded size. Nothing is left at `out` on
    /// failure. Returns the identity of the expanded file.
    pub fn download_computer(
        &self,
        version: &str,
        target: &str,
        artifact: &ComputerArtifact,
        out: &Path,
    ) -> Result<ArtifactIdentity, UpdateError> {
        let url = self.version_url(version, &format!("{target}/{COMPUTER_GZIP}"))?;
        let request = computer_request(artifact, url, out)?;
        let receipt = fetch::fetch(&self.agent, &request)
            .map_err(|error| transfer_error(error, COMPUTER_GZIP))?;
        computer_result(receipt, artifact, out)
    }

    /// Downloads `<version>/photon_rs_bg.wasm` to `out` and checks its exact size and checksum.
    pub fn download_photon_wasm(
        &self,
        version: &str,
        artifact: &NamedArtifact,
        out: &Path,
    ) -> Result<ArtifactIdentity, UpdateError> {
        let request = photon_request(artifact, self.version_url(version, PHOTON_WASM)?, out)?;
        let receipt = fetch::fetch(&self.agent, &request)
            .map_err(|error| transfer_error(error, PHOTON_WASM))?;
        photon_result(receipt, artifact, out)
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{path}", self.base)
    }

    /// `<base>/<version>/<path>`, for a version that is one safe URL segment.
    fn version_url(&self, version: &str, path: &str) -> Result<String, UpdateError> {
        if !is_valid_release_version(version) {
            return Err(UpdateError::FeedInvalid(format!(
                "version is invalid: {version:?}"
            )));
        }
        Ok(self.url(&format!("{version}/{path}")))
    }
}

impl ReleaseSource for Feed {
    fn resolve_version(&self, selection: &str) -> Result<String, UpdateError> {
        Feed::resolve_version(self, selection)
    }

    fn manifest(&self, version: &str) -> Result<ReleaseManifest, UpdateError> {
        Feed::manifest(self, version)
    }

    fn download_computer(
        &self,
        version: &str,
        target: &str,
        artifact: &ComputerArtifact,
        out: &Path,
    ) -> Result<ArtifactIdentity, UpdateError> {
        Feed::download_computer(self, version, target, artifact, out)
    }

    fn download_photon_wasm(
        &self,
        version: &str,
        artifact: &NamedArtifact,
        out: &Path,
    ) -> Result<ArtifactIdentity, UpdateError> {
        Feed::download_photon_wasm(self, version, artifact, out)
    }
}

/// The transfer of `<target>/coforge-computer.gz` to `out` for `artifact`, refused before any byte
/// is read when the manifest records a size above the ceiling. Shared by every release source.
pub(crate) fn computer_request(
    artifact: &ComputerArtifact,
    url: String,
    out: &Path,
) -> Result<FetchRequest, UpdateError> {
    let compressed = &artifact.gzip.identity;
    // install.sh bounds the download and the expansion by the same ceiling, whatever the
    // manifest says; a larger record is refused without asking the feed for anything.
    for (object, size) in [
        (COMPUTER_GZIP, compressed.size),
        (COMPUTER_BINARY, artifact.identity.size),
    ] {
        if size > MAX_BINARY_BYTES {
            return Err(UpdateError::FeedInvalid(format!(
                "{object} is recorded as {size} bytes, above the {MAX_BINARY_BYTES}-byte limit"
            )));
        }
    }
    Ok(FetchRequest {
        url,
        sha256: compressed.checksum.clone(),
        expanded_sha256: Some(artifact.identity.checksum.clone()),
        out: out.to_owned(),
        max_wire_bytes: compressed.size,
        max_written_bytes: artifact.identity.size,
    })
}

/// Checks a finished computer transfer against `artifact` and returns the expanded identity.
pub(crate) fn computer_result(
    receipt: FetchReceipt,
    artifact: &ComputerArtifact,
    out: &Path,
) -> Result<ArtifactIdentity, UpdateError> {
    let compressed = &artifact.gzip.identity;
    let identity = ArtifactIdentity {
        size: receipt.written_bytes,
        checksum: receipt.written_sha256,
    };
    if receipt.wire_bytes != compressed.size || identity.size != artifact.identity.size {
        let _ = fs::remove_file(out);
        return Err(UpdateError::IntegrityFailed(format!(
            "{COMPUTER_GZIP} is {} bytes and expands to {}, not the recorded {} and {}",
            receipt.wire_bytes, identity.size, compressed.size, artifact.identity.size
        )));
    }
    Ok(identity)
}

/// The transfer of the image library to `out`, refused before any byte is read when the manifest
/// records a size above the ceiling. Shared by every release source.
pub(crate) fn photon_request(
    artifact: &NamedArtifact,
    url: String,
    out: &Path,
) -> Result<FetchRequest, UpdateError> {
    let recorded = &artifact.identity;
    if recorded.size > MAX_PHOTON_WASM_BYTES {
        return Err(UpdateError::FeedInvalid(format!(
            "{PHOTON_WASM} is recorded as {} bytes, above the {MAX_PHOTON_WASM_BYTES}-byte limit",
            recorded.size
        )));
    }
    Ok(FetchRequest {
        url,
        sha256: recorded.checksum.clone(),
        expanded_sha256: None,
        out: out.to_owned(),
        max_wire_bytes: recorded.size,
        max_written_bytes: recorded.size,
    })
}

/// Checks a finished image-library transfer against the recorded identity.
pub(crate) fn photon_result(
    receipt: FetchReceipt,
    artifact: &NamedArtifact,
    out: &Path,
) -> Result<ArtifactIdentity, UpdateError> {
    let recorded = &artifact.identity;
    if receipt.written_bytes != recorded.size {
        let _ = fs::remove_file(out);
        return Err(UpdateError::IntegrityFailed(format!(
            "{PHOTON_WASM} is {} bytes, not the recorded {}",
            receipt.written_bytes, recorded.size
        )));
    }
    Ok(recorded.clone())
}

/// A metadata object the feed could not deliver is a download failure; one that arrived larger
/// than its ceiling is a feed that breaks its rules.
pub(crate) fn feed_error(error: FetchError) -> UpdateError {
    match error.code {
        FetchErrorCode::Download | FetchErrorCode::HttpStatus => {
            UpdateError::DownloadFailed(error.message)
        }
        FetchErrorCode::SizeLimit
        | FetchErrorCode::ChecksumMismatch
        | FetchErrorCode::GzipInvalid
        | FetchErrorCode::Write => UpdateError::FeedInvalid(error.message),
    }
}

/// A transfer the feed could not complete is a download failure, never a judgement of the
/// object; a bad object is an integrity failure.
pub(crate) fn transfer_error(error: FetchError, object: &str) -> UpdateError {
    match error.code {
        FetchErrorCode::Download | FetchErrorCode::HttpStatus => {
            UpdateError::DownloadFailed(error.message)
        }
        FetchErrorCode::SizeLimit => UpdateError::IntegrityFailed(format!(
            "{object} is larger than its recorded size ({})",
            error.message
        )),
        FetchErrorCode::ChecksumMismatch => UpdateError::IntegrityFailed(format!(
            "downloaded artifact failed integrity: {object} ({})",
            error.message
        )),
        FetchErrorCode::GzipInvalid => UpdateError::IntegrityFailed(format!(
            "compressed artifact is invalid: {object} ({})",
            error.message
        )),
        FetchErrorCode::Write => UpdateError::Local(error.message),
    }
}

#[cfg(test)]
mod download_failure_tests;
#[cfg(test)]
mod tests;
