//! Repair's registration of the service definition: the active version's executable says what the
//! service manager should hold, and the manager's backend writes it only when it differs. Repair
//! reconciles it whether or not the activation needed repair, because a definition can vanish
//! from a healthy installation (a launchd plist deleted while its job stays loaded). Nothing is
//! stopped or started.

use crate::lifecycle::reported_service_definition;
use crate::service::Registered;
use crate::switch::Ports;

/// Registers the service definition the active `version` reports. `None` is a Computer that
/// predates `__lifecycle service-definition` and reports none, which is left alone. Repair never
/// stops the service: a manager that would have to replace the registration of a running service
/// answers [`Registered::LeftRunning`], and only a missing or stopped registration is written.
pub(super) fn register(ports: &Ports<'_>, version: &str) -> Result<Option<Registered>, String> {
    let Some(definition) =
        reported_service_definition(ports.lifecycle, &ports.store.computer_path(version))
            .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    ports
        .service
        .install(&definition)
        .map(Some)
        .map_err(|error| error.to_string())
}
