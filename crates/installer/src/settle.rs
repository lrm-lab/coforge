//! Settling first: every operation settles an unfinished upgrade (the journal) before its own
//! work, instead of refusing until a person asks for that. [`settle_first`] runs the same
//! recovery [`crate::recover`] owns; `Ok` means there is no journal left, or none to settle.
//! `start` settles the journal before it starts the service ([`settle_before_start`]).

use crate::journal::Journal;
use crate::recover::{RecoverOutcome, recover};
use crate::switch::Ports;

/// Why an operation may not go on after it tried to settle an unfinished upgrade first.
#[derive(Debug, PartialEq, Eq)]
pub enum Unsettled {
    /// This process runs inside the service's own unit, which settling would stop.
    Refused { message: String },
    /// Another operation holds the machine lock.
    Held { message: String },
    /// The upgrade could not be settled now; running the same command again tries once more.
    Unresolved { message: String },
}

impl Unsettled {
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Refused { .. } => crate::contract::EXIT_FAILED,
            Self::Held { .. } => crate::contract::EXIT_HELD,
            Self::Unresolved { .. } => crate::contract::EXIT_UNRESOLVED,
        }
    }

    /// What a person is told: an unsettled upgrade is not their task, so the answer is to run the
    /// same command again.
    pub fn message(&self) -> String {
        match self {
            Self::Refused { message } | Self::Held { message } => message.clone(),
            Self::Unresolved { message } => format!(
                "An earlier upgrade could not be recovered yet: {message}. Run the same command \
                 again. Nothing was changed."
            ),
        }
    }
}

/// Every operation settles an unfinished upgrade (the journal) before its own work, instead of
/// refusing until a person asks for that: `Ok` means there is none left, or none to settle.
pub fn settle_first(
    ports: &Ports<'_>,
    caller: Option<crate::processes::VerifiedCaller>,
    stage: &mut dyn FnMut(&str),
) -> Result<(), Unsettled> {
    if matches!(Journal::new(ports.install_root).read(), Ok(None)) {
        return Ok(());
    }
    stage("An upgrade was left unfinished; settling it first");
    match recover(ports, caller, stage) {
        RecoverOutcome::NothingToRecover | RecoverOutcome::Recovered { .. } => Ok(()),
        RecoverOutcome::Refused { message } => Err(Unsettled::Refused { message }),
        RecoverOutcome::Held { message } => Err(Unsettled::Held { message }),
        RecoverOutcome::Unresolved { message } => Err(Unsettled::Unresolved { message }),
    }
}

/// What `coforge-installer start` does about an unfinished upgrade before it starts the service.
/// `None` means go on and start. Inside the service's own unit, settling is refused (it would stop
/// the caller), and the start goes on as it always did.
pub fn settle_before_start(
    ports: &Ports<'_>,
    stage: &mut dyn FnMut(&str),
) -> Option<crate::start::Outcome> {
    match settle_first(ports, None, stage) {
        Ok(()) | Err(Unsettled::Refused { .. }) => None,
        Err(Unsettled::Held { message }) => Some(crate::start::Outcome::Held { message }),
        Err(Unsettled::Unresolved { message }) => Some(crate::start::Outcome::Failed { message }),
    }
}

#[cfg(test)]
mod tests;
