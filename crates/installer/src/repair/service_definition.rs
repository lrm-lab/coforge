//! Repair's registration of the service definition: after the activation is repaired, the active
//! version's executable says what the service manager should hold, and the manager's backend
//! writes it only when it differs. Nothing is stopped or started.

use crate::lifecycle::reported_service_definition;
use crate::service::ServiceState;
use crate::switch::Ports;

/// Registers the service definition the active `version` reports. A Computer that predates the
/// command reports none and is left alone. A manager whose registration may end a running
/// service (a Windows task) keeps a running service's registration as it is: repair never stops
/// the service, and only a missing or stopped registration is written.
pub(super) fn register(
    ports: &Ports<'_>,
    version: &str,
    stage: &mut dyn FnMut(&str),
) -> Result<(), String> {
    if ports.service.install_may_end_running_service()
        && matches!(
            ports.service.state().map_err(|error| error.to_string())?,
            ServiceState::Running { .. }
        )
    {
        stage("The Computer supervisor service is running; its registration is left as it is");
        return Ok(());
    }
    let Some(definition) =
        reported_service_definition(ports.lifecycle, &ports.store.computer_path(version))
            .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    stage("Registering the Computer supervisor service definition");
    ports
        .service
        .install(&definition)
        .map_err(|error| error.to_string())
}
