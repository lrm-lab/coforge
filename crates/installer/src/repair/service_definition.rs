//! Repair's registration of the service definition: the active version's executable says what the
//! service manager should hold, and the manager's backend writes it only when it differs. Repair
//! reconciles it whether or not the activation needed repair, because a definition can vanish
//! from a healthy installation (a launchd plist deleted while its job stays loaded). Nothing is
//! stopped or started.

use crate::lifecycle::reported_service_definition;
use crate::service::{Installed, ServiceState};
use crate::switch::Ports;

/// What registering the active version's service definition did.
pub(super) enum Registration {
    /// The manager's registration was written: repair did something.
    Written,
    /// The manager already held exactly this definition.
    AlreadyInPlace,
    /// The Computer predates `__lifecycle service-definition` and reports none.
    NotReported,
    /// The manager is one whose registration may end a running service, and the service runs.
    LeftRunning,
}

impl Registration {
    /// The stage line that tells a person what repair did, if it did or skipped anything worth
    /// saying.
    pub(super) fn stage_line(&self) -> Option<&'static str> {
        match self {
            Self::Written => Some("Registered the Computer supervisor service definition"),
            Self::LeftRunning => Some(
                "The Computer supervisor service is running; its registration is left as it is",
            ),
            Self::AlreadyInPlace | Self::NotReported => None,
        }
    }
}

/// Registers the service definition the active `version` reports. A Computer that predates the
/// command reports none and is left alone. A manager whose registration may end a running
/// service (a Windows task) keeps a running service's registration as it is: repair never stops
/// the service, and only a missing or stopped registration is written.
pub(super) fn register(ports: &Ports<'_>, version: &str) -> Result<Registration, String> {
    if ports.service.install_may_end_running_service()
        && matches!(
            ports.service.state().map_err(|error| error.to_string())?,
            ServiceState::Running { .. }
        )
    {
        return Ok(Registration::LeftRunning);
    }
    let Some(definition) =
        reported_service_definition(ports.lifecycle, &ports.store.computer_path(version))
            .map_err(|error| error.to_string())?
    else {
        return Ok(Registration::NotReported);
    };
    ports
        .service
        .install(&definition)
        .map(|installed| match installed {
            Installed::Written => Registration::Written,
            Installed::AlreadyInPlace => Registration::AlreadyInPlace,
        })
        .map_err(|error| error.to_string())
}
