use std::fs;

use super::*;
use crate::active::read_active;
use crate::clock::VirtualClock;
use crate::contract::ReceiptOutcome;
use crate::contract::{
    ACTIVE_STATE_SCHEMA_VERSION, ActiveState, ERROR_CODE_ROLLED_BACK, UpgradeReceipt,
};
use crate::journal::{Journal, Transaction};
use crate::lock::MachineMutationLock;
use crate::processes::VerifiedCaller;
use crate::processes::fakes::FakeTable;
use crate::receipts::ReceiptStore;
use crate::service::ServiceState;
use crate::upgrade::fakes::*;
use crate::upgrade::{Outcome, UpgradeRequest, upgrade};

const OTHER_REQUEST: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

fn recover_with(ports: &Ports<'_>) -> (RecoverOutcome, Vec<String>) {
    let mut stages = Vec::new();
    let outcome = recover(ports, None, &mut |stage| stages.push(stage.to_owned()));
    (outcome, stages)
}

fn journal(
    from: Option<&str>,
    from_previous: Option<&str>,
    supervisor_running: bool,
) -> Transaction {
    Transaction {
        request_id: REQUEST.to_owned(),
        from: from.map(str::to_owned),
        from_previous: from_previous.map(str::to_owned),
        to: NEW.to_owned(),
        supervisor_running,
    }
}

fn record_journal(fixture: &Fixture, transaction: &Transaction) {
    let lock = MachineMutationLock::acquire(fixture.root()).unwrap();
    Journal::new(fixture.root())
        .record(&lock, transaction)
        .unwrap();
}

fn stored(fixture: &Fixture) -> Option<UpgradeReceipt> {
    ReceiptStore::new(fixture.root()).read(REQUEST).unwrap()
}

fn active(fixture: &Fixture) -> Option<ActiveState> {
    read_active(fixture.root()).unwrap()
}

fn active_state(current: &str, previous: Option<&str>) -> Option<ActiveState> {
    Some(ActiveState {
        schema_version: ACTIVE_STATE_SCHEMA_VERSION,
        current: current.to_owned(),
        previous: previous.map(str::to_owned),
    })
}

#[test]
fn with_no_journal_there_is_nothing_to_recover_and_nothing_runs() {
    let fixture = Fixture::new("recover-none");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = recover_with(&ports);

    assert_eq!(outcome, RecoverOutcome::NothingToRecover);
    assert_eq!(outcome.exit_code(), 0);
    assert!(service.calls().is_empty());
    assert_eq!(active(&fixture), active_state(OLD, None));
}

#[test]
fn an_upgrade_killed_mid_transaction_is_restored_and_its_rollback_is_recorded() {
    let fixture = Fixture::new("recover-killed");
    fixture.install_old();
    // The switch had moved `active` to the new version and stopped the old supervisor when the
    // process was killed: the journal says what to restore, and no receipt was written.
    fixture.install(NEW);
    fixture.activate(NEW, Some(OLD));
    // The interrupted candidate no longer verifies, so recovery cannot settle on it.
    fs::write(fixture.computer(NEW), b"").unwrap();
    record_journal(&fixture, &journal(Some(OLD), None, true));
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    // Both run `current/coforge-computer`, which holds the new version's files.
    table.spawn(100, 1, &fixture.canonical_current());
    table.spawn(200, 2, &fixture.canonical_current());
    let service = FakeService::new(ServiceState::Stopped);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, OLD);
    lifecycle.answers_status(
        &fixture.computer(OLD),
        vec![Some(running(OLD, "restored-id"))],
    );
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = recover_with(&ports);

    assert_eq!(
        outcome,
        RecoverOutcome::Recovered {
            version: OLD.to_owned()
        }
    );
    assert_eq!(active(&fixture), active_state(OLD, None));
    // `current/` is synced back to the restored version.
    #[cfg(unix)]
    assert_eq!(
        fs::read_to_string(fixture.root().join("current/version")).unwrap(),
        "0.1.0\n"
    );
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    assert_eq!(service.calls(), ["stop", "start"]);
    let receipt = stored(&fixture).expect("a receipt for the interrupted upgrade");
    assert_eq!(receipt.status(), crate::contract::ReceiptStatus::Failed);
    assert_eq!(receipt.error_code(), Some(ERROR_CODE_ROLLED_BACK));
    assert_eq!(receipt.restored_version(), Some(OLD));
    assert_eq!(
        receipt.error(),
        Some("the upgrade was interrupted before it finished")
    );
    let dead: Vec<u32> = receipt
        .dead_process_identities()
        .unwrap()
        .iter()
        .map(|process| process.pid)
        .collect();
    assert_eq!(dead, [100, 200]);
}

#[test]
fn an_interrupted_first_install_is_recovered_to_the_new_version_and_reported_succeeded() {
    let fixture = Fixture::new("recover-first-install");
    fixture.install(NEW);
    fixture.activate(NEW, None);
    record_journal(&fixture, &journal(None, None, false));
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = recover_with(&ports);

    assert_eq!(
        outcome,
        RecoverOutcome::Recovered {
            version: NEW.to_owned()
        }
    );
    assert_eq!(active(&fixture), active_state(NEW, None));
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    let receipt = stored(&fixture).expect("a receipt");
    assert_eq!(receipt.status(), crate::contract::ReceiptStatus::Succeeded);
    assert_eq!(receipt.version(), Some(NEW));
    assert!(service.calls().is_empty());
}

#[test]
fn an_upgrade_whose_success_was_recorded_but_whose_journal_was_not_cleared_keeps_the_new_version() {
    let fixture = Fixture::new("recover-succeeded");
    fixture.install(OLD);
    fixture.install(NEW);
    fixture.activate(NEW, Some(OLD));
    record_journal(&fixture, &journal(Some(OLD), None, false));
    {
        let lock = MachineMutationLock::acquire(fixture.root()).unwrap();
        ReceiptStore::new(fixture.root())
            .commit(
                &lock,
                &UpgradeReceipt::new(
                    REQUEST,
                    ReceiptOutcome::Succeeded {
                        version: NEW.to_owned(),
                    },
                    Vec::new(),
                )
                .unwrap(),
            )
            .unwrap();
    }
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = recover_with(&ports);

    assert_eq!(
        outcome,
        RecoverOutcome::Recovered {
            version: NEW.to_owned()
        }
    );
    assert_eq!(active(&fixture), active_state(NEW, Some(OLD)));
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    assert_eq!(stored(&fixture).unwrap().version(), Some(NEW));
}

#[test]
fn a_rollback_that_failed_is_completed_by_recover_without_a_second_receipt() {
    let fixture = Fixture::new("recover-unresolved");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, OLD);
    fixture.answers_protocol(&lifecycle, NEW);
    lifecycle.answers_status(
        &fixture.computer(OLD),
        vec![Some(running(OLD, "old-id")), None],
    );
    lifecycle.answers_status(&fixture.computer(NEW), vec![Some(stopped(NEW))]);
    {
        let ports = fixture.ports(&lifecycle, &service, &table, &clock);
        let mut sink = |_: &str| {};
        let request = UpgradeRequest {
            request_id: REQUEST,
            selection: NEW,
            caller: None,
            allow_downgrade: false,
        };
        let outcome = upgrade(&ports, &request, &mut sink);
        assert!(matches!(outcome, Outcome::Receipt(ref receipt) if receipt.exit_code() == 3));
    }
    let unresolved = stored(&fixture).expect("the unresolved receipt");

    // The previous version works again; recovery restores it and writes nothing new.
    lifecycle.answers_status(
        &fixture.computer(OLD),
        vec![Some(running(OLD, "recovered-id"))],
    );
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let (outcome, _) = recover_with(&ports);

    assert_eq!(
        outcome,
        RecoverOutcome::Recovered {
            version: OLD.to_owned()
        }
    );
    assert_eq!(stored(&fixture), Some(unresolved));
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    assert_eq!(active(&fixture), active_state(OLD, None));
    let other = ReceiptStore::new(fixture.root())
        .read(OTHER_REQUEST)
        .unwrap();
    assert!(other.is_none());
}

#[test]
fn an_installed_version_that_no_longer_verifies_is_not_restored() {
    let fixture = Fixture::new("recover-verify");
    fixture.install_old();
    fixture.install(NEW);
    fixture.activate(NEW, Some(OLD));
    // The interrupted candidate no longer verifies, so recovery cannot settle on it.
    fs::write(fixture.computer(NEW), b"").unwrap();
    record_journal(&fixture, &journal(Some(OLD), None, true));
    fs::write(fixture.computer(OLD), b"tampered").unwrap();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::Stopped);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = recover_with(&ports);

    match &outcome {
        RecoverOutcome::Unresolved { message } => assert!(message.contains("0.1.0")),
        other => panic!("expected unresolved, got {other:?}"),
    }
    assert_eq!(outcome.exit_code(), 3);
    assert!(service.calls().is_empty());
    assert_eq!(active(&fixture), active_state(NEW, Some(OLD)));
    assert!(Journal::new(fixture.root()).read().unwrap().is_some());
    assert!(stored(&fixture).is_none());
}

#[test]
fn a_held_machine_lock_stops_recovery_with_exit_2() {
    let fixture = Fixture::new("recover-held");
    fixture.install_old();
    record_journal(&fixture, &journal(Some(OLD), None, false));
    let _held = MachineMutationLock::acquire(fixture.root()).unwrap();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = recover_with(&ports);

    assert!(matches!(outcome, RecoverOutcome::Held { .. }));
    assert_eq!(outcome.exit_code(), 2);
    assert!(Journal::new(fixture.root()).read().unwrap().is_some());
}

#[test]
fn a_success_whose_receipt_could_not_be_written_is_kept_by_recover() {
    let fixture = Fixture::new("recover-unwritten-success");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    lifecycle.answers_status(&fixture.computer(OLD), vec![Some(stopped(OLD))]);
    let result = fixture
        .root()
        .join("upgrade-results")
        .join(format!("{REQUEST}.result.json"));
    {
        let ports = fixture.ports(&lifecycle, &service, &table, &clock);
        // The receipt cannot be written once the request is recorded: a directory stands where
        // the result file goes, so the commit after the switch is refused.
        let mut block = |line: &str| {
            if line.starts_with("Verifying current version") {
                fs::create_dir(&result).unwrap();
            }
        };
        let request = UpgradeRequest {
            request_id: REQUEST,
            selection: NEW,
            caller: None,
            allow_downgrade: false,
        };
        match upgrade(&ports, &request, &mut block) {
            Outcome::NoReceipt { exit, message } => {
                assert_eq!(exit, 3);
                assert!(message.contains("is active"));
            }
            other => panic!("expected no receipt, got {other:?}"),
        }
    }
    assert_eq!(active(&fixture), active_state(NEW, Some(OLD)));
    assert!(Journal::new(fixture.root()).read().unwrap().is_some());
    fs::remove_dir(&result).unwrap();

    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let (outcome, _) = recover_with(&ports);

    assert_eq!(
        outcome,
        RecoverOutcome::Recovered {
            version: NEW.to_owned()
        }
    );
    assert_eq!(active(&fixture), active_state(NEW, Some(OLD)));
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    let receipt = stored(&fixture).expect("the success is recorded");
    assert_eq!(receipt.status(), crate::contract::ReceiptStatus::Succeeded);
    assert_eq!(receipt.version(), Some(NEW));
}

#[test]
fn the_verified_caller_is_never_collected_or_signalled_during_recovery() {
    let fixture = Fixture::new("recover-caller");
    fixture.install(OLD);
    fixture.install(NEW);
    fixture.activate(NEW, Some(OLD));
    record_journal(&fixture, &journal(Some(OLD), None, true));
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    // `coforge-computer upgrade` (pid 42) runs the active product executable and waits for this
    // installer (pid 7), which is its child.
    table.spawn(7, 1, "/usr/bin/coforge-installer");
    table.parent(7, 42);
    table.spawn(42, 2, &fixture.canonical_computer(OLD));
    table.spawn(100, 3, &fixture.canonical_computer(OLD));
    table.spawn(200, 4, &fixture.canonical_computer(NEW));
    let caller = VerifiedCaller::verify(&table, 7, 42).unwrap();
    let service = FakeService::new(ServiceState::Stopped);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, OLD);
    // The new supervisor never comes up, so recovery stops everything twice, then restores.
    lifecycle.answers_status(&fixture.computer(NEW), vec![Some(stopped(NEW))]);
    lifecycle.answers_status(
        &fixture.computer(OLD),
        vec![Some(running(OLD, "restored-id"))],
    );
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let mut stages = Vec::new();

    let outcome = recover(&ports, Some(caller), &mut |stage| {
        stages.push(stage.to_owned())
    });

    assert_eq!(
        outcome,
        RecoverOutcome::Recovered {
            version: OLD.to_owned()
        }
    );
    assert!(table.signals().iter().all(|(pid, _)| *pid != 42));
    let receipt = stored(&fixture).expect("a receipt");
    let dead: Vec<u32> = receipt
        .dead_process_identities()
        .unwrap()
        .iter()
        .map(|process| process.pid)
        .collect();
    assert_eq!(dead, [100, 200]);
}

#[test]
fn inside_the_supervisor_service_with_it_running_recovery_is_refused_and_keeps_the_journal() {
    let fixture = Fixture::new("recover-inside-running");
    fixture.install_old();
    record_journal(&fixture, &journal(Some(OLD), None, true));
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) }).inside_unit();
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, stages) = recover_with(&ports);

    assert_eq!(
        outcome,
        RecoverOutcome::Refused {
            message: "Recovery stops coforge-daemon.service, the service this process runs \
                      inside, so it would stop itself. Run `coforge-computer upgrade` from a \
                      normal terminal, not from inside the service. Nothing was changed."
                .to_owned(),
        }
    );
    assert_eq!(outcome.exit_code(), 1);
    assert!(stages.is_empty());
    assert_eq!(service.calls(), ["state"]);
    assert!(table.signals().is_empty());
    assert!(Journal::new(fixture.root()).read().unwrap().is_some());
    assert_eq!(active(&fixture), active_state(OLD, None));
    assert!(stored(&fixture).is_none());
}

/// An upgrade killed after it activated the new version: kept when it settles, else restored.
mod after_activation;
