use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use super::tests::QUERY;
use super::*;
use crate::clock::VirtualClock;
use crate::service::coordinator_service;
use crate::service::fakes::{ScriptedRunner, definition, exits};
use crate::service::{CommandOutput, RunError};

const SYSTEM_ROOT: &str = "C:\\Windows";
const XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n<Task>caf\u{e9} \u{1f680}</Task>\n";

/// Answers the state query with the task's state and every other command with `code`, and keeps
/// the line run and the file its `/XML` argument named as it was while the command ran.
struct Capturing {
    /// The `State` PowerShell prints for the task; `None` is a task that is not registered.
    task: Option<&'static str>,
    code: i32,
    seen: RefCell<Vec<(CommandLine, Option<Vec<u8>>)>>,
}

impl CommandRunner for Capturing {
    fn run(&self, command: &CommandLine, _: Duration) -> Result<CommandOutput, RunError> {
        if command.args().iter().any(|arg| arg == "-Command") {
            self.seen.borrow_mut().push((command.clone(), None));
            return Ok(CommandOutput {
                code: if self.task.is_some() { 0 } else { 3 },
                stdout: self
                    .task
                    .map(|state| format!("{state}\r\n"))
                    .unwrap_or_default(),
                stderr: String::new(),
            });
        }
        let file = command
            .args()
            .iter()
            .position(|arg| arg == "/XML")
            .map(|index| fs::read(&command.args()[index + 1]).unwrap());
        self.seen.borrow_mut().push((command.clone(), file));
        Ok(CommandOutput {
            code: self.code,
            stdout: String::new(),
            stderr: "ERROR: Access is denied.\n".repeat(usize::from(self.code != 0)),
        })
    }
}

/// What an installation did.
struct Registration {
    result: Result<Registered, ServiceError>,
    /// The commands the runner saw, each with the file its `/XML` argument named.
    seen: Vec<(CommandLine, Option<Vec<u8>>)>,
}

impl Registration {
    /// The commands that were not the state query.
    fn changes(&self) -> Vec<&(CommandLine, Option<Vec<u8>>)> {
        self.seen
            .iter()
            .filter(|(command, _)| !command.args().iter().any(|arg| arg == "-Command"))
            .collect()
    }

    /// The file the registration named with `/XML`, if it named one.
    fn xml_path(&self) -> Option<PathBuf> {
        self.seen.iter().find_map(|(command, _)| {
            let args = command.args();
            let index = args.iter().position(|arg| arg == "/XML")?;
            Some(PathBuf::from(&args[index + 1]))
        })
    }
}

/// Installs a definition for `manager` over a task in state `task` (`None`: not registered)
/// against a runner whose `schtasks` answers `code`.
fn install(manager: &str, task: Option<&'static str>, code: i32) -> Registration {
    let runner = Capturing {
        task,
        code,
        seen: RefCell::new(Vec::new()),
    };
    let clock = VirtualClock::new();
    let result = WindowsTask::new(&runner, &clock, &coordinator_service(), SYSTEM_ROOT)
        .unwrap()
        .install(&definition(manager, XML));
    Registration {
        result,
        seen: runner.seen.into_inner(),
    }
}

#[test]
fn installing_registers_the_xml_as_utf16_with_a_byte_order_mark_and_does_not_run_the_task() {
    let installed = install("windows-task", Some("Ready"), 0);
    let path = installed.xml_path().unwrap();
    // A task has no file to compare, so a registration is always written.
    assert_eq!(installed.result, Ok(Registered::Written));
    let [(command, file)] = installed.changes().as_slice() else {
        panic!("expected one command, saw {:?}", installed.seen);
    };
    assert_eq!(command.program(), "C:\\Windows\\System32\\schtasks.exe");
    let args = command.args();
    assert_eq!(&args[..4], ["/Create", "/TN", "CoForge Daemon", "/XML"]);
    assert_eq!(args[5], "/F");
    assert_eq!(args.len(), 6);
    let bytes = file.as_deref().unwrap();
    assert_eq!(&bytes[..2], [0xFF, 0xFE]);
    let units: Vec<u16> = bytes[2..]
        .chunks(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    assert_eq!(String::from_utf16(&units).unwrap(), XML);
    assert!(!path.exists(), "{}", path.display());
}

#[test]
fn the_temporary_file_is_removed_when_the_registration_is_refused() {
    let installed = install("windows-task", Some("Ready"), 1);
    let path = installed.xml_path().unwrap();
    let message = installed.result.as_ref().unwrap_err().to_string();
    assert!(message.contains("Access is denied."), "{message}");
    assert_eq!(installed.changes().len(), 1);
    assert!(!path.exists(), "{}", path.display());
}

#[test]
fn a_definition_for_another_manager_is_refused_before_any_file_or_command() {
    let installed = install("launchd", Some("Ready"), 0);
    assert_eq!(
        installed.result.unwrap_err(),
        ServiceError::DefinitionForOtherManager {
            expected: "windows-task",
            found: "launchd".to_owned()
        }
    );
    assert!(installed.seen.is_empty());
}

#[test]
fn a_task_that_is_missing_or_not_running_is_registered() {
    for task in [None, Some("Ready"), Some("Disabled")] {
        let installed = install("windows-task", task, 0);
        assert_eq!(installed.result, Ok(Registered::Written), "{task:?}");
        assert_eq!(installed.changes().len(), 1, "{task:?}");
    }
}

#[test]
fn a_running_task_keeps_its_registration_and_no_file_is_made() {
    // Nothing documents what `schtasks /Create /F` does to a running instance, so a running (or
    // queued) task is not replaced.
    for task in ["Running", "Queued"] {
        let installed = install("windows-task", Some(task), 0);
        assert_eq!(installed.result, Ok(Registered::LeftRunning), "{task}");
        assert_eq!(installed.seen.len(), 1, "{task}");
        assert!(installed.changes().is_empty(), "{task}");
        assert_eq!(installed.xml_path(), None, "{task}");
    }
}

#[test]
fn a_state_that_cannot_be_read_refuses_the_registration() {
    // The task's state is unknown, so it may be running.
    let runner = ScriptedRunner::new(vec![exits(
        QUERY,
        1,
        "Get-ScheduledTask: Access is denied.",
    )]);
    let clock = VirtualClock::new();
    let task = WindowsTask::new(&runner, &clock, &coordinator_service(), SYSTEM_ROOT).unwrap();

    let message = task
        .install(&definition("windows-task", XML))
        .unwrap_err()
        .to_string();

    assert!(message.contains("Access is denied."), "{message}");
    assert_eq!(runner.ran().len(), 1);
}
