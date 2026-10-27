//! OS service control of the Computer supervisor (the Coordinator): ask the platform's service
//! manager whether it is installed, stop it and know it has really gone, start it and know a
//! process is running. The installer never pauses or drains busy Agents first; it stops and
//! starts the service the way the manager does.
//!
//! One backend per manager, ported from the Computer's own hosts
//! (`packages/daemon/src/daemon-host/`): [`Launchd`] (macOS), [`SystemdUser`] (Linux), and
//! [`WindowsTask`] (Windows). Each runs its manager's tool through a [`CommandRunner`] and waits
//! through a [`Clock`], so the tests script both. The names come from the shared contract
//! (`contract/service-identities.json`). The Computer authors the service definition (a plist,
//! unit, or task XML; `__lifecycle service-definition`); the installer registers that text with
//! the manager before it starts the service ([`SupervisorService::install`]), so a definition
//! that vanished while the service stayed loaded cannot strand an upgrade.
//!
//! What "stopped" means is the manager's word, not the process's: the manager has dropped the
//! service (launchd), reports it inactive (systemd), or the task has no running instance
//! (Windows). Whether a process of the product still lives is [`crate::processes`].

use std::path::Path;
use std::time::Duration;

use crate::clock::Clock;
use crate::contract::{CoordinatorService, LifecycleServiceDefinition};
use crate::paths::Platform;

mod definition;
mod error;
mod launchd;
mod port;
mod systemd;
mod windows_task;

#[cfg(test)]
pub(crate) mod fakes;

pub use error::ServiceError;
pub use launchd::{Launchd, current_uid};
pub use port::{CommandLine, CommandOutput, CommandRunner, RunError, SystemRunner};
pub use systemd::{OwnCgroup, ProcessCgroup, SystemdUser};
pub use windows_task::WindowsTask;

/// What the service manager says about the supervisor service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceState {
    /// The manager has no service under the Computer's name.
    NotInstalled,
    /// Installed, and the manager is neither running it nor about to.
    Stopped,
    /// The manager has the service up or coming up. `pid` is the process it reports: `None` when
    /// it reports none (launchd between respawns of a job that keeps exiting, systemd waiting out
    /// a restart delay) and always on Windows, whose Task Scheduler exposes no process id.
    Running { pid: Option<u32> },
}

/// What [`SupervisorService::stop`] found and did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopOutcome {
    /// The state observed just before the stop. `Running` names the process the manager reported;
    /// `NotInstalled` and `Stopped` mean there was nothing to stop.
    pub before: ServiceState,
}

/// What [`SupervisorService::start`] did: the manager reports the service running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartOutcome {
    /// The process the manager reports, as in [`ServiceState::Running`].
    pub pid: Option<u32>,
}

/// The Computer supervisor service under one platform's manager.
pub trait SupervisorService {
    /// The name the manager knows the service by, as a refusal names it (the launchd label, the
    /// systemd unit, or the Windows task).
    fn display_name(&self) -> String;

    /// Whether the calling process runs inside this service's own unit, so that stopping the
    /// service would stop the caller too.
    fn caller_is_inside_unit(&self) -> Result<bool, ServiceError>;

    /// Reads the manager's state. Changes nothing.
    fn state(&self) -> Result<ServiceState, ServiceError>;

    /// Stops the service and waits, bounded, until the manager has really let go of it. A service
    /// that is not installed or not running is not an error: [`StopOutcome::before`] says so.
    fn stop(&self) -> Result<StopOutcome, ServiceError>;

    /// Registers `definition` with the manager without starting the service, replacing any
    /// earlier registration. The definition must be for this backend's manager. launchd and
    /// systemd leave a definition file that already holds exactly these bytes alone, so a
    /// registration that is current changes nothing; a Windows task has no file to compare and
    /// is always replaced.
    fn install(&self, definition: &LifecycleServiceDefinition) -> Result<(), ServiceError>;

    /// Whether [`SupervisorService::install`] may end a running service when it replaces its
    /// registration. launchd and systemd only write what they read at the next bootstrap or
    /// reload, so they answer no. Windows answers yes: `schtasks /Create /F` is documented only
    /// as suppressing the warning for an existing task, and nothing documents what it does to a
    /// running instance. A caller that must not disturb a running service registers only when
    /// this is false.
    fn install_may_end_running_service(&self) -> bool;

    /// Starts the service and waits, bounded, until the manager reports it running. Already
    /// running is not an error. A service that is not installed is [`ServiceError::NotInstalled`]:
    /// [`SupervisorService::install`] registers one first.
    fn start(&self) -> Result<StartOutcome, ServiceError>;
}

/// The names the Coordinator's service has under each manager
/// (`contract/service-identities.json`, pinned to it by a test).
pub fn coordinator_service() -> CoordinatorService {
    CoordinatorService {
        launchd_label: "cn.coforge.computer.daemon".to_owned(),
        launchd_domain: "gui/{uid}".to_owned(),
        systemd_user_unit: "coforge-daemon.service".to_owned(),
        windows_task: "CoForge Daemon".to_owned(),
    }
}

/// The backend for `platform`. `home` is the user's home directory (the launchd plist and the
/// systemd unit live under it) and `uid` the user's id ([`current_uid`]), which only macOS uses.
/// Windows finds its tools under `%SystemRoot%`, never through `PATH`.
pub fn for_platform<'a>(
    platform: Platform,
    home: &Path,
    uid: Option<u32>,
    runner: &'a dyn CommandRunner,
    clock: &'a dyn Clock,
) -> Result<Box<dyn SupervisorService + 'a>, ServiceError> {
    let names = coordinator_service();
    Ok(match platform {
        Platform::Darwin => {
            let uid = uid.ok_or_else(|| ServiceError::InvalidIdentity {
                what: "user id",
                value: "none".to_owned(),
            })?;
            Box::new(Launchd::new(runner, clock, &names, home, uid)?)
        }
        Platform::Linux => Box::new(SystemdUser::new(runner, clock, &names, &OwnCgroup, home)?),
        Platform::Windows => {
            let system_root =
                std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_owned());
            Box::new(WindowsTask::new(runner, clock, &names, &system_root)?)
        }
    })
}

/// A command that ran to completion, with the line that was run.
pub(crate) struct Attempt {
    pub(crate) command: CommandLine,
    pub(crate) output: CommandOutput,
}

impl Attempt {
    pub(crate) fn succeeded(&self) -> bool {
        self.output.code == 0
    }

    pub(crate) fn code(&self) -> i32 {
        self.output.code
    }

    /// The command as a person would type it.
    pub(crate) fn command_text(&self) -> String {
        self.command.to_string()
    }

    /// The manager's own words: its error stream, or its output when it wrote nothing there.
    pub(crate) fn diagnostic(&self) -> String {
        let text = if self.output.stderr.trim().is_empty() {
            &self.output.stdout
        } else {
            &self.output.stderr
        };
        error::diagnostic(text)
    }
}

/// Runs `command` through `runner`, turning a command that could not finish into the error a
/// person can act on.
pub(crate) fn execute(
    runner: &dyn CommandRunner,
    command: CommandLine,
    timeout: Duration,
) -> Result<Attempt, ServiceError> {
    match runner.run(&command, timeout) {
        Ok(output) => Ok(Attempt { command, output }),
        Err(RunError::NotFound) => Err(ServiceError::ToolMissing {
            program: command.program().to_owned(),
        }),
        Err(RunError::TimedOut) => Err(ServiceError::CommandTimedOut {
            command: command.to_string(),
            waited: timeout,
        }),
        Err(RunError::Failed(detail)) => Err(ServiceError::CommandNotRun {
            command: command.to_string(),
            detail,
        }),
    }
}

#[cfg(test)]
mod tests;
