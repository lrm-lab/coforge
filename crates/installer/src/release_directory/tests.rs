use std::fs;

use super::*;
use crate::test_support::{Release, Scratch};

const VERSION: &str = "0.2.0";

#[test]
fn a_directory_takes_a_concrete_version_never_latest() {
    let package = Scratch::new("release-directory-latest");
    let source = ReleaseDirectory::new(package.path());

    let error = source.resolve_version("latest").unwrap_err();

    assert_eq!(error.code(), Some("UPDATE_FEED_INVALID"), "{error:?}");
    assert_eq!(source.resolve_version(VERSION).unwrap(), VERSION);
}

#[test]
fn a_missing_object_is_a_feed_problem_that_names_the_directory() {
    let release = Release::new(VERSION, "linux-x64");
    let package = Scratch::new("release-directory-missing");
    release.write_directory(package.path());
    fs::remove_file(package.path().join("photon_rs_bg.wasm")).unwrap();
    let source = ReleaseDirectory::new(package.path());
    let out = package.path().join("out.wasm");

    let error = source
        .download_photon_wasm(VERSION, &release_manifest_photon(&release), &out)
        .unwrap_err();

    assert_eq!(error.code(), Some("UPDATE_FEED_INVALID"), "{error:?}");
    assert!(error.to_string().contains("photon_rs_bg.wasm"), "{error}");
    assert!(!out.exists());
}

#[test]
fn an_object_that_opens_but_cannot_be_read_is_a_feed_problem_never_a_download_failure() {
    // A directory opens on Unix and fails on the first read. Nothing was downloaded, so the
    // local release is unusable, not a feed that could not be reached.
    let release = Release::new(VERSION, "linux-x64");
    let package = Scratch::new("release-directory-unreadable");
    release.write_directory(package.path());
    fs::remove_file(package.path().join("photon_rs_bg.wasm")).unwrap();
    fs::create_dir(package.path().join("photon_rs_bg.wasm")).unwrap();
    let source = ReleaseDirectory::new(package.path());
    let out = package.path().join("out.wasm");

    let error = source
        .download_photon_wasm(VERSION, &release_manifest_photon(&release), &out)
        .unwrap_err();

    assert_eq!(error.code(), Some("UPDATE_FEED_INVALID"), "{error:?}");
    assert!(error.to_string().contains("photon_rs_bg.wasm"), "{error}");
    assert!(!out.exists());
}

fn release_manifest_photon(release: &Release) -> NamedArtifact {
    let manifest = parse_release_manifest(release.manifest().to_string().as_bytes(), VERSION)
        .expect("the fixture manifest is valid");
    manifest.photon_wasm
}
