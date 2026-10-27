use super::*;
use crate::contract::tests::golden;

#[test]
fn release_manifest_v2() {
    let manifest: ReleaseManifest = golden("manifest.v2.json");
    assert_eq!(manifest.schema_version, RELEASE_MANIFEST_SCHEMA_VERSION);
    assert_eq!(manifest.installer_protocol, Some(INSTALLER_PROTOCOL));
    assert_eq!(manifest.photon_wasm.file, "photon_rs_bg.wasm");
    for platform in manifest.platforms.values() {
        assert_eq!(platform.computer.binary, "coforge-computer");
        assert_eq!(platform.computer.gzip.binary, "coforge-computer.gz");
    }
}

#[test]
fn installer_manifest_v1() {
    let manifest: InstallerManifest = golden("installer-manifest.v1.json");
    assert_eq!(manifest.schema_version, INSTALLER_MANIFEST_SCHEMA_VERSION);
    assert_eq!(manifest.installer_protocol, INSTALLER_PROTOCOL);
    let windows = &manifest.platforms["windows-x64"].installer;
    assert_eq!(windows.file, "coforge-installer.exe");
    assert_eq!(windows.gzip.file, "coforge-installer.exe.gz");
}

#[test]
fn release_versions() {
    let versions: ReleaseVersions = golden("release-versions.json");
    assert!(versions.cases.iter().any(|case| case.valid));
    assert!(versions.cases.iter().any(|case| !case.valid));
}

#[test]
fn feed_environments() {
    let feeds: FeedEnvironments = golden("feed-environments.json");
    assert!(
        feeds
            .environments
            .iter()
            .any(|environment| feeds.default_feed.starts_with(&environment.feed))
    );
}
