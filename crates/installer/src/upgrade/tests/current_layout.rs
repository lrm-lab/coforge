use super::*;
use crate::store::VersionStore;

fn version_marker(fixture: &Fixture) -> String {
    fs::read_to_string(fixture.root().join("current/version")).unwrap()
}

#[test]
fn processes_running_from_current_are_stopped_and_current_then_holds_the_new_version() {
    let fixture = Fixture::new("upgrade-current-running");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    // The supervisor and a daemon run `current/coforge-computer`; a straggler started before
    // `current/` existed still runs from the version directory.
    table.spawn(100, 1, &fixture.canonical_current());
    table.spawn(101, 2, &fixture.canonical_current());
    table.spawn(102, 3, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    script_running_upgrade(&fixture, &lifecycle);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    assert_eq!(version_marker(&fixture), "0.1.0\n");

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 0);
    assert_eq!(pids(receipt(&outcome)), [100, 101, 102]);
    assert_eq!(active(&fixture), active_state(NEW, Some(OLD)));
    assert_eq!(version_marker(&fixture), "0.2.0\n");
    assert_eq!(
        fixture.current_file("installation.json"),
        fixture.stored_file(NEW, "installation.json")
    );
    assert_eq!(
        fs::read_link(fixture.root().join("active")).unwrap(),
        Path::new("current")
    );
}

#[test]
fn an_install_from_before_current_is_converted_and_its_processes_are_stopped() {
    let fixture = Fixture::new("upgrade-current-migrate");
    fixture.install_old();
    fixture.use_the_layout_from_before_current(OLD);
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    table.spawn(101, 2, &fixture.canonical_computer(OLD));
    let service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let lifecycle = FakeLifecycle::default();
    script_running_upgrade(&fixture, &lifecycle);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    assert_eq!(exit_of(&outcome), 0);
    assert_eq!(pids(receipt(&outcome)), [100, 101]);
    assert_eq!(
        fs::read_link(fixture.root().join("active")).unwrap(),
        Path::new("current")
    );
    assert_eq!(version_marker(&fixture), "0.2.0\n");
    assert_eq!(
        fixture.current_file("installation.json"),
        fixture.stored_file(NEW, "installation.json")
    );
}

#[test]
fn a_rolled_back_upgrade_restores_current_and_keeps_both_stored_versions() {
    let fixture = Fixture::new("upgrade-current-rollback");
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_current());
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
    lifecycle.answers_status(&fixture.computer(NEW), vec![Some(stopped(NEW))]);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let executable = fixture.root().join("current/coforge-computer");
    let real_path = fs::canonicalize(&executable).unwrap();

    let (outcome, _) = run(&ports, REQUEST, NEW, None);

    assert_eq!(receipt(&outcome).error_code(), Some(ERROR_CODE_ROLLED_BACK));
    assert_eq!(pids(receipt(&outcome)), [100]);
    assert_eq!(active(&fixture), active_state(OLD, None));
    assert_eq!(version_marker(&fixture), "0.1.0\n");
    assert_eq!(
        fixture.current_file("installation.json"),
        fixture.stored_file(OLD, "installation.json")
    );
    // Upgrade and rollback ran from one real path.
    assert_eq!(fs::canonicalize(&executable).unwrap(), real_path);
    // The failed candidate is kept as the store's, and verifies.
    let store = VersionStore::new(fixture.root(), TARGET);
    assert!(store.verify_installed(NEW).is_ok());
    assert!(store.verify_installed(OLD).is_ok());
}
