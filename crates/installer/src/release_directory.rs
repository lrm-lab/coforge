//! A release read from a local directory (`install --from-directory`): the same objects the feed
//! serves for one version, laid out flat as the Computer's local package is: `manifest.json`,
//! `coforge-computer.gz` (this target's gzip), and `photon_rs_bg.wasm`.
//!
//! Every read is bounded by the feed's size ceilings and every object is checked against the
//! manifest by the same functions the feed client uses ([`crate::feed`]), so a directory is
//! accepted or refused exactly as the feed would be. The directory only supplies bytes.

use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::contract::{ArtifactIdentity, ComputerArtifact, NamedArtifact, ReleaseManifest};
use crate::feed::{
    COMPUTER_GZIP, MAX_MANIFEST_BYTES, PHOTON_WASM, computer_request, computer_result,
    photon_request, photon_result, transfer_error,
};
use crate::fetch::{self, FetchErrorCode};
use crate::manifest::parse_release_manifest;
use crate::prepare::ReleaseSource;
use crate::update_error::UpdateError;
use crate::version::is_valid_release_version;

const MANIFEST: &str = "manifest.json";

pub struct ReleaseDirectory {
    directory: PathBuf,
}

impl ReleaseDirectory {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    /// Reads `name` in full, refusing more than `max_bytes`. A missing or unreadable object is a
    /// feed problem that names the directory.
    fn read_capped(&self, name: &str, max_bytes: u64) -> Result<Vec<u8>, UpdateError> {
        let path = self.directory.join(name);
        let file = File::open(&path).map_err(|error| self.unreadable(name, &error))?;
        let mut bytes = Vec::new();
        file.take(max_bytes.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| self.unreadable(name, &error))?;
        if bytes.len() as u64 > max_bytes {
            return Err(UpdateError::FeedInvalid(format!(
                "{name} in {} is more than {max_bytes} bytes",
                self.directory.display()
            )));
        }
        Ok(bytes)
    }

    /// An object that is missing, cannot be opened, or fails while it is read.
    fn unreadable(&self, name: &str, error: &impl fmt::Display) -> UpdateError {
        UpdateError::FeedInvalid(format!(
            "{name} cannot be read from {}: {error}",
            self.directory.display()
        ))
    }

    /// Streams `name` through the same verified transfer the feed uses, writing `out`. A file that
    /// fails while it is read is unreadable, as one that cannot be opened; nothing was downloaded.
    fn transfer(
        &self,
        name: &str,
        gzip: bool,
        request: &fetch::FetchRequest,
    ) -> Result<fetch::FetchReceipt, UpdateError> {
        let file =
            File::open(self.directory.join(name)).map_err(|error| self.unreadable(name, &error))?;
        fetch::install(file, gzip, request).map_err(|error| match error.code {
            FetchErrorCode::Download => self.unreadable(name, &error.message),
            _ => transfer_error(error, name),
        })
    }
}

impl ReleaseSource for ReleaseDirectory {
    /// A directory holds one release, and it has no pointer: only a concrete version is accepted.
    fn resolve_version(&self, selection: &str) -> Result<String, UpdateError> {
        if selection == "latest" || selection.is_empty() {
            return Err(UpdateError::FeedInvalid(
                "a release directory takes a version, not latest".into(),
            ));
        }
        if !is_valid_release_version(selection) {
            return Err(UpdateError::FeedInvalid(
                "version must be a valid version string".into(),
            ));
        }
        Ok(selection.to_owned())
    }

    fn manifest(&self, version: &str) -> Result<ReleaseManifest, UpdateError> {
        let bytes = self.read_capped(MANIFEST, MAX_MANIFEST_BYTES)?;
        parse_release_manifest(&bytes, version)
    }

    fn download_computer(
        &self,
        _version: &str,
        _target: &str,
        artifact: &ComputerArtifact,
        out: &Path,
    ) -> Result<ArtifactIdentity, UpdateError> {
        let request = computer_request(artifact, self.directory.display().to_string(), out)?;
        let receipt = self.transfer(COMPUTER_GZIP, true, &request)?;
        computer_result(receipt, artifact, out)
    }

    fn download_photon_wasm(
        &self,
        _version: &str,
        artifact: &NamedArtifact,
        out: &Path,
    ) -> Result<ArtifactIdentity, UpdateError> {
        let request = photon_request(artifact, self.directory.display().to_string(), out)?;
        let receipt = self.transfer(PHOTON_WASM, false, &request)?;
        photon_result(receipt, artifact, out)
    }
}

#[cfg(test)]
mod tests;
