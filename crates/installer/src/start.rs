//! `coforge-installer start`: registers the active version's service definition with the service
//! manager and starts the service, for a Computer whose service is not registered.
//!
//! Starting the active version switches nothing, so it needs neither a journal check nor a
//! probe: an unfinished upgrade (the journal) does not block this function. The command settles
//! the journal first (`auto_recover::settle_before_start`) and does not start the service when
//! that fails. The definition is the active version's own,
//! read from its stored executable (`__lifecycle service-definition`); a Computer that cannot
//! report one cannot be started this way. The Computer checks that the supervisor answers after
//! this returns. Whether a manager keeps a running service's registration as it is, is the
//! backend's decision (`Registered::LeftRunning`), not this command's.
//!
//! `start` stops nothing, so it has no caller to spare and needs no refusal from inside the
//! service's own unit: there it registers without restarting (launchd writes the file only,
//! systemd writes it and reloads without restarting, Windows leaves a running task) and finds
//! the service running.

use crate::active::read_active;
use crate::contract::{EXIT_FAILED, EXIT_HELD, EXIT_SUCCEEDED};
use crate::lifecycle::reported_service_definition;
use crate::lock::{LockError, MachineMutationLock};
use crate::switch::Ports;

/// How a start ended, for the CLI to print and exit with.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The manager reports the service of `version` running.
    Started { version: String },
    /// Another install, upgrade, recovery, or repair holds the lock. Nothing changed.
    Held { message: String },
    /// The service could not be registered or started.
    Failed { message: String },
}

impl Outcome {
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Started { .. } => EXIT_SUCCEEDED,
            Self::Held { .. } => EXIT_HELD,
            Self::Failed { .. } => EXIT_FAILED,
        }
    }
}

pub fn start(ports: &Ports<'_>, stage: &mut dyn FnMut(&str)) -> Outcome {
    let _lock = match MachineMutationLock::acquire(ports.install_root) {
        Ok(lock) => lock,
        Err(LockError::Busy) => {
            return Outcome::Held {
                message:
                    "another install, upgrade, recovery, or repair is running. Nothing was changed."
                        .to_owned(),
            };
        }
        Err(error) => return failed(error),
    };
    let version = match read_active(ports.install_root) {
        Ok(Some(active)) => active.current,
        Ok(None) => {
            return failed(
                "no CoForge Computer is installed, so there is no service to start. Install CoForge \
                 Computer first. Nothing was changed.",
            );
        }
        Err(error) => return failed(error),
    };
    let executable = ports.store.computer_path(&version);
    let definition = match reported_service_definition(ports.lifecycle, &executable) {
        Ok(Some(definition)) => definition,
        Ok(None) => {
            return failed(format!(
                "the installed CoForge Computer {version} cannot report its service definition, \
                 so its service cannot be registered. Run `coforge-computer upgrade`. Nothing \
                 was changed."
            ));
        }
        Err(error) => return failed(error),
    };
    match ports.service.install(&definition) {
        Ok(registered) => {
            if let Some(line) = registered.stage_line() {
                stage(line);
            }
        }
        Err(error) => return failed(error),
    }
    stage(&format!("Starting Computer supervisor {version}"));
    if let Err(error) = ports.service.start() {
        return failed(error);
    }
    stage(&format!("Computer supervisor {version} started"));
    Outcome::Started { version }
}

fn failed(message: impl ToString) -> Outcome {
    Outcome::Failed {
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests;
