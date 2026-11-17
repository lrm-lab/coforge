use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::active::{activate, read_active};
use crate::clock::VirtualClock;
use crate::contract::{ACTIVE_STATE_SCHEMA_VERSION, ActiveState};
use crate::feed::Feed;
use crate::journal::{Journal, Transaction};
use crate::lock::MachineMutationLock;
use crate::prepare::prepare_version;
use crate::processes::fakes::FakeTable;
use crate::recover::{RecoverOutcome, recover};
use crate::repair::repair;
use crate::service::ServiceState;
use crate::store::VersionStore;
use crate::switch::Ports;
use crate::test_support::{Release, Response, Scratch, Server, loopback_feed};
use crate::upgrade::fakes::{
    FakeLifecycle, FakeService, NEW, OLD, REQUEST, TARGET, protocol, running, stopped,
};
use crate::upgrade::{Outcome, UpgradeRequest, upgrade};

const OLDEST: &str = "0.0.9";
const SECOND_REQUEST: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const THIRD_REQUEST: &str = "4a8b12c3-9d0e-4f5a-8b6c-1d2e3f4a5b6c";

fn exit_of(outcome: &Outcome) -> u8 {
    match outcome {
        Outcome::Receipt(receipt) => receipt.exit_code(),
        Outcome::NoReceipt { exit, .. } => *exit,
    }
}

fn active_state(current: &str, previous: Option<&str>) -> Option<ActiveState> {
    Some(ActiveState {
        schema_version: ACTIVE_STATE_SCHEMA_VERSION,
        current: current.to_owned(),
        previous: previous.map(str::to_owned),
    })
}

fn stored_versions(root: &Path) -> Vec<String> {
    let mut versions: Vec<String> = fs::read_dir(root.join("versions"))
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    versions.sort();
    versions
}

fn multi_version_feed(versions: &[&str], latest: &str) -> (Server, Feed) {
    let mut routes = BTreeMap::new();
    for version in versions {
        routes.extend(Release::new(version, TARGET).routes());
    }
    routes.insert("/latest".to_owned(), Response::ok(format!("{latest}\n")));
    let server = Server::start_scripted(routes, BTreeMap::new());
    let feed = loopback_feed(&server.base_url(), Default::default());
    (server, feed)
}

fn run_upgrade(ports: &Ports<'_>, request_id: &str, selection: &str) -> Outcome {
    let request = UpgradeRequest {
        request_id,
        selection,
        caller: None,
        allow_downgrade: false,
    };
    upgrade(ports, &request, &mut |_| {})
}

#[test]
fn consecutive_upgrades_prune_versions_older_than_previous_while_preserving_rollback() {
    let scratch = Scratch::new("upgrade-prune-sequence");
    let root = scratch.path().join("install");
    let bin = scratch.path().join("bin");
    let store = VersionStore::new(&root, TARGET);
    let (_server, feed) = multi_version_feed(&[OLDEST, OLD, NEW], NEW);
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    for version in [OLDEST, OLD, NEW] {
        lifecycle.answers_protocol(&store.computer_path(version), vec![Some(protocol(version))]);
        lifecycle.answers_status(&store.computer_path(version), vec![Some(stopped(version))]);
    }
    let ports = Ports {
        install_root: &root,
        binary_directory: &bin,
        store: &store,
        release: &feed,
        lifecycle: &lifecycle,
        service: &service,
        processes: &table,
        clock: &clock,
    };

    // First install (0.0.9): only 0.0.9 is stored.
    lifecycle.answers_protocol(
        &store.running_computer_path(OLDEST),
        vec![Some(protocol(OLDEST))],
    );
    assert_eq!(exit_of(&run_upgrade(&ports, REQUEST, OLDEST)), 0);
    assert_eq!(stored_versions(&root), [OLDEST]);

    // Upgrade to 0.1.0: 0.0.9 stays as `active.previous` for rollback.
    lifecycle.answers_protocol(&store.running_computer_path(OLD), vec![Some(protocol(OLD))]);
    assert_eq!(exit_of(&run_upgrade(&ports, SECOND_REQUEST, OLD)), 0);
    assert_eq!(read_active(&root).unwrap(), active_state(OLD, Some(OLDEST)));
    assert_eq!(stored_versions(&root), [OLDEST, OLD]);

    // Upgrade to 0.2.0: 0.1.0 becomes `previous`, and 0.0.9 is pruned.
    lifecycle.answers_protocol(&store.running_computer_path(NEW), vec![Some(protocol(NEW))]);
    assert_eq!(exit_of(&run_upgrade(&ports, THIRD_REQUEST, NEW)), 0);
    assert_eq!(read_active(&root).unwrap(), active_state(NEW, Some(OLD)));
    assert_eq!(stored_versions(&root), [OLD, NEW]);
}

#[test]
fn upgrade_spares_an_inactive_version_whose_binary_is_still_running_in_process_table() {
    let scratch = Scratch::new("upgrade-prune-running-spared");
    let root = scratch.path().join("install");
    let bin = scratch.path().join("bin");
    let store = VersionStore::new(&root, TARGET);
    let (_server, feed) = multi_version_feed(&[OLDEST, OLD, NEW], NEW);
    let lock = MachineMutationLock::acquire(&root).unwrap();
    for version in [OLDEST, OLD] {
        prepare_version(&lock, &feed, &store, version, None).unwrap();
    }
    activate(
        &store,
        &bin,
        &ActiveState {
            schema_version: ACTIVE_STATE_SCHEMA_VERSION,
            current: OLD.to_owned(),
            previous: Some(OLDEST.to_owned()),
        },
        false,
    )
    .unwrap();
    drop(lock);

    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let running_oldest = fs::canonicalize(store.computer_path(OLDEST))
        .unwrap()
        .to_string_lossy()
        .into_owned();
    table.spawn(5050, 1, &running_oldest);

    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    for version in [OLD, NEW] {
        lifecycle.answers_protocol(&store.computer_path(version), vec![Some(protocol(version))]);
    }
    lifecycle.answers_protocol(&store.running_computer_path(NEW), vec![Some(protocol(NEW))]);
    lifecycle.answers_status(&store.computer_path(OLD), vec![Some(stopped(OLD))]);
    let ports = Ports {
        install_root: &root,
        binary_directory: &bin,
        store: &store,
        release: &feed,
        lifecycle: &lifecycle,
        service: &service,
        processes: &table,
        clock: &clock,
    };

    assert_eq!(exit_of(&run_upgrade(&ports, REQUEST, NEW)), 0);
    assert_eq!(read_active(&root).unwrap(), active_state(NEW, Some(OLD)));
    assert_eq!(stored_versions(&root), [OLDEST, OLD, NEW]);
}

#[test]
fn repair_prunes_inactive_historical_versions_under_the_mutation_lock() {
    let scratch = Scratch::new("repair-prunes-inactive");
    let root = scratch.path().join("install");
    let bin = scratch.path().join("bin");
    let store = VersionStore::new(&root, TARGET);
    let (_server, feed) = multi_version_feed(&[OLDEST, OLD, NEW], NEW);
    let lock = MachineMutationLock::acquire(&root).unwrap();
    for version in [OLDEST, OLD, NEW] {
        prepare_version(&lock, &feed, &store, version, None).unwrap();
    }
    activate(
        &store,
        &bin,
        &ActiveState {
            schema_version: ACTIVE_STATE_SCHEMA_VERSION,
            current: NEW.to_owned(),
            previous: Some(OLD.to_owned()),
        },
        false,
    )
    .unwrap();
    drop(lock);

    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    lifecycle.answers_protocol(&store.computer_path(NEW), vec![Some(protocol(NEW))]);
    let ports = Ports {
        install_root: &root,
        binary_directory: &bin,
        store: &store,
        release: &feed,
        lifecycle: &lifecycle,
        service: &service,
        processes: &table,
        clock: &clock,
    };

    let outcome = repair(&ports, REQUEST, None, false, &mut |_| {});

    assert_eq!(exit_of(&outcome), 2);
    assert_eq!(stored_versions(&root), [OLD, NEW]);
}

#[test]
fn recovery_prunes_inactive_historical_versions_after_settling_on_the_target() {
    let scratch = Scratch::new("recover-prunes-inactive");
    let root = scratch.path().join("install");
    let bin = scratch.path().join("bin");
    let store = VersionStore::new(&root, TARGET);
    let (_server, feed) = multi_version_feed(&[OLDEST, OLD, NEW], NEW);
    let lock = MachineMutationLock::acquire(&root).unwrap();
    for version in [OLDEST, OLD, NEW] {
        prepare_version(&lock, &feed, &store, version, None).unwrap();
    }
    activate(
        &store,
        &bin,
        &ActiveState {
            schema_version: ACTIVE_STATE_SCHEMA_VERSION,
            current: NEW.to_owned(),
            previous: Some(OLD.to_owned()),
        },
        false,
    )
    .unwrap();
    Journal::new(&root)
        .record(
            &lock,
            &Transaction {
                request_id: REQUEST.to_owned(),
                from: Some(OLD.to_owned()),
                from_previous: Some(OLDEST.to_owned()),
                to: NEW.to_owned(),
                supervisor_running: true,
            },
        )
        .unwrap();
    drop(lock);

    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::Stopped);
    let lifecycle = FakeLifecycle::default();
    lifecycle.answers_protocol(&store.computer_path(NEW), vec![Some(protocol(NEW))]);
    lifecycle.answers_status(
        &store.computer_path(NEW),
        vec![Some(running(NEW, "new-id"))],
    );
    let ports = Ports {
        install_root: &root,
        binary_directory: &bin,
        store: &store,
        release: &feed,
        lifecycle: &lifecycle,
        service: &service,
        processes: &table,
        clock: &clock,
    };

    let outcome = recover(&ports, None, &mut |_| {});

    assert_eq!(
        outcome,
        RecoverOutcome::Recovered {
            version: NEW.to_owned()
        }
    );
    assert_eq!(stored_versions(&root), [OLD, NEW]);
}
