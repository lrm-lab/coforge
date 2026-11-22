use super::*;

fn tracked_progress(fixture: &Fixture) -> PathBuf {
    let directory = fixture.root().join("upgrade-progress").join(REQUEST);
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join("context.json"),
        serde_json::to_vec(&serde_json::json!({
            "generation": OTHER_REQUEST,
            "version": NEW,
        }))
        .unwrap(),
    )
    .unwrap();
    directory
}

#[test]
fn tracked_journal_file_sync_and_rename_failures_leave_no_change_for_recovery() {
    use crate::private_fs::{DurableReplaceStep, FAIL_DURABLE_REPLACE};
    use crate::recover::{RecoverOutcome, recover};

    for step in [DurableReplaceStep::FileSync, DurableReplaceStep::Rename] {
        let fixture = Fixture::new("tracked-uncommitted");
        fixture.install_old();
        let progress = tracked_progress(&fixture);
        let clock = VirtualClock::new();
        let table = FakeTable::new(&clock);
        let service = FakeService::new(ServiceState::Running { pid: Some(100) });
        let lifecycle = FakeLifecycle::default();
        script_running_upgrade(&fixture, &lifecycle);
        let ports = fixture.ports(&lifecycle, &service, &table, &clock);

        FAIL_DURABLE_REPLACE.set(Some(step));
        let (outcome, _) = run(&ports, REQUEST, NEW, None);
        assert_eq!(receipt(&outcome).status(), ReceiptStatus::Failed);
        assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
        assert!(!progress.join("switching.json").exists());
        assert!(!progress.join("activated.json").exists());
        assert_eq!(active(&fixture), active_state(OLD, None));
        assert_eq!(
            recover(&ports, None, &mut |_| {}),
            RecoverOutcome::NothingToRecover
        );
        assert_eq!(service.calls(), ["state"]);
        assert!(!progress.join("recovery.json").exists());
    }
}

#[cfg(unix)]
#[test]
fn tracked_journal_directory_sync_failure_remains_uncertain_until_recovery_can_commit() {
    use crate::private_fs::{DurableReplaceStep, FAIL_DURABLE_REPLACE};
    use crate::recover::{RecoverOutcome, recover};

    let fixture = Fixture::new("tracked-uncertain");
    fixture.install_old();
    let progress = tracked_progress(&fixture);
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    script_running_upgrade(&fixture, &lifecycle);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    FAIL_DURABLE_REPLACE.set(Some(DurableReplaceStep::DirectorySync));
    let (outcome, _) = run(&ports, REQUEST, NEW, None);
    assert_eq!(exit_of(&outcome), EXIT_UNRESOLVED);
    assert!(Journal::new(fixture.root()).read().unwrap().is_some());
    assert!(progress.join("uncertain.json").exists());
    assert!(!progress.join("switching.json").exists());
    assert!(!progress.join("activated.json").exists());
    assert_eq!(active(&fixture), active_state(OLD, None));

    FAIL_DURABLE_REPLACE.set(Some(DurableReplaceStep::DirectorySync));
    assert!(matches!(
        recover(&ports, None, &mut |_| {}),
        RecoverOutcome::Unresolved { .. }
    ));
    assert_eq!(service.calls(), ["state"]);
    assert!(!progress.join("recovery.json").exists());

    lifecycle.answers_status(&fixture.computer(OLD), vec![Some(running(OLD, "restored"))]);
    assert_eq!(
        recover(&ports, None, &mut |_| {}),
        RecoverOutcome::Recovered {
            version: OLD.to_owned()
        }
    );
    let evidence = fs::read(progress.join("recovery.json")).unwrap();
    let evidence: serde_json::Value = serde_json::from_slice(&evidence).unwrap();
    assert_eq!(evidence["outcome"], "rolled_back");
    assert_eq!(evidence["restoredVersion"], OLD);
}

#[test]
fn tracked_committed_journal_survives_interruption_before_stop_or_activate() {
    use crate::recover::{RecoverOutcome, recover};
    use std::panic::{AssertUnwindSafe, catch_unwind};

    for running_supervisor in [false, true] {
        let fixture = Fixture::new("tracked-interrupted");
        fixture.install_old();
        let progress = tracked_progress(&fixture);
        let clock = VirtualClock::new();
        let table = FakeTable::new(&clock);
        let service = FakeService::new(if running_supervisor {
            ServiceState::Running { pid: Some(100) }
        } else {
            ServiceState::Stopped
        });
        let lifecycle = FakeLifecycle::default();
        script_running_upgrade(&fixture, &lifecycle);
        if !running_supervisor {
            lifecycle.answers_status(&fixture.computer(OLD), vec![Some(stopped(OLD))]);
        }
        let ports = fixture.ports(&lifecycle, &service, &table, &clock);
        let request = UpgradeRequest {
            request_id: REQUEST,
            selection: NEW,
            caller: None,
            allow_downgrade: false,
        };
        let before = if running_supervisor {
            "Stopping"
        } else {
            "Switching to"
        };
        let interrupted = catch_unwind(AssertUnwindSafe(|| {
            upgrade(&ports, &request, &mut |stage| {
                assert!(!stage.starts_with(before), "injected before {before}");
            })
        }));
        assert!(interrupted.is_err());
        assert!(Journal::new(fixture.root()).read().unwrap().is_some());
        assert_eq!(active(&fixture), active_state(OLD, None));
        assert!(!progress.join("activated.json").exists());
        assert!(!service.calls().iter().any(|call| call == &"stop"));

        fixture.answers_protocol(&lifecycle, OLD);
        lifecycle.answers_status(&fixture.computer(OLD), vec![Some(running(OLD, "restored"))]);
        assert_eq!(
            recover(&ports, None, &mut |_| {}),
            RecoverOutcome::Recovered {
                version: OLD.to_owned()
            }
        );
        assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
        let evidence = fs::read(progress.join("recovery.json")).unwrap();
        let evidence: serde_json::Value = serde_json::from_slice(&evidence).unwrap();
        assert_eq!(evidence["generation"], OTHER_REQUEST);
        assert_eq!(evidence["outcome"], "rolled_back");
        assert_eq!(evidence["restoredVersion"], OLD);
    }
}

#[test]
fn tracked_recovery_publishes_target_activation_without_overwriting_original_receipt() {
    use crate::contract::ReceiptOutcome;
    use crate::recover::{RecoverOutcome, recover};

    let fixture = Fixture::new("tracked-recover-target");
    fixture.install_old();
    fixture.install(NEW);
    fixture.activate(NEW, Some(OLD));
    let progress = tracked_progress(&fixture);
    fs::write(
        progress.join("receipt.json"),
        br#"{"outcome":"unresolved"}"#,
    )
    .unwrap();
    let journal = Journal::new(fixture.root());
    let receipts = ReceiptStore::new(fixture.root());
    let lock = MachineMutationLock::acquire(fixture.root()).unwrap();
    journal
        .record_switch(
            &lock,
            &Transaction {
                request_id: REQUEST.to_owned(),
                from: Some(OLD.to_owned()),
                from_previous: None,
                to: NEW.to_owned(),
                supervisor_running: true,
            },
        )
        .unwrap();
    let original = UpgradeReceipt::new(
        REQUEST,
        ReceiptOutcome::Unresolved {
            error: "fixture".to_owned(),
            rollback_failed: true,
        },
        Vec::new(),
    )
    .unwrap();
    receipts.commit(&lock, &original).unwrap();
    drop(lock);

    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::Stopped);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocols(&lifecycle);
    lifecycle.answers_status(&fixture.computer(NEW), vec![Some(running(NEW, "new"))]);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    assert_eq!(
        recover(&ports, None, &mut |_| {}),
        RecoverOutcome::Recovered {
            version: NEW.to_owned()
        }
    );
    assert_eq!(receipts.read(REQUEST).unwrap(), Some(original));
    assert_eq!(journal.read().unwrap(), None);
    assert!(progress.join("activated.json").exists());
    assert!(progress.join("healthy.json").exists());
    assert_eq!(
        fs::read(progress.join("receipt.json")).unwrap(),
        br#"{"outcome":"unresolved"}"#
    );
    let recovery = fs::read(progress.join("recovery.json")).unwrap();
    let evidence: serde_json::Value = serde_json::from_slice(&recovery).unwrap();
    assert_eq!(evidence["outcome"], "promoted");
    assert_eq!(evidence["oldProcesses"], "verified");
    assert_eq!(evidence["generation"], OTHER_REQUEST);
}
