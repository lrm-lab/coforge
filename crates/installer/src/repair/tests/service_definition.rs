//! Repair registers the active version's service definition without stopping or starting
//! anything, and leaves a registration that is already current alone.

use super::*;
use crate::contract::ReceiptStatus;
use crate::service::fakes::{ScriptedRunner, definition, exits, modified, place_dated};
use crate::service::{Launchd, SupervisorService, coordinator_service};
use crate::test_support::Scratch;
use crate::upgrade::fakes::{protocol, service_definition};

const REGISTERED: &str = "Registered the Computer supervisor service definition";
const VERIFYING: &str = "Verifying active CoForge Computer 0.1.0";
const REPAIRED: &str = "Repaired active CoForge Computer 0.1.0";

/// An installed [`OLD`] whose `active` link is gone, so that repair has an activation to fix.
fn damaged(label: &str) -> Fixture {
    let fixture = Fixture::new(label);
    fixture.install_old();
    let active = fixture.root().join("active");
    if cfg!(windows) {
        fs::remove_dir(&active).unwrap();
    } else {
        fs::remove_file(&active).unwrap();
    }
    fixture
}

/// An installed, activated [`OLD`]: nothing about its activation needs repair.
fn healthy(label: &str) -> Fixture {
    let fixture = Fixture::new(label);
    fixture.install_old();
    fixture
}

fn plist_in(home: &Scratch) -> std::path::PathBuf {
    home.path()
        .join("Library/LaunchAgents/cn.coforge.computer.daemon.plist")
}

/// Scripts the installed [`OLD`] Computer to report a launchd definition holding `contents`.
fn reports_launchd_definition(fixture: &Fixture, lifecycle: &FakeLifecycle, contents: &str) {
    let executable = fixture.computer(OLD);
    lifecycle.answers_protocol(
        &executable,
        vec![Some(crate::contract::LifecycleProtocol {
            commands: Some(vec!["service-definition".to_owned()]),
            ..protocol(OLD)
        })],
    );
    lifecycle.answers_service_definition(&executable, vec![Some(definition("launchd", contents))]);
}

fn run_repair(
    fixture: &Fixture,
    service: &dyn SupervisorService,
    lifecycle: &FakeLifecycle,
) -> (Outcome, Vec<String>) {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let ports = fixture.ports(lifecycle, service, &table, &clock);
    let mut stages = Vec::new();
    let outcome = repair(&ports, REQUEST, None, false, &mut |line| {
        stages.push(line.to_owned())
    });
    (outcome, stages)
}

#[test]
fn repair_registers_the_definition_of_the_active_version() {
    let fixture = damaged("repair-definition-missing");
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);

    let (outcome, stages) = run_repair(&fixture, &service, &lifecycle);

    assert_eq!(exit_code(&outcome), 0);
    assert_eq!(service.installed(), [service_definition(OLD)]);
    assert_eq!(service.calls(), ["state", "install"]);
    assert_eq!(stages, [VERIFYING, REGISTERED, REPAIRED]);
}

#[test]
fn a_running_service_is_registered_without_being_stopped_or_started() {
    let fixture = damaged("repair-definition-running");
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);

    let (outcome, _) = run_repair(&fixture, &service, &lifecycle);

    assert_eq!(exit_code(&outcome), 0);
    assert_eq!(service.calls(), ["state", "install"]);
    assert_eq!(service.installed(), [service_definition(OLD)]);
}

#[test]
fn a_computer_that_predates_the_command_gets_no_registration() {
    let fixture = damaged("repair-definition-older-computer");
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, OLD);

    let (outcome, stages) = run_repair(&fixture, &service, &lifecycle);

    assert_eq!(exit_code(&outcome), 0);
    assert_eq!(service.calls(), ["state"]);
    assert!(service.installed().is_empty());
    assert_eq!(stages, [VERIFYING, REPAIRED]);
}

#[test]
fn a_manager_that_keeps_a_running_registration_is_told_so_in_the_stage_lines() {
    let fixture = damaged("repair-definition-windows-running");
    let service =
        FakeService::new(ServiceState::Running { pid: None }).keeping_a_running_registration();
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);

    let (outcome, stages) = run_repair(&fixture, &service, &lifecycle);

    assert_eq!(exit_code(&outcome), 0);
    assert_eq!(service.calls(), ["state", "install"]);
    assert!(service.installed().is_empty());
    assert_eq!(
        stages,
        [
            VERIFYING,
            "The Computer supervisor service is running; its registration is left as it is",
            REPAIRED
        ]
    );
}

#[test]
fn a_manager_that_keeps_a_running_registration_still_registers_a_missing_one() {
    let fixture = damaged("repair-definition-windows-missing");
    let service = FakeService::new(ServiceState::NotInstalled).keeping_a_running_registration();
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);

    let (outcome, _) = run_repair(&fixture, &service, &lifecycle);

    assert_eq!(exit_code(&outcome), 0);
    assert_eq!(service.calls(), ["state", "install"]);
    assert_eq!(service.installed(), [service_definition(OLD)]);
}

#[test]
fn a_definition_that_cannot_be_read_fails_the_receipt_but_keeps_the_repaired_activation() {
    let fixture = damaged("repair-definition-unreadable");
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);
    lifecycle.answers_service_definition(&fixture.computer(OLD), vec![None]);

    let (outcome, stages) = run_repair(&fixture, &service, &lifecycle);

    assert_eq!(exit_code(&outcome), 1);
    let Outcome::Receipt(receipt) = outcome else {
        panic!("repair did not write a receipt");
    };
    assert_eq!(receipt.status(), ReceiptStatus::Failed);
    assert_eq!(receipt.error_code(), None);
    let message = receipt.error().unwrap();
    assert!(message.contains("service-definition"), "{message}");
    assert!(
        message.contains("0.1.0 was repaired.") && message.contains("could not be registered"),
        "{message}"
    );
    assert!(fixture.root().join("active").exists());
    assert_eq!(service.calls(), ["state"]);
    assert_eq!(stages, [VERIFYING]);
}

#[test]
fn a_registration_that_is_already_current_is_left_alone() {
    // The real launchd backend over a scratch home: any `launchctl` call but the state query, or
    // any rewrite of the plist, fails the test.
    let fixture = damaged("repair-definition-current");
    let home = Scratch::new("repair-definition-current-home");
    let plist = plist_in(&home);
    let placed = place_dated(&plist, "<plist>current</plist>");
    let runner = ScriptedRunner::new(vec![exits(
        "/bin/launchctl print gui/501/cn.coforge.computer.daemon",
        113,
        "Could not find service",
    )]);
    let clock = VirtualClock::new();
    let launchd = Launchd::new(&runner, &clock, &coordinator_service(), home.path(), 501).unwrap();
    let lifecycle = FakeLifecycle::default();
    reports_launchd_definition(&fixture, &lifecycle, "<plist>current</plist>");

    let (outcome, stages) = run_repair(&fixture, &launchd, &lifecycle);

    assert_eq!(exit_code(&outcome), 0);
    assert_eq!(modified(&plist), placed);
    assert_eq!(stages, [VERIFYING, REPAIRED]);
}

#[test]
fn a_healthy_installation_whose_plist_vanished_gets_it_registered() {
    // The incident: the job stays loaded, the plist is gone, and nothing else is wrong. The real
    // launchd backend over a scratch home; registering only writes the plist, so the empty script
    // fails the test on any `launchctl` call.
    let fixture = healthy("repair-healthy-plist-missing");
    let home = Scratch::new("repair-healthy-plist-missing-home");
    let runner = ScriptedRunner::new(Vec::new());
    let clock = VirtualClock::new();
    let launchd = Launchd::new(&runner, &clock, &coordinator_service(), home.path(), 501).unwrap();
    let lifecycle = FakeLifecycle::default();
    reports_launchd_definition(&fixture, &lifecycle, "<plist>current</plist>");

    let (outcome, stages) = run_repair(&fixture, &launchd, &lifecycle);

    assert_eq!(exit_code(&outcome), 0);
    let Outcome::Receipt(receipt) = outcome else {
        panic!("repair did not write a receipt");
    };
    assert_eq!(receipt.status(), ReceiptStatus::Succeeded);
    assert_eq!(
        fs::read_to_string(plist_in(&home)).unwrap(),
        "<plist>current</plist>"
    );
    assert_eq!(stages, [REGISTERED, REPAIRED]);
}

#[test]
fn a_healthy_installation_with_its_plist_in_place_is_not_repaired() {
    let fixture = healthy("repair-healthy-plist-current");
    let home = Scratch::new("repair-healthy-plist-current-home");
    let plist = plist_in(&home);
    let placed = place_dated(&plist, "<plist>current</plist>");
    let runner = ScriptedRunner::new(Vec::new());
    let clock = VirtualClock::new();
    let launchd = Launchd::new(&runner, &clock, &coordinator_service(), home.path(), 501).unwrap();
    let lifecycle = FakeLifecycle::default();
    reports_launchd_definition(&fixture, &lifecycle, "<plist>current</plist>");

    let (outcome, stages) = run_repair(&fixture, &launchd, &lifecycle);

    assert_eq!(exit_code(&outcome), 2);
    let Outcome::Receipt(receipt) = outcome else {
        panic!("repair did not record the held result");
    };
    assert_eq!(receipt.error_code(), Some("REPAIR_NOT_NEEDED"));
    assert_eq!(modified(&plist), placed);
    assert!(stages.is_empty(), "{stages:?}");
}

#[test]
fn a_healthy_installation_keeps_a_running_registration_a_manager_would_replace() {
    let fixture = healthy("repair-healthy-windows-running");
    let service =
        FakeService::new(ServiceState::Running { pid: None }).keeping_a_running_registration();
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);

    let (outcome, stages) = run_repair(&fixture, &service, &lifecycle);

    assert_eq!(exit_code(&outcome), 2);
    assert_eq!(service.calls(), ["install"]);
    assert!(service.installed().is_empty());
    assert!(stages.is_empty(), "{stages:?}");
}

#[test]
fn a_healthy_installation_whose_definition_cannot_be_read_fails_the_receipt() {
    let fixture = healthy("repair-healthy-definition-unreadable");
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);
    lifecycle.answers_service_definition(&fixture.computer(OLD), vec![None]);

    let (outcome, stages) = run_repair(&fixture, &service, &lifecycle);

    assert_eq!(exit_code(&outcome), 1);
    let Outcome::Receipt(receipt) = outcome else {
        panic!("repair did not write a receipt");
    };
    assert_eq!(receipt.status(), ReceiptStatus::Failed);
    let message = receipt.error().unwrap();
    assert!(message.contains("service-definition"), "{message}");
    assert!(message.contains("needed no repair"), "{message}");
    assert!(message.contains("could not be registered"), "{message}");
    assert!(service.calls().is_empty());
    assert!(stages.is_empty(), "{stages:?}");
}
