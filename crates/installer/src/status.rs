//! What `coforge-installer status` reports: read-only, taking no lock.
//!
//! The JSON form (`status --json`) is one object with these snake_case fields; a field is added,
//! never renamed. `active_version` and `previous_version` come from `active.json`, and
//! `active_error` says why it could not be read. `journal` is the unfinished upgrade, if any
//! (`journal_error` when it cannot be read). `lifecycle` is the active executable's
//! `__lifecycle status` (`contract::LifecycleStatus`), or `lifecycle_error` when that call failed.

use serde::Serialize;

use crate::active::read_active;
use crate::contract::LifecycleStatus;
use crate::journal::Journal;
use crate::lifecycle::ComputerLifecycle;
use crate::store::VersionStore;

#[derive(Debug, Serialize)]
pub struct StatusReport {
    pub active_version: Option<String>,
    pub previous_version: Option<String>,
    pub active_error: Option<String>,
    pub journal: Option<JournalReport>,
    pub journal_error: Option<String>,
    pub lifecycle: Option<LifecycleStatus>,
    pub lifecycle_error: Option<String>,
}

/// The unfinished upgrade the journal records.
#[derive(Debug, Serialize)]
pub struct JournalReport {
    pub request_id: String,
    pub from: Option<String>,
    pub to: String,
    pub supervisor_running: bool,
}

/// The state of the installation under `store`'s install root.
pub fn report(store: &VersionStore, lifecycle: &dyn ComputerLifecycle) -> StatusReport {
    let root = store.install_root();
    let (active_version, previous_version, active_error) = match read_active(root) {
        Ok(Some(active)) => (Some(active.current), active.previous, None),
        Ok(None) => (None, None, None),
        Err(error) => (None, None, Some(error.to_string())),
    };
    let (journal, journal_error) = match Journal::new(root).read() {
        Ok(Some(transaction)) => (
            Some(JournalReport {
                request_id: transaction.request_id,
                from: transaction.from,
                to: transaction.to,
                supervisor_running: transaction.supervisor_running,
            }),
            None,
        ),
        Ok(None) => (None, None),
        Err(error) => (None, Some(error.to_string())),
    };
    let (lifecycle_status, lifecycle_error) = match &active_version {
        Some(version) => match lifecycle.status(&store.computer_path(version)) {
            Ok(status) => (Some(status), None),
            Err(error) => (None, Some(error.to_string())),
        },
        None => (None, None),
    };
    StatusReport {
        active_version,
        previous_version,
        active_error,
        journal,
        journal_error,
        lifecycle: lifecycle_status,
        lifecycle_error,
    }
}

impl StatusReport {
    /// The short human form, one fact per line.
    pub fn lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        match (&self.active_version, &self.active_error) {
            (Some(current), _) => {
                let previous = self.previous_version.as_deref().unwrap_or("none");
                lines.push(format!("Active version: {current} (previous: {previous})"));
            }
            (None, Some(error)) => lines.push(format!("Active version unreadable: {error}")),
            (None, None) => lines.push("No CoForge Computer is installed.".to_owned()),
        }
        if let Some(journal) = &self.journal {
            lines.push(format!(
                "An upgrade to {} (request {}) did not finish; run the same command again, or any upgrade.",
                journal.to, journal.request_id
            ));
        }
        if let Some(error) = &self.journal_error {
            lines.push(format!("Recovery journal unreadable: {error}"));
        }
        if let Some(status) = &self.lifecycle {
            let supervisor = if status.supervisor.running {
                format!(
                    "running (version {})",
                    status.supervisor.version.as_deref().unwrap_or("unknown")
                )
            } else {
                "not running".to_owned()
            };
            lines.push(format!("Supervisor: {supervisor}"));
            if !status.healthy {
                lines.push(format!("Workspace runtimes: {}", status.problems.len()));
            }
        }
        if let Some(error) = &self.lifecycle_error {
            lines.push(format!("Lifecycle status unavailable: {error}"));
        }
        lines
    }
}
