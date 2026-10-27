//! The machine mutation lock, the service names, and the install and state paths.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// How the machine mutation lock is taken (`lock.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineMutationLock {
    pub directory: String,
    pub file: String,
    pub mode: String,
    pub engine: String,
    pub statements: Vec<String>,
    pub contention_codes: Vec<String>,
    pub busy_error_code: String,
    pub held_for: String,
}

/// Services the product installs and the installer controls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceIdentities {
    pub coordinator: CoordinatorService,
    /// Names containing `{request_id}`; see [`request_scoped`].
    pub upgrade_job: UpgradeJobIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoordinatorService {
    pub launchd_label: String,
    pub launchd_domain: String,
    pub systemd_user_unit: String,
    pub windows_task: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeJobIdentity {
    pub launchd_label: String,
    pub systemd_user_unit: String,
    pub windows_task: String,
}

/// Fills a `{request_id}` name template.
pub fn request_scoped(template: &str, request_id: &str) -> String {
    template.replace("{request_id}", request_id)
}

/// Installation roots, as the product resolves them for example homes (`paths.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paths {
    pub home_directory: String,
    pub cases: Vec<PathCase>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathCase {
    pub platform: String,
    pub home: String,
    pub environment: BTreeMap<String, String>,
    pub install_root: String,
    pub state_directory: String,
    pub binary_directory: String,
}

/// The process ID in `<state>/supervisor.lock/owner`, if it names one.
pub fn parse_supervisor_lock_owner(contents: &str) -> Option<u32> {
    contents.trim().parse().ok().filter(|pid| *pid > 0)
}

#[cfg(test)]
mod tests;
