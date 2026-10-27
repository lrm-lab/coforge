//! Everything an upgrade checks and installs before its first change: the active version is
//! intact and healthy, and the candidate verifies. When the active supervisor runs, it is
//! service-managed and both versions' service definitions are read here, so the switch runs no
//! Computer executable inside the downtime. A failure here is a [`Refusal`]: nothing was changed.

use super::{
    INTEGRITY_CODE, Installed, Prepared, Refusal, Run, downgrade_refusal, refuse, unhealthy_message,
};
use crate::active::read_active;
use crate::contract::{ActiveState, LifecycleProtocol, LifecycleServiceDefinition, RuntimeState};
use crate::lifecycle::{reported_service_definition, service_definition_if_listed};
use crate::prepare::prepare_version;
use crate::service::{ServiceError, ServiceState};
use crate::switch::refusal_inside_service;

impl Run<'_, '_> {
    /// Everything before the first change: the active version is intact and healthy, its
    /// supervisor is service-managed, and the candidate verifies.
    pub(super) fn prepare(&mut self, selection: &str) -> Result<Prepared, Refusal> {
        if let Some(message) = refusal_inside_service(
            self.ports.service,
            "The upgrade",
            "coforge-computer upgrade",
        )
        .map_err(refuse)?
        {
            return Err(refuse(message));
        }
        let active = read_active(self.ports.install_root)?;
        if let Some(active) = &active {
            self.ports.store.verify_installed(&active.current)?;
        }
        self.switch
            .say(&format!("Preparing CoForge Computer {selection}"));
        // The target is resolved before anything is installed, so a refused downgrade leaves no
        // version directory behind.
        let target = self.ports.release.resolve_version(selection)?;
        if let Some(installed) = &active
            && let Some(refusal) =
                downgrade_refusal(&target, &installed.current, self.allow_downgrade)
        {
            return Err(refusal);
        }
        // The active version was verified above under this lock; a same-version upgrade must not
        // hash it again.
        let verified = active.as_ref().map(|active| active.current.as_str());
        let to = prepare_version(
            self.lock,
            self.ports.release,
            self.ports.store,
            &target,
            verified,
        )?
        .version;
        let probe = self
            .ports
            .lifecycle
            .protocol(&self.ports.store.computer_path(&to))
            .map_err(|error| Refusal {
                error: error.to_string(),
                code: Some(INTEGRITY_CODE),
            })?;
        if probe.version != to {
            return Err(Refusal {
                error: format!(
                    "the new Computer executable reports version {}, not {to}",
                    probe.version
                ),
                code: Some(INTEGRITY_CODE),
            });
        }
        let from = match active {
            None => None,
            Some(active) => Some(self.inspect(active)?),
        };
        let mut from_definition = None;
        let mut to_definition = None;
        if let Some(installed) = from
            .as_ref()
            .filter(|installed| installed.supervisor_running)
        {
            self.require_managed_supervisor()?;
            from_definition = self.read_service_definition(&installed.version)?;
            to_definition = self.read_candidate_service_definition(&to, &probe)?;
        }
        Ok(Prepared {
            from,
            to,
            from_definition,
            to_definition,
        })
    }

    /// The active version's status, which must be healthy before anything stops.
    fn inspect(&self, active: ActiveState) -> Result<Installed, Refusal> {
        let status = self
            .ports
            .lifecycle
            .status(&self.ports.store.computer_path(&active.current))
            .map_err(|error| refuse(error.to_string()))?;
        if !status.healthy {
            return Err(refuse(unhealthy_message(&status)));
        }
        Ok(Installed {
            version: active.current,
            previous: active.previous,
            supervisor_running: status.supervisor.running,
            supervisor_id: status.supervisor.id.clone(),
            runtimes: status
                .bindings
                .iter()
                .map(|binding| RuntimeState {
                    binding_id: binding.binding_id.clone(),
                    running: binding.running,
                })
                .collect(),
        })
    }

    /// A supervisor running outside the service manager (a foreground Computer) cannot be
    /// restarted by the installer, so the upgrade is refused before it stops anything.
    fn require_managed_supervisor(&self) -> Result<(), Refusal> {
        match self.ports.service.state() {
            Err(error) => Err(refuse(error.to_string())),
            Ok(ServiceState::NotInstalled) => {
                let error = ServiceError::NotInstalled {
                    service: self.ports.service.display_name(),
                };
                Err(refuse(format!(
                    "Cannot upgrade a foreground externally supervised Computer while it is \
                     running: {error} Stop it through its external supervisor before upgrading, \
                     or install the supported user service with `coforge-computer start`."
                )))
            }
            Ok(_) => Ok(()),
        }
    }

    /// The service definition of `version`, read from its stored executable before anything
    /// stops (see [`Prepared`]). `None` is a Computer that predates the command, which has none
    /// to read.
    fn read_service_definition(
        &self,
        version: &str,
    ) -> Result<Option<LifecycleServiceDefinition>, Refusal> {
        reported_service_definition(
            self.ports.lifecycle,
            &self.ports.store.computer_path(version),
        )
        .map_err(|error| refuse(error.to_string()))
    }

    /// [`Run::read_service_definition`] for the candidate, whose `protocol` the preparation has
    /// already read as `probe`: the candidate costs one more spawn, for the definition itself.
    fn read_candidate_service_definition(
        &self,
        to: &str,
        probe: &LifecycleProtocol,
    ) -> Result<Option<LifecycleServiceDefinition>, Refusal> {
        service_definition_if_listed(
            self.ports.lifecycle,
            &self.ports.store.computer_path(to),
            probe,
        )
        .map_err(|error| refuse(error.to_string()))
    }
}
