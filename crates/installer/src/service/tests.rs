use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use super::*;
use crate::clock::VirtualClock;
use crate::contract::ServiceIdentities;
use crate::test_support::Scratch;

#[test]
fn the_installer_controls_the_services_the_product_installs() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contract/service-identities.json");
    let contract: ServiceIdentities =
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(coordinator_service(), contract.coordinator);
}

/// Answers every command the same way and remembers what was run.
struct Recording {
    ran: RefCell<Vec<String>>,
}

impl CommandRunner for Recording {
    fn run(&self, command: &CommandLine, _: Duration) -> Result<CommandOutput, RunError> {
        self.ran.borrow_mut().push(command.to_string());
        Ok(CommandOutput {
            code: 0,
            stdout: "501\n".to_owned(),
            stderr: String::new(),
        })
    }
}

fn first_commands(platform: Platform) -> Vec<String> {
    let runner = Recording {
        ran: RefCell::new(Vec::new()),
    };
    let home = Scratch::new("for-platform");
    let clock = VirtualClock::new();
    let service = for_platform(platform, home.path(), Some(501), &runner, &clock).unwrap();
    // What the manager answers is not the point here, only which manager is asked.
    let _ = service.state();
    runner.ran.take()
}

#[test]
fn macos_asks_launchd_in_the_domain_of_the_user_id_id_prints() {
    assert_eq!(
        first_commands(Platform::Darwin),
        vec!["/bin/launchctl print gui/501/cn.coforge.computer.daemon"]
    );
}

#[test]
fn macos_without_a_user_id_has_no_domain_to_ask() {
    let runner = Recording {
        ran: RefCell::new(Vec::new()),
    };
    let home = Scratch::new("for-platform-no-uid");
    let clock = VirtualClock::new();
    let refused = for_platform(Platform::Darwin, home.path(), None, &runner, &clock);
    assert!(matches!(refused, Err(ServiceError::InvalidIdentity { .. })));
    assert_eq!(runner.ran.take(), Vec::<String>::new());
}

#[test]
fn linux_asks_the_user_systemd() {
    let commands = first_commands(Platform::Linux);
    assert_eq!(commands.len(), 1);
    assert!(
        commands[0].starts_with("systemctl --user show coforge-daemon.service "),
        "{commands:?}"
    );
}

#[test]
fn windows_asks_task_scheduler() {
    let commands = first_commands(Platform::Windows);
    assert_eq!(commands.len(), 1);
    assert!(
        commands[0].contains(r"\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile"),
        "{commands:?}"
    );
    assert!(commands[0].contains("CoForge Daemon"), "{commands:?}");
}

#[test]
fn every_failure_says_why_and_names_a_command_to_run() {
    let command = "systemctl --user show coforge-daemon.service".to_owned();
    let failures = [
        ServiceError::InvalidIdentity {
            what: "launchd label",
            value: "x/y".to_owned(),
        },
        ServiceError::NotInstalled {
            service: "coforge-daemon.service".to_owned(),
        },
        ServiceError::NoSystemdUserSession {
            command: command.clone(),
            diagnostic: "Failed to connect to bus".to_owned(),
        },
        ServiceError::NoLaunchdDomain {
            domain: "gui/501".to_owned(),
            command: command.clone(),
            code: 112,
            diagnostic: "Could not find domain".to_owned(),
        },
        ServiceError::TaskDisabled {
            task: "CoForge Daemon".to_owned(),
        },
        ServiceError::ToolMissing {
            program: "systemctl".to_owned(),
        },
        ServiceError::FileUnreadable {
            path: "/home/u/Library/LaunchAgents/x.plist".to_owned(),
            detail: "Permission denied (os error 13)".to_owned(),
        },
        ServiceError::CommandFailed {
            command: command.clone(),
            code: 1,
            diagnostic: "Access denied".to_owned(),
            hint: "Run `systemctl --user status coforge-daemon.service`.".to_owned(),
        },
        ServiceError::CommandTimedOut {
            command: command.clone(),
            waited: Duration::from_secs(30),
        },
        ServiceError::CommandNotRun {
            command: command.clone(),
            detail: "Too many open files (os error 24)".to_owned(),
        },
        ServiceError::UnexpectedOutput {
            command: command.clone(),
            output: "???".to_owned(),
        },
        ServiceError::StopTimedOut {
            service: "coforge-daemon.service".to_owned(),
            waited: Duration::from_secs(15),
            observed: "ActiveState=deactivating".to_owned(),
            hint: "Check `systemctl --user status coforge-daemon.service`.".to_owned(),
        },
        ServiceError::StartTimedOut {
            service: "coforge-daemon.service".to_owned(),
            waited: Duration::from_secs(10),
            observed: "ActiveState=activating".to_owned(),
            hint: "Check `journalctl --user -u coforge-daemon.service`.".to_owned(),
        },
    ];
    for failure in failures {
        let message = failure.to_string();
        // A command is a backticked span with a space in it, or one of the bare tools.
        let commands: Vec<&str> = message.split('`').skip(1).step_by(2).collect();
        assert!(!commands.is_empty(), "no command to run in: {message}");
        assert!(message.len() > 60, "too little to act on: {message}");
    }
}

fn machine(platform: Platform, has_systemd: bool) -> (Vec<String>, String) {
    use crate::processes::fakes::FakeTable;
    let runner = Recording {
        ran: RefCell::new(Vec::new()),
    };
    let home = Scratch::new("for-machine");
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = for_machine(
        platform,
        has_systemd,
        home.path(),
        &home.path().join(".coforge/daemon"),
        Some(501),
        Ports {
            runner: &runner,
            clock: &clock,
            table: &table,
            spawner: &SystemSpawn,
        },
    )
    .unwrap();
    let name = service.display_name();
    let _ = service.state();
    (runner.ran.take(), name)
}

#[test]
fn linux_without_systemd_gets_the_detached_process_and_asks_no_manager() {
    let (commands, name) = machine(Platform::Linux, false);
    assert!(commands.is_empty(), "{commands:?}");
    assert_eq!(name, "the detached Computer process");
}

#[test]
fn linux_with_systemd_keeps_the_user_unit() {
    let (commands, name) = machine(Platform::Linux, true);
    assert_eq!(commands.len(), 1);
    assert_eq!(name, "coforge-daemon.service");
}

#[test]
fn macos_and_windows_never_get_the_detached_process() {
    for platform in [Platform::Darwin, Platform::Windows] {
        for has_systemd in [true, false] {
            let (_, name) = machine(platform, has_systemd);
            assert_ne!(name, "the detached Computer process", "{platform:?}");
        }
    }
    assert_eq!(
        machine(Platform::Darwin, false).0,
        vec!["/bin/launchctl print gui/501/cn.coforge.computer.daemon"]
    );
}

#[test]
fn systemd_is_present_only_with_a_running_manager_and_a_systemctl() {
    let run = Scratch::new("run-dir");
    let bin = Scratch::new("bin-dir");
    let path = std::env::join_paths([bin.path()]).unwrap();
    assert!(!systemd_present(run.path(), Some(&path)), "neither");
    fs::create_dir_all(run.path().join("systemd/system")).unwrap();
    assert!(!systemd_present(run.path(), Some(&path)), "no systemctl");
    fs::write(bin.path().join("systemctl"), "").unwrap();
    assert!(systemd_present(run.path(), Some(&path)), "both");
    fs::remove_dir_all(run.path().join("systemd")).unwrap();
    assert!(
        !systemd_present(run.path(), Some(&path)),
        "no running manager"
    );
    assert!(!systemd_present(run.path(), None), "no PATH");
}

fn supervised_machine(record: &str, scope_system: bool) -> (Vec<String>, String, bool) {
    use crate::processes::fakes::FakeTable;
    let runner = Recording {
        ran: RefCell::new(Vec::new()),
    };
    let home = Scratch::new("for-machine-supervised");
    let state = home.path().join(".coforge/daemon");
    fs::create_dir_all(&state).unwrap();
    fs::write(state.join("supervisor.json"), record).unwrap();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = for_machine(
        Platform::Linux,
        true,
        home.path(),
        &state,
        Some(501),
        Ports {
            runner: &runner,
            clock: &clock,
            table: &table,
            spawner: &SystemSpawn,
        },
    )
    .unwrap();
    let name = service.display_name();
    let _ = service.state();
    let registered = service
        .install(&crate::service::fakes::definition("systemd-user", "[Unit]"))
        .unwrap();
    let wrote_unit = home.path().join(".config/systemd/user").exists();
    assert_eq!(registered, Registered::AlreadyInPlace, "{scope_system}");
    (runner.ran.take(), name, wrote_unit)
}

#[test]
fn a_supervised_user_unit_is_controlled_as_itself_and_never_registered() {
    let (commands, name, wrote_unit) = supervised_machine(
        r#"{"kind":"systemd","scope":"user","unit":"mine.service","invocationId":"i","pid":7,"recordedAt":"t"}"#,
        false,
    );
    assert_eq!(name, "mine.service");
    assert!(
        commands[0].starts_with("systemctl --user show mine.service"),
        "{commands:?}"
    );
    assert!(
        commands
            .iter()
            .all(|c| !c.contains("daemon-reload") && !c.contains("enable")),
        "install ran nothing: {commands:?}"
    );
    assert!(
        !wrote_unit,
        "no unit file may be written for a supervised unit"
    );
}

#[test]
fn a_supervised_system_unit_is_asked_without_the_user_flag() {
    let (commands, name, _) = supervised_machine(
        r#"{"kind":"systemd","scope":"system","unit":"coforge.service","invocationId":"i","pid":7,"recordedAt":"t"}"#,
        true,
    );
    assert_eq!(name, "coforge.service");
    assert!(
        commands[0].starts_with("systemctl show coforge.service"),
        "{commands:?}"
    );
}

/// Answers a `systemctl show` the way systemd does for a unit it has never heard of.
struct UnitGone;

impl CommandRunner for UnitGone {
    fn run(&self, _: &CommandLine, _: Duration) -> Result<CommandOutput, RunError> {
        Ok(CommandOutput {
            code: 0,
            stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n"
                .to_owned(),
            stderr: String::new(),
        })
    }
}

#[test]
fn a_record_of_a_unit_systemd_forgot_is_dropped_and_the_coordinator_unit_is_used() {
    use crate::processes::fakes::FakeTable;
    let home = Scratch::new("for-machine-forgotten");
    let state = home.path().join(".coforge/daemon");
    fs::create_dir_all(&state).unwrap();
    let record = state.join("supervisor.json");
    fs::write(
        &record,
        r#"{"kind":"systemd","scope":"user","unit":"gone.service","invocationId":"i","pid":7,"recordedAt":"t"}"#,
    )
    .unwrap();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = for_machine(
        Platform::Linux,
        true,
        home.path(),
        &state,
        Some(501),
        Ports {
            runner: &UnitGone,
            clock: &clock,
            table: &table,
            spawner: &SystemSpawn,
        },
    )
    .unwrap();
    assert_eq!(service.display_name(), "coforge-daemon.service");
    assert!(!record.exists(), "the stale record is removed");
}
