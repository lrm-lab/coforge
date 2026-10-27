//! The switch registers the service definition of the executable it activates before it starts
//! the supervisor, in an upgrade, in its rollback, and in recovery.

use super::*;
use crate::recover::{RecoverOutcome, recover};

const INSTALLING: &str = "Installing the Computer supervisor service definition";

/// An upgrade from a running [`OLD`] to [`NEW`], both of which print their service definition. The
/// new supervisor comes up, as `script_running_upgrade` has it.
fn script_reporting_upgrade(fixture: &Fixture, lifecycle: &FakeLifecycle) {
    for version in [OLD, NEW] {
        fixture.reports_service_definition(lifecycle, version);
    }
    lifecycle.answers_status(&fixture.computer(OLD), vec![Some(running(OLD, "old-id"))]);
    lifecycle.answers_status(
        &fixture.computer(NEW),
        vec![Some(stopped(NEW)), Some(running(NEW, "new-id"))],
    );
}

/// An upgrade whose new supervisor never reports, so that it rolls back to a restarted [`OLD`].
fn script_rolling_back_upgrade(fixture: &Fixture, lifecycle: &FakeLifecycle) {
    for version in [OLD, NEW] {
        fixture.reports_service_definition(lifecycle, version);
    }
    lifecycle.answers_status(
        &fixture.computer(OLD),
        vec![
            Some(running(OLD, "old-id")),
            Some(running(OLD, "restored-id")),
        ],
    );
    lifecycle.answers_status(&fixture.computer(NEW), vec![Some(stopped(NEW))]);
}

#[test]
fn an_upgrade_installs_the_new_definition_before_it_starts_a_service_whose_definition_vanished() {
    // The incident: the job is loaded and running, but the file the manager would start it from
    // is gone, so the stop leaves nothing to start.
    let fixture = Fixture::new("upgrade-definition-vanished");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) }).without_definition();
    let lifecycle = FakeLifecycle::default();
    script_reporting_upgrade(&fixture, &lifecycle);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, stages) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 0, "{outcome:?}");
    assert_eq!(receipt(&outcome).version(), Some(NEW));
    assert_eq!(active(&fixture), active_state(NEW, Some(OLD)));
    assert_eq!(service.calls(), ["state", "stop", "install", "start"]);
    assert_eq!(service.installed(), [service_definition(NEW)]);
    let position = |line: &str| stages.iter().position(|stage| stage == line).unwrap();
    assert_eq!(
        position(INSTALLING) + 1,
        position("Starting Computer supervisor 0.2.0")
    );
}

#[test]
fn a_rollback_installs_the_definition_of_the_version_it_restores() {
    let fixture = Fixture::new("upgrade-definition-rollback");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    script_rolling_back_upgrade(&fixture, &lifecycle);
    // `current/` holds the new version for the first switch and the restored one for the second.
    let running = fixture.running_computer(NEW);
    lifecycle.answers_service_definition(
        &running,
        vec![Some(service_definition(NEW)), Some(service_definition(OLD))],
    );
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    assert_eq!(receipt(&outcome).restored_version(), Some(OLD));
    assert_eq!(
        service.calls(),
        [
            "state", "stop", "install", "start", "stop", "install", "start"
        ]
    );
    assert_eq!(
        service.installed(),
        [service_definition(NEW), service_definition(OLD)]
    );
}

#[test]
fn a_definition_the_new_computer_cannot_print_rolls_the_upgrade_back() {
    let fixture = Fixture::new("upgrade-definition-unreadable");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    script_rolling_back_upgrade(&fixture, &lifecycle);
    lifecycle.answers_service_definition(
        &fixture.running_computer(NEW),
        vec![None, Some(service_definition(OLD))],
    );
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    let receipt = receipt(&outcome);
    assert_eq!(receipt.error_code(), Some(ERROR_CODE_ROLLED_BACK));
    assert_eq!(receipt.restored_version(), Some(OLD));
    assert!(
        receipt.error().unwrap().contains("service-definition"),
        "{:?}",
        receipt.error()
    );
    assert_eq!(
        service.calls(),
        ["state", "stop", "stop", "install", "start"]
    );
    assert_eq!(service.installed(), [service_definition(OLD)]);
}

#[test]
fn a_computer_that_lists_no_commands_is_started_as_before() {
    let fixture = Fixture::new("upgrade-definition-older-computer");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    script_running_upgrade(&fixture, &lifecycle);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, stages) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 0, "{outcome:?}");
    assert_eq!(service.calls(), ["state", "stop", "start"]);
    assert!(service.installed().is_empty());
    assert!(!stages.iter().any(|stage| stage == INSTALLING));
}

#[test]
fn an_active_definition_that_cannot_be_read_refuses_the_upgrade_before_anything_stops() {
    let fixture = Fixture::new("upgrade-definition-active-unreadable");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    script_reporting_upgrade(&fixture, &lifecycle);
    lifecycle.answers_service_definition(&fixture.computer(OLD), vec![None]);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 1);
    let receipt = receipt(&outcome);
    assert_eq!(receipt.status(), ReceiptStatus::Failed);
    assert_eq!(receipt.error_code(), None);
    assert!(receipt.error().unwrap().contains("service-definition"));
    assert_eq!(service.calls(), ["state"]);
    assert!(table.signals().is_empty());
    assert_eq!(active(&fixture), active_state(OLD, None));
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
}

#[test]
fn recovery_installs_the_restored_definition_before_it_starts() {
    let fixture = Fixture::new("recover-definition");
    fixture.install_old();
    fixture.install(NEW);
    fixture.activate(NEW, Some(OLD));
    // The interrupted candidate no longer verifies, so recovery restores the previous version.
    fs::write(fixture.computer(NEW), b"").unwrap();
    let lock = MachineMutationLock::acquire(fixture.root()).unwrap();
    Journal::new(fixture.root())
        .record(
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
    drop(lock);
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::Stopped).without_definition();
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);
    lifecycle.answers_status(
        &fixture.computer(OLD),
        vec![Some(running(OLD, "restored-id"))],
    );
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let outcome = recover(&ports, None, &mut |_| {});

    assert_eq!(
        outcome,
        RecoverOutcome::Recovered {
            version: OLD.to_owned()
        }
    );
    assert_eq!(service.calls(), ["stop", "install", "start"]);
    assert_eq!(service.installed(), [service_definition(OLD)]);
}
