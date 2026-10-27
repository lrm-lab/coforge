use super::*;
use crate::clock::VirtualClock;
use crate::contract::{EXIT_FAILED, EXIT_HELD, EXIT_SUCCEEDED};
use crate::journal::{Journal, Transaction};
use crate::lock::MachineMutationLock;
use crate::processes::fakes::FakeTable;
use crate::service::ServiceState;
use crate::upgrade::fakes::{FakeLifecycle, FakeService, Fixture, NEW, OLD, service_definition};

const REGISTERED: &str = "Registered the Computer supervisor service definition";
const STARTING: &str = "Starting Computer supervisor 0.1.0";
const STARTED: &str = "Computer supervisor 0.1.0 started";

fn run_start(
    fixture: &Fixture,
    service: &FakeService,
    lifecycle: &FakeLifecycle,
) -> (Outcome, Vec<String>) {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let ports = fixture.ports(lifecycle, service, &table, &clock);
    let mut stages = Vec::new();
    let outcome = start(&ports, &mut |line| stages.push(line.to_owned()));
    (outcome, stages)
}

fn failure_message(outcome: Outcome) -> String {
    match outcome {
        Outcome::Failed { message } => message,
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[test]
fn start_registers_the_active_definition_then_starts_the_service() {
    let fixture = Fixture::new("start-registers");
    fixture.install_old();
    // The manager holds no definition, as when the Computer finds its service not registered.
    let service = FakeService::new(ServiceState::NotInstalled).without_definition();
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);

    let (outcome, stages) = run_start(&fixture, &service, &lifecycle);

    assert_eq!(
        outcome,
        Outcome::Started {
            version: OLD.to_owned()
        }
    );
    assert_eq!(outcome.exit_code(), EXIT_SUCCEEDED);
    assert_eq!(service.calls(), ["install", "start"]);
    assert_eq!(service.installed(), [service_definition(OLD)]);
    assert_eq!(stages, [REGISTERED, STARTING, STARTED]);
}

#[test]
fn an_unfinished_upgrade_does_not_stop_the_service_from_starting() {
    let fixture = Fixture::new("start-journal");
    fixture.install_old();
    {
        let lock = MachineMutationLock::acquire(fixture.root()).unwrap();
        Journal::new(fixture.root())
            .record(
                &lock,
                &Transaction {
                    request_id: crate::upgrade::fakes::REQUEST.to_owned(),
                    from: Some(OLD.to_owned()),
                    from_previous: None,
                    to: NEW.to_owned(),
                    supervisor_running: false,
                },
            )
            .unwrap();
    }
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);

    let (outcome, _) = run_start(&fixture, &service, &lifecycle);

    assert_eq!(outcome.exit_code(), EXIT_SUCCEEDED, "{outcome:?}");
    assert_eq!(service.calls(), ["install", "start"]);
    // Starting the active version switches nothing: the journal is still the recovery's to settle.
    assert!(Journal::new(fixture.root()).read().unwrap().is_some());
}

#[test]
fn another_operation_holding_the_machine_lock_holds_the_start() {
    let fixture = Fixture::new("start-held");
    fixture.install_old();
    let _held = MachineMutationLock::acquire(fixture.root()).unwrap();
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);

    let (outcome, stages) = run_start(&fixture, &service, &lifecycle);

    let Outcome::Held { message } = &outcome else {
        panic!("expected a hold, got {outcome:?}");
    };
    assert_eq!(
        message,
        "another install, upgrade, recovery, or repair is running. Nothing was changed."
    );
    assert_eq!(outcome.exit_code(), EXIT_HELD);
    assert!(service.calls().is_empty());
    assert!(stages.is_empty());
}

#[test]
fn a_computer_that_cannot_report_its_definition_is_not_registered_or_started() {
    let fixture = Fixture::new("start-older-computer");
    fixture.install_old();
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, OLD);

    let (outcome, stages) = run_start(&fixture, &service, &lifecycle);

    assert_eq!(outcome.exit_code(), EXIT_FAILED);
    let message = failure_message(outcome);
    assert!(
        message.contains("cannot report its service definition")
            && message.contains("coforge-computer upgrade"),
        "{message}"
    );
    assert!(service.calls().is_empty());
    assert!(stages.is_empty());
}

#[test]
fn a_definition_that_cannot_be_read_fails_before_the_service_is_touched() {
    let fixture = Fixture::new("start-unreadable");
    fixture.install_old();
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);
    lifecycle.answers_service_definition(&fixture.computer(OLD), vec![None]);

    let (outcome, _) = run_start(&fixture, &service, &lifecycle);

    let message = failure_message(outcome);
    assert!(message.contains("service-definition"), "{message}");
    assert!(service.calls().is_empty());
}

#[test]
fn nothing_installed_fails_without_touching_the_service() {
    let fixture = Fixture::new("start-nothing-installed");
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();

    let (outcome, _) = run_start(&fixture, &service, &lifecycle);

    assert_eq!(outcome.exit_code(), EXIT_FAILED);
    let message = failure_message(outcome);
    assert!(
        message.contains("no CoForge Computer is installed"),
        "{message}"
    );
    assert!(service.calls().is_empty());
}

#[test]
fn inside_the_service_unit_the_start_is_refused() {
    let fixture = Fixture::new("start-inside-unit");
    fixture.install_old();
    let service = FakeService::new(ServiceState::Running { pid: Some(7) }).inside_unit();
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);

    let (outcome, stages) = run_start(&fixture, &service, &lifecycle);

    assert_eq!(outcome.exit_code(), EXIT_FAILED);
    let message = failure_message(outcome);
    assert!(message.contains("coforge-daemon.service"), "{message}");
    assert!(message.contains("coforge-computer start"), "{message}");
    assert!(message.contains("Nothing was changed"), "{message}");
    // Only the inside-the-unit check read the state: nothing was registered or started.
    assert_eq!(service.calls(), ["state"]);
    assert!(stages.is_empty());
}

#[test]
fn a_registration_the_manager_leaves_as_it_is_is_reported_and_the_service_still_started() {
    let fixture = Fixture::new("start-windows-running");
    fixture.install_old();
    let service =
        FakeService::new(ServiceState::Running { pid: None }).keeping_a_running_registration();
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);

    let (outcome, stages) = run_start(&fixture, &service, &lifecycle);

    assert_eq!(outcome.exit_code(), EXIT_SUCCEEDED, "{outcome:?}");
    assert_eq!(service.calls(), ["install", "start"]);
    assert!(service.installed().is_empty());
    assert_eq!(
        stages,
        [
            "The Computer supervisor service is running; its registration is left as it is",
            STARTING,
            STARTED
        ]
    );
}
