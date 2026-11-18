use std::fs;
use std::path::Path;

use super::*;
use crate::active::write_active_state;
use crate::clock::VirtualClock;
use crate::contract::{ACTIVE_STATE_SCHEMA_VERSION, ActiveState};
use crate::digest::measure_bytes;
use crate::lock::MachineMutationLock;
use crate::processes::fakes::FakeTable;
use crate::store::VersionStore;
use crate::test_support::Scratch;
use crate::update_error::UpdateError;

fn install_version(store: &VersionStore, lock: &MachineMutationLock, version: &str) {
    let staging = store.begin_staging(lock, version).unwrap();
    let computer = format!("#!/bin/sh\necho coforge-computer {version}\n").into_bytes();
    let wasm = b"\0asm\x01\0\0\0photon".to_vec();
    fs::write(staging.computer_path(), &computer).unwrap();
    fs::write(staging.photon_wasm_path(), &wasm).unwrap();
    staging
        .install(measure_bytes(&computer), measure_bytes(&wasm))
        .unwrap();
}

fn write_active(root: &Path, current: &str, previous: Option<&str>) {
    write_active_state(
        root,
        &ActiveState {
            schema_version: ACTIVE_STATE_SCHEMA_VERSION,
            current: current.to_owned(),
            previous: previous.map(str::to_owned),
        },
    )
    .unwrap();
}

fn stored_versions(root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root.join("versions")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn refuses_a_lock_covering_another_install_root_without_deleting_anything() {
    let root = Scratch::new("prune-wrong-lock");
    let other = Scratch::new("prune-other-lock");
    let root_lock = MachineMutationLock::acquire(root.path()).unwrap();
    let other_lock = MachineMutationLock::acquire(other.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    for version in ["0.1.0", "0.2.0", "0.3.0"] {
        install_version(&store, &root_lock, version);
    }
    write_active(root.path(), "0.3.0", Some("0.2.0"));
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);

    let error = prune_inactive_versions(&other_lock, &store, &table, &[]).unwrap_err();

    assert!(
        matches!(&error, UpdateError::Local(message) if message.contains("machine mutation lock")),
        "{error:?}"
    );
    assert_eq!(stored_versions(root.path()), ["0.1.0", "0.2.0", "0.3.0"]);
}

#[test]
fn keeps_active_current_previous_and_explicit_targets_while_pruning_older_versions() {
    let root = Scratch::new("prune-keep-active-and-previous");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    for version in ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"] {
        install_version(&store, &lock, version);
    }
    write_active(root.path(), "0.5.0", Some("0.4.0"));
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);

    let report = prune_inactive_versions(&lock, &store, &table, &["0.3.0"]).unwrap();

    assert_eq!(report.removed, ["0.1.0", "0.2.0"]);
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    assert_eq!(stored_versions(root.path()), ["0.3.0", "0.4.0", "0.5.0"]);
}

#[test]
fn never_prunes_a_version_whose_binary_is_running_in_the_process_table() {
    let root = Scratch::new("prune-running-process");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    for version in ["0.1.0", "0.2.0", "0.3.0"] {
        install_version(&store, &lock, version);
    }
    write_active(root.path(), "0.3.0", Some("0.2.0"));
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let canonical = fs::canonicalize(store.computer_path("0.1.0"))
        .unwrap()
        .to_string_lossy()
        .into_owned();
    table.spawn(4242, 10, &canonical);

    let while_running = prune_inactive_versions(&lock, &store, &table, &[]).unwrap();

    assert!(while_running.removed.is_empty());
    assert_eq!(stored_versions(root.path()), ["0.1.0", "0.2.0", "0.3.0"]);

    table.vanish(4242);
    let after_exit = prune_inactive_versions(&lock, &store, &table, &[]).unwrap();

    assert_eq!(after_exit.removed, ["0.1.0"]);
    assert_eq!(stored_versions(root.path()), ["0.2.0", "0.3.0"]);
}

#[test]
fn skips_pruning_when_active_state_is_missing_or_invalid() {
    let root = Scratch::new("prune-missing-active");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    for version in ["0.1.0", "0.2.0"] {
        install_version(&store, &lock, version);
    }
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);

    let missing = prune_inactive_versions(&lock, &store, &table, &[]).unwrap();
    assert!(missing.removed.is_empty());
    assert_eq!(stored_versions(root.path()), ["0.1.0", "0.2.0"]);

    fs::write(root.path().join("active.json"), "{not-json").unwrap();
    let invalid = prune_inactive_versions(&lock, &store, &table, &[]).unwrap();
    assert!(invalid.removed.is_empty());
    assert_eq!(stored_versions(root.path()), ["0.1.0", "0.2.0"]);
}

#[test]
fn skips_pruning_when_process_inspection_fails() {
    let root = Scratch::new("prune-inspect-error");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    for version in ["0.1.0", "0.2.0", "0.3.0"] {
        install_version(&store, &lock, version);
    }
    write_active(root.path(), "0.3.0", Some("0.2.0"));
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(77, 1, "/usr/bin/unrelated");
    table.fail_inspecting(77);

    let report = prune_inactive_versions(&lock, &store, &table, &[]).unwrap();

    assert!(report.removed.is_empty());
    assert_eq!(report.warnings.len(), 1);
    assert_eq!(stored_versions(root.path()), ["0.1.0", "0.2.0", "0.3.0"]);
}

#[cfg(unix)]
#[test]
fn tolerates_best_effort_removal_failure_and_continues_pruning_other_versions() {
    use std::os::unix::fs::PermissionsExt;

    let root = Scratch::new("prune-removal-failure");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    for version in ["0.1.0", "0.2.0", "0.3.0", "0.4.0"] {
        install_version(&store, &lock, version);
    }
    write_active(root.path(), "0.4.0", Some("0.3.0"));
    fs::write(root.path().join("versions/README.txt"), "keep non-dir").unwrap();

    // Removing files inside a read-only (`0o500`) directory fails with EACCES on Unix unless root.
    let locked_dir = store.version_directory("0.1.0");
    fs::set_permissions(&locked_dir, fs::Permissions::from_mode(0o500)).unwrap();

    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let report = prune_inactive_versions(&lock, &store, &table, &[]).unwrap();

    // Restore permissions so Scratch cleanup removes the directory on drop.
    fs::set_permissions(&locked_dir, fs::Permissions::from_mode(0o700)).unwrap();

    assert_eq!(report.removed, ["0.2.0"]);
    assert_eq!(report.warnings.len(), 1);
    assert!(
        report.warnings[0].contains("0.1.0"),
        "{:?}",
        report.warnings
    );
    assert_eq!(
        stored_versions(root.path()),
        ["0.1.0", "0.3.0", "0.4.0", "README.txt"]
    );
}

#[test]
fn skips_pruning_when_any_process_is_unlinked_or_unreadable() {
    for mode in ["unlinked", "unreadable"] {
        let root = Scratch::new(&format!("prune-{mode}"));
        let lock = MachineMutationLock::acquire(root.path()).unwrap();
        let store = VersionStore::new(root.path(), "linux-x64");
        for version in ["0.1.0", "0.2.0", "0.3.0"] {
            install_version(&store, &lock, version);
        }
        write_active(root.path(), "0.3.0", Some("0.2.0"));

        let clock = VirtualClock::new();
        let table = FakeTable::new(&clock);
        let exe = store.computer_path("0.1.0");
        table.spawn(100, 1, &exe.to_string_lossy());
        if mode == "unlinked" {
            table.unlink(100);
        } else {
            table.become_unreadable(100);
        }

        let report = prune_inactive_versions(&lock, &store, &table, &[]).unwrap();
        assert!(report.removed.is_empty(), "{mode}: {:?}", report.removed);
        assert_eq!(report.warnings.len(), 1, "{mode}: {:?}", report.warnings);
        assert_eq!(stored_versions(root.path()), ["0.1.0", "0.2.0", "0.3.0"]);
    }
}
