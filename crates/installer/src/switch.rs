//! The switch of the active version: stop the supervisor when it runs, make a target version
//! active, register the target's service definition, restart the supervisor, and probe that it
//! reports the target. The upgrade and recovery both switch through [`ActiveSwitch`], so they stop, activate,
//! register, restart, and probe the same way.
//!
//! The switch makes no decision about what to switch to: `upgrade.rs` decides what to install and
//! roll back to, and `recover.rs` decides what the journal asks for. Its one refusal is that a
//! process must not stop the service it runs inside. It runs no Computer executable to learn a
//! definition: the caller read it from the target before anything stopped. Each failure is returned to the caller as
//! text; the caller records it in a receipt or keeps the journal.

use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::active;
use crate::clock::{Clock, poll_until};
use crate::contract::{
    ACTIVE_STATE_SCHEMA_VERSION, ActiveState, DeadProcessIdentity, LifecycleServiceDefinition,
};
use crate::lifecycle::ComputerLifecycle;
use crate::prepare::ReleaseSource;
use crate::processes::{
    Escalation, ProcessTable, ProductExecutable, VerifiedCaller, collect, dead_process_identity,
    terminate,
};
use crate::service::{ServiceState, SupervisorService};
use crate::store::VersionStore;

/// How long a restarted supervisor has to report the version it was switched to.
const PROBE_BOUND: Duration = Duration::from_secs(60);
const PROBE_INTERVAL: Duration = Duration::from_millis(500);

/// Everything the transaction touches, each behind its port so tests can script it.
pub struct Ports<'a> {
    pub install_root: &'a Path,
    pub binary_directory: &'a Path,
    pub store: &'a VersionStore,
    /// The release the transaction installs from: the feed, or a local directory.
    pub release: &'a dyn ReleaseSource,
    pub lifecycle: &'a dyn ComputerLifecycle,
    pub service: &'a dyn SupervisorService,
    pub processes: &'a dyn ProcessTable,
    pub clock: &'a dyn Clock,
}

/// The version to make active, and the version `active.json` keeps as previous.
pub(crate) struct Target<'a> {
    pub(crate) version: &'a str,
    pub(crate) previous: Option<&'a str>,
    /// The service definition to register before the supervisor starts, read from the target
    /// before anything stopped. `None` is a Computer that predates `__lifecycle
    /// service-definition`, started from what it installed itself.
    pub(crate) definition: Option<&'a LifecycleServiceDefinition>,
}

/// What a switch stops before it changes the active version, and how it restarts.
pub(crate) struct Plan<'a> {
    pub(crate) supervisor_running: bool,
    /// The Workspace runtimes running now, for the stage line; `None` when nothing was read.
    pub(crate) running_runtimes: Option<usize>,
    /// The executables whose processes make up the supervisor being stopped.
    pub(crate) stop: &'a [PathBuf],
    /// The supervisor id the restarted one must not keep. `None` accepts any running supervisor
    /// of the target version.
    pub(crate) replaces: Option<&'a Option<String>>,
}

/// One switch of the active version, with the processes it has stopped so far. The upgrade and
/// recovery both switch through it, so they stop, activate, restart, and probe the same way.
pub(crate) struct ActiveSwitch<'r, 'p> {
    ports: &'r Ports<'p>,
    stage: &'r mut dyn FnMut(&str),
    caller: Option<VerifiedCaller>,
    dead: Vec<DeadProcessIdentity>,
}

impl<'r, 'p> ActiveSwitch<'r, 'p> {
    pub(crate) fn new(
        ports: &'r Ports<'p>,
        stage: &'r mut dyn FnMut(&str),
        caller: Option<VerifiedCaller>,
    ) -> Self {
        Self {
            ports,
            stage,
            caller,
            dead: Vec::new(),
        }
    }

    pub(crate) fn say(&mut self, line: &str) {
        (self.stage)(line);
    }

    /// The processes this switch has stopped and verified dead, for a receipt.
    pub(crate) fn dead(&self) -> Vec<DeadProcessIdentity> {
        self.dead.clone()
    }

    /// Stops the supervisor when it runs, makes `target` active, restarts the supervisor, and
    /// probes the result. Any error leaves the caller to roll back or to keep the journal.
    pub(crate) fn switch(&mut self, target: &Target<'_>, plan: &Plan<'_>) -> Result<(), String> {
        let version = target.version;
        if plan.supervisor_running {
            match plan.running_runtimes {
                Some(count) => self.say(&format!(
                    "Stopping Computer supervisor and {count} Workspace runtime{}",
                    plural(count)
                )),
                None => self.say("Stopping Computer supervisor"),
            }
            self.stop_supervisor(plan.stop)?;
        } else {
            self.say("Computer supervisor is not running; no processes to restart");
        }
        self.say(&format!("Switching the active executable to {version}"));
        self.activate(target)?;
        if plan.supervisor_running {
            self.install_service_definition(target)?;
            self.say(&format!("Starting Computer supervisor {version}"));
            self.ports
                .service
                .start()
                .map_err(|error| error.to_string())?;
            self.say(&format!(
                "Waiting for the Computer supervisor to report {version}"
            ));
            self.await_supervisor(version, plan.replaces)?;
            self.say(&format!("Computer supervisor {version} healthy"));
        } else {
            self.say(&format!(
                "Checking the activated executable reports {version}"
            ));
            self.check_executable(version)?;
            self.say(&format!("Activated executable {version} confirmed"));
        }
        Ok(())
    }

    /// Registers the target's service definition, so that the start that follows never depends on
    /// a definition an earlier registration left on disk (a plist can vanish while its job stays
    /// loaded). It was read before the switch stopped anything: asking the activated executable
    /// would be a cold start of a large executable inside the downtime.
    fn install_service_definition(&mut self, target: &Target<'_>) -> Result<(), String> {
        let Some(definition) = target.definition else {
            return Ok(());
        };
        self.say("Installing the Computer supervisor service definition");
        self.ports
            .service
            .install(definition)
            .map_err(|error| error.to_string())
    }

    /// Collects the processes of `executables` (the caller spared), stops the service, ends what
    /// is still alive, and records each one as dead. Collection comes first: a process that
    /// exists only while the manager runs must be found before the manager stops it.
    /// [`VersionStore::executables_to_stop`] names the executables.
    fn stop_supervisor(&mut self, executables: &[PathBuf]) -> Result<(), String> {
        let mut identities = Vec::new();
        for executable in executables {
            let product = ProductExecutable::resolve(executable)
                .map_err(|error| format!("{}: {error}", executable.display()))?;
            identities.extend(
                collect(self.ports.processes, &product, self.caller.as_ref())
                    .map_err(|error| error.to_string())?,
            );
        }
        self.ports
            .service
            .stop()
            .map_err(|error| error.to_string())?;
        terminate(
            self.ports.processes,
            self.ports.clock,
            Escalation::default(),
            &identities,
        )
        .map_err(|error| error.to_string())?;
        for identity in &identities {
            self.dead.push(
                dead_process_identity(self.ports.processes, identity)
                    .map_err(|error| error.to_string())?,
            );
        }
        Ok(())
    }

    fn activate(&self, target: &Target<'_>) -> Result<(), String> {
        let state = ActiveState {
            schema_version: ACTIVE_STATE_SCHEMA_VERSION,
            current: target.version.to_owned(),
            previous: target.previous.map(str::to_owned),
        };
        active::activate(self.ports.store, self.ports.binary_directory, &state, false)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// Polls the restarted supervisor's status until it runs `version` under an id other than
    /// `replaces`'s, bounded by [`PROBE_BOUND`]. A failed status call is a reason to keep
    /// waiting; its message is kept for the timeout.
    fn await_supervisor(
        &self,
        version: &str,
        replaces: Option<&Option<String>>,
    ) -> Result<(), String> {
        let executable = self.ports.store.computer_path(version);
        let mut last = String::from("no answer");
        let found = poll_until(
            self.ports.clock,
            PROBE_BOUND,
            PROBE_INTERVAL,
            || -> Result<Option<()>, Infallible> {
                match self.ports.lifecycle.status(&executable) {
                    Ok(status) => {
                        let supervisor = &status.supervisor;
                        let up = supervisor.running
                            && supervisor.version.as_deref() == Some(version)
                            && replaces.is_none_or(|old| supervisor.id != *old);
                        if up {
                            return Ok(Some(()));
                        }
                        last = format!(
                            "supervisor running: {}, reported version: {}",
                            supervisor.running,
                            supervisor.version.as_deref().unwrap_or("none")
                        );
                    }
                    Err(error) => last = error.to_string(),
                }
                Ok(None)
            },
        );
        let Ok(found) = found;
        match found {
            Some(()) => Ok(()),
            None => Err(format!(
                "the Computer supervisor did not report {version} within {}s; its last answer \
                 was {last}",
                PROBE_BOUND.as_secs()
            )),
        }
    }

    /// The probe when no supervisor was running: the executable that runs reports `version`.
    fn check_executable(&self, version: &str) -> Result<(), String> {
        let protocol = self
            .ports
            .lifecycle
            .protocol(&self.ports.store.running_computer_path(version))
            .map_err(|error| error.to_string())?;
        if protocol.version == version {
            Ok(())
        } else {
            Err(format!(
                "the activated executable reports {}, not {version}",
                protocol.version
            ))
        }
    }
}

/// Refuses a stop of the supervisor from inside its own service: when this process runs in the
/// service's unit and the service is running, stopping it would stop this process too. `action`
/// names the operation and `command` what a person runs instead; both appear in the refusal. `None`
/// means the stop is safe.
pub(crate) fn refusal_inside_service(
    service: &dyn SupervisorService,
    action: &str,
    command: &str,
) -> Result<Option<String>, String> {
    if !service
        .caller_is_inside_unit()
        .map_err(|error| error.to_string())?
    {
        return Ok(None);
    }
    match service.state().map_err(|error| error.to_string())? {
        ServiceState::Running { .. } => Ok(Some(format!(
            "{action} stops {}, the service this process runs inside, so it would stop itself. \
             Run `{command}` from a normal terminal, not from inside the service. Nothing was \
             changed.",
            service.display_name()
        ))),
        ServiceState::NotInstalled | ServiceState::Stopped => Ok(None),
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}
