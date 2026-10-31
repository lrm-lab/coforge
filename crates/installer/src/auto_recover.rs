//! Recovery without a person: every operation settles an unfinished upgrade first, and
//! `coforge-installer settle` retries it from a trigger.
//!
//! An upgrade that cannot be rolled back leaves its journal, stops the service on purpose, and
//! exits 3; the machine used to stay down until a person asked for recovery. Now the next
//! operation of any kind settles it first ([`settle_first`]), and the installer arms a one-shot [`RetryTrigger`] in the
//! same step; each time it fires, this module tries the same recovery, waiting longer after every failure ([`wait_before`]) and giving up
//! after [`MAX_ATTEMPTS`]. What it did is written to `recovery-report.json`, which the Computer
//! reads and reports to the server. A machine with no journal has no trigger and no state.
//!
//! The attempt count and the earliest next attempt live in `recovery-state.json`, so a trigger
//! that fires early (a reboot) or twice does nothing until its time. A state file that cannot be
//! read counts as a fresh one.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::journal::Journal;
use crate::private_fs::{self, FileMode};
use crate::recover::{RecoverOutcome, recover};
use crate::retry_trigger::RetryTrigger;
use crate::switch::Ports;

const STATE_FILE: &str = "recovery-state.json";
const REPORT_FILE: &str = "recovery-report.json";
const SCHEMA_VERSION: u32 = 1;

/// How many recoveries are tried before the installer stops trying on its own.
pub const MAX_ATTEMPTS: u32 = 8;

/// How long to wait before attempt `attempt` (1-based): 1 minute, 5 minutes, 15 minutes, 1 hour,
/// then 6 hours.
pub fn wait_before(attempt: u32) -> Duration {
    match attempt {
        0 | 1 => Duration::from_secs(60),
        2 => Duration::from_secs(5 * 60),
        3 => Duration::from_secs(15 * 60),
        4 => Duration::from_secs(60 * 60),
        _ => Duration::from_secs(6 * 60 * 60),
    }
}

/// How an automatic recovery run ended, for the CLI to print and exit with.
#[derive(Debug, PartialEq, Eq)]
pub enum AutoOutcome {
    /// No journal: there is nothing to settle, and the trigger is gone.
    NothingToRecover,
    /// The machine runs `version` again, the journal is cleared and the trigger is gone.
    Recovered { version: String },
    /// Not time yet, or another operation holds the lock; the trigger stays.
    NotYet,
    /// This attempt failed; the next is armed.
    Retry { attempts: u32, message: String },
    /// The last attempt failed too. Nothing is armed until the next operation settles it.
    GaveUp { attempts: u32, message: String },
}

impl AutoOutcome {
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::NothingToRecover | Self::Recovered { .. } | Self::NotYet => 0,
            Self::Retry { .. } | Self::GaveUp { .. } => crate::contract::EXIT_UNRESOLVED,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct State {
    schema_version: u32,
    /// Recoveries tried so far.
    attempts: u32,
    /// The earliest time of the next one, in seconds since the epoch.
    not_before: u64,
}

/// What the last automatic recovery did, for the Computer to report. The shape is the contract's
/// `InstallerRecoveryReport`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
    schema_version: u32,
    outcome: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    restored_version: Option<&'a str>,
    attempts: u32,
    finished_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

fn read_state(root: &Path) -> State {
    fs::read(root.join(STATE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<State>(&bytes).ok())
        .filter(|state| state.schema_version == SCHEMA_VERSION)
        .unwrap_or_default()
}

fn write_json(path: PathBuf, value: &impl Serialize, root: &Path) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    bytes.push(b'\n');
    private_fs::create_private_directories(root)?;
    private_fs::replace_file(&path, &bytes, FileMode::Exact(0o600))
}

fn write_state(root: &Path, attempts: u32, not_before: u64) -> io::Result<()> {
    let state = State {
        schema_version: SCHEMA_VERSION,
        attempts,
        not_before,
    };
    write_json(root.join(STATE_FILE), &state, root)
}

fn clear_state(root: &Path) {
    let _ = fs::remove_file(root.join(STATE_FILE));
}

fn write_report(
    ports: &Ports<'_>,
    outcome: &str,
    restored_version: Option<&str>,
    attempts: u32,
    message: Option<&str>,
) -> io::Result<()> {
    let report = Report {
        schema_version: SCHEMA_VERSION,
        outcome,
        restored_version,
        attempts,
        finished_at: ports.clock.unix_seconds(),
        message,
    };
    write_json(
        ports.install_root.join(REPORT_FILE),
        &report,
        ports.install_root,
    )
}

/// Keeps the trigger in step with the journal after any operation: a journal that is there gets a
/// trigger — asked again for the time that is left while its state lasts, so an arrangement that
/// was lost is armed again — and one that is gone loses it. Best effort: a trigger that cannot be
/// arranged leaves recovery to the next service start or a person.
pub fn keep_trigger_in_step(
    ports: &Ports<'_>,
    trigger: &dyn RetryTrigger,
    stage: &mut dyn FnMut(&str),
) {
    let root = ports.install_root;
    if matches!(Journal::new(root).read(), Ok(None)) {
        if root.join(STATE_FILE).exists() {
            // Settled by a person or a start, not by an automatic try: a report of an earlier
            // failure would no longer be true.
            clear_state(root);
            let _ = fs::remove_file(root.join(REPORT_FILE));
            let _ = trigger.cancel();
        }
        return;
    }
    if root.join(STATE_FILE).exists() {
        // The arrangement may have been lost since it was armed (a disabled unit, a pruned
        // job); asking the trigger again for the time that is left costs little and keeps
        // recovery moving. Recovery that already gave up stays disarmed.
        let state = read_state(root);
        if state.attempts >= MAX_ATTEMPTS {
            return;
        }
        let remaining = state
            .not_before
            .saturating_sub(ports.clock.unix_seconds())
            .max(1);
        if let Err(error) = trigger.schedule(Duration::from_secs(remaining)) {
            stage(&format!("Automatic recovery could not be armed: {error}"));
        }
        return;
    }
    // A new unfinished upgrade: the last one's report is not about it.
    let _ = fs::remove_file(root.join(REPORT_FILE));
    let delay = wait_before(1);
    let not_before = ports.clock.unix_seconds() + delay.as_secs();
    if let Err(error) = write_state(root, 0, not_before) {
        stage(&format!("Automatic recovery could not be armed: {error}"));
        return;
    }
    match trigger.schedule(delay) {
        Ok(()) => stage("Automatic recovery will try again soon"),
        Err(error) => stage(&format!("Automatic recovery could not be armed: {error}")),
    }
}

/// Why an operation may not go on after it tried to settle an unfinished upgrade first.
#[derive(Debug, PartialEq, Eq)]
pub enum Unsettled {
    /// This process runs inside the service's own unit, which settling would stop.
    Refused { message: String },
    /// Another operation holds the machine lock.
    Held { message: String },
    /// The upgrade could not be settled now; the retry trigger will try again.
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

/// One automatic recovery run: the trigger fired, or the machine started.
pub fn recover_auto(
    ports: &Ports<'_>,
    trigger: &dyn RetryTrigger,
    stage: &mut dyn FnMut(&str),
) -> AutoOutcome {
    let root = ports.install_root;
    if matches!(Journal::new(root).read(), Ok(None)) {
        clear_state(root);
        let _ = trigger.cancel();
        return AutoOutcome::NothingToRecover;
    }
    let state = read_state(root);
    if state.attempts >= MAX_ATTEMPTS {
        let _ = trigger.cancel();
        return AutoOutcome::GaveUp {
            attempts: state.attempts,
            message: "automatic recovery already gave up".to_owned(),
        };
    }
    let now = ports.clock.unix_seconds();
    // A clock that was wrong when the state was written (or a state edited by hand) must not
    // hold recovery off for longer than the longest wait there is.
    let latest = now + wait_before(MAX_ATTEMPTS).as_secs();
    if now < state.not_before && state.not_before <= latest {
        // The trigger that fired was spent; keep one for the time that is left.
        let _ = trigger.schedule(Duration::from_secs(state.not_before - now));
        return AutoOutcome::NotYet;
    }
    match recover(ports, None, stage) {
        RecoverOutcome::NothingToRecover => {
            clear_state(root);
            let _ = trigger.cancel();
            AutoOutcome::NothingToRecover
        }
        RecoverOutcome::Recovered { version } => {
            // A report that cannot be written costs the server the news, not the machine.
            let attempts = state.attempts + 1;
            if let Err(error) = write_report(ports, "recovered", Some(&version), attempts, None) {
                stage(&format!(
                    "The recovery report could not be written: {error}"
                ));
            }
            clear_state(root);
            let _ = trigger.cancel();
            AutoOutcome::Recovered { version }
        }
        RecoverOutcome::Held { .. } => {
            let _ = trigger.schedule(wait_before(1));
            AutoOutcome::NotYet
        }
        RecoverOutcome::Refused { message } | RecoverOutcome::Unresolved { message } => {
            let attempts = state.attempts + 1;
            if attempts >= MAX_ATTEMPTS {
                if let Err(error) = write_state(root, attempts, now)
                    .and_then(|()| write_report(ports, "failed", None, attempts, Some(&message)))
                {
                    stage(&format!(
                        "The recovery report could not be written: {error}"
                    ));
                }
                let _ = trigger.cancel();
                return AutoOutcome::GaveUp { attempts, message };
            }
            let mut delay = wait_before(attempts + 1);
            if let Err(error) = write_state(root, attempts, now + delay.as_secs()) {
                // Without the count, tries could go on for ever: slow them to the longest wait.
                stage(&format!("The recovery state could not be written: {error}"));
                delay = wait_before(MAX_ATTEMPTS);
            }
            if let Err(error) = trigger.schedule(delay) {
                stage(&format!("The next recovery could not be armed: {error}"));
            }
            AutoOutcome::Retry { attempts, message }
        }
    }
}

#[cfg(test)]
mod tests;
