use std::fs;

use super::*;
use crate::clock::VirtualClock;
use crate::processes::fakes::FakeTable;
use crate::upgrade::fakes::{FakeLifecycle, FakeService, Fixture, OLD, REQUEST};

fn exit_code(outcome: &Outcome) -> u8 {
    match outcome {
        Outcome::Receipt(receipt) => receipt.exit_code(),
        Outcome::NoReceipt { exit, .. } => *exit,
    }
}

#[test]
fn repairs_missing_active_links_from_the_verified_active_version() {
    let fixture = Fixture::new("repair-links");
    fixture.install_old();
    // `active` is a symlink on Unix and a directory junction on Windows, which only
    // `remove_dir` removes.
    let active = fixture.root().join("active");
    if cfg!(windows) {
        fs::remove_dir(&active).unwrap();
    } else {
        fs::remove_file(&active).unwrap();
    }
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, OLD);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let mut stages = Vec::new();
    let outcome = repair(&ports, REQUEST, None, false, &mut |line| {
        stages.push(line.to_owned())
    });

    assert_eq!(exit_code(&outcome), 0);
    match &outcome {
        Outcome::Receipt(receipt) => assert_eq!(receipt.operation(), "repair"),
        Outcome::NoReceipt { .. } => panic!("repair did not write a receipt"),
    }
    // Repair reads the service state once and never stops or starts it.
    assert_eq!(service.calls(), ["state"]);
    #[cfg(windows)]
    assert_eq!(
        fs::canonicalize(&active).unwrap(),
        fs::canonicalize(fixture.root().join("versions").join(OLD)).unwrap()
    );
    #[cfg(not(windows))]
    assert_eq!(
        fs::read_link(&active).unwrap(),
        std::path::Path::new("current")
    );
    assert_eq!(
        stages,
        [
            "Verifying active CoForge Computer 0.1.0",
            "Repaired active CoForge Computer 0.1.0"
        ]
    );
}

#[test]
fn reinstalls_a_corrupt_active_version_without_stopping_service() {
    let fixture = Fixture::new("repair-corrupt");
    fixture.install_old();
    fs::remove_file(fixture.computer(OLD)).unwrap();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, OLD);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let outcome = repair(&ports, REQUEST, None, false, &mut |_| {});

    assert_eq!(exit_code(&outcome), 0);
    assert!(fixture.root().join("active").exists());
    assert_eq!(service.calls(), ["state"]);
}

#[test]
fn a_healthy_active_installation_is_held_without_reactivating() {
    let fixture = Fixture::new("repair-healthy");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let mut stages = Vec::new();
    let outcome = repair(&ports, REQUEST, None, false, &mut |line| {
        stages.push(line.to_owned())
    });

    assert_eq!(exit_code(&outcome), 2);
    match outcome {
        Outcome::Receipt(receipt) => {
            assert_eq!(receipt.error_code(), Some("REPAIR_NOT_NEEDED"));
        }
        Outcome::NoReceipt { .. } => panic!("repair did not record the held result"),
    }
    assert!(
        stages.is_empty(),
        "a healthy install was re-activated: {stages:?}"
    );
    // No activation, so the service state is not read.
    assert!(service.calls().is_empty());
}

#[test]
fn an_unselected_installation_without_active_state_is_held() {
    let fixture = Fixture::new("repair-not-needed");
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let outcome = repair(&ports, REQUEST, None, false, &mut |_| {});

    assert_eq!(exit_code(&outcome), 2);
    match outcome {
        Outcome::Receipt(receipt) => {
            assert_eq!(receipt.status(), crate::contract::ReceiptStatus::Held);
            assert_eq!(receipt.error_code(), Some("REPAIR_NOT_NEEDED"));
        }
        Outcome::NoReceipt { .. } => panic!("repair did not record the held result"),
    }
}

/// What repair registers with the service manager, and what it leaves alone.
mod service_definition;

/// The POSIX layout: `active` -> `current`, a synced copy of the active version.
#[cfg(unix)]
mod current_layout;
