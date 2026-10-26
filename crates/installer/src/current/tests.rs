//! `current/` on real files: what a sync leaves, and what a crash in the middle of one leaves.

use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use super::*;
use crate::test_support::{Scratch, entries_of, mode_of};

/// A version directory holding the payload files, each containing `<name> <version>`.
fn version(scratch: &Scratch, version: &str, names: &[&str]) -> PathBuf {
    let directory = scratch.path().join("versions").join(version);
    fs::create_dir_all(&directory).unwrap();
    for name in names {
        let path = directory.join(name);
        let text = if *name == "version" {
            format!("{version}\n")
        } else {
            format!("{name} {version}")
        };
        fs::write(&path, text).unwrap();
        let mode = if *name == "coforge-computer" || *name == "coforge" {
            0o700
        } else {
            0o600
        };
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
    }
    directory
}

const PAYLOAD: [&str; 4] = [
    "coforge-computer",
    "coforge",
    "photon_rs_bg.wasm",
    "version",
];

fn read(directory: &Path, name: &str) -> String {
    fs::read_to_string(directory.join(name)).unwrap()
}

#[test]
fn a_sync_copies_every_file_with_its_mode_into_a_private_directory() {
    let scratch = Scratch::new("current-copy");
    let source = version(&scratch, "0.1.0", &PAYLOAD);
    let destination = scratch.path().join("current");

    sync(&source, &destination, false).unwrap();

    assert_eq!(mode_of(&destination), 0o700);
    let mut expected = PAYLOAD.map(str::to_owned).to_vec();
    expected.sort();
    assert_eq!(entries_of(&destination), expected);
    assert_eq!(
        read(&destination, "coforge-computer"),
        "coforge-computer 0.1.0"
    );
    assert_eq!(read(&destination, "version"), "0.1.0\n");
    assert_eq!(mode_of(&destination.join("coforge-computer")), 0o700);
    assert_eq!(mode_of(&destination.join("coforge")), 0o700);
    assert_eq!(mode_of(&destination.join("photon_rs_bg.wasm")), 0o600);
    assert!(in_sync(&source, &destination));
}

#[test]
fn the_executable_is_replaced_in_place_at_the_same_path_through_a_new_file() {
    let scratch = Scratch::new("current-in-place");
    let first = version(&scratch, "0.1.0", &PAYLOAD);
    let second = version(&scratch, "0.2.0", &PAYLOAD);
    let destination = scratch.path().join("current");
    let executable = destination.join("coforge-computer");
    sync(&first, &destination, false).unwrap();
    let real_path = fs::canonicalize(&executable).unwrap();
    let inode = fs::metadata(&executable).unwrap().ino();
    // A running process holds its executable open, as this handle does.
    let mut running = fs::File::open(&executable).unwrap();

    sync(&second, &destination, false).unwrap();

    assert_eq!(fs::canonicalize(&executable).unwrap(), real_path);
    assert_eq!(
        read(&destination, "coforge-computer"),
        "coforge-computer 0.2.0"
    );
    assert_ne!(fs::metadata(&executable).unwrap().ino(), inode);
    let mut old = String::new();
    running.read_to_string(&mut old).unwrap();
    assert_eq!(old, "coforge-computer 0.1.0");
    assert!(in_sync(&second, &destination));
    assert!(!in_sync(&first, &destination));
}

#[test]
fn a_file_that_already_matches_is_not_rewritten() {
    let scratch = Scratch::new("current-untouched");
    let source = version(&scratch, "0.1.0", &PAYLOAD);
    let destination = scratch.path().join("current");
    sync(&source, &destination, false).unwrap();
    let before: Vec<u64> = PAYLOAD
        .iter()
        .map(|name| fs::metadata(destination.join(name)).unwrap().ino())
        .collect();

    sync(&source, &destination, false).unwrap();

    let after: Vec<u64> = PAYLOAD
        .iter()
        .map(|name| fs::metadata(destination.join(name)).unwrap().ino())
        .collect();
    assert_eq!(before, after);
}

#[test]
fn a_file_with_the_right_bytes_and_the_wrong_mode_is_replaced() {
    let scratch = Scratch::new("current-mode");
    let source = version(&scratch, "0.1.0", &PAYLOAD);
    let destination = scratch.path().join("current");
    sync(&source, &destination, false).unwrap();
    let executable = destination.join("coforge-computer");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(!in_sync(&source, &destination));

    sync(&source, &destination, false).unwrap();

    assert_eq!(mode_of(&executable), 0o700);
    assert!(in_sync(&source, &destination));
}

#[test]
fn files_the_new_version_does_not_have_and_stray_temporaries_are_removed() {
    let scratch = Scratch::new("current-strangers");
    let old = version(&scratch, "0.1.0", &[&PAYLOAD[..], &["old-only"]].concat());
    let new = version(&scratch, "0.2.0", &PAYLOAD);
    let destination = scratch.path().join("current");
    sync(&old, &destination, false).unwrap();
    fs::write(destination.join("coforge-computer.1-2-3.tmp"), "half").unwrap();
    fs::create_dir_all(destination.join("leftover/inner")).unwrap();

    sync(&new, &destination, false).unwrap();

    let mut expected = PAYLOAD.map(str::to_owned).to_vec();
    expected.sort();
    assert_eq!(entries_of(&destination), expected);
    assert!(in_sync(&new, &destination));
}

#[test]
fn a_directory_where_a_file_belongs_is_replaced_by_the_file() {
    let scratch = Scratch::new("current-directory-in-the-way");
    let source = version(&scratch, "0.1.0", &PAYLOAD);
    let destination = scratch.path().join("current");
    fs::create_dir_all(destination.join("coforge-computer/inner")).unwrap();

    sync(&source, &destination, false).unwrap();

    assert!(destination.join("coforge-computer").is_file());
    assert!(in_sync(&source, &destination));
}

#[test]
fn the_marker_is_replaced_last_so_a_failed_copy_never_leaves_it_naming_the_new_version() {
    let scratch = Scratch::new("current-marker-last");
    let old = version(&scratch, "0.1.0", &PAYLOAD);
    let new = version(&scratch, "0.2.0", &PAYLOAD);
    let destination = scratch.path().join("current");
    sync(&old, &destination, false).unwrap();
    // The executable is the last file before the marker, so its failure is the latest a sync can
    // stop at without having committed.
    let unreadable = new.join("coforge-computer");
    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::File::open(&unreadable).is_ok() {
        // Running as a user that ignores file modes (root): the failure cannot be staged.
        return;
    }

    let error = sync(&new, &destination, false).unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(read(&destination, "version"), "0.1.0\n");
    assert_eq!(
        read(&destination, "coforge-computer"),
        "coforge-computer 0.1.0"
    );
    // The files before the executable are already the new version's; the next sync finishes.
    assert_eq!(
        read(&destination, "photon_rs_bg.wasm"),
        "photon_rs_bg.wasm 0.2.0"
    );
    assert!(!in_sync(&new, &destination));
    assert!(
        !entries_of(&destination)
            .iter()
            .any(|name| name.ends_with(".tmp")),
        "{:?}",
        entries_of(&destination)
    );
    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o700)).unwrap();
    sync(&new, &destination, false).unwrap();
    assert_eq!(read(&destination, "version"), "0.2.0\n");
    assert!(in_sync(&new, &destination));
}

#[test]
fn a_source_entry_that_is_not_a_regular_file_is_refused_before_anything_changes() {
    let scratch = Scratch::new("current-bad-source");
    let old = version(&scratch, "0.1.0", &PAYLOAD);
    let bad = version(&scratch, "0.2.0", &PAYLOAD);
    let destination = scratch.path().join("current");
    sync(&old, &destination, false).unwrap();
    fs::create_dir(bad.join("a-directory")).unwrap();

    let error = sync(&bad, &destination, false).unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(in_sync(&old, &destination));
    assert!(!in_sync(&bad, &destination));
}

#[test]
fn a_destination_with_a_changed_byte_a_missing_file_or_an_extra_file_is_not_in_sync() {
    let scratch = Scratch::new("current-in-sync");
    let source = version(&scratch, "0.1.0", &PAYLOAD);
    let destination = scratch.path().join("current");
    assert!(!in_sync(&source, &destination), "no directory at all");
    sync(&source, &destination, false).unwrap();
    assert!(in_sync(&source, &destination));

    let wasm = destination.join("photon_rs_bg.wasm");
    fs::write(&wasm, "photon_rs_bg.wasm 0.1.1").unwrap();
    fs::set_permissions(&wasm, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(
        !in_sync(&source, &destination),
        "same length, one byte differs"
    );
    sync(&source, &destination, false).unwrap();

    fs::remove_file(destination.join("coforge")).unwrap();
    assert!(!in_sync(&source, &destination), "a missing file");
    sync(&source, &destination, false).unwrap();

    fs::write(destination.join("extra"), "").unwrap();
    assert!(!in_sync(&source, &destination), "an extra file");
}

#[test]
fn a_differing_executable_is_spared_when_asked_and_so_is_the_marker() {
    let scratch = Scratch::new("current-spare");
    let old = version(&scratch, "0.1.0", &PAYLOAD);
    let new = version(&scratch, "0.2.0", &PAYLOAD);
    let destination = scratch.path().join("current");
    sync(&old, &destination, false).unwrap();
    let executable = destination.join("coforge-computer");
    let inode = fs::metadata(&executable).unwrap().ino();

    let activation = sync(&new, &destination, true).unwrap();

    assert_eq!(activation, Activation::ExecutableSpared);
    assert_eq!(fs::metadata(&executable).unwrap().ino(), inode);
    assert_eq!(
        read(&destination, "coforge-computer"),
        "coforge-computer 0.1.0"
    );
    // The other files are the new version's; the marker still names the version whose
    // executable is there, so `current/` never claims the new version.
    assert_eq!(
        read(&destination, "photon_rs_bg.wasm"),
        "photon_rs_bg.wasm 0.2.0"
    );
    assert_eq!(read(&destination, "version"), "0.1.0\n");
    assert!(!in_sync(&new, &destination));
    assert_eq!(
        sync(&new, &destination, false).unwrap(),
        Activation::Complete
    );
    assert!(in_sync(&new, &destination));
}

#[test]
fn sparing_the_executable_changes_nothing_when_it_is_missing_or_already_matches() {
    let scratch = Scratch::new("current-spare-unneeded");
    let source = version(&scratch, "0.1.0", &PAYLOAD);
    let destination = scratch.path().join("current");

    // No executable yet: creating one disturbs nothing.
    assert_eq!(
        sync(&source, &destination, true).unwrap(),
        Activation::Complete
    );
    assert!(in_sync(&source, &destination));
    // One that matches is not replaced.
    assert_eq!(
        sync(&source, &destination, true).unwrap(),
        Activation::Complete
    );
}

#[test]
fn links_and_directories_in_the_way_are_removed_without_following_them() {
    let scratch = Scratch::new("current-links");
    let source = version(&scratch, "0.1.0", &PAYLOAD);
    let outside = scratch.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("keep"), "kept").unwrap();
    let destination = scratch.path().join("current");
    fs::create_dir_all(&destination).unwrap();
    std::os::unix::fs::symlink(&outside, destination.join("coforge")).unwrap();
    std::os::unix::fs::symlink(&outside, destination.join("stray-link")).unwrap();

    sync(&source, &destination, false).unwrap();

    assert!(in_sync(&source, &destination));
    assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "kept");
}
