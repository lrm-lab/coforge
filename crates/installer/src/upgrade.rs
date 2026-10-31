//! The upgrade transaction: `coforge-computer upgrade` from the machine lock to its receipt.
//!
//! The installer owns this transaction. Busy Agents are not held: the supervisor is stopped the way
//! its service manager stops it, so there is no launch hold to pause or resume. There is no
//! `rollback` operation: a rollback is only the second half of a failed upgrade.
//!
//! Nothing changes until the candidate is verified and the running supervisor is known to be
//! healthy and under a service manager. The journal is written before the first process stops, and
//! cleared only once the machine is on a known good version. A failed rollback keeps the journal,
//! which every operation settles first (`auto_recover.rs`, `recover.rs`). What is checked
//! and installed before the journal is written is `upgrade/preparation.rs`.

use std::cmp::Ordering;

use crate::active::ActiveError;
use crate::contract::{
    ERROR_CODE_DOWNGRADE_REFUSED, EXIT_FAILED, EXIT_HELD, EXIT_UNRESOLVED,
    LifecycleServiceDefinition, LifecycleStatus, ReceiptOutcome, RuntimeState, UpgradeReceipt,
};
use crate::journal::{Journal, Transaction};
use crate::lock::{LockError, MachineMutationLock};
use crate::processes::VerifiedCaller;
use crate::receipts::{Begin, ReceiptStore};
use crate::switch::{ActiveSwitch, Plan, Ports, Target};
use crate::update_error::UpdateError;
use crate::version::precedence;

/// The SDK's code for a candidate whose bytes do not describe the version it claims
/// (`upgrade-error-codes.json`).
const INTEGRITY_CODE: &str = "UPDATE_INTEGRITY_FAILED";

pub struct UpgradeRequest<'a> {
    pub request_id: &'a str,
    /// `latest` or a version, as the request named it (it is part of the request's identity).
    pub selection: &'a str,
    /// The `upgrade` command that launched this installer, which must not be stopped.
    pub caller: Option<VerifiedCaller>,
    /// `--allow-downgrade`: an older target than the installed version is allowed.
    pub allow_downgrade: bool,
}

/// How a request ended: a receipt, or a refusal that wrote none.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Receipt(Box<UpgradeReceipt>),
    NoReceipt { exit: u8, message: String },
}

use Outcome::NoReceipt;

/// Runs one upgrade request. Once the request is recorded, every outcome is a receipt written
/// under the lock; `stage` receives the human stage lines in order.
pub fn upgrade(
    ports: &Ports<'_>,
    request: &UpgradeRequest<'_>,
    stage: &mut dyn FnMut(&str),
) -> Outcome {
    let lock = match MachineMutationLock::acquire(ports.install_root) {
        Ok(lock) => lock,
        Err(error) => return lock_refusal(&error),
    };
    let journal = Journal::new(ports.install_root);
    match journal.read() {
        Ok(None) => {}
        Ok(Some(_)) => {
            return NoReceipt {
                exit: EXIT_UNRESOLVED,
                message: "an earlier upgrade did not finish. Run the same command again. \
                          Nothing was changed."
                    .to_owned(),
            };
        }
        Err(error) => {
            return NoReceipt {
                exit: EXIT_UNRESOLVED,
                message: format!(
                    "the recovery journal {} cannot be read: {error}. Nothing was changed; run \
                     the same command again once it is readable.",
                    journal.path().display()
                ),
            };
        }
    }
    let receipts = ReceiptStore::new(ports.install_root);
    match receipts.begin(&lock, request.request_id, request.selection) {
        Ok(Begin::Fresh) => {}
        Ok(Begin::Replay(receipt)) => return Outcome::Receipt(receipt),
        Ok(Begin::Conflict(message)) => {
            return NoReceipt {
                exit: EXIT_HELD,
                message: format!("{message}. Nothing was changed."),
            };
        }
        Err(error) => {
            return NoReceipt {
                exit: EXIT_FAILED,
                message: format!(
                    "the upgrade request could not be recorded: {error}. Nothing was changed."
                ),
            };
        }
    }
    let mut run = Run {
        ports,
        lock: &lock,
        receipts: &receipts,
        journal: &journal,
        request_id: request.request_id,
        allow_downgrade: request.allow_downgrade,
        switch: ActiveSwitch::new(ports, stage, request.caller),
    };
    run.execute(request.selection)
}

fn lock_refusal(error: &LockError) -> Outcome {
    match error {
        LockError::Busy => NoReceipt {
            exit: EXIT_HELD,
            message: "another install, upgrade, or recovery is running. Nothing was changed."
                .to_owned(),
        },
        other => NoReceipt {
            exit: EXIT_FAILED,
            message: format!("{other}. Nothing was changed."),
        },
    }
}

/// A failure before the transaction changed anything: its receipt is `failed`, carrying the SDK
/// code that names it when one does.
struct Refusal {
    error: String,
    code: Option<&'static str>,
}

fn refuse(error: impl Into<String>) -> Refusal {
    Refusal {
        error: error.into(),
        code: None,
    }
}

impl From<UpdateError> for Refusal {
    fn from(error: UpdateError) -> Self {
        Self {
            error: error.to_string(),
            code: error.code(),
        }
    }
}

impl From<ActiveError> for Refusal {
    fn from(error: ActiveError) -> Self {
        Self {
            error: error.to_string(),
            code: error.code(),
        }
    }
}

/// The refusal for activating `target` over the installed `installed` without `--allow-downgrade`.
/// A target that is older by SemVer precedence is refused; so is one whose order is unknown,
/// because a version that is not SemVer cannot be shown to be newer. The same version and a newer
/// one pass.
fn downgrade_refusal(target: &str, installed: &str, allow_downgrade: bool) -> Option<Refusal> {
    // The same version is a reinstall, whether or not it can be ordered.
    if allow_downgrade || target == installed {
        return None;
    }
    let reason = match precedence(target, installed) {
        Some(Ordering::Less) => {
            format!("CoForge Computer {target} is older than the installed {installed}.")
        }
        Some(Ordering::Equal | Ordering::Greater) => return None,
        None => format!(
            "CoForge Computer {target} cannot be ordered against the installed {installed}, \
             because one of them is not a SemVer version."
        ),
    };
    Some(Refusal {
        error: format!(
            "{reason} Nothing was changed. To go back, run `coforge-computer upgrade --version \
             {target} --allow-downgrade`."
        ),
        code: Some(ERROR_CODE_DOWNGRADE_REFUSED),
    })
}

/// The version `active.json` named before the upgrade, and what its supervisor was doing.
struct Installed {
    version: String,
    previous: Option<String>,
    supervisor_running: bool,
    /// The supervisor's id before the switch: a restarted one must have another.
    supervisor_id: Option<String>,
    runtimes: Vec<RuntimeState>,
}

impl Installed {
    fn running_runtimes(&self) -> usize {
        self.runtimes
            .iter()
            .filter(|runtime| runtime.running)
            .count()
    }
}

/// The version being replaced (if any) and the candidate, once both are verified.
///
/// Both service definitions are read before anything stops, so that neither the switch nor its
/// rollback depends on a Computer that has not started yet. They are read only when the
/// supervisor runs (a stopped one is not restarted, so nothing registers a definition); `None`
/// is also a Computer that predates `__lifecycle service-definition`.
struct Prepared {
    from: Option<Installed>,
    to: String,
    /// The definition the rollback registers: the replaced version's.
    from_definition: Option<LifecycleServiceDefinition>,
    /// The definition the switch registers: the candidate's.
    to_definition: Option<LifecycleServiceDefinition>,
}

/// One upgrade from the journal onward.
struct Run<'r, 'p> {
    ports: &'r Ports<'p>,
    lock: &'r MachineMutationLock,
    receipts: &'r ReceiptStore,
    journal: &'r Journal,
    request_id: &'r str,
    allow_downgrade: bool,
    switch: ActiveSwitch<'r, 'p>,
}

impl Run<'_, '_> {
    fn execute(&mut self, selection: &str) -> Outcome {
        let prepared = match self.prepare(selection) {
            Ok(prepared) => prepared,
            Err(refusal) => return self.refused(refusal),
        };
        let transaction = journal_entry(self.request_id, &prepared);
        if let Err(error) = self.journal.record(self.lock, &transaction) {
            return self.refused(refuse(format!(
                "the recovery journal could not be written: {error}"
            )));
        }
        match self.switch_to(&prepared) {
            Ok(()) => self.succeeded(prepared),
            Err(candidate) => self.roll_back(prepared, candidate),
        }
    }

    fn switch_to(&mut self, prepared: &Prepared) -> Result<(), String> {
        let from = prepared.from.as_ref();
        let store = self.ports.store;
        let stop = from.map_or_else(Vec::new, |old| {
            store.executables_to_stop([old.version.as_str()])
        });
        let plan = Plan {
            supervisor_running: from.is_some_and(|installed| installed.supervisor_running),
            running_runtimes: from.map(Installed::running_runtimes),
            stop: &stop,
            replaces: from
                .filter(|installed| installed.supervisor_running)
                .map(|installed| &installed.supervisor_id),
        };
        let previous = previous_after(from, &prepared.to);
        self.switch.switch(
            &Target {
                version: &prepared.to,
                previous: previous.as_deref(),
                definition: prepared.to_definition.as_ref(),
            },
            &plan,
        )
    }

    fn succeeded(&mut self, prepared: Prepared) -> Outcome {
        let runtimes = prepared
            .from
            .as_ref()
            .map(|installed| (installed.supervisor_running, installed.runtimes.clone()));
        let outcome = ReceiptOutcome::Succeeded {
            version: prepared.to.clone(),
        };
        match self.record(outcome, runtimes) {
            Ok(receipt) => {
                self.clear_journal();
                Outcome::Receipt(Box::new(receipt))
            }
            Err(detail) => NoReceipt {
                exit: EXIT_UNRESOLVED,
                message: format!(
                    "{} is active, but its receipt could not be written: {detail}. The upgrade \
                     is not settled: run the same command again, which keeps it when it works.",
                    prepared.to
                ),
            },
        }
    }

    /// Restores the previous version after a failed switch. With none to restore, the failure is
    /// kept unresolved with its journal.
    fn roll_back(&mut self, prepared: Prepared, candidate: String) -> Outcome {
        let Some(from) = prepared.from else {
            return self.unresolved(ReceiptOutcome::Unresolved {
                error: candidate,
                rollback_failed: false,
            });
        };
        self.switch.say(&format!(
            "Upgrade failed: {candidate}; restoring {}",
            from.version
        ));
        let stop = self.ports.store.executables_to_stop([prepared.to.as_str()]);
        let plan = Plan {
            supervisor_running: from.supervisor_running,
            running_runtimes: Some(from.running_runtimes()),
            stop: &stop,
            replaces: None,
        };
        let target = Target {
            version: &from.version,
            previous: from.previous.as_deref(),
            definition: prepared.from_definition.as_ref(),
        };
        match self.switch.switch(&target, &plan) {
            Ok(()) => {
                let outcome = ReceiptOutcome::RolledBack {
                    error: candidate,
                    restored_version: from.version.clone(),
                };
                match self.record(outcome, None) {
                    Ok(receipt) => {
                        self.clear_journal();
                        Outcome::Receipt(Box::new(receipt))
                    }
                    Err(detail) => NoReceipt {
                        exit: EXIT_UNRESOLVED,
                        message: format!(
                            "{} was restored, but its receipt could not be written: {detail}. Run \
                             the same command again.",
                            from.version
                        ),
                    },
                }
            }
            Err(rollback) => self.unresolved(ReceiptOutcome::Unresolved {
                error: format!("{candidate}; rollback failed: {rollback}"),
                rollback_failed: true,
            }),
        }
    }

    /// A failure before the change: its receipt is written, and nothing else.
    fn refused(&mut self, refusal: Refusal) -> Outcome {
        let outcome = ReceiptOutcome::Failed {
            error: refusal.error.clone(),
            error_code: refusal.code.map(str::to_owned),
        };
        match self.record(outcome, None) {
            Ok(receipt) => Outcome::Receipt(Box::new(receipt)),
            Err(detail) => NoReceipt {
                exit: EXIT_FAILED,
                message: format!("{}; no receipt was written: {detail}", refusal.error),
            },
        }
    }

    /// An outcome that leaves the journal in place for the next settling.
    fn unresolved(&mut self, outcome: ReceiptOutcome) -> Outcome {
        match self.record(outcome, None) {
            Ok(receipt) => Outcome::Receipt(Box::new(receipt)),
            Err(detail) => NoReceipt {
                exit: EXIT_UNRESOLVED,
                message: format!(
                    "the upgrade is unresolved and its receipt could not be written: {detail}. \
                     Run the same command again."
                ),
            },
        }
    }

    /// Builds and commits the receipt under the lock. `runtimes` is what a success reports about
    /// the supervisor it replaced, when there was one.
    fn record(
        &self,
        outcome: ReceiptOutcome,
        runtimes: Option<(bool, Vec<RuntimeState>)>,
    ) -> Result<UpgradeReceipt, String> {
        let mut receipt = UpgradeReceipt::new(self.request_id, outcome, self.switch.dead())
            .map_err(|error| error.to_string())?;
        if let Some((supervisor_running, states)) = runtimes {
            receipt = receipt.with_runtimes(supervisor_running, states);
        }
        self.receipts
            .commit(self.lock, &receipt)
            .map_err(|error| error.to_string())?;
        Ok(receipt)
    }

    /// The receipt is the truth now, so a journal that will not go is a warning for the next run.
    fn clear_journal(&mut self) {
        if let Err(error) = self.journal.clear(self.lock) {
            self.switch.say(&format!(
                "warning: the recovery journal could not be removed: {error}; run the same command again"
            ));
        }
    }
}

fn journal_entry(request_id: &str, prepared: &Prepared) -> Transaction {
    Transaction {
        request_id: request_id.to_owned(),
        from: prepared
            .from
            .as_ref()
            .map(|installed| installed.version.clone()),
        from_previous: prepared
            .from
            .as_ref()
            .and_then(|installed| installed.previous.clone()),
        to: prepared.to.clone(),
        supervisor_running: prepared
            .from
            .as_ref()
            .is_some_and(|installed| installed.supervisor_running),
    }
}

/// The previous version after switching to `target`: the version that was active, unless
/// `target` is that version, which keeps the one before it.
fn previous_after(from: Option<&Installed>, target: &str) -> Option<String> {
    let from = from?;
    if from.version == target {
        from.previous.clone()
    } else {
        Some(from.version.clone())
    }
}

/// The refusal message when the running Computer reports itself unhealthy.
fn unhealthy_message(status: &LifecycleStatus) -> String {
    let problems: Vec<&str> = status
        .problems
        .iter()
        .map(|problem| problem.message.as_str())
        .collect();
    let text = if problems.is_empty() {
        "the installed Computer reports an unhealthy runtime set".to_owned()
    } else {
        problems.join(" ")
    };
    if status.supervisor.running {
        format!("Workspace runtime set is unhealthy: {text}")
    } else {
        text
    }
}

mod preparation;

#[cfg(test)]
pub(crate) mod fakes;
#[cfg(test)]
mod tests;
