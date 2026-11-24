use std::os::unix::fs::symlink;

use super::*;
use crate::paths::Platform;
use crate::service::fakes::{ScriptedRunner, Step, exits, ok};
use crate::service::{self, SystemSpawn};

const UNIT: &str = "customer-coforge.service";
const UNIT_PATH: &str = "/org/freedesktop/systemd1/unit/customer_2dcoforge_2eservice";
const ACTIVE: &str = "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=100\n";
const INACTIVE: &str = "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\n";

fn systemctl(scope: &str, args: &str) -> String {
    if scope == "user" {
        format!("systemctl --user {args}")
    } else {
        format!("systemctl {args}")
    }
}

fn show(scope: &str, output: &str) -> Step {
    ok(
        &systemctl(
            scope,
            &format!(
                "show {UNIT} --property=LoadState --property=ActiveState --property=SubState --property=MainPID"
            ),
        ),
        output,
    )
}

fn exec_start(scope: &str, executable: Option<&Path>) -> Vec<Step> {
    let busctl = if scope == "user" {
        "busctl --user"
    } else {
        "busctl"
    };
    let get_unit = format!(
        "{busctl} --json=short call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager GetUnit s {UNIT}"
    );
    let Some(executable) = executable else {
        return vec![exits(&get_unit, 1, "bus unavailable")];
    };
    let unit = serde_json::json!({"type": "o", "data": [UNIT_PATH]});
    let command = serde_json::json!({
        "type": "a(sasbttttuii)",
        "data": [[executable, [executable, Path::new("foreground")], false, 0, 0, 0, 0, 100, 0, 0]],
    });
    vec![
        ok(&get_unit, &unit.to_string()),
        ok(
            &format!(
                "{busctl} --json=short get-property org.freedesktop.systemd1 {UNIT_PATH} org.freedesktop.systemd1.Service ExecStart"
            ),
            &command.to_string(),
        ),
    ]
}

fn run_external_upgrade(
    fixture: &Fixture,
    clock: &VirtualClock,
    table: &FakeTable<'_>,
    runner: &ScriptedRunner,
    scope: &str,
) -> (Outcome, Vec<String>) {
    fs::write(
        fixture.root().join("supervisor.json"),
        serde_json::json!({"kind": "systemd", "unit": UNIT, "scope": scope}).to_string(),
    )
    .unwrap();
    let service = service::for_machine(
        Platform::Linux,
        true,
        fixture.root(),
        fixture.root(),
        None,
        service::Ports {
            runner,
            clock,
            table,
            spawner: &SystemSpawn,
        },
    )
    .unwrap();
    let lifecycle = FakeLifecycle::default();
    script_running_upgrade(fixture, &lifecycle);
    let mut ports = fixture.ports(&lifecycle, service.as_ref(), table, clock);
    ports.state_directory = Some(fixture.root());
    let progress = fixture.root().join("upgrade-progress").join(REQUEST);
    fs::create_dir_all(&progress).unwrap();
    fs::write(
        progress.join("context.json"),
        serde_json::json!({"generation": OTHER_REQUEST, "version": NEW}).to_string(),
    )
    .unwrap();
    run(&ports, REQUEST, NEW, None)
}

#[test]
fn a_fixed_external_exec_start_refuses_before_waiting_or_stopping() {
    for scope in ["user", "system"] {
        let fixture = Fixture::new("external-systemd-fixed");
        fixture.install_old();
        let copy = fixture.root().join("old copy");
        fs::copy(fixture.computer(OLD), &copy).unwrap();
        let link = fixture.root().join("external-executable");
        symlink(&copy, &link).unwrap();
        let executable = if scope == "user" { &copy } else { &link };
        let clock = VirtualClock::new();
        let table = FakeTable::new(&clock);
        let mut steps = vec![show(scope, ACTIVE), show(scope, ACTIVE)];
        steps.extend(exec_start(scope, Some(executable)));
        let runner = ScriptedRunner::new(steps);

        let (outcome, stages) = run_external_upgrade(&fixture, &clock, &table, &runner, scope);

        assert_eq!(exit_of(&outcome), 1);
        let result = committed(&fixture, &outcome);
        assert_eq!(result.status(), ReceiptStatus::Failed);
        let error = result.error().unwrap();
        assert!(error.contains(UNIT), "{error}");
        assert!(error.contains(executable.to_str().unwrap()), "{error}");
        assert!(
            error.contains(fixture.running_computer(OLD).to_str().unwrap()),
            "{error}"
        );
        assert!(!stages.iter().any(|line| line.starts_with("Stopping")
            || line.starts_with("Switching")
            || line.starts_with("Waiting")));
        assert!(table.signals().is_empty());
        assert_eq!(active(&fixture), active_state(OLD, None));
        assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
        let progress = fixture.root().join("upgrade-progress").join(REQUEST);
        assert!(!progress.join("switching.json").exists());
        assert!(!progress.join("waiting.json").exists());
        assert!(!fixture.root().join("upgrade-drain-request.json").exists());
    }
}

#[test]
fn an_external_exec_start_can_name_a_different_release_than_the_running_supervisor() {
    let fixture = Fixture::new("external-systemd-other-release");
    fixture.install_old();
    let directory = fixture.root().join("other-release");
    fs::create_dir(&directory).unwrap();
    let executable = directory.join("coforge-computer");
    fs::write(
        &executable,
        b"\x7fELF\0/$bunfs/root/linux-x64-coforge-computer\0coforge-computer __lifecycle",
    )
    .unwrap();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_current());
    let scope = "user";
    let mut steps = vec![show(scope, ACTIVE), show(scope, ACTIVE)];
    steps.extend(exec_start(scope, Some(&executable)));
    let runner = ScriptedRunner::new(steps);

    let (outcome, _) = run_external_upgrade(&fixture, &clock, &table, &runner, scope);

    assert_eq!(exit_of(&outcome), 1);
    let result = committed(&fixture, &outcome);
    assert!(
        result
            .error()
            .unwrap()
            .contains(executable.to_str().unwrap())
    );
    assert!(table.signals().is_empty());
    assert_eq!(active(&fixture), active_state(OLD, None));
}

#[test]
fn external_managed_paths_and_unknown_commands_keep_the_existing_upgrade() {
    for scenario in [
        "managed",
        "tracking-link",
        "wrapper",
        "native-wrapper",
        "unavailable",
    ] {
        let fixture = Fixture::new("external-systemd-allowed");
        fixture.install_old();
        let managed = fixture.running_computer(OLD);
        let external = fixture.root().join("coforge-computer");
        let executable = match scenario {
            "managed" => Some(managed.as_path()),
            "tracking-link" => {
                symlink(fixture.root().join("active/coforge-computer"), &external).unwrap();
                Some(external.as_path())
            }
            "wrapper" => {
                fs::write(&external, "#!/bin/sh\nexec coforge-computer foreground\n").unwrap();
                Some(external.as_path())
            }
            "native-wrapper" => {
                fs::write(
                    &external,
                    b"\x7fELF\0/$bunfs/root/linux-x64-coforge-computer\0",
                )
                .unwrap();
                Some(external.as_path())
            }
            _ => None,
        };
        let clock = VirtualClock::new();
        let table = FakeTable::new(&clock);
        let scope = "user";
        let mut steps = vec![show(scope, ACTIVE), show(scope, ACTIVE)];
        steps.extend(exec_start(scope, executable));
        steps.extend([
            show(scope, ACTIVE),
            ok(&systemctl(scope, &format!("stop {UNIT}")), ""),
            show(scope, INACTIVE),
            show(scope, INACTIVE),
            ok(&systemctl(scope, &format!("reset-failed {UNIT}")), ""),
            ok(&systemctl(scope, &format!("start {UNIT}")), ""),
            show(scope, ACTIVE),
        ]);
        let runner = ScriptedRunner::new(steps);

        let (outcome, _) = run_external_upgrade(&fixture, &clock, &table, &runner, scope);

        assert_eq!(exit_of(&outcome), 0, "{scenario}: {outcome:?}");
        assert_eq!(active(&fixture), active_state(NEW, Some(OLD)));
    }
}
