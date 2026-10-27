//! Repair registers the active version's service definition without stopping or starting
//! anything, and leaves a registration that is already current alone.

use super::*;
use crate::contract::ReceiptStatus;
use crate::service::fakes::{ScriptedRunner, definition, exits, modified, place_dated};
use crate::service::{Launchd, SupervisorService, coordinator_service};
use crate::test_support::Scratch;
use crate::upgrade::fakes::{protocol, service_definition};

const REGISTERING: &str = "Registering the Computer supervisor service definition";
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
    assert_eq!(stages, [VERIFYING, REGISTERING, REPAIRED]);
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
fn a_manager_whose_install_may_end_a_running_service_keeps_its_running_registration() {
    let fixture = damaged("repair-definition-windows-running");
    let service = FakeService::new(ServiceState::Running { pid: None })
        .whose_install_may_end_a_running_service();
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);

    let (outcome, stages) = run_repair(&fixture, &service, &lifecycle);

    assert_eq!(exit_code(&outcome), 0);
    assert_eq!(service.calls(), ["state", "state"]);
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
fn a_manager_whose_install_may_end_a_running_service_still_registers_a_missing_one() {
    let fixture = damaged("repair-definition-windows-missing");
    let service =
        FakeService::new(ServiceState::NotInstalled).whose_install_may_end_a_running_service();
    let lifecycle = FakeLifecycle::default();
    fixture.reports_service_definition(&lifecycle, OLD);

    let (outcome, _) = run_repair(&fixture, &service, &lifecycle);

    assert_eq!(exit_code(&outcome), 0);
    assert_eq!(service.calls(), ["state", "state", "install"]);
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
        message.contains("repaired") && message.contains("0.1.0"),
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
    let plist = home
        .path()
        .join("Library/LaunchAgents/cn.coforge.computer.daemon.plist");
    let placed = place_dated(&plist, "<plist>current</plist>");
    let runner = ScriptedRunner::new(vec![exits(
        "/bin/launchctl print gui/501/cn.coforge.computer.daemon",
        113,
        "Could not find service",
    )]);
    let clock = VirtualClock::new();
    let launchd = Launchd::new(&runner, &clock, &coordinator_service(), home.path(), 501).unwrap();
    let lifecycle = FakeLifecycle::default();
    let executable = fixture.computer(OLD);
    lifecycle.answers_protocol(
        &executable,
        vec![Some(crate::contract::LifecycleProtocol {
            commands: Some(vec!["service-definition".to_owned()]),
            ..protocol(OLD)
        })],
    );
    lifecycle.answers_service_definition(
        &executable,
        vec![Some(definition("launchd", "<plist>current</plist>"))],
    );

    let (outcome, _) = run_repair(&fixture, &launchd, &lifecycle);

    assert_eq!(exit_code(&outcome), 0);
    assert_eq!(modified(&plist), placed);
}
