//! The automatic-recovery report the installer leaves for the Computer to report to the server.

use serde::{Deserialize, Serialize};

/// `schemaVersion` of a recovery report.
pub const RECOVERY_REPORT_SCHEMA_VERSION: u32 = 1;

/// How one automatic recovery run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryOutcome {
    /// The machine runs a known version again.
    Recovered,
    /// The last allowed attempt failed too.
    Failed,
}

/// What the last automatic recovery did about one unfinished upgrade, at
/// `<install root>/recovery-report.json`. The shape is the contract's `InstallerRecoveryReport`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub schema_version: u32,
    /// The upgrade request whose journal the recovery settled, when it could still be read.
    /// Reports written before the linkage existed carry none.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub request_id: Option<String>,
    pub outcome: RecoveryOutcome,
    /// The version the machine runs again; only ever set on `Recovered`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub restored_version: Option<String>,
    /// How many recovery tries ran before this outcome.
    pub attempts: u32,
    /// Seconds since the epoch.
    pub finished_at: u64,
    /// Why the recovery failed, when it did.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub message: Option<String>,
}

#[cfg(test)]
mod tests;
