//! Best-effort pruning of inactive `versions/<v>/` directories under the machine mutation lock.
//!
//! After an install, upgrade, recovery, or repair settles on an active version, older
//! `versions/<v>/` directories that are neither `active.current`, `active.previous` (kept for
//! rollback), an explicitly retained target, nor running in [`ProcessTable`] are removed while the
//! caller still holds [`MachineMutationLock`]. Any failure to inspect or remove a directory is
//! reported as a warning and never aborts an already-activated installation.

use std::fs;
use std::io;
use std::path::PathBuf;

use crate::active::read_active;
use crate::lock::MachineMutationLock;
use crate::private_fs;
use crate::processes::{Inspection, ProcessError, ProcessTable, ProductExecutable, path_is_within};
use crate::store::VersionStore;
use crate::update_error::UpdateError;
use crate::version::is_valid_release_version;

/// What [`prune_inactive_versions`] removed, and any best-effort warnings it encountered.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PruneReport {
    pub removed: Vec<String>,
    pub warnings: Vec<String>,
}

/// Removes inactive `versions/<v>/` directories under `lock` (`VersionStore::require_lock` refuses
/// a lock covering another install root).
pub fn prune_inactive_versions(
    lock: &MachineMutationLock,
    store: &VersionStore,
    processes: &dyn ProcessTable,
    keep: &[&str],
) -> Result<PruneReport, UpdateError> {
    store.require_lock(lock)?;
    let mut report = PruneReport::default();

    let active = match read_active(store.install_root()) {
        Ok(Some(active)) => active,
        Ok(None) | Err(_) => return Ok(report),
    };

    let versions_root = store.install_root().join("versions");
    let entries = match fs::read_dir(&versions_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(report),
        Err(error) => {
            report.warnings.push(format!(
                "versions directory {} could not be read: {error}",
                versions_root.display()
            ));
            return Ok(report);
        }
    };

    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Some(version) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !is_valid_release_version(&version) {
            continue;
        }
        let retained = version == active.current
            || active.previous.as_deref() == Some(version.as_str())
            || keep.contains(&version.as_str());
        if !retained {
            candidates.push(version);
        }
    }
    if candidates.is_empty() {
        return Ok(report);
    }
    candidates.sort();

    let live = match live_executables(processes) {
        Ok(LiveExecutables::Known(live)) => live,
        Ok(LiveExecutables::Blocked(reason)) => {
            report
                .warnings
                .push(format!("skipping version pruning because {reason}"));
            return Ok(report);
        }
        Err(error) => {
            report.warnings.push(format!(
                "skipping version pruning because running processes could not be inspected: {error}"
            ));
            return Ok(report);
        }
    };

    for version in candidates {
        if version_is_running(store, &version, &live) {
            continue;
        }
        let directory = store.version_directory(&version);
        match fs::remove_dir_all(&directory) {
            Ok(()) => report.removed.push(version),
            Err(error) => report.warnings.push(format!(
                "inactive version {version} could not be removed: {error}"
            )),
        }
    }
    if !report.removed.is_empty() {
        private_fs::sync_directory(&versions_root);
    }
    Ok(report)
}

/// Runs [`prune_inactive_versions`] as post-activation housekeeping, printing any warnings to
/// stderr without failing the caller's completed transaction.
pub(crate) fn prune_best_effort(
    lock: &MachineMutationLock,
    store: &VersionStore,
    processes: &dyn ProcessTable,
    keep: &[&str],
) {
    match prune_inactive_versions(lock, store, processes, keep) {
        Ok(report) => {
            for warning in report.warnings {
                eprintln!("coforge-installer: warning: {warning}");
            }
        }
        Err(error) => {
            eprintln!("coforge-installer: warning: could not prune inactive versions: {error}");
        }
    }
}

enum LiveExecutables {
    Known(Vec<PathBuf>),
    Blocked(&'static str),
}

fn live_executables(processes: &dyn ProcessTable) -> Result<LiveExecutables, ProcessError> {
    let mut executables = Vec::new();
    for pid in processes.pids()? {
        match processes.inspect(pid)? {
            Inspection::Alive(identity) => executables.push(identity.executable),
            Inspection::Unlinked { .. } => {
                return Ok(LiveExecutables::Blocked(
                    "a running process has an unlinked executable",
                ));
            }
            Inspection::Unreadable => {
                return Ok(LiveExecutables::Blocked(
                    "some running processes could not be inspected",
                ));
            }
            Inspection::Absent | Inspection::Zombie => {}
        }
    }
    Ok(LiveExecutables::Known(executables))
}

fn version_is_running(store: &VersionStore, version: &str, live: &[PathBuf]) -> bool {
    let directory = store.version_directory(version);
    let canonical_directory = fs::canonicalize(&directory).ok();
    let resolved_computer = ProductExecutable::resolve(&store.computer_path(version)).ok();
    live.iter().any(|executable| {
        path_is_within(executable, &directory)
            || canonical_directory
                .as_deref()
                .is_some_and(|canonical| path_is_within(executable, canonical))
            || resolved_computer
                .as_ref()
                .is_some_and(|product| product.matches(executable))
    })
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod transaction_tests;
