//! Repairs a broken Computer installation while preserving the selected user installation.
//!
//! A healthy immutable version only needs its activation recreated: the links, and on POSIX the
//! `current/` copy that runs. A damaged version is quarantined and fetched again through the
//! normal manifest/checksum pipeline. Once the activation is repaired, the active version's
//! service definition is registered with the service manager (`repair/service_definition.rs`).
//! Repair never stops or starts the Computer supervisor, matching the reference installer's
//! forced-stop-free repair transaction.

use std::cmp::Ordering;
use std::fs;

use crate::active::{self, Activation, ActiveError, read_active};
use crate::contract::{
    ACTIVE_STATE_SCHEMA_VERSION, ActiveState, ERROR_CODE_DOWNGRADE_REFUSED, EXIT_FAILED, EXIT_HELD,
    EXIT_UNRESOLVED, ReceiptOutcome, UpgradeReceipt,
};
use crate::journal::Journal;
use crate::lock::{BUSY_ERROR_CODE, LockError, MachineMutationLock};
use crate::prepare::prepare_version;
use crate::private_fs;
use crate::receipts::{Begin, ReceiptStore};
use crate::service::ServiceState;
use crate::switch::Ports;
use crate::upgrade::Outcome;
use crate::version::precedence;

/// Repairs the active installation, optionally selecting a version or the feed's latest pointer.
pub fn repair(
    ports: &Ports<'_>,
    request_id: &str,
    selection: Option<&str>,
    _allow_downgrade: bool,
    stage: &mut dyn FnMut(&str),
) -> Outcome {
    let lock =
        match MachineMutationLock::acquire(ports.install_root) {
            Ok(lock) => lock,
            Err(LockError::Busy) => return Outcome::NoReceipt {
                exit: EXIT_HELD,
                message:
                    "another install, upgrade, recovery, or repair is running. Nothing was changed."
                        .to_owned(),
            },
            Err(error) => {
                return Outcome::NoReceipt {
                    exit: EXIT_FAILED,
                    message: format!("{error}. Nothing was changed."),
                };
            }
        };

    let journal = Journal::new(ports.install_root);
    match journal.read() {
        Ok(None) => {}
        Ok(Some(_)) => return Outcome::NoReceipt {
            exit: EXIT_UNRESOLVED,
            message: "an earlier upgrade did not finish. Run `coforge-computer recover` first. Nothing was changed.".to_owned(),
        },
        Err(error) => return Outcome::NoReceipt {
            exit: EXIT_UNRESOLVED,
            message: format!("the recovery journal {} cannot be read: {error}. Nothing was changed; run `coforge-computer recover` once it is readable.", journal.path().display()),
        },
    }

    let receipts = ReceiptStore::new(ports.install_root);
    match receipts.begin_operation(&lock, request_id, "repair", selection.unwrap_or("active")) {
        Ok(Begin::Fresh) => {}
        Ok(Begin::Replay(receipt)) => return Outcome::Receipt(receipt),
        Ok(Begin::Conflict(message)) => {
            return Outcome::NoReceipt {
                exit: EXIT_HELD,
                message: format!("{message}. Nothing was changed."),
            };
        }
        Err(error) => {
            return Outcome::NoReceipt {
                exit: EXIT_FAILED,
                message: format!(
                    "the repair request could not be recorded: {error}. Nothing was changed."
                ),
            };
        }
    }

    let mut quarantined_active_metadata: Option<(std::path::PathBuf, std::path::PathBuf)> = None;
    let active = match read_active(ports.install_root) {
        Ok(active) => active,
        Err(crate::active::ActiveError::Invalid) => match quarantine_active_metadata(ports) {
            Ok(path) => {
                quarantined_active_metadata = path;
                None
            }
            Err(error) => return failed(&receipts, &lock, request_id, error, None),
        },
        Err(error) => return failed(&receipts, &lock, request_id, error.to_string(), None),
    };
    let requested = if let Some(selection) = selection {
        selection.to_owned()
    } else if quarantined_active_metadata.is_some() {
        "latest".to_owned()
    } else if let Some(active) = &active {
        active.current.clone()
    } else {
        return held(
            &receipts,
            &lock,
            request_id,
            "This installation does not need repair. Use install or upgrade.",
        );
    };
    let target = match ports.release.resolve_version(&requested) {
        Ok(target) => target,
        Err(error) => {
            restore_quarantine(quarantined_active_metadata.take());
            return failed(&receipts, &lock, request_id, error.to_string(), None);
        }
    };
    if let Some(active) = &active
        && target != active.current
        && !_allow_downgrade
        && !matches!(
            precedence(&target, &active.current),
            Some(Ordering::Greater)
        )
    {
        restore_quarantine(quarantined_active_metadata.take());
        return failed(
            &receipts,
            &lock,
            request_id,
            format!(
                "CoForge Computer {target} is older than the installed {}. Nothing was changed. \
                 To repair it, pass `--allow-downgrade`.",
                active.current
            ),
            Some(ERROR_CODE_DOWNGRADE_REFUSED),
        );
    }
    let activation;
    let active_is_target = active.as_ref().is_some_and(|state| state.current == target);
    if active_is_target && ports.store.verify_installed(&target).is_ok() {
        let state = active.as_ref().expect("active_is_target implies active");
        if active::is_activated(ports.store, ports.binary_directory, &target) {
            return held(
                &receipts,
                &lock,
                request_id,
                "This installation does not need repair. Use install or upgrade.",
            );
        }
        stage(&format!("Verifying active CoForge Computer {target}"));
        activation = match activate(ports, state) {
            Ok(activation) => activation,
            Err(error) => return failed(&receipts, &lock, request_id, error.to_string(), None),
        };
    } else {
        let target_is_damaged = ports.store.version_directory(&target).exists()
            && ports.store.verify_installed(&target).is_err();
        let quarantined_version = if target_is_damaged {
            match quarantine_version(ports, &target) {
                Ok(path) => path,
                Err(error) => {
                    restore_quarantine(quarantined_active_metadata.take());
                    return failed(&receipts, &lock, request_id, error, None);
                }
            }
        } else {
            None
        };
        stage(&format!("Downloading CoForge Computer {target}"));
        let prepared = match prepare_version(&lock, ports.release, ports.store, &target, None) {
            Ok(prepared) => prepared,
            Err(error) => {
                restore_quarantine(quarantined_version);
                restore_quarantine(quarantined_active_metadata.take());
                return failed(&receipts, &lock, request_id, error.to_string(), None);
            }
        };
        let state = ActiveState {
            schema_version: ACTIVE_STATE_SCHEMA_VERSION,
            current: prepared.version.clone(),
            previous: active.as_ref().and_then(|old| old.previous.clone()),
        };
        activation = match activate(ports, &state) {
            Ok(activation) => activation,
            Err(error) => {
                restore_quarantine(quarantined_version);
                restore_active(ports, active.as_ref());
                restore_quarantine(quarantined_active_metadata.take());
                return failed(&receipts, &lock, request_id, error.to_string(), None);
            }
        };
        drop(quarantined_active_metadata.take());
    }
    // The activation is repaired for good: a service definition that cannot be registered fails
    // the receipt but undoes nothing.
    let definition = service_definition::register(ports, &target, stage);
    if activation == Activation::ExecutableSpared {
        return executable_spared(
            ports,
            &receipts,
            &lock,
            request_id,
            &target,
            definition.err(),
        );
    }
    if let Err(error) = definition {
        return failed(
            &receipts,
            &lock,
            request_id,
            format!(
                "CoForge Computer {target} was repaired, but its service definition could not be \
                 registered: {error}"
            ),
            None,
        );
    }
    stage(&format!("Repaired active CoForge Computer {target}"));
    match record(
        &receipts,
        &lock,
        request_id,
        ReceiptOutcome::Succeeded { version: target },
    ) {
        Ok(receipt) => Outcome::Receipt(Box::new(receipt)),
        Err(error) => Outcome::NoReceipt {
            exit: EXIT_UNRESOLVED,
            message: format!(
                "the active Computer was repaired, but its receipt could not be written: {error}"
            ),
        },
    }
}

fn quarantine_version(
    ports: &Ports<'_>,
    version: &str,
) -> Result<Option<(std::path::PathBuf, std::path::PathBuf)>, String> {
    let source = ports.store.version_directory(version);
    if !source.exists() {
        return Ok(None);
    }
    let directory = ports.install_root.join("quarantine");
    private_fs::create_private_directories(&directory).map_err(|error| error.to_string())?;
    let mut destination = directory.join(format!("{version}-{}", std::process::id()));
    let mut suffix = 0u32;
    while destination.exists() {
        suffix += 1;
        destination = directory.join(format!("{version}-{}-{suffix}", std::process::id()));
    }
    std::fs::rename(&source, &destination).map_err(|error| {
        format!("the damaged Computer version {version} could not be quarantined: {error}")
    })?;
    Ok(Some((destination, source)))
}

fn quarantine_active_metadata(
    ports: &Ports<'_>,
) -> Result<Option<(std::path::PathBuf, std::path::PathBuf)>, String> {
    let source = ports.install_root.join(active::ACTIVE_FILE);
    if !source.exists() {
        return Ok(None);
    }
    let directory = ports.install_root.join("quarantine");
    private_fs::create_private_directories(&directory).map_err(|error| error.to_string())?;
    let mut destination = directory.join(format!("active.json-{}", std::process::id()));
    let mut suffix = 0u32;
    while destination.exists() {
        suffix += 1;
        destination = directory.join(format!("active.json-{}-{suffix}", std::process::id()));
    }
    fs::rename(&source, &destination)
        .map_err(|error| format!("the damaged active state could not be quarantined: {error}"))?;
    Ok(Some((destination, source)))
}

fn restore_quarantine(paths: Option<(std::path::PathBuf, std::path::PathBuf)>) {
    if let Some((quarantined, original)) = paths {
        let _ = fs::rename(quarantined, original);
    }
}

fn restore_active(ports: &Ports<'_>, state: Option<&ActiveState>) {
    if let Some(state) = state {
        let _ = activate(ports, state);
    }
}

/// Activates `state`. Repair does not stop the service, so a running supervisor's differing
/// executable is spared (see [`active::activate`]): replacing it under the process is not
/// something repair can undo, and the next upgrade could no longer be sure to find that process.
/// The service state is read right before the activation, not earlier: a re-download takes
/// minutes, and the service may have started meanwhile. A state that cannot be read may be
/// running.
fn activate(ports: &Ports<'_>, state: &ActiveState) -> Result<Activation, ActiveError> {
    let spare_executable = !matches!(
        ports.service.state(),
        Ok(ServiceState::NotInstalled | ServiceState::Stopped)
    );
    active::activate(ports.store, ports.binary_directory, state, spare_executable)
}

/// The failed receipt of a repair that fixed everything but the executable of a running service.
/// It carries `UPDATE_BUSY`, the SDK's "not now" code (an installer-only code is not allowed).
fn executable_spared(
    ports: &Ports<'_>,
    receipts: &ReceiptStore,
    lock: &MachineMutationLock,
    request_id: &str,
    version: &str,
    definition_error: Option<String>,
) -> Outcome {
    let service = ports.service.display_name();
    let definition = definition_error.map_or_else(String::new, |error| {
        format!(" Its service definition could not be registered either: {error}")
    });
    failed(
        receipts,
        lock,
        request_id,
        format!(
            "{service} is running CoForge Computer {version} from a file that differs from the \
             installed version, so repair left that file as it is and repaired everything else. \
             Stop {service}, then run the repair again.{definition}"
        ),
        Some(BUSY_ERROR_CODE),
    )
}

fn held(
    receipts: &ReceiptStore,
    lock: &MachineMutationLock,
    request_id: &str,
    error: &str,
) -> Outcome {
    match record(
        receipts,
        lock,
        request_id,
        ReceiptOutcome::Held {
            error: error.to_owned(),
            error_code: Some("REPAIR_NOT_NEEDED".to_owned()),
        },
    ) {
        Ok(receipt) => Outcome::Receipt(Box::new(receipt)),
        Err(detail) => Outcome::NoReceipt {
            exit: EXIT_HELD,
            message: format!("repair could not record its held result: {detail}"),
        },
    }
}

fn failed(
    receipts: &ReceiptStore,
    lock: &MachineMutationLock,
    request_id: &str,
    error: String,
    error_code: Option<&str>,
) -> Outcome {
    match record(
        receipts,
        lock,
        request_id,
        ReceiptOutcome::Failed {
            error,
            error_code: error_code.map(str::to_owned),
        },
    ) {
        Ok(receipt) => Outcome::Receipt(Box::new(receipt)),
        Err(detail) => Outcome::NoReceipt {
            exit: EXIT_FAILED,
            message: format!("repair failed and its receipt could not be written: {detail}"),
        },
    }
}

fn record(
    receipts: &ReceiptStore,
    lock: &MachineMutationLock,
    request_id: &str,
    outcome: ReceiptOutcome,
) -> Result<UpgradeReceipt, String> {
    let receipt = UpgradeReceipt::new_for_operation(request_id, "repair", outcome, Vec::new())
        .map_err(|error| error.to_string())?;
    receipts
        .commit(lock, &receipt)
        .map_err(|error| error.to_string())?;
    Ok(receipt)
}

mod service_definition;

#[cfg(test)]
mod tests;
