//! Makes a release version present in the version store: resolve what to install, download and
//! verify it, stage it, and move it into `versions/`.
//!
//! This is the Computer's `#prepare` without its bookkeeping (packages/computer/src/updater.ts):
//! it neither verifies the version that is running nor touches `active.json`, which belong to
//! the install transaction. The one difference in order is deliberate: a version whose directory
//! already exists is verified and used as it is, before anything is fetched beyond the pointer,
//! because the updater discards what it downloads in that case anyway.

use std::path::Path;

use crate::contract::{ArtifactIdentity, ComputerArtifact, NamedArtifact, ReleaseManifest};
use crate::lock::MachineMutationLock;
use crate::manifest::computer_artifact;
use crate::store::{Installation, Presence, VersionStore};
use crate::update_error::UpdateError;

#[derive(Debug, PartialEq, Eq)]
pub struct Prepared {
    pub version: String,
    pub installation: Installation,
}

/// Where a release's objects come from: the release feed, or a directory laid out the same way
/// (`--from-directory`). Everything else in this module is the same for both. Each object is
/// checked against the manifest before it is returned, whatever the source.
pub trait ReleaseSource {
    /// `latest` (where the source has a pointer) or a concrete version, as a concrete version.
    fn resolve_version(&self, selection: &str) -> Result<String, UpdateError>;
    /// The manifest, validated as exactly `version`'s.
    fn manifest(&self, version: &str) -> Result<ReleaseManifest, UpdateError>;
    /// Writes the target's expanded computer executable to `out` and returns its identity.
    fn download_computer(
        &self,
        version: &str,
        target: &str,
        artifact: &ComputerArtifact,
        out: &Path,
    ) -> Result<ArtifactIdentity, UpdateError>;
    /// Writes the image library to `out` and returns its identity.
    fn download_photon_wasm(
        &self,
        version: &str,
        artifact: &NamedArtifact,
        out: &Path,
    ) -> Result<ArtifactIdentity, UpdateError>;
}

/// Resolves `selection` (`latest` or a version) on `release` and installs it into `store` for the
/// store's release target. `lock` must be the machine mutation lock on the store's install root
/// (anything else is refused before the release is asked): the witness that no other install,
/// upgrade, or repair is changing it.
///
/// `already_verified` names a version the caller has verified under this same lock moments ago;
/// it is used as it is and not hashed a second time.
pub fn prepare_version(
    lock: &MachineMutationLock,
    release: &dyn ReleaseSource,
    store: &VersionStore,
    selection: &str,
    already_verified: Option<&str>,
) -> Result<Prepared, UpdateError> {
    prepare_version_with_stage(
        lock,
        release,
        store,
        selection,
        already_verified,
        &mut |_| {},
    )
}

/// As [`prepare_version`], reporting download progress and the verification boundary.
/// `stage` is deliberately optional at the public entry point so existing callers keep the
/// same behavior while the installer CLI can show byte progress for an upgrade.
pub fn prepare_version_with_stage(
    lock: &MachineMutationLock,
    release: &dyn ReleaseSource,
    store: &VersionStore,
    selection: &str,
    already_verified: Option<&str>,
    stage: &mut dyn FnMut(&str),
) -> Result<Prepared, UpdateError> {
    store.require_lock(lock)?;
    let version = release.resolve_version(selection)?;
    let verified = already_verified == Some(version.as_str());
    if verified || store.presence(&version)? == Presence::Verified {
        return Ok(Prepared {
            version,
            installation: Installation::AlreadyInstalled,
        });
    }
    let manifest = release.manifest(&version)?;
    let computer = computer_artifact(&manifest, store.target())?;

    let staging = store.begin_staging(lock, &version)?;
    stage("Downloading 0 bytes");
    let computer =
        release.download_computer(&version, store.target(), computer, &staging.computer_path())?;
    stage(&format!("Downloading {} bytes", computer.size));
    let photon_wasm = release.download_photon_wasm(
        &version,
        &manifest.photon_wasm,
        &staging.photon_wasm_path(),
    )?;
    stage(&format!(
        "Downloading {} bytes",
        computer.size.saturating_add(photon_wasm.size)
    ));
    stage("Verifying download");
    let installation = staging.install(computer, photon_wasm)?;
    Ok(Prepared {
        version,
        installation,
    })
}

#[cfg(test)]
mod tests;
