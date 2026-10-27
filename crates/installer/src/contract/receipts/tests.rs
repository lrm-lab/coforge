use std::collections::{BTreeMap, BTreeSet};

use super::*;
use crate::contract::tests::{REQUEST_ID, emit, golden};
use crate::contract::{MachineMutationLock, to_file_json};

#[test]
fn receipts() {
    let succeeded: UpgradeReceipt = golden("receipt.succeeded.json");
    assert_eq!(succeeded.status(), ReceiptStatus::Succeeded);
    assert_eq!(succeeded.exit_code(), EXIT_SUCCEEDED);
    assert_eq!(succeeded.protocol(), INSTALLER_RECEIPT_PROTOCOL);
    assert_eq!(
        succeeded.dead_process_identities(),
        Some(dead_processes().as_slice())
    );
    let rolled_back: UpgradeReceipt = golden("receipt.rolled-back.json");
    assert_eq!(rolled_back.status(), ReceiptStatus::Failed);
    assert_eq!(rolled_back.error_code(), Some("UPGRADE_ROLLED_BACK"));
    assert_eq!(rolled_back.exit_code(), EXIT_FAILED);
    assert!(rolled_back.restored_version().is_some());
    assert_eq!(
        rolled_back.dead_process_identities(),
        Some(dead_processes().as_slice())
    );
    // No v1 operation is held with a receipt yet; the example says what one looks like.
    let held: UpgradeReceipt = golden("receipt.held.json");
    assert_eq!(held.status(), ReceiptStatus::Held);
    assert_eq!(held.exit_code(), EXIT_HELD);
    assert!(held.error().is_some());
    assert_eq!(held.error_code(), None);
    assert_eq!(held.dead_process_identities(), None);
    let unresolved: UpgradeReceipt = golden("receipt.unresolved.json");
    assert_eq!(unresolved.error_code(), Some("UPGRADE_ROLLBACK_FAILED"));
    assert_eq!(unresolved.exit_code(), EXIT_UNRESOLVED);
    assert_eq!(
        unresolved.dead_process_identities(),
        Some(dead_processes().as_slice())
    );
}

/// The processes the receipt examples say the installer stopped.
fn dead_processes() -> Vec<DeadProcessIdentity> {
    let boot_id = "0d9a7e64-6e5f-4a1b-8c3d-2f4e6a8b0c1d";
    let executable = "/home/example/.coforge/computer/install/versions/0.1.0/coforge-computer";
    [(4242, 48_213_337), (4243, 48_213_351)]
        .into_iter()
        .map(|(pid, ticks)| DeadProcessIdentity {
            pid,
            started_at: format!("{boot_id}:{ticks}"),
            executable: executable.into(),
        })
        .collect()
}

#[test]
fn installer_codes() {
    let codes: InstallerCodes = golden("installer-codes.json");
    assert_eq!(
        codes.exit_codes,
        BTreeMap::from([
            ("SUCCEEDED".to_owned(), EXIT_SUCCEEDED),
            ("FAILED".to_owned(), EXIT_FAILED),
            ("HELD".to_owned(), EXIT_HELD),
            ("UNRESOLVED".to_owned(), EXIT_UNRESOLVED),
        ])
    );
    assert_eq!(codes.max_receipt_bytes, RECEIPT_MAX_BYTES);
}

#[test]
fn upgrade_error_codes() {
    let codes: UpgradeErrorCodes = golden("upgrade-error-codes.json");
    assert_eq!(codes.codes["ROLLED_BACK"], ERROR_CODE_ROLLED_BACK);
    assert_eq!(codes.codes["ROLLBACK_FAILED"], ERROR_CODE_ROLLBACK_FAILED);
    assert_eq!(
        codes.codes["DOWNGRADE_REFUSED"],
        ERROR_CODE_DOWNGRADE_REFUSED
    );
    assert_eq!(
        codes.codes["INSTALLER_UNAVAILABLE"],
        "UPGRADE_INSTALLER_UNAVAILABLE"
    );
    assert_eq!(
        codes.codes["INSTALLER_INCOMPATIBLE"],
        "UPGRADE_INSTALLER_INCOMPATIBLE"
    );
    assert_eq!(codes.codes["UPDATE_BUSY"], lock_busy_code());
}

fn lock_busy_code() -> String {
    golden::<MachineMutationLock>("lock.json").busy_error_code
}

/// One receipt per allowed row of `receipt-cases.json`.
fn constructed_receipts() -> Vec<(&'static str, UpgradeReceipt)> {
    let new = |outcome, stopped| UpgradeReceipt::new(REQUEST_ID, outcome, stopped).unwrap();
    let failed = |error: &str, error_code: Option<&str>| ReceiptOutcome::Failed {
        error: error.into(),
        error_code: error_code.map(Into::into),
    };
    vec![
        (
            "succeeded",
            new(
                ReceiptOutcome::Succeeded {
                    version: "0.2.0".into(),
                },
                dead_processes(),
            )
            .with_runtimes(
                true,
                vec![RuntimeState {
                    binding_id: "ws_example".into(),
                    running: true,
                }],
            ),
        ),
        (
            "succeeded-uppercase-request-id",
            UpgradeReceipt::new(
                "0F8B6D5E-2A41-4C3B-BE7D-1A2B3C4D5E6F",
                ReceiptOutcome::Succeeded {
                    version: "0.2.0".into(),
                },
                vec![],
            )
            .unwrap(),
        ),
        (
            "repair-succeeded",
            UpgradeReceipt::new_for_operation(
                REQUEST_ID,
                "repair",
                ReceiptOutcome::Succeeded {
                    version: "0.2.0".into(),
                },
                vec![],
            )
            .unwrap(),
        ),
        (
            "failed-installer-unavailable",
            new(
                failed(
                    "The release feed did not answer",
                    Some("UPGRADE_INSTALLER_UNAVAILABLE"),
                ),
                vec![],
            ),
        ),
        (
            "failed-installer-incompatible",
            new(
                failed(
                    "This version needs a newer installer",
                    Some("UPGRADE_INSTALLER_INCOMPATIBLE"),
                ),
                vec![],
            ),
        ),
        (
            "failed-downgrade-refused",
            new(
                failed(
                    "CoForge Computer 0.1.0 is older than the installed 0.2.0. Nothing was changed. To go back, run `coforge-computer upgrade --version 0.1.0 --allow-downgrade`.",
                    Some(ERROR_CODE_DOWNGRADE_REFUSED),
                ),
                vec![],
            ),
        ),
        (
            "failed",
            new(failed("Could not create the staging directory", None), vec![]),
        ),
        (
            "rolled-back",
            new(
                ReceiptOutcome::RolledBack {
                    error: "Computer supervisor did not report 0.2.0".into(),
                    restored_version: "0.1.0".into(),
                },
                dead_processes(),
            ),
        ),
        (
            "held",
            new(
                ReceiptOutcome::Held {
                    error: "Version 0.1.0 is older than the installed 0.2.0, so the installer held the upgrade before changing anything".into(),
                    error_code: None,
                },
                vec![],
            ),
        ),
        (
            "unresolved",
            new(
                ReceiptOutcome::Unresolved {
                    error: "Computer supervisor did not report 0.2.0; rollback failed: Computer supervisor did not report 0.1.0".into(),
                    rollback_failed: true,
                },
                dead_processes(),
            ),
        ),
        (
            "unresolved-no-previous-version",
            new(
                ReceiptOutcome::Unresolved {
                    error: "Computer supervisor did not report 0.1.0 and no previous version existed".into(),
                    rollback_failed: false,
                },
                dead_processes(),
            ),
        ),
    ]
}

#[test]
fn receipt_cases() {
    let cases: ReceiptCases = golden("receipt-cases.json");
    let built: BTreeMap<&str, UpgradeReceipt> = constructed_receipts().into_iter().collect();
    assert_eq!(
        built.keys().copied().collect::<BTreeSet<_>>(),
        cases
            .allowed
            .iter()
            .map(|case| case.slug.as_str())
            .collect::<BTreeSet<_>>(),
        "the constructed receipts are not the allowed rows"
    );
    for case in &cases.allowed {
        let parsed: UpgradeReceipt = serde_json::from_value(case.receipt.clone())
            .unwrap_or_else(|error| panic!("{} is refused: {error}", case.slug));
        assert_eq!(
            serde_json::to_value(&parsed).unwrap(),
            case.receipt,
            "{} does not round-trip",
            case.slug
        );
        // Built from its outcome, the receipt is the row: its exit code is derived, not chosen.
        let mut expected = case.receipt.clone();
        expected["installer_version"] = env!("CARGO_PKG_VERSION").into();
        assert_eq!(
            serde_json::to_value(&built[case.slug.as_str()]).unwrap(),
            expected,
            "{} is not what the constructor builds",
            case.slug
        );
    }
    for case in &cases.rejected {
        assert!(
            serde_json::from_value::<UpgradeReceipt>(case.receipt.clone()).is_err(),
            "{} is accepted",
            case.name
        );
    }
}

#[test]
fn a_receipt_is_only_built_in_a_valid_shape() {
    let build = |outcome, stopped| UpgradeReceipt::new(REQUEST_ID, outcome, stopped);
    let held = |error: &str, error_code: Option<&str>| ReceiptOutcome::Held {
        error: error.into(),
        error_code: error_code.map(Into::into),
    };
    let failed = |error: &str, error_code: Option<&str>| ReceiptOutcome::Failed {
        error: error.into(),
        error_code: error_code.map(Into::into),
    };

    // The exit code follows the outcome; nothing else picks it.
    assert_eq!(
        build(held("why", None), vec![]).unwrap().exit_code(),
        EXIT_HELD
    );
    assert_eq!(
        build(failed("why", None), vec![]).unwrap().exit_code(),
        EXIT_FAILED
    );
    let unresolved = |rollback_failed| ReceiptOutcome::Unresolved {
        error: "why".into(),
        rollback_failed,
    };
    let rollback_failed = build(unresolved(true), vec![]).unwrap();
    assert_eq!(rollback_failed.exit_code(), EXIT_UNRESOLVED);
    assert_eq!(
        rollback_failed.error_code(),
        Some(ERROR_CODE_ROLLBACK_FAILED)
    );
    let nothing_to_restore = build(unresolved(false), vec![]).unwrap();
    assert_eq!(nothing_to_restore.exit_code(), EXIT_UNRESOLVED);
    assert_eq!(nothing_to_restore.error_code(), None);

    // A receipt that is not succeeded says why, and only the outcome that means it names a
    // rollback code.
    assert!(build(held("", None), vec![]).is_err());
    assert!(build(failed("", None), vec![]).is_err());
    assert!(build(held("why", Some(ERROR_CODE_ROLLED_BACK)), vec![]).is_err());
    assert!(build(held("why", Some(ERROR_CODE_ROLLBACK_FAILED)), vec![]).is_err());
    assert!(build(failed("why", Some(ERROR_CODE_ROLLED_BACK)), vec![]).is_err());
    assert!(build(failed("why", Some(ERROR_CODE_ROLLBACK_FAILED)), vec![]).is_err());
    assert!(build(failed("why", Some("not-a-code")), vec![]).is_err());
    let no_restored_version = ReceiptOutcome::RolledBack {
        error: "why".into(),
        restored_version: String::new(),
    };
    assert!(build(no_restored_version, vec![]).is_err());

    // Processes are named exactly when some were stopped, and each is a real identity.
    let stopped_nothing = build(failed("why", None), vec![]).unwrap();
    assert_eq!(stopped_nothing.dead_process_identities(), None);
    assert!(
        serde_json::to_value(&stopped_nothing)
            .unwrap()
            .get("deadProcessIdentities")
            .is_none()
    );
    let dead = |pid, started_at: &str, executable: &str| DeadProcessIdentity {
        pid,
        started_at: started_at.into(),
        executable: executable.into(),
    };
    assert!(build(failed("why", None), vec![dead(1, "7", "/bin/x")]).is_ok());
    assert!(build(failed("why", None), vec![dead(0, "7", "/bin/x")]).is_err());
    assert!(build(failed("why", None), vec![dead(1, "", "/bin/x")]).is_err());
    assert!(build(failed("why", None), vec![dead(1, "7", "")]).is_err());
}

#[test]
fn emits_receipts() {
    for (slug, receipt) in constructed_receipts() {
        let text = to_file_json(&receipt);
        assert!(
            text.len() as u64 <= RECEIPT_MAX_BYTES,
            "{slug} is too large"
        );
        emit(&format!("receipt.{slug}.json"), &text);
    }
}
