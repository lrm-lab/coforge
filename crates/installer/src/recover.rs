//! Recovery: `coforge-computer recover` settles an upgrade that did not finish.
//!
//! The journal (`installer-transaction.json`) is the only thing that says a run ended between
//! recording the transaction and clearing it. A succeeded receipt commits recovery to the new
//! version. Otherwise, recovery first tries a new version that is already active, keeping it when
//! it settles; if it is not active or cannot settle, recovery restores `from`. With no previous
//! version to restore, or if the required switch fails, the journal stays unresolved. A settled
//! recovery clears the journal and writes a receipt only when none exists.

use std::path::PathBuf;

use crate::active::read_active;
use crate::contract::{
    DeadProcessIdentity, EXIT_FAILED, EXIT_HELD, EXIT_SUCCEEDED, EXIT_UNRESOLVED, ReceiptOutcome,
    ReceiptStatus, UpgradeReceipt,
};
use crate::journal::{Journal, Transaction};
use crate::lock::{LockError, MachineMutationLock};
use crate::processes::VerifiedCaller;
use crate::receipts::ReceiptStore;
use crate::switch::{ActiveSwitch, Plan, Ports, Target, refusal_inside_service};

/// How recovery ended, for the CLI to print and exit with.
#[derive(Debug, PartialEq, Eq)]
pub enum RecoverOutcome {
    /// No journal: no upgrade was left unfinished.
    NothingToRecover,
    /// The machine runs `version` again and the journal is cleared.
    Recovered { version: String },
    /// Another install or upgrade holds the lock. Nothing changed.
    Held { message: String },
    /// This process runs inside the supervisor's service, which recovery would stop. Nothing changed.
    Refused { message: String },
    /// Recovery could not finish. The journal stays, and so does the refusal of other operations.
    Unresolved { message: String },
}

impl RecoverOutcome {
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::NothingToRecover | Self::Recovered { .. } => EXIT_SUCCEEDED,
            Self::Held { .. } => EXIT_HELD,
            Self::Refused { .. } => EXIT_FAILED,
            Self::Unresolved { .. } => EXIT_UNRESOLVED,
        }
    }
}

pub fn recover(
    ports: &Ports<'_>,
    caller: Option<VerifiedCaller>,
    stage: &mut dyn FnMut(&str),
) -> RecoverOutcome {
    match refusal_inside_service(ports.service, "Recovery", "coforge-computer recover") {
        Ok(None) => {}
        Ok(Some(message)) | Err(message) => return RecoverOutcome::Refused { message },
    }
    let lock = match MachineMutationLock::acquire(ports.install_root) {
        Ok(lock) => lock,
        Err(LockError::Busy) => {
            return RecoverOutcome::Held {
                message: "another install, upgrade, or recovery is running. Nothing was changed."
                    .to_owned(),
            };
        }
        Err(error) => return unresolved(error.to_string()),
    };
    let journal = Journal::new(ports.install_root);
    let transaction = match journal.read() {
        Ok(Some(transaction)) => transaction,
        Ok(None) => return RecoverOutcome::NothingToRecover,
        Err(error) => {
            return unresolved(format!(
                "the recovery journal {} cannot be read: {error}",
                journal.path().display()
            ));
        }
    };
    let receipts = ReceiptStore::new(ports.install_root);
    let receipt = match receipts.read(&transaction.request_id) {
        Ok(receipt) => receipt,
        Err(error) => {
            return unresolved(format!(
                "the receipt of request {} cannot be read: {error}",
                transaction.request_id
            ));
        }
    };
    let succeeded = receipt
        .as_ref()
        .is_some_and(|receipt| receipt.status() == ReceiptStatus::Succeeded);
    let active_is_new = read_active(ports.install_root)
        .ok()
        .flatten()
        .is_some_and(|active| active.current == transaction.to);
    let executables = executables(ports, &transaction);
    let mut switch = ActiveSwitch::new(ports, stage, caller);

    // A new version that the interrupted run already activated is kept when it works: it is the
    // version the machine was moving to, and a rollback would undo a healthy upgrade. Only a
    // receipt that says it succeeded forbids the restore outright.
    if succeeded || active_is_new {
        let to = transaction.to.clone();
        switch.say(&format!(
            "Recovering the interrupted upgrade: settling on {to}"
        ));
        match attempt(&mut switch, ports, &transaction, &to, &executables) {
            Ok(()) => {
                if receipt.is_none()
                    && let Err(error) = commit(
                        &receipts,
                        &lock,
                        &transaction.request_id,
                        ReceiptOutcome::Succeeded {
                            version: to.clone(),
                        },
                        switch.dead(),
                    )
                {
                    return unresolved(format!(
                        "{to} is active, but its receipt could not be written: {error}"
                    ));
                }
                return finish(&journal, &lock, to);
            }
            Err(error) if succeeded || transaction.from.is_none() => {
                return unresolved(format!("recovery to {to} failed: {error}"));
            }
            Err(error) => switch.say(&format!(
                "{to} does not settle ({error}); restoring the previous version"
            )),
        }
    }

    let Some(from) = transaction.from.clone() else {
        return unresolved(format!(
            "{} is not active and there is no previous version to restore",
            transaction.to
        ));
    };
    if let Err(error) = attempt(&mut switch, ports, &transaction, &from, &executables) {
        return unresolved(format!("recovery to {from} failed: {error}"));
    }
    if receipt.is_none()
        && let Err(error) = commit(
            &receipts,
            &lock,
            &transaction.request_id,
            ReceiptOutcome::RolledBack {
                error: "the upgrade was interrupted before it finished".to_owned(),
                restored_version: from.clone(),
            },
            switch.dead(),
        )
    {
        return unresolved(format!(
            "{from} was restored, but its receipt could not be written: {error}"
        ));
    }
    finish(&journal, &lock, from)
}

/// Makes `target` the active version through the shared switch, after its bytes verify.
fn attempt(
    switch: &mut ActiveSwitch<'_, '_>,
    ports: &Ports<'_>,
    transaction: &Transaction,
    target: &str,
    executables: &[PathBuf],
) -> Result<(), String> {
    ports
        .store
        .verify_installed(target)
        .map_err(|error| format!("{target} cannot be restored: {error}"))?;
    let previous = previous_for(transaction, target);
    let plan = Plan {
        supervisor_running: transaction.supervisor_running,
        running_runtimes: None,
        stop: executables,
        replaces: None,
    };
    switch.switch(
        &Target {
            version: target,
            previous: previous.as_deref(),
        },
        &plan,
    )
}

fn commit(
    receipts: &ReceiptStore,
    lock: &MachineMutationLock,
    request_id: &str,
    outcome: ReceiptOutcome,
    dead: Vec<DeadProcessIdentity>,
) -> Result<(), String> {
    let receipt =
        UpgradeReceipt::new(request_id, outcome, dead).map_err(|error| error.to_string())?;
    receipts
        .commit(lock, &receipt)
        .map_err(|error| error.to_string())
}

fn finish(journal: &Journal, lock: &MachineMutationLock, version: String) -> RecoverOutcome {
    if let Err(error) = journal.clear(lock) {
        return unresolved(format!(
            "{version} is active, but the recovery journal could not be removed: {error}"
        ));
    }
    RecoverOutcome::Recovered { version }
}

fn unresolved(message: String) -> RecoverOutcome {
    RecoverOutcome::Unresolved { message }
}

/// The previous version once `target` is active: the version the journal replaced, unless the
/// target is that version, which keeps the one before it.
fn previous_for(transaction: &Transaction, target: &str) -> Option<String> {
    match &transaction.from {
        Some(from) if from == target => transaction.from_previous.clone(),
        Some(from) => Some(from.clone()),
        None => None,
    }
}

/// The executables of both versions the journal names, those that exist, each once: their
/// processes belong to the supervisor the interrupted upgrade may have left running.
fn executables(ports: &Ports<'_>, transaction: &Transaction) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    for version in transaction
        .from
        .iter()
        .chain(std::iter::once(&transaction.to))
    {
        let path = ports.store.computer_path(version);
        if path.exists() && !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

#[cfg(test)]
mod tests;
