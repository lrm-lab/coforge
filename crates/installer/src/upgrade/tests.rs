use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::fakes::*;
use super::*;
use crate::active::read_active;
use crate::clock::VirtualClock;
use crate::contract::{
    ACTIVE_STATE_SCHEMA_VERSION, ActiveState, ArtifactIdentity, ComputerArtifact,
    ERROR_CODE_ROLLBACK_FAILED, ERROR_CODE_ROLLED_BACK, NamedArtifact, ReceiptStatus,
    ReleaseManifest, UpgradeReceipt,
};
use crate::journal::{Journal, Transaction};
use crate::lock::MachineMutationLock;
use crate::prepare::ReleaseSource;
use crate::processes::VerifiedCaller;
use crate::processes::fakes::FakeTable;
use crate::receipts::ReceiptStore;
use crate::service::ServiceState;
use crate::update_error::UpdateError;

const OTHER_REQUEST: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

mod support;
use support::*;

#[test]
fn a_running_supervisor_moves_to_the_new_version_and_is_restarted() {
    let fixture = Fixture::new("upgrade-running");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    table.spawn(101, 2, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    script_running_upgrade(&fixture, &lifecycle);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, stages) = run(&ports, REQUEST, "latest", None);

    assert_eq!(exit_of(&outcome), 0);
    let receipt = receipt(&outcome);
    assert_eq!(receipt.status(), ReceiptStatus::Succeeded);
    assert_eq!(receipt.version(), Some(NEW));
    assert_eq!(receipt.supervisor_running(), Some(true));
    let runtimes: Vec<(&str, bool)> = receipt
        .runtimes()
        .unwrap()
        .iter()
        .map(|runtime| (runtime.binding_id.as_str(), runtime.running))
        .collect();
    assert_eq!(runtimes, [("workspace-a", true), ("workspace-b", false)]);
    assert_eq!(pids(receipt), [100, 101]);
    assert_eq!(active(&fixture), active_state(NEW, Some(OLD)));
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    assert_eq!(service.calls(), ["state", "stop", "start"]);
    assert_eq!(
        stages,
        [
            "Verifying current version",
            "Resolving target version",
            "Downloading 0 bytes",
            "Downloading 39 bytes",
            "Downloading 60 bytes",
            "Verifying download",
            "Checking new version",
            "Stopping (1 Workspace runtime)",
            "Switching to 0.2.0",
            "Starting 0.2.0",
            "Waiting for the Computer supervisor to report 0.2.0",
            "Computer supervisor 0.2.0 healthy",
        ]
    );
    committed(&fixture, &outcome);
}

#[test]
fn a_first_install_probes_the_new_executable_and_restarts_nothing() {
    let fixture = Fixture::new("upgrade-fresh");
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, stages) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 0);
    let receipt = receipt(&outcome);
    assert_eq!(receipt.status(), ReceiptStatus::Succeeded);
    assert_eq!(receipt.version(), Some(NEW));
    assert_eq!(receipt.supervisor_running(), None);
    assert_eq!(receipt.runtimes(), None);
    assert_eq!(receipt.dead_process_identities(), None);
    assert_eq!(active(&fixture), active_state(NEW, None));
    assert!(service.calls().is_empty());
    assert_eq!(
        stages,
        [
            "Verifying current version",
            "Resolving target version",
            "Downloading 0 bytes",
            "Downloading 39 bytes",
            "Downloading 60 bytes",
            "Verifying download",
            "Checking new version",
            "Computer supervisor is not running; no processes to restart",
            "Switching to 0.2.0",
            "Checking the activated executable reports 0.2.0",
            "Activated executable 0.2.0 confirmed",
        ]
    );
    committed(&fixture, &outcome);
}

#[test]
fn an_installed_version_with_no_supervisor_running_restarts_nothing() {
    let fixture = Fixture::new("upgrade-stopped");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    lifecycle.answers_status(&fixture.computer(OLD), vec![Some(stopped(OLD))]);
    fixture.answers_protocol(&lifecycle, NEW);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, stages) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 0);
    let receipt = receipt(&outcome);
    assert_eq!(receipt.supervisor_running(), Some(false));
    assert_eq!(receipt.runtimes(), Some(&[][..]));
    assert_eq!(receipt.dead_process_identities(), None);
    assert_eq!(active(&fixture), active_state(NEW, Some(OLD)));
    assert!(service.calls().is_empty());
    assert_eq!(
        stages.last().map(String::as_str),
        Some("Activated executable 0.2.0 confirmed")
    );
    committed(&fixture, &outcome);
}

#[test]
fn the_verified_caller_is_never_collected_or_signalled() {
    let fixture = Fixture::new("upgrade-caller");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    // The installer (pid 7) was started by the `upgrade` command (pid 42), which runs the same
    // executable as the product: the caller must be spared, the other supervisor process not.
    table.spawn(7, 1, "/usr/bin/coforge-installer");
    table.parent(7, 42);
    table.spawn(42, 2, &fixture.canonical_computer(OLD));
    table.spawn(100, 3, &fixture.canonical_computer(OLD));
    let caller = VerifiedCaller::verify(&table, 7, 42).unwrap();
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    script_running_upgrade(&fixture, &lifecycle);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, Some(caller));

    assert_eq!(exit_of(&outcome), 0);
    assert_eq!(pids(receipt(&outcome)), [100]);
    assert!(table.signals().iter().all(|(pid, _)| *pid != 42));
}

#[test]
fn a_held_machine_lock_stops_the_upgrade_with_exit_2_and_no_receipt() {
    let fixture = Fixture::new("upgrade-held");
    let _held = MachineMutationLock::acquire(fixture.root()).unwrap();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    match &outcome {
        Outcome::NoReceipt { exit, message } => {
            assert_eq!(*exit, 2);
            assert!(message.contains("another install, upgrade, or recovery is running"));
        }
        other => panic!("expected no receipt, got {other:?}"),
    }
    assert!(
        ReceiptStore::new(fixture.root())
            .read(REQUEST)
            .unwrap()
            .is_none()
    );
    assert!(service.calls().is_empty());
}

#[test]
fn an_unfinished_upgrade_blocks_a_new_one_with_exit_3_naming_recover() {
    let fixture = Fixture::new("upgrade-journal");
    fixture.install_old();
    {
        let lock = MachineMutationLock::acquire(fixture.root()).unwrap();
        Journal::new(fixture.root())
            .record(
                &lock,
                &Transaction {
                    request_id: OTHER_REQUEST.to_owned(),
                    from: Some(OLD.to_owned()),
                    from_previous: None,
                    to: NEW.to_owned(),
                    supervisor_running: false,
                },
            )
            .unwrap();
    }
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    match &outcome {
        Outcome::NoReceipt { exit, message } => {
            assert_eq!(*exit, 3);
            assert!(message.contains("same command again"));
        }
        other => panic!("expected no receipt, got {other:?}"),
    }
    assert!(
        ReceiptStore::new(fixture.root())
            .read(REQUEST)
            .unwrap()
            .is_none()
    );
    assert!(service.calls().is_empty());
    assert_eq!(active(&fixture), active_state(OLD, None));
}

#[test]
fn an_unreadable_journal_is_exit_3_with_its_error_and_nothing_starts() {
    let fixture = Fixture::new("upgrade-bad-journal");
    fs::create_dir_all(fixture.root()).unwrap();
    fs::write(
        fixture.root().join("installer-transaction.json"),
        "not json",
    )
    .unwrap();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    match &outcome {
        Outcome::NoReceipt { exit, message } => {
            assert_eq!(*exit, 3);
            assert!(message.contains("installer-transaction.json"));
        }
        other => panic!("expected no receipt, got {other:?}"),
    }
    assert!(service.calls().is_empty());
}

#[test]
fn a_finished_request_replays_its_receipt_and_changes_nothing() {
    let fixture = Fixture::new("upgrade-replay");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    script_running_upgrade(&fixture, &lifecycle);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let (first, _) = run(&ports, REQUEST, NEW, None);
    let calls = service.calls();
    let signals = table.signals().len();

    let (second, stages) = run(&ports, REQUEST, NEW, None);

    assert_eq!(second, first);
    assert_eq!(exit_of(&second), 0);
    assert_eq!(service.calls(), calls);
    assert_eq!(table.signals().len(), signals);
    assert!(stages.is_empty());
    assert_eq!(active(&fixture), active_state(NEW, Some(OLD)));
}

#[test]
fn a_request_id_reused_for_another_selection_is_held_without_a_receipt() {
    let fixture = Fixture::new("upgrade-conflict");
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let (first, _) = run(&ports, REQUEST, NEW, None);
    assert_eq!(exit_of(&first), 0);

    let (second, _) = run(&ports, REQUEST, "latest", None);

    match &second {
        Outcome::NoReceipt { exit, message } => {
            assert_eq!(*exit, 2);
            assert!(message.contains("already used for another operation or version"));
        }
        other => panic!("expected no receipt, got {other:?}"),
    }
    assert_eq!(committed(&fixture, &first).version(), Some(NEW));
}

#[test]
fn a_feed_failure_is_a_failed_receipt_before_any_change() {
    let fixture = Fixture::new("upgrade-feed");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    // No such version: the manifest is a 404.
    let (outcome, _) = run(&ports, REQUEST, "0.9.9", None);

    assert_eq!(exit_of(&outcome), 1);
    let receipt = receipt(&outcome);
    assert_eq!(receipt.status(), ReceiptStatus::Failed);
    assert_eq!(receipt.error_code(), Some("UPDATE_DOWNLOAD_FAILED"));
    assert!(receipt.error().is_some_and(|error| !error.is_empty()));
    assert_eq!(active(&fixture), active_state(OLD, None));
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    assert!(service.calls().is_empty());
    assert!(table.signals().is_empty());
    committed(&fixture, &outcome);
}

#[test]
fn a_candidate_that_does_not_report_its_version_is_refused_before_any_change() {
    let fixture = Fixture::new("upgrade-probe");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    lifecycle.answers_protocol(&fixture.computer(NEW), vec![Some(protocol(OLD))]);
    lifecycle.answers_status(&fixture.computer(OLD), vec![Some(running(OLD, "old-id"))]);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 1);
    let receipt = receipt(&outcome);
    assert_eq!(receipt.error_code(), Some("UPDATE_INTEGRITY_FAILED"));
    assert_eq!(active(&fixture), active_state(OLD, None));
    assert!(service.calls().is_empty());
    committed(&fixture, &outcome);
}

#[test]
fn an_unhealthy_installed_version_is_refused_before_anything_stops() {
    let fixture = Fixture::new("upgrade-unhealthy");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    lifecycle.answers_status(
        &fixture.computer(OLD),
        vec![Some(unhealthy(
            OLD,
            &["Workspace workspace-b is not running; run `coforge-computer start`."],
        ))],
    );
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 1);
    let receipt = receipt(&outcome);
    assert_eq!(
        receipt.error(),
        Some(
            "Workspace runtime set is unhealthy: Workspace workspace-b is not running; run `coforge-computer start`."
        )
    );
    assert_eq!(receipt.error_code(), None);
    assert!(service.calls().is_empty());
    assert!(table.signals().is_empty());
    assert_eq!(active(&fixture), active_state(OLD, None));
    committed(&fixture, &outcome);
}

#[test]
fn a_foreground_supervisor_is_refused_with_the_existing_wording_before_any_change() {
    let fixture = Fixture::new("upgrade-foreground");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    lifecycle.answers_status(&fixture.computer(OLD), vec![Some(running(OLD, "old-id"))]);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 1);
    let error = receipt(&outcome).error().unwrap().to_owned();
    assert!(error.starts_with(
        "Cannot upgrade a foreground externally supervised Computer while it is running: "
    ));
    assert!(error.ends_with(
        "Stop it through its external supervisor before upgrading, or install the supported user service with `coforge-computer start`."
    ));
    assert_eq!(service.calls(), ["state"]);
    assert!(table.signals().is_empty());
    assert_eq!(active(&fixture), active_state(OLD, None));
}

#[test]
fn a_candidate_that_never_reports_is_rolled_back_to_the_previous_version() {
    let fixture = Fixture::new("upgrade-rollback");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocols(&lifecycle);
    lifecycle.answers_status(
        &fixture.computer(OLD),
        vec![
            Some(running(OLD, "old-id")),
            Some(running(OLD, "restored-id")),
        ],
    );
    // The new supervisor never comes up.
    lifecycle.answers_status(&fixture.computer(NEW), vec![Some(stopped(NEW))]);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, stages) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 1);
    let receipt = receipt(&outcome);
    assert_eq!(receipt.status(), ReceiptStatus::Failed);
    assert_eq!(receipt.error_code(), Some(ERROR_CODE_ROLLED_BACK));
    assert_eq!(receipt.restored_version(), Some(OLD));
    assert!(receipt.error().unwrap().contains("did not report"));
    assert_eq!(active(&fixture), active_state(OLD, None));
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    assert_eq!(service.calls(), ["state", "stop", "start", "stop", "start"]);
    assert!(clock.elapsed() >= Duration::from_secs(60));
    assert!(
        stages
            .iter()
            .any(|stage| stage.starts_with("Upgrade failed: ")
                && stage.ends_with("; restoring 0.1.0"))
    );
    committed(&fixture, &outcome);
}

#[test]
fn a_failed_rollback_keeps_the_journal_and_refuses_the_next_upgrade() {
    let fixture = Fixture::new("upgrade-unresolved");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocols(&lifecycle);
    // The previous version reports healthy once, then answers nothing.
    lifecycle.answers_status(
        &fixture.computer(OLD),
        vec![Some(running(OLD, "old-id")), None],
    );
    lifecycle.answers_status(&fixture.computer(NEW), vec![Some(stopped(NEW))]);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 3);
    let receipt = receipt(&outcome);
    assert_eq!(receipt.status(), ReceiptStatus::Failed);
    assert_eq!(receipt.error_code(), Some(ERROR_CODE_ROLLBACK_FAILED));
    assert!(receipt.error().unwrap().contains("; rollback failed: "));
    assert_eq!(receipt.restored_version(), None);
    let journal = Journal::new(fixture.root())
        .read()
        .unwrap()
        .expect("journal kept");
    assert_eq!(journal.request_id, REQUEST);
    assert_eq!(
        (journal.from.as_deref(), journal.to.as_str()),
        (Some(OLD), NEW)
    );
    assert!(journal.supervisor_running);
    committed(&fixture, &outcome);

    // Another upgrade is refused until recovery has resolved the journal.
    let (next, _) = run(&ports, OTHER_REQUEST, NEW, None);
    match &next {
        Outcome::NoReceipt { exit, message } => {
            assert_eq!(*exit, 3);
            assert!(message.contains("same command again"));
        }
        other => panic!("expected no receipt, got {other:?}"),
    }
    assert!(
        ReceiptStore::new(fixture.root())
            .read(OTHER_REQUEST)
            .unwrap()
            .is_none()
    );
}

/// Forwards to the fixture's feed and counts the manifest reads a preparation makes. On the first
/// resolution it overwrites the installed executable, which runs after the active version was
/// verified: a second verification would then fail and fetch the release again.
struct TamperingRelease<'a> {
    feed: &'a dyn ReleaseSource,
    tamper: PathBuf,
    manifest_reads: Cell<usize>,
}

impl ReleaseSource for TamperingRelease<'_> {
    fn resolve_version(&self, selection: &str) -> Result<String, UpdateError> {
        let version = self.feed.resolve_version(selection)?;
        fs::write(&self.tamper, b"tampered").unwrap();
        Ok(version)
    }

    fn manifest(&self, version: &str) -> Result<ReleaseManifest, UpdateError> {
        self.manifest_reads.set(self.manifest_reads.get() + 1);
        self.feed.manifest(version)
    }

    fn download_computer(
        &self,
        version: &str,
        target: &str,
        artifact: &ComputerArtifact,
        out: &Path,
    ) -> Result<ArtifactIdentity, UpdateError> {
        self.feed.download_computer(version, target, artifact, out)
    }

    fn download_photon_wasm(
        &self,
        version: &str,
        artifact: &NamedArtifact,
        out: &Path,
    ) -> Result<ArtifactIdentity, UpdateError> {
        self.feed.download_photon_wasm(version, artifact, out)
    }
}

#[test]
fn a_same_version_upgrade_verifies_the_active_installation_once() {
    let fixture = Fixture::new("upgrade-same-version");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    lifecycle.answers_status(&fixture.computer(OLD), vec![Some(stopped(OLD))]);
    fixture.answers_protocol(&lifecycle, OLD);
    let release = TamperingRelease {
        feed: fixture.feed(),
        tamper: fixture.computer(OLD),
        manifest_reads: Cell::new(0),
    };
    let ports = Ports {
        release: &release,
        ..fixture.ports(&lifecycle, &service, &table, &clock)
    };

    let (outcome, _) = run(&ports, REQUEST, OLD, None);

    assert_eq!(exit_of(&outcome), 0);
    assert_eq!(release.manifest_reads.get(), 0);
    assert_eq!(active(&fixture), active_state(OLD, None));
}

const INSIDE_REFUSAL: &str = "The upgrade stops coforge-daemon.service, the service this process runs \
    inside, so it would stop itself. Run `coforge-computer upgrade` from a normal terminal, not \
    from inside the service. Nothing was changed.";

#[test]
fn inside_the_supervisor_service_with_it_running_the_upgrade_is_refused_before_anything_stops() {
    let fixture = Fixture::new("upgrade-inside-running");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) }).inside_unit();
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    lifecycle.answers_status(&fixture.computer(OLD), vec![Some(running(OLD, "old-id"))]);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, stages) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 1);
    assert_eq!(receipt(&outcome).error(), Some(INSIDE_REFUSAL));
    assert_eq!(receipt(&outcome).error_code(), None);
    assert_eq!(service.calls(), ["state"]);
    assert!(table.signals().is_empty());
    assert!(!stages.iter().any(|stage| stage.starts_with("Stopping")));
    assert!(Journal::new(fixture.root()).read().unwrap().is_none());
    assert_eq!(active(&fixture), active_state(OLD, None));
    committed(&fixture, &outcome);
}

#[test]
fn inside_the_supervisor_service_with_it_stopped_the_upgrade_proceeds() {
    let fixture = Fixture::new("upgrade-inside-stopped");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::Stopped).inside_unit();
    let lifecycle = FakeLifecycle::default();
    lifecycle.answers_status(&fixture.computer(OLD), vec![Some(stopped(OLD))]);
    fixture.answers_protocol(&lifecycle, NEW);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 0);
    assert_eq!(active(&fixture), active_state(NEW, Some(OLD)));
}

/// Installs [`NEW`] as the active version, the state every downgrade starts from.
fn install_new(fixture: &Fixture) {
    fixture.install(NEW);
    fixture.activate(NEW, None);
}

#[test]
fn an_older_version_is_refused_without_the_flag_before_anything_changes() {
    let fixture = Fixture::new("upgrade-downgrade-refused");
    install_new(&fixture);
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(NEW));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, stages) = run(&ports, REQUEST, OLD, None);

    assert_eq!(exit_of(&outcome), 1);
    let receipt = receipt(&outcome);
    assert_eq!(receipt.status(), ReceiptStatus::Failed);
    assert_eq!(receipt.error_code(), Some("UPGRADE_DOWNGRADE_REFUSED"));
    assert_eq!(
        receipt.error(),
        Some(
            "CoForge Computer 0.1.0 is older than the installed 0.2.0. Nothing was changed. To go back, run `coforge-computer upgrade --version 0.1.0 --allow-downgrade`."
        )
    );
    assert_eq!(
        stages,
        ["Verifying current version", "Resolving target version"]
    );
    assert_eq!(active(&fixture), active_state(NEW, None));
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    assert!(!fixture.computer(OLD).exists());
    assert!(service.calls().is_empty());
    assert!(table.signals().is_empty());
    committed(&fixture, &outcome);
}

#[test]
fn an_older_version_moves_back_when_the_flag_is_given() {
    let fixture = Fixture::new("upgrade-downgrade-allowed");
    install_new(&fixture);
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(NEW));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocols(&lifecycle);
    lifecycle.answers_status(&fixture.computer(NEW), vec![Some(running(NEW, "new-id"))]);
    lifecycle.answers_status(
        &fixture.computer(OLD),
        vec![Some(stopped(OLD)), Some(running(OLD, "old-id"))],
    );
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run_with(&ports, REQUEST, OLD, None, true);

    assert_eq!(exit_of(&outcome), 0);
    assert_eq!(receipt(&outcome).version(), Some(OLD));
    assert_eq!(active(&fixture), active_state(OLD, Some(NEW)));
    assert_eq!(service.calls(), ["state", "stop", "start"]);
    committed(&fixture, &outcome);
}

#[test]
fn a_latest_pointer_older_than_the_installed_version_is_refused_without_the_flag() {
    let fixture = Fixture::with_latest("upgrade-downgrade-latest", OLD);
    install_new(&fixture);
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(NEW));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, "latest", None);

    assert_eq!(exit_of(&outcome), 1);
    let receipt = receipt(&outcome);
    assert_eq!(receipt.error_code(), Some("UPGRADE_DOWNGRADE_REFUSED"));
    assert!(receipt.error().is_some_and(|error| {
        error.starts_with("CoForge Computer 0.1.0 is older than the installed 0.2.0.")
            && error.ends_with("run `coforge-computer upgrade --version 0.1.0 --allow-downgrade`.")
    }));
    assert_eq!(active(&fixture), active_state(NEW, None));
    assert!(service.calls().is_empty());
    committed(&fixture, &outcome);
}

#[test]
fn a_version_without_semver_precedence_is_refused_without_the_flag() {
    assert!(downgrade_refusal("1.0", "0.1.0", false).is_some());
    assert!(downgrade_refusal("1.0", "0.1.0", true).is_none());
    assert!(downgrade_refusal("0.2.0", "0.2.0", false).is_none());
    assert!(downgrade_refusal("0.2.0", "0.1.0", false).is_none());
}

#[test]
fn the_same_version_is_never_gated_even_without_semver_precedence() {
    assert!(downgrade_refusal("1.0", "1.0", false).is_none());
}

/// The POSIX layout: processes run from `current/`, which activation replaces in place.
#[cfg(unix)]
mod current_layout;

/// The switch registers the service definition before it starts the supervisor.
mod service_definition;
