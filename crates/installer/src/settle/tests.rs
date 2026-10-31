use std::fs;

use super::*;
use crate::clock::VirtualClock;
use crate::journal::{Journal, Transaction};
use crate::lock::MachineMutationLock;
use crate::processes::fakes::FakeTable;
use crate::service::ServiceState;
use crate::upgrade::fakes::*;

fn record_journal(fixture: &Fixture, supervisor_running: bool) {
    let lock = MachineMutationLock::acquire(fixture.root()).unwrap();
    Journal::new(fixture.root())
        .record(
            &lock,
            &Transaction {
                request_id: REQUEST.to_owned(),
                from: None,
                from_previous: None,
                to: NEW.to_owned(),
                supervisor_running,
            },
        )
        .unwrap();
}

/// A first install that was interrupted after activation: recovery settles on the new version.
fn recoverable() -> Fixture {
    let fixture = Fixture::new("settle-ok");
    fixture.install(NEW);
    fixture.activate(NEW, None);
    record_journal(&fixture, false);
    fixture
}

/// A journal recovery cannot settle: the version it would restore no longer verifies.
fn unrecoverable() -> Fixture {
    let fixture = Fixture::new("settle-stuck");
    fixture.install_old();
    fixture.install(NEW);
    fixture.activate(NEW, Some(OLD));
    fs::write(fixture.computer(NEW), b"").unwrap();
    fs::write(fixture.computer(OLD), b"tampered").unwrap();
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
    fixture
}

#[test]
fn a_start_settles_the_journal_before_it_starts_the_service() {
    let fixture = recoverable();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let mut stages = Vec::new();

    let stop = settle_before_start(&ports, &mut |line| stages.push(line.to_owned()));

    assert_eq!(stop, None);
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    assert!(stages[0].contains("settling it first"));
}

#[test]
fn a_start_that_cannot_settle_the_journal_does_not_start_the_service() {
    let fixture = unrecoverable();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::Stopped);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let stop = settle_before_start(&ports, &mut |_| {});

    match stop {
        Some(crate::start::Outcome::Failed { message }) => assert!(message.contains("0.1.0")),
        other => panic!("expected a failed start, got {other:?}"),
    }
    assert!(Journal::new(fixture.root()).read().unwrap().is_some());
    assert!(service.calls().is_empty());
}

#[test]
fn a_start_with_no_journal_goes_straight_on() {
    let fixture = Fixture::new("settle-start-clean");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    assert_eq!(settle_before_start(&ports, &mut |_| {}), None);
    assert!(service.calls().is_empty());
}

#[test]
fn an_operation_settles_a_recoverable_journal_and_goes_on() {
    let fixture = recoverable();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    assert_eq!(settle_first(&ports, None, &mut |_| {}), Ok(()));
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
}

#[test]
fn an_operation_that_cannot_settle_the_journal_is_told_to_run_the_same_command_again() {
    let fixture = unrecoverable();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::Stopped);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let stop = settle_first(&ports, None, &mut |_| {}).unwrap_err();

    assert_eq!(stop.exit_code(), 3);
    assert!(stop.message().contains("Run the same command again"));
    assert!(stop.message().contains("Nothing was changed"));
    assert!(Journal::new(fixture.root()).read().unwrap().is_some());
}
