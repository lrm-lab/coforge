use std::fs;
use std::time::Duration;

use super::*;
use crate::clock::{Clock, VirtualClock, WALL_ORIGIN};
use crate::journal::{Journal, Transaction};
use crate::lock::MachineMutationLock;
use crate::processes::fakes::FakeTable;
use crate::retry_trigger::fakes::FakeTrigger;
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

fn read(fixture: &Fixture, file: &str) -> Option<serde_json::Value> {
    let bytes = fs::read(fixture.root().join(file)).ok()?;
    Some(serde_json::from_slice(&bytes).unwrap())
}

/// A first install that was interrupted after activation: recovery settles on the new version.
fn recoverable() -> Fixture {
    let fixture = Fixture::new("auto-recover-ok");
    fixture.install(NEW);
    fixture.activate(NEW, None);
    record_journal(&fixture, false);
    fixture
}

/// A journal recovery cannot settle: the version it would restore no longer verifies.
fn unrecoverable() -> Fixture {
    let fixture = Fixture::new("auto-recover-stuck");
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
fn with_no_journal_it_does_nothing_and_takes_the_trigger_away() {
    let fixture = Fixture::new("auto-recover-none");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let trigger = FakeTrigger::default();

    let outcome = recover_auto(&ports, &trigger, &mut |_| {});

    assert_eq!(outcome, AutoOutcome::NothingToRecover);
    assert_eq!(trigger.calls(), ["cancel"]);
    assert!(service.calls().is_empty());
    assert!(read(&fixture, REPORT_FILE).is_none());
}

#[test]
fn a_recovery_that_settles_is_reported_and_the_trigger_is_gone() {
    let fixture = recoverable();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let trigger = FakeTrigger::default();

    let outcome = recover_auto(&ports, &trigger, &mut |_| {});

    assert_eq!(
        outcome,
        AutoOutcome::Recovered {
            version: NEW.to_owned()
        }
    );
    assert_eq!(outcome.exit_code(), 0);
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    assert_eq!(trigger.calls(), ["cancel"]);
    assert!(read(&fixture, STATE_FILE).is_none());
    let report = read(&fixture, REPORT_FILE).expect("a report");
    assert_eq!(report["outcome"], "recovered");
    assert_eq!(report["restoredVersion"], NEW);
    assert_eq!(report["attempts"], 1);
    assert_eq!(report["finishedAt"], WALL_ORIGIN);
    assert_eq!(report["schemaVersion"], 1);
}

#[test]
fn a_failed_attempt_waits_longer_and_an_early_trigger_does_nothing() {
    let fixture = unrecoverable();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::Stopped);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let trigger = FakeTrigger::default();

    let first = recover_auto(&ports, &trigger, &mut |_| {});
    assert!(matches!(first, AutoOutcome::Retry { attempts: 1, .. }));
    assert_eq!(first.exit_code(), 3);
    assert_eq!(trigger.calls(), ["schedule 300s"]);
    let state = read(&fixture, STATE_FILE).unwrap();
    assert_eq!(state["attempts"], 1);
    assert_eq!(state["notBefore"], WALL_ORIGIN + 300);
    // The journal and the report: a failed attempt is not yet news.
    assert!(Journal::new(fixture.root()).read().unwrap().is_some());
    assert!(read(&fixture, REPORT_FILE).is_none());

    // The trigger fires again at once (a reboot): not yet, and it changes nothing.
    assert_eq!(
        recover_auto(&ports, &trigger, &mut |_| {}),
        AutoOutcome::NotYet
    );
    // The trigger that fired was spent, so one is armed again for the time that is left.
    assert_eq!(trigger.calls(), ["schedule 300s", "schedule 300s"]);

    clock.sleep(Duration::from_secs(300));
    let second = recover_auto(&ports, &trigger, &mut |_| {});
    assert!(matches!(second, AutoOutcome::Retry { attempts: 2, .. }));
    assert_eq!(
        trigger.calls(),
        ["schedule 300s", "schedule 300s", "schedule 900s"]
    );
}

#[test]
fn the_eighth_failure_gives_up_reports_it_and_arms_nothing() {
    let fixture = unrecoverable();
    write_state(fixture.root(), MAX_ATTEMPTS - 1, 0).unwrap();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::Stopped);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let trigger = FakeTrigger::default();

    let outcome = recover_auto(&ports, &trigger, &mut |_| {});

    assert!(matches!(
        outcome,
        AutoOutcome::GaveUp {
            attempts: MAX_ATTEMPTS,
            ..
        }
    ));
    assert_eq!(trigger.calls(), ["cancel"]);
    let report = read(&fixture, REPORT_FILE).expect("a report");
    assert_eq!(report["outcome"], "failed");
    assert_eq!(report["attempts"], MAX_ATTEMPTS);
    assert!(report["message"].as_str().unwrap().contains("0.1.0"));
    assert!(report.get("restoredVersion").is_none());
    // It does not try again by itself.
    assert!(matches!(
        recover_auto(&ports, &trigger, &mut |_| {}),
        AutoOutcome::GaveUp { .. }
    ));
}

#[test]
fn the_waits_are_one_minute_five_fifteen_one_hour_then_six_hours() {
    let waits: Vec<u64> = (1..=MAX_ATTEMPTS)
        .map(|attempt| wait_before(attempt).as_secs() / 60)
        .collect();
    assert_eq!(waits, [1, 5, 15, 60, 360, 360, 360, 360]);
}

#[test]
fn a_journal_gets_a_trigger_once_and_loses_it_with_the_journal() {
    let fixture = unrecoverable();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::Stopped);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let trigger = FakeTrigger::default();

    keep_trigger_in_step(&ports, &trigger, &mut |_| {});
    keep_trigger_in_step(&ports, &trigger, &mut |_| {});
    assert_eq!(trigger.calls(), ["schedule 60s"]);
    assert_eq!(read(&fixture, STATE_FILE).unwrap()["attempts"], 0);

    let lock = MachineMutationLock::acquire(fixture.root()).unwrap();
    Journal::new(fixture.root()).clear(&lock).unwrap();
    drop(lock);
    keep_trigger_in_step(&ports, &trigger, &mut |_| {});
    assert_eq!(trigger.calls(), ["schedule 60s", "cancel"]);
    assert!(read(&fixture, STATE_FILE).is_none());
    // A machine that never had one is not asked to cancel anything.
    keep_trigger_in_step(&ports, &trigger, &mut |_| {});
    assert_eq!(trigger.calls(), ["schedule 60s", "cancel"]);
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
    let fixture = Fixture::new("auto-recover-start-clean");
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
fn a_not_before_far_beyond_the_longest_wait_does_not_hold_recovery_off() {
    let fixture = recoverable();
    // A clock that read years ahead when this was written.
    write_state(fixture.root(), 1, WALL_ORIGIN + 10 * 365 * 24 * 3600).unwrap();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let trigger = FakeTrigger::default();

    let outcome = recover_auto(&ports, &trigger, &mut |_| {});

    assert_eq!(
        outcome,
        AutoOutcome::Recovered {
            version: NEW.to_owned()
        }
    );
}

#[test]
fn a_report_of_a_failure_does_not_outlive_a_recovery_a_person_finished() {
    let fixture = recoverable();
    write_state(fixture.root(), MAX_ATTEMPTS, 0).unwrap();
    fs::write(
        fixture.root().join(REPORT_FILE),
        b"{\"outcome\":\"failed\"}",
    )
    .unwrap();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let trigger = FakeTrigger::default();
    // A person (or a start) settles the journal; the operation then keeps the trigger in step.
    let lock = MachineMutationLock::acquire(fixture.root()).unwrap();
    Journal::new(fixture.root()).clear(&lock).unwrap();
    drop(lock);

    keep_trigger_in_step(&ports, &trigger, &mut |_| {});

    assert!(read(&fixture, REPORT_FILE).is_none());
    assert!(read(&fixture, STATE_FILE).is_none());
    assert_eq!(trigger.calls(), ["cancel"]);
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
