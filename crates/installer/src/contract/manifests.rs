//! The release manifests of the product and installer feeds, the official feed list, and the
//! release version strings the product accepts.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::ArtifactIdentity;

/// The installer protocol this build implements (`installer_protocol` in both manifests).
pub const INSTALLER_PROTOCOL: u32 = 1;
/// `schema_version` of the product release manifest.
pub const RELEASE_MANIFEST_SCHEMA_VERSION: u32 = 2;
/// `schema_version` of the installer's own release manifest.
pub const INSTALLER_MANIFEST_SCHEMA_VERSION: u32 = 1;

/// `<version>/manifest.json` of the product feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseManifest {
    pub schema_version: u32,
    pub version: String,
    pub commit: String,
    #[serde(rename = "buildDate")]
    pub build_date: String,
    pub platforms: BTreeMap<String, ReleasePlatform>,
    #[serde(rename = "photonWasm")]
    pub photon_wasm: NamedArtifact,
    /// The lowest installer protocol that can install this version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installer_protocol: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleasePlatform {
    pub computer: ComputerArtifact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComputerArtifact {
    pub binary: String,
    #[serde(flatten)]
    pub identity: ArtifactIdentity,
    pub gzip: GzipObject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GzipObject {
    pub binary: String,
    #[serde(flatten)]
    pub identity: ArtifactIdentity,
}

/// A feed object named by `file`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedArtifact {
    pub file: String,
    #[serde(flatten)]
    pub identity: ArtifactIdentity,
}

/// `installer/<version>/manifest.json` of the installer feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallerManifest {
    pub schema_version: u32,
    pub version: String,
    pub commit: String,
    #[serde(rename = "buildDate")]
    pub build_date: String,
    pub installer_protocol: u32,
    pub platforms: BTreeMap<String, InstallerPlatform>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallerPlatform {
    pub installer: InstallerArtifact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallerArtifact {
    pub file: String,
    #[serde(flatten)]
    pub identity: ArtifactIdentity,
    pub gzip: NamedArtifact,
}

/// Release version strings and whether the product accepts each (`release-versions.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseVersions {
    pub cases: Vec<ReleaseVersionCase>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseVersionCase {
    pub value: String,
    pub valid: bool,
}

/// The official feeds and the server each one belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedEnvironments {
    pub default_feed: String,
    pub environments: Vec<FeedEnvironment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedEnvironment {
    pub feed: String,
    pub server: String,
}

#[cfg(test)]
mod tests;
