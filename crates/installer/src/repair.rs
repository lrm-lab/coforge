//! Repairs the active Computer selection without downloading or replacing an immutable version.
//!
//! `repair` verifies the version named by `active.json`, then recreates the active link and PATH
//! shim from that verified state. It never edits a version directory and never starts or stops the
//! supervisor. A missing or corrupt active version is reported as a failed receipt so the caller
//! can choose a full install or upgrade explicitly.

use crate::active::{self, read_active};
use crate::contract::{EXIT_FAILED, EXIT_HELD, EXIT_UNRESOLVED, ReceiptOutcome, UpgradeReceipt};
use crate::journal::Journal;
use crate::lock::{LockError, MachineMutationLock};
use crate::receipts::{Begin, ReceiptStore};
use crate::switch::Ports;
use crate::upgrade::Outcome;

/// Repairs the active metadata and links for the currently selected verified version.
pub fn repair(ports: &Ports<'_>, request_id: &str, stage: &mut dyn FnMut(&str)) -> Outcome {
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
    match receipts.begin_operation(&lock, request_id, "repair", "active") {
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

    let active = match read_active(ports.install_root) {
        Ok(Some(active)) => active,
        Ok(None) => {
            return failed(
                &receipts,
                &lock,
                request_id,
                "no active Computer version is selected".to_owned(),
                None,
            );
        }
        Err(error) => return failed(&receipts, &lock, request_id, error.to_string(), None),
    };
    let version = active.current.clone();
    if let Err(error) = ports.store.verify_installed(&version) {
        return failed(
            &receipts,
            &lock,
            request_id,
            format!("the active version {version} cannot be repaired: {error}"),
            Some("UPDATE_INTEGRITY_FAILED"),
        );
    }

    stage(&format!("Verifying active CoForge Computer {version}"));
    if let Err(error) = active::activate(
        ports.install_root,
        ports.binary_directory,
        ports.store.target(),
        &active,
    ) {
        return failed(
            &receipts,
            &lock,
            request_id,
            format!("the active Computer links could not be repaired: {error}"),
            None,
        );
    }
    stage(&format!("Repaired active CoForge Computer {version}"));
    match record(
        &receipts,
        &lock,
        request_id,
        ReceiptOutcome::Succeeded { version },
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

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::clock::VirtualClock;
    use crate::processes::fakes::FakeTable;
    use crate::service::ServiceState;
    use crate::upgrade::fakes::{FakeLifecycle, FakeService, Fixture, OLD, REQUEST};

    fn exit_code(outcome: &Outcome) -> u8 {
        match outcome {
            Outcome::Receipt(receipt) => receipt.exit_code(),
            Outcome::NoReceipt { exit, .. } => *exit,
        }
    }

    #[test]
    fn repairs_missing_active_links_from_the_verified_active_version() {
        let fixture = Fixture::new("repair-links");
        fixture.install_old();
        fs::remove_file(fixture.root().join("active")).unwrap();
        let clock = VirtualClock::new();
        let table = FakeTable::new(&clock);
        let service = FakeService::new(ServiceState::NotInstalled);
        let lifecycle = FakeLifecycle::default();
        let ports = fixture.ports(&lifecycle, &service, &table, &clock);

        let mut stages = Vec::new();
        let outcome = repair(&ports, REQUEST, &mut |line| stages.push(line.to_owned()));

        assert_eq!(exit_code(&outcome), 0);
        match &outcome {
            Outcome::Receipt(receipt) => assert_eq!(receipt.operation(), "repair"),
            Outcome::NoReceipt { .. } => panic!("repair did not write a receipt"),
        }
        assert_eq!(service.calls(), Vec::<&'static str>::new());
        assert_eq!(
            fs::read_link(fixture.root().join("active")).unwrap(),
            std::path::Path::new("versions/0.1.0")
        );
        assert_eq!(
            stages,
            [
                "Verifying active CoForge Computer 0.1.0",
                "Repaired active CoForge Computer 0.1.0"
            ]
        );
    }

    #[test]
    fn refuses_to_repair_a_corrupt_active_version_without_mutating_links() {
        let fixture = Fixture::new("repair-corrupt");
        fixture.install_old();
        fs::remove_file(
            fixture
                .root()
                .join("versions")
                .join(OLD)
                .join("coforge-computer"),
        )
        .unwrap();
        let clock = VirtualClock::new();
        let table = FakeTable::new(&clock);
        let service = FakeService::new(ServiceState::NotInstalled);
        let lifecycle = FakeLifecycle::default();
        let ports = fixture.ports(&lifecycle, &service, &table, &clock);

        let outcome = repair(&ports, REQUEST, &mut |_| {});

        assert_eq!(exit_code(&outcome), 1);
        assert!(fixture.root().join("active").exists());
        assert!(service.calls().is_empty());
    }
}
