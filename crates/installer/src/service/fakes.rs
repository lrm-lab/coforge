//! Test doubles for the service backends: a [`CommandRunner`] that plays a script of exactly the
//! command lines the backend is expected to run, in order, and fails the test on any deviation.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use super::{CommandLine, CommandOutput, CommandRunner, ProcessCgroup, RunError};
use crate::contract::{LIFECYCLE_PROTOCOL, LifecycleServiceDefinition};

/// The service definition a Computer of version 0.2.0 reports for `manager`, with `contents`.
pub(crate) fn definition(manager: &str, contents: &str) -> LifecycleServiceDefinition {
    LifecycleServiceDefinition {
        lifecycle_protocol: LIFECYCLE_PROTOCOL,
        version: "0.2.0".to_owned(),
        manager: manager.to_owned(),
        contents: contents.to_owned(),
    }
}

/// Writes `contents` to `path`, creating its directory, and dates the file long ago. A test tells a
/// definition that was rewritten from one that was left alone by [`modified`] no longer being
/// the returned time.
pub(crate) fn place_dated(path: &Path, contents: &str) -> SystemTime {
    let long_ago = SystemTime::UNIX_EPOCH + Duration::from_secs(86_400);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(long_ago)
        .unwrap();
    long_ago
}

/// When `path` was last written.
pub(crate) fn modified(path: &Path) -> SystemTime {
    fs::metadata(path).unwrap().modified().unwrap()
}

/// A cgroup listing that the test chooses; `None` is a file that cannot be read.
pub(crate) struct FixedCgroup(pub(crate) Option<&'static str>);

impl ProcessCgroup for FixedCgroup {
    fn read(&self) -> std::io::Result<String> {
        self.0
            .map(str::to_owned)
            .ok_or_else(|| std::io::Error::other("no /proc"))
    }
}

/// One expected command and what it answers.
pub(crate) struct Step {
    expect: String,
    answer: Result<CommandOutput, RunError>,
    /// How many more times this step answers; `None` answers until the test ends.
    remaining: Option<usize>,
}

impl Step {
    /// The step answers `count` times in a row.
    pub(crate) fn times(mut self, count: usize) -> Self {
        self.remaining = Some(count);
        self
    }

    /// The step answers every remaining call: a poll that never sees the change it waits for.
    pub(crate) fn forever(mut self) -> Self {
        self.remaining = None;
        self
    }
}

/// `command` exits 0 and prints `stdout`.
pub(crate) fn ok(command: &str, stdout: &str) -> Step {
    exits(command, 0, "").with_stdout(stdout)
}

/// `command` exits `code` and writes `stderr`.
pub(crate) fn exits(command: &str, code: i32, stderr: &str) -> Step {
    Step {
        expect: command.to_owned(),
        answer: Ok(CommandOutput {
            code,
            stdout: String::new(),
            stderr: stderr.to_owned(),
        }),
        remaining: Some(1),
    }
}

/// `command` cannot be run at all.
pub(crate) fn cannot_run(command: &str, error: RunError) -> Step {
    Step {
        expect: command.to_owned(),
        answer: Err(error),
        remaining: Some(1),
    }
}

impl Step {
    fn with_stdout(mut self, stdout: &str) -> Self {
        if let Ok(output) = &mut self.answer {
            output.stdout = stdout.to_owned();
        }
        self
    }
}

pub(crate) struct ScriptedRunner {
    script: RefCell<VecDeque<Step>>,
    ran: RefCell<Vec<(String, Duration)>>,
}

impl ScriptedRunner {
    pub(crate) fn new(steps: Vec<Step>) -> Self {
        Self {
            script: RefCell::new(steps.into()),
            ran: RefCell::new(Vec::new()),
        }
    }

    /// Every command line run so far, as typed.
    pub(crate) fn ran(&self) -> Vec<String> {
        self.ran
            .borrow()
            .iter()
            .map(|(command, _)| command.clone())
            .collect()
    }

    /// The longest bound any command was given.
    pub(crate) fn longest_timeout(&self) -> Duration {
        self.ran
            .borrow()
            .iter()
            .map(|(_, timeout)| *timeout)
            .max()
            .unwrap_or_default()
    }
}

impl CommandRunner for ScriptedRunner {
    fn run(&self, command: &CommandLine, timeout: Duration) -> Result<CommandOutput, RunError> {
        let line = command.to_string();
        self.ran.borrow_mut().push((line.clone(), timeout));
        let mut script = self.script.borrow_mut();
        let Some(step) = script.front_mut() else {
            panic!("unexpected command after the script ended: {line}");
        };
        assert_eq!(
            step.expect,
            line,
            "command number {} did not match the script; ran so far: {:#?}",
            self.ran.borrow().len(),
            self.ran.borrow()
        );
        let answer = step.answer.clone();
        match &mut step.remaining {
            None => {}
            Some(remaining) if *remaining > 1 => *remaining -= 1,
            Some(_) => {
                script.pop_front();
            }
        }
        answer
    }
}

impl Drop for ScriptedRunner {
    fn drop(&mut self) {
        if std::thread::panicking() {
            return;
        }
        let unrun: Vec<String> = self
            .script
            .borrow()
            .iter()
            .filter(|step| step.remaining.is_some())
            .map(|step| step.expect.clone())
            .collect();
        assert!(
            unrun.is_empty(),
            "the script expected more commands: {unrun:#?}"
        );
    }
}
