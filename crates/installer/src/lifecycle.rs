//! The installer's one way of asking a Computer about itself: `coforge-computer __lifecycle
//! protocol|status|service-definition` (packages/computer/src/release/lifecycle-command.ts).
//! Every call prints one versioned JSON object; this module runs it bounded and reads that
//! object, never human text.
//!
//! `protocol` answers without contacting anything, so it also probes a candidate executable that
//! has never run. `status` asks the running supervisor, or reads its persisted state when none
//! runs. `service-definition` prints the service definition the Computer registers with the
//! service manager; only a Computer whose `protocol` lists that command answers it, which
//! [`reported_service_definition`] checks before it asks.

use std::fmt;
use std::path::Path;
use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::contract::{
    LIFECYCLE_PROTOCOL, LifecycleError, LifecycleProtocol, LifecycleServiceDefinition,
    LifecycleStatus,
};
use crate::service::{CommandLine, CommandRunner, RunError};

/// `protocol` reads nothing; this only covers starting a large executable.
const PROTOCOL_BOUND: Duration = Duration::from_secs(20);
/// `status` asks a supervisor that may be busy.
const STATUS_BOUND: Duration = Duration::from_secs(30);
/// `service-definition` renders text from paths and settings, as `protocol` does.
const SERVICE_DEFINITION_BOUND: Duration = Duration::from_secs(10);
/// The `commands` entry of `protocol` for `service-definition`.
const SERVICE_DEFINITION_COMMAND: &str = "service-definition";

#[derive(Debug)]
pub enum LifecycleFailure {
    /// The executable could not be run, or did not finish within its bound.
    NotRun { command: String, detail: String },
    /// It answered with its error object and a non-zero exit status.
    Failed {
        command: String,
        code: i32,
        message: String,
    },
    /// What it printed is not the object it promises.
    Unreadable { command: String, detail: String },
    /// It speaks another lifecycle protocol.
    Protocol { command: String, found: u32 },
}

impl fmt::Display for LifecycleFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotRun { command, detail } => {
                write!(formatter, "`{command}` could not be run: {detail}")
            }
            Self::Failed {
                command,
                code,
                message,
            } => write!(formatter, "`{command}` failed (exit {code}): {message}"),
            Self::Unreadable { command, detail } => write!(
                formatter,
                "`{command}` did not answer with its lifecycle JSON: {detail}"
            ),
            Self::Protocol { command, found } => write!(
                formatter,
                "`{command}` speaks lifecycle protocol {found}; this installer speaks \
                 {LIFECYCLE_PROTOCOL}. Run `coforge-computer upgrade` again: it fetches the \
                 current installer."
            ),
        }
    }
}

impl std::error::Error for LifecycleFailure {}

/// What the install transaction asks a Computer executable about itself. [`Lifecycle`] runs the
/// real command; the transaction's tests script the answers per executable.
pub trait ComputerLifecycle {
    /// `__lifecycle protocol`: the executable's version, answered without contacting a supervisor.
    fn protocol(&self, executable: &Path) -> Result<LifecycleProtocol, LifecycleFailure>;

    /// `__lifecycle status`: the running supervisor's answer, or its persisted state.
    fn status(&self, executable: &Path) -> Result<LifecycleStatus, LifecycleFailure>;

    /// `__lifecycle service-definition`: the service definition the executable registers with the
    /// service manager. Ask only an executable whose `protocol` lists the command: use
    /// [`reported_service_definition`].
    fn service_definition(
        &self,
        executable: &Path,
    ) -> Result<LifecycleServiceDefinition, LifecycleFailure>;
}

/// The service definition the Computer at `executable` reports, or `None` when it predates
/// `__lifecycle service-definition` (its `protocol` lists no such command).
pub fn reported_service_definition(
    lifecycle: &dyn ComputerLifecycle,
    executable: &Path,
) -> Result<Option<LifecycleServiceDefinition>, LifecycleFailure> {
    service_definition_if_listed(lifecycle, executable, &lifecycle.protocol(executable)?)
}

/// [`reported_service_definition`] for a caller that has already read the `protocol` of
/// `executable`: the definition when `protocol` lists the command, `None` when it does not.
pub fn service_definition_if_listed(
    lifecycle: &dyn ComputerLifecycle,
    executable: &Path,
    protocol: &LifecycleProtocol,
) -> Result<Option<LifecycleServiceDefinition>, LifecycleFailure> {
    if supports_service_definition(protocol) {
        lifecycle.service_definition(executable).map(Some)
    } else {
        Ok(None)
    }
}

/// Whether a Computer answers `__lifecycle service-definition`: its `protocol` lists the command.
/// A Computer that predates it reports no `commands`.
fn supports_service_definition(protocol: &LifecycleProtocol) -> bool {
    protocol.commands.as_deref().is_some_and(|commands| {
        commands
            .iter()
            .any(|name| name == SERVICE_DEFINITION_COMMAND)
    })
}

pub struct Lifecycle<'a> {
    runner: &'a dyn CommandRunner,
}

impl<'a> Lifecycle<'a> {
    pub fn new(runner: &'a dyn CommandRunner) -> Self {
        Self { runner }
    }

    fn call<T: DeserializeOwned>(
        &self,
        executable: &Path,
        command: &str,
        bound: Duration,
    ) -> Result<T, LifecycleFailure> {
        let line = CommandLine::new(&executable.to_string_lossy(), ["__lifecycle", command]);
        let text = line.to_string();
        let output = self.runner.run(&line, bound).map_err(|error| {
            let detail = match error {
                RunError::NotFound => "it does not exist".to_owned(),
                RunError::TimedOut => format!("it did not finish within {}s", bound.as_secs()),
                RunError::Failed(detail) => detail,
            };
            LifecycleFailure::NotRun {
                command: text.clone(),
                detail,
            }
        })?;
        let printed = output.stdout.trim();
        if output.code != 0 {
            let message = serde_json::from_str::<LifecycleError>(printed)
                .map(|error| error.message)
                .unwrap_or_else(|_| {
                    let stderr = output.stderr.trim();
                    if stderr.is_empty() { printed } else { stderr }.to_owned()
                });
            return Err(LifecycleFailure::Failed {
                command: text,
                code: output.code,
                message,
            });
        }
        let unreadable = |detail: String| LifecycleFailure::Unreadable {
            command: text.clone(),
            detail,
        };
        // The protocol number first: a later protocol may change everything else.
        let value: serde_json::Value =
            serde_json::from_str(printed).map_err(|error| unreadable(error.to_string()))?;
        let found = value
            .get("lifecycle_protocol")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| unreadable("it has no lifecycle_protocol".to_owned()))?;
        if found != u64::from(LIFECYCLE_PROTOCOL) {
            return Err(LifecycleFailure::Protocol {
                command: text,
                found: u32::try_from(found).unwrap_or(u32::MAX),
            });
        }
        let value: T =
            serde_json::from_value(value).map_err(|error| unreadable(error.to_string()))?;
        Ok(value)
    }
}

impl ComputerLifecycle for Lifecycle<'_> {
    fn protocol(&self, executable: &Path) -> Result<LifecycleProtocol, LifecycleFailure> {
        self.call(executable, "protocol", PROTOCOL_BOUND)
    }

    fn status(&self, executable: &Path) -> Result<LifecycleStatus, LifecycleFailure> {
        self.call(executable, "status", STATUS_BOUND)
    }

    fn service_definition(
        &self,
        executable: &Path,
    ) -> Result<LifecycleServiceDefinition, LifecycleFailure> {
        self.call(
            executable,
            SERVICE_DEFINITION_COMMAND,
            SERVICE_DEFINITION_BOUND,
        )
    }
}

#[cfg(test)]
mod tests;
