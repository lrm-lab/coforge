//! Files and JSON shared with CoForge Computer. TypeScript defines the shapes and generates the
//! schemas and goldens; these types read and write them while ignoring future fields.

use serde::{Deserialize, Serialize};

mod installation;
mod lifecycle;
mod machine;
mod manifests;
mod receipts;
mod recovery;

pub use installation::{
    ACTIVE_STATE_SCHEMA_VERSION, ActiveState, INSTALLED_IDENTITY_SCHEMA_VERSION, InstalledIdentity,
    LauncherFile, Launchers, WindowsLaunchers, WindowsShim, agent_cli_launcher,
    github_cli_launcher, windows_computer_launcher,
};
pub use lifecycle::{
    LIFECYCLE_PROTOCOL, LifecycleBinding, LifecycleCodes, LifecycleError, LifecycleProblem,
    LifecycleProtocol, LifecycleServiceDefinition, LifecycleStatus, SupervisorState,
};
pub use machine::{
    CoordinatorService, MachineMutationLock, PathCase, Paths, ServiceIdentities,
    UpgradeJobIdentity, parse_supervisor_lock_owner, request_scoped,
};
pub use manifests::{
    ComputerArtifact, FeedEnvironment, FeedEnvironments, GzipObject,
    INSTALLER_MANIFEST_SCHEMA_VERSION, INSTALLER_PROTOCOL, InstallerArtifact, InstallerManifest,
    InstallerPlatform, NamedArtifact, RELEASE_MANIFEST_SCHEMA_VERSION, ReleaseManifest,
    ReleasePlatform, ReleaseVersionCase, ReleaseVersions,
};
pub use receipts::{
    AllowedReceipt, DeadProcessIdentity, ERROR_CODE_DOWNGRADE_REFUSED, ERROR_CODE_ROLLBACK_FAILED,
    ERROR_CODE_ROLLED_BACK, EXIT_FAILED, EXIT_HELD, EXIT_SUCCEEDED, EXIT_UNRESOLVED,
    INSTALLER_RECEIPT_PROTOCOL, InstallerCodes, InvalidReceipt, RECEIPT_MAX_BYTES,
    RECEIPT_SCHEMA_VERSION, ReceiptCases, ReceiptOutcome, ReceiptStatus, RejectedReceipt,
    RuntimeState, UpgradeErrorCodes, UpgradeReceipt, is_request_id,
};
pub use recovery::{RECOVERY_REPORT_SCHEMA_VERSION, RecoveryOutcome, RecoveryReport};

/// Byte size and lowercase hex SHA-256 of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactIdentity {
    pub size: u64,
    pub checksum: String,
}

/// A JSON state file's contents as the product writes them: compact, newline-terminated.
pub fn to_file_json<T: Serialize>(value: &T) -> String {
    let mut text = serde_json::to_string(value).expect("contract types always serialize");
    text.push('\n');
    text
}

#[cfg(test)]
mod tests;
