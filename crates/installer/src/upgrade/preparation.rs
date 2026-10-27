//! Everything an upgrade checks and installs before its first change: the active version is
//! intact and healthy, its supervisor is service-managed and its service definition readable, and
//! the candidate verifies. A failure here is a [`Refusal`]: nothing was changed.

use super::{
    INTEGRITY_CODE, Installed, Prepared, Refusal, Run, downgrade_refusal, refuse, unhealthy_message,
};
use crate::active::read_active;
use crate::contract::{ActiveState, RuntimeState};
use crate::lifecycle::supports_service_definition;
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
        if let Some(installed) = from
            .as_ref()
            .filter(|installed| installed.supervisor_running)
        {
            self.require_managed_supervisor()?;
            self.require_readable_service_definition(&installed.version)?;
        }
        Ok(Prepared { from, to })
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

    /// The rollback registers the active version's service definition again, so a Computer that
    /// reports one must be able to say it now, before anything stops. A Computer that predates
    /// the command has none to read.
    fn require_readable_service_definition(&self, version: &str) -> Result<(), Refusal> {
        let executable = self.ports.store.computer_path(version);
        let protocol = self
            .ports
            .lifecycle
            .protocol(&executable)
            .map_err(|error| refuse(error.to_string()))?;
        if supports_service_definition(&protocol) {
            self.ports
                .lifecycle
                .service_definition(&executable)
                .map_err(|error| refuse(error.to_string()))?;
        }
        Ok(())
    }
}
