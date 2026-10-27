//! `coforge-installer start`: registers the active version's service definition with the service
//! manager and starts the service, for a Computer whose service is not registered.
//!
//! Starting the active version switches nothing, so it needs neither a journal check nor a
//! probe: an unfinished upgrade (the journal) does not block it, which keeps it an escape hatch
//! when `coforge-computer recover` cannot yet run. The definition is the active version's own,
//! read from its stored executable (`__lifecycle service-definition`); a Computer that cannot
//! report one cannot be started this way. The Computer checks that the supervisor answers after
//! this returns.

use crate::active::read_active;
use crate::contract::{EXIT_FAILED, EXIT_HELD, EXIT_SUCCEEDED};
use crate::lifecycle::reported_service_definition;
use crate::lock::{LockError, MachineMutationLock};
use crate::service::ServiceState;
use crate::switch::Ports;

/// How a start ended, for the CLI to print and exit with.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The manager reports the service of `version` running.
    Started { version: String },
    /// Another install, upgrade, recovery, or repair holds the lock. Nothing changed.
    Held { message: String },
    /// This process runs inside the service's own unit. Nothing changed.
    Refused { message: String },
    /// The service could not be registered or started.
    Failed { message: String },
}

impl Outcome {
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Started { .. } => EXIT_SUCCEEDED,
            Self::Held { .. } => EXIT_HELD,
            Self::Refused { .. } | Self::Failed { .. } => EXIT_FAILED,
        }
    }
}

pub fn start(ports: &Ports<'_>, stage: &mut dyn FnMut(&str)) -> Outcome {
    match ports.service.caller_is_inside_unit() {
        Ok(false) => {}
        Ok(true) => {
            return Outcome::Refused {
                message: format!(
                    "this process runs inside {}, the service it would register and start. Run \
                     `coforge-computer start` from a normal terminal, not from inside the \
                     service. Nothing was changed.",
                    ports.service.display_name()
                ),
            };
        }
        Err(error) => return failed(error),
    }
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
    // A manager whose registration may end a running service keeps a running one as it is.
    let replaces_running = ports.service.install_may_end_running_service()
        && match ports.service.state() {
            Ok(state) => matches!(state, ServiceState::Running { .. }),
            Err(error) => return failed(error),
        };
    if replaces_running {
        stage("The Computer supervisor service is running; its registration is left as it is");
    } else {
        stage("Registering the Computer supervisor service definition");
        if let Err(error) = ports.service.install(&definition) {
            return failed(error);
        }
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
