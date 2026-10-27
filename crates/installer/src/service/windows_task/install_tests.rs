use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use super::*;
use crate::clock::VirtualClock;
use crate::service::coordinator_service;
use crate::service::fakes::definition;
use crate::service::{CommandOutput, RunError};

const SYSTEM_ROOT: &str = "C:\\Windows";
const XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n<Task>caf\u{e9} \u{1f680}</Task>\n";

/// Answers every command with `code`, and keeps the line run and the file its `/XML` argument
/// named as it was while the command ran.
struct Capturing {
    code: i32,
    seen: RefCell<Vec<(CommandLine, Option<Vec<u8>>)>>,
}

impl CommandRunner for Capturing {
    fn run(&self, command: &CommandLine, _: Duration) -> Result<CommandOutput, RunError> {
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
struct Installed {
    result: Result<(), ServiceError>,
    /// The commands the runner saw, each with the file its `/XML` argument named.
    seen: Vec<(CommandLine, Option<Vec<u8>>)>,
}

impl Installed {
    /// The file the registration named with `/XML`, if it named one.
    fn xml_path(&self) -> Option<PathBuf> {
        self.seen.iter().find_map(|(command, _)| {
            let args = command.args();
            let index = args.iter().position(|arg| arg == "/XML")?;
            Some(PathBuf::from(&args[index + 1]))
        })
    }
}

/// Installs against a runner that answers `code`.
fn install(manager: &str, code: i32) -> Installed {
    let runner = Capturing {
        code,
        seen: RefCell::new(Vec::new()),
    };
    let clock = VirtualClock::new();
    let result = WindowsTask::new(&runner, &clock, &coordinator_service(), SYSTEM_ROOT)
        .unwrap()
        .install(&definition(manager, XML));
    Installed {
        result,
        seen: runner.seen.into_inner(),
    }
}

#[test]
fn installing_registers_the_xml_as_utf16_with_a_byte_order_mark_and_does_not_run_the_task() {
    let installed = install("windows-task", 0);
    let path = installed.xml_path().unwrap();
    installed.result.as_ref().unwrap();
    let [(command, file)] = installed.seen.as_slice() else {
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
    let installed = install("windows-task", 1);
    let path = installed.xml_path().unwrap();
    let message = installed.result.unwrap_err().to_string();
    assert!(message.contains("Access is denied."), "{message}");
    assert_eq!(installed.seen.len(), 1);
    assert!(!path.exists(), "{}", path.display());
}

#[test]
fn a_definition_for_another_manager_is_refused_before_any_file_or_command() {
    let installed = install("launchd", 0);
    assert_eq!(
        installed.result.unwrap_err(),
        ServiceError::DefinitionForOtherManager {
            expected: "windows-task",
            found: "launchd".to_owned()
        }
    );
    assert!(installed.seen.is_empty());
}
