use std::fs;

use super::*;
use crate::contract::{ReceiptOutcome, UpgradeReceipt};
use crate::lock::MachineMutationLock;
use crate::test_support::Scratch;

const ID: &str = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";

fn succeeded(version: &str) -> UpgradeReceipt {
    UpgradeReceipt::new(
        ID,
        ReceiptOutcome::Succeeded {
            version: version.to_owned(),
        },
        Vec::new(),
    )
    .unwrap()
}

#[test]
fn a_new_request_is_recorded_and_begins() {
    let root = Scratch::new("receipts-new");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = ReceiptStore::new(root.path());
    assert_eq!(store.begin(&lock, ID, "1.2.3").unwrap(), Begin::Fresh);
    let request: serde_json::Value = serde_json::from_slice(
        &fs::read(
            root.path()
                .join(format!("upgrade-results/{ID}.request.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        request,
        serde_json::json!({
            "schema_version": 1,
            "request_id": ID,
            "operation": "upgrade",
            "selection": "1.2.3",
        })
    );
}

#[test]
fn a_repair_request_records_its_distinct_operation() {
    let root = Scratch::new("receipts-repair");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = ReceiptStore::new(root.path());
    assert_eq!(
        store
            .begin_operation(&lock, ID, "repair", "active")
            .unwrap(),
        Begin::Fresh
    );
    let request: serde_json::Value = serde_json::from_slice(
        &fs::read(
            root.path()
                .join(format!("upgrade-results/{ID}.request.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(request["operation"], "repair");
    assert_eq!(request["selection"], "active");
}

#[test]
fn a_committed_receipt_is_read_back_and_never_overwritten() {
    let root = Scratch::new("receipts-commit");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = ReceiptStore::new(root.path());
    store.begin(&lock, ID, "latest").unwrap();
    store.commit(&lock, &succeeded("1.2.3")).unwrap();
    assert_eq!(store.read(ID).unwrap(), Some(succeeded("1.2.3")));
    assert!(matches!(
        store.commit(&lock, &succeeded("1.2.4")),
        Err(ReceiptError::AlreadyCommitted { .. })
    ));
    assert_eq!(store.read(ID).unwrap(), Some(succeeded("1.2.3")));
}

#[test]
fn the_same_request_again_replays_its_receipt() {
    let root = Scratch::new("receipts-replay");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = ReceiptStore::new(root.path());
    store.begin(&lock, ID, "latest").unwrap();
    store.commit(&lock, &succeeded("1.2.3")).unwrap();
    assert_eq!(
        store.begin(&lock, ID, "latest").unwrap(),
        Begin::Replay(Box::new(succeeded("1.2.3")))
    );
}

#[test]
fn the_same_request_id_for_another_target_is_a_conflict_and_changes_nothing() {
    let root = Scratch::new("receipts-conflict");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = ReceiptStore::new(root.path());
    store.begin(&lock, ID, "1.2.3").unwrap();
    assert!(matches!(
        store.begin(&lock, ID, "1.2.4").unwrap(),
        Begin::Conflict(_)
    ));
    store.commit(&lock, &succeeded("1.2.3")).unwrap();
    assert!(matches!(
        store.begin(&lock, ID, "latest").unwrap(),
        Begin::Conflict(_)
    ));
    assert_eq!(store.read(ID).unwrap(), Some(succeeded("1.2.3")));
}

#[test]
fn a_request_that_never_finished_begins_again() {
    let root = Scratch::new("receipts-resume");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = ReceiptStore::new(root.path());
    store.begin(&lock, ID, "1.2.3").unwrap();
    assert_eq!(store.begin(&lock, ID, "1.2.3").unwrap(), Begin::Fresh);
}

#[test]
fn a_receipt_over_the_limit_or_not_a_receipt_is_unreadable() {
    let root = Scratch::new("receipts-unreadable");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = ReceiptStore::new(root.path());
    store.begin(&lock, ID, "1.2.3").unwrap();
    let result = root
        .path()
        .join(format!("upgrade-results/{ID}.result.json"));
    fs::write(&result, "{}").unwrap();
    assert!(matches!(
        store.read(ID),
        Err(ReceiptError::Unreadable { .. })
    ));
    assert!(matches!(
        store.begin(&lock, ID, "1.2.3").unwrap(),
        Begin::Conflict(_)
    ));
    fs::write(&result, vec![b' '; 64 * 1024 + 1]).unwrap();
    assert!(matches!(
        store.read(ID),
        Err(ReceiptError::Unreadable { .. })
    ));
}

#[test]
fn a_missing_receipt_reads_as_none() {
    let root = Scratch::new("receipts-none");
    assert_eq!(ReceiptStore::new(root.path()).read(ID).unwrap(), None);
}

#[test]
fn a_lock_on_another_root_is_refused() {
    let root = Scratch::new("receipts-root");
    let other = Scratch::new("receipts-other");
    let lock = MachineMutationLock::acquire(other.path()).unwrap();
    assert!(matches!(
        ReceiptStore::new(root.path()).begin(&lock, ID, "1.2.3"),
        Err(ReceiptError::WrongLock { .. })
    ));
}

#[cfg(unix)]
#[test]
fn receipts_are_private_to_the_user() {
    use std::os::unix::fs::PermissionsExt;
    let root = Scratch::new("receipts-modes");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = ReceiptStore::new(root.path());
    store.begin(&lock, ID, "1.2.3").unwrap();
    store.commit(&lock, &succeeded("1.2.3")).unwrap();
    let mode = |path: &str| {
        fs::metadata(root.path().join(path))
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    };
    assert_eq!(mode("upgrade-results"), 0o700);
    assert_eq!(mode(&format!("upgrade-results/{ID}.request.json")), 0o600);
    assert_eq!(mode(&format!("upgrade-results/{ID}.result.json")), 0o600);
}
