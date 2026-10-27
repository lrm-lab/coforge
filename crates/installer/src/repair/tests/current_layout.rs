use std::os::unix::fs::MetadataExt;
use std::path::Path;

use super::*;
use crate::test_support::point_active_at_version;

type Damage = fn(&Fixture);

/// Repairs an installation of [`OLD`] after `damage`, with the supervisor service in
/// `service_state`. The service state is read once per activation and the service never stopped or
/// started.
fn repair_with_service(
    label: &str,
    service_state: ServiceState,
    damage: impl FnOnce(&Fixture),
) -> (Fixture, Outcome) {
    let fixture = Fixture::new(label);
    fixture.install_old();
    damage(&fixture);
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(service_state);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, OLD);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let outcome = repair(&ports, REQUEST, None, false, &mut |_| {});
    assert_eq!(service.calls(), ["state"]);
    (fixture, outcome)
}

/// Appends a byte to `current/<name>`, keeping its mode.
fn tamper(fixture: &Fixture, name: &str) {
    let path = fixture.root().join("current").join(name);
    let mut bytes = fs::read(&path).unwrap();
    bytes.push(b'!');
    fs::write(&path, bytes).unwrap();
}

fn assert_healthy(fixture: &Fixture) {
    assert_eq!(
        fs::read_link(fixture.root().join("active")).unwrap(),
        Path::new("current")
    );
    assert_eq!(fixture.current_file("version"), b"0.1.0\n");
    assert!(crate::current::in_sync(
        &fixture.root().join("versions").join(OLD),
        &fixture.root().join("current")
    ));
}

#[test]
fn every_way_the_activation_can_be_damaged_is_repaired() {
    let cases: [(&str, Damage); 6] = [
        ("an install from before current/", |fixture| {
            fixture.use_the_layout_from_before_current(OLD)
        }),
        (
            "an older installer re-pointed active at the version",
            |fixture| point_active_at_version(fixture.root(), OLD),
        ),
        ("a tampered executable", |fixture| {
            tamper(fixture, "coforge-computer")
        }),
        ("a marker naming another version", |fixture| {
            fs::write(fixture.root().join("current/version"), "0.2.0\n").unwrap()
        }),
        ("a missing current/", |fixture| {
            fs::remove_dir_all(fixture.root().join("current")).unwrap()
        }),
        ("a file beyond the version's", |fixture| {
            fs::write(fixture.root().join("current/left-over"), "x").unwrap()
        }),
    ];
    for (label, damage) in cases {
        let (fixture, outcome) =
            repair_with_service("repair-damaged", ServiceState::NotInstalled, damage);

        assert_eq!(exit_code(&outcome), 0, "{label}");
        assert_healthy(&fixture);
    }
}

#[test]
fn a_running_supervisor_keeps_its_executable_and_the_rest_is_repaired() {
    let executable_of = |fixture: &Fixture| fixture.root().join("current/coforge-computer");
    let mut before = None;
    let (fixture, outcome) = repair_with_service(
        "repair-running",
        ServiceState::Running { pid: Some(7) },
        |fixture| {
            tamper(fixture, "coforge-computer");
            tamper(fixture, "photon_rs_bg.wasm");
            fs::write(fixture.root().join("current/version"), "0.2.0\n").unwrap();
            point_active_at_version(fixture.root(), OLD);
            let executable = executable_of(fixture);
            before = Some((
                fs::metadata(&executable).unwrap().ino(),
                fs::read(&executable).unwrap(),
            ));
        },
    );

    let Outcome::Receipt(receipt) = &outcome else {
        panic!("repair did not write a receipt");
    };
    assert_eq!(receipt.exit_code(), 1);
    assert_eq!(receipt.status(), crate::contract::ReceiptStatus::Failed);
    assert_eq!(receipt.error_code(), Some("UPDATE_BUSY"));
    let error = receipt.error().unwrap();
    assert!(error.contains("coforge-daemon.service"), "{error}");
    assert!(error.contains("Stop coforge-daemon.service,"), "{error}");
    assert!(!error.contains("  "), "{error}");
    // The running executable is untouched: the same file, the same bytes.
    let (inode, bytes) = before.unwrap();
    let executable = executable_of(&fixture);
    assert_eq!(fs::metadata(&executable).unwrap().ino(), inode);
    assert_eq!(fs::read(&executable).unwrap(), bytes);
    // Everything else is fixed, except the marker, which must not claim a version whose
    // files are not all in place.
    assert_eq!(
        fixture.current_file("photon_rs_bg.wasm"),
        fixture.stored_file(OLD, "photon_rs_bg.wasm")
    );
    assert_eq!(
        fs::read_link(fixture.root().join("active")).unwrap(),
        Path::new("current")
    );
    assert_eq!(fixture.current_file("version"), b"0.2.0\n");
}

#[test]
fn a_running_supervisor_whose_executable_already_matches_gets_the_full_repair() {
    let (fixture, outcome) = repair_with_service(
        "repair-running-matching",
        ServiceState::Running { pid: Some(7) },
        |fixture| {
            tamper(fixture, "photon_rs_bg.wasm");
            fs::write(fixture.root().join("current/version"), "0.2.0\n").unwrap();
        },
    );

    assert_eq!(exit_code(&outcome), 0);
    assert_healthy(&fixture);
}

#[test]
fn a_stopped_supervisor_gets_its_tampered_executable_replaced() {
    let mut inode = 0;
    let (fixture, outcome) =
        repair_with_service("repair-stopped", ServiceState::Stopped, |fixture| {
            tamper(fixture, "coforge-computer");
            inode = fs::metadata(fixture.root().join("current/coforge-computer"))
                .unwrap()
                .ino();
        });

    assert_eq!(exit_code(&outcome), 0);
    assert_healthy(&fixture);
    assert_ne!(
        fs::metadata(fixture.root().join("current/coforge-computer"))
            .unwrap()
            .ino(),
        inode
    );
}
