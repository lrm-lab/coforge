use super::*;
use crate::contract::tests::{REQUEST_ID, golden, read_text};

#[test]
fn supervisor_lock_owner() {
    assert_eq!(
        parse_supervisor_lock_owner(&read_text("supervisor-lock-owner.txt")),
        Some(4242)
    );
}

#[test]
fn machine_mutation_lock() {
    let lock: MachineMutationLock = golden("lock.json");
    assert_eq!(lock.file, "machine-mutation-lock.sqlite");
    assert_eq!(
        lock.statements.last().map(String::as_str),
        Some("BEGIN IMMEDIATE")
    );
}

#[test]
fn service_identities() {
    let identities: ServiceIdentities = golden("service-identities.json");
    assert_eq!(
        request_scoped(&identities.upgrade_job.launchd_label, REQUEST_ID),
        format!("cn.coforge.upgrade.{REQUEST_ID}")
    );
}

#[test]
fn paths() {
    let paths: Paths = golden("paths.json");
    for platform in ["linux", "darwin", "win32"] {
        assert!(
            paths.cases.iter().any(|case| case.platform == platform),
            "{platform}"
        );
    }
}
