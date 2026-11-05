//! The detached backend (Linux without systemd): the Computer's own process, started by the
//! installer and left running, with no manager behind it. It does not start at boot and is not
//! restarted when it crashes; `status` says so. A machine where systemd exists is never given this
//! backend (see `for_platform`), so a missing user session bus stays an error there.
//!
//! The Computer authors the definition (`__lifecycle service-definition`, manager `detached`): a
//! JSON [`Spec`] of what to run. The installer keeps it in `<state>/detached-service.json`, the
//! running process as `<state>/detached.pid` (`<pid> <started_at>`, the identity
//! [`crate::processes`] uses, so a reused pid is never taken for the service), and its output in
//! `<state>/detached.log`, rotated when it passes [`LOG_LIMIT`] at a start, like the Computer's own
//! log (10 MiB). The spec holds paths and switches only, never a credential.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::definition::{is_in_place, require_manager, write_private};
use super::{Registered, ServiceError, ServiceState, StartOutcome, StopOutcome, SupervisorService};
use crate::clock::{Clock, poll_until};
use crate::contract::LifecycleServiceDefinition;
use crate::processes::{Escalation, Inspection, ProcessIdentity, ProcessTable, terminate};

const MANAGER: &str = "detached";
const SPEC_FILE: &str = "detached-service.json";
const PID_FILE: &str = "detached.pid";
const LOG_FILE: &str = "detached.log";
/// The Computer's own log rotates at this size (`computer-logger.ts`).
pub(crate) const LOG_LIMIT: u64 = 10 * 1024 * 1024;
const START_WAIT: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(50);
/// Names that carry a credential; none may be in the spec's environment.
const CREDENTIAL_WORDS: [&str; 6] = ["key", "token", "secret", "password", "credential", "auth"];

/// What to run, as the Computer writes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spec {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

/// Starts the process: the port the tests replace.
pub trait Spawn {
    /// Runs `spec` detached with its output appended to `log`, and returns its pid.
    fn spawn(&self, spec: &Spec, log: &Path) -> io::Result<u32>;
}

/// The real thing: a child in its own process group, so a hang-up on the installer's terminal
/// does not reach it.
pub struct SystemSpawn;

impl Spawn for SystemSpawn {
    #[cfg(not(unix))]
    fn spawn(&self, _spec: &Spec, _log: &Path) -> io::Result<u32> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }

    #[cfg(unix)]
    fn spawn(&self, spec: &Spec, log: &Path) -> io::Result<u32> {
        use std::os::unix::process::CommandExt;
        let out = fs::OpenOptions::new().create(true).append(true).open(log)?;
        let err = out.try_clone()?;
        let child = Command::new(&spec.program)
            .args(&spec.args)
            .envs(&spec.env)
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .process_group(0)
            .spawn()?;
        Ok(child.id())
    }
}

pub struct Detached<'a> {
    state_directory: PathBuf,
    table: &'a dyn ProcessTable,
    clock: &'a dyn Clock,
    spawner: &'a dyn Spawn,
}

impl<'a> Detached<'a> {
    pub fn new(
        state_directory: &Path,
        table: &'a dyn ProcessTable,
        clock: &'a dyn Clock,
        spawner: &'a dyn Spawn,
    ) -> Self {
        Self {
            state_directory: state_directory.to_owned(),
            table,
            clock,
            spawner,
        }
    }

    fn spec_path(&self) -> PathBuf {
        self.state_directory.join(SPEC_FILE)
    }

    fn pid_path(&self) -> PathBuf {
        self.state_directory.join(PID_FILE)
    }

    fn log_path(&self) -> PathBuf {
        self.state_directory.join(LOG_FILE)
    }

    fn read_spec(&self) -> Result<Option<Spec>, ServiceError> {
        let path = self.spec_path();
        match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).map(Some).map_err(|error| {
                ServiceError::FileUnreadable {
                    path: path.display().to_string(),
                    detail: error.to_string(),
                }
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(ServiceError::FileUnreadable {
                path: path.display().to_string(),
                detail: error.to_string(),
            }),
        }
    }

    /// The identity the pid file names, when the process is still that one.
    fn running(&self) -> Result<Option<ProcessIdentity>, ServiceError> {
        let Ok(text) = fs::read_to_string(self.pid_path()) else {
            return Ok(None);
        };
        let mut parts = text.split_whitespace();
        let (Some(pid), Some(started)) = (
            parts.next().and_then(|p| p.parse::<u32>().ok()),
            parts.next().and_then(|s| s.parse::<u64>().ok()),
        ) else {
            return Ok(None);
        };
        let inspected = self
            .table
            .inspect(pid)
            .map_err(|error| ServiceError::FileUnreadable {
                path: self.pid_path().display().to_string(),
                detail: error.to_string(),
            })?;
        Ok(match inspected {
            Inspection::Alive(identity) if identity.started_at == started => Some(identity),
            _ => None,
        })
    }

    fn rotate_log(&self) {
        let log = self.log_path();
        if fs::metadata(&log).is_ok_and(|meta| meta.len() > LOG_LIMIT) {
            let _ = fs::rename(&log, self.state_directory.join(format!("{LOG_FILE}.1")));
        }
    }
}

/// The first environment name in `spec` that looks like a credential.
fn credential_name(spec: &Spec) -> Option<&str> {
    spec.env.keys().map(String::as_str).find(|name| {
        let lower = name.to_ascii_lowercase();
        CREDENTIAL_WORDS.iter().any(|word| lower.contains(word))
    })
}

impl SupervisorService for Detached<'_> {
    fn display_name(&self) -> String {
        "the detached Computer process".to_owned()
    }

    fn caller_is_inside_unit(&self) -> Result<bool, ServiceError> {
        let Some(service) = self.running()? else {
            return Ok(false);
        };
        let mut pid = std::process::id();
        for _ in 0..64 {
            if pid == service.pid {
                return Ok(true);
            }
            match self.table.parent_of(pid) {
                Ok(Some(parent)) if parent != pid && parent > 1 => pid = parent,
                _ => return Ok(false),
            }
        }
        Ok(false)
    }

    fn state(&self) -> Result<ServiceState, ServiceError> {
        if self.read_spec()?.is_none() {
            return Ok(ServiceState::NotInstalled);
        }
        Ok(match self.running()? {
            Some(identity) => ServiceState::Running {
                pid: Some(identity.pid),
            },
            None => ServiceState::Stopped,
        })
    }

    fn stop(&self) -> Result<StopOutcome, ServiceError> {
        let before = self.state()?;
        if let Some(identity) = self.running()? {
            terminate(self.table, self.clock, Escalation::default(), &[identity]).map_err(
                |error| ServiceError::StopTimedOut {
                    service: self.display_name(),
                    waited: Escalation::default().exit_wait + Escalation::default().kill_wait,
                    observed: error.to_string(),
                    hint: format!("Check the log at {}.", self.log_path().display()),
                },
            )?;
        }
        let _ = fs::remove_file(self.pid_path());
        Ok(StopOutcome { before })
    }

    fn install(&self, definition: &LifecycleServiceDefinition) -> Result<Registered, ServiceError> {
        require_manager(MANAGER, definition)?;
        let spec: Spec = serde_json::from_str(&definition.contents).map_err(|error| {
            ServiceError::DefinitionNotWritten {
                path: self.spec_path().display().to_string(),
                detail: format!("the definition is not a valid detached spec: {error}"),
            }
        })?;
        if let Some(name) = credential_name(&spec) {
            return Err(ServiceError::DefinitionNotWritten {
                path: self.spec_path().display().to_string(),
                detail: format!("the spec's environment may not carry a credential (`{name}`)"),
            });
        }
        let path = self.spec_path();
        if is_in_place(&path, &definition.contents) {
            return Ok(Registered::AlreadyInPlace);
        }
        write_private(&path, &definition.contents)?;
        Ok(Registered::Written)
    }

    fn start(&self) -> Result<StartOutcome, ServiceError> {
        let Some(spec) = self.read_spec()? else {
            return Err(ServiceError::NotInstalled {
                service: self.display_name(),
            });
        };
        if let Some(identity) = self.running()? {
            return Ok(StartOutcome {
                pid: Some(identity.pid),
            });
        }
        self.rotate_log();
        let log = self.log_path();
        let pid = self
            .spawner
            .spawn(&spec, &log)
            .map_err(|error| ServiceError::CommandNotRun {
                command: spec.program.clone(),
                detail: error.to_string(),
            })?;
        let mut observed = format!("pid {pid} not seen alive");
        let found = poll_until(self.clock, START_WAIT, POLL, || {
            match self.table.inspect(pid) {
                Ok(Inspection::Alive(identity)) => Ok(Some(identity)),
                Ok(other) => {
                    observed = format!("{other:?}");
                    Ok(None)
                }
                Err(error) => Err(ServiceError::FileUnreadable {
                    path: self.pid_path().display().to_string(),
                    detail: error.to_string(),
                }),
            }
        })?;
        let Some(identity) = found else {
            return Err(ServiceError::StartTimedOut {
                service: self.display_name(),
                waited: START_WAIT,
                observed,
                hint: format!("Check the log at {}.", log.display()),
            });
        };
        write_private(
            &self.pid_path(),
            &format!("{} {}", identity.pid, identity.started_at),
        )?;
        Ok(StartOutcome {
            pid: Some(identity.pid),
        })
    }
}

#[cfg(test)]
mod tests;
