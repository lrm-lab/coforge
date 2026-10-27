//! Upgrade receipts, their exit statuses and error codes, and the dead-process evidence they carry.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

/// `schema_version` of an upgrade receipt.
pub const RECEIPT_SCHEMA_VERSION: u32 = 1;
/// `protocol` of every receipt this installer writes.
pub const INSTALLER_RECEIPT_PROTOCOL: &str = "coforge-installer/v1";

/// Exit status: the operation succeeded.
pub const EXIT_SUCCEEDED: u8 = 0;
/// Exit status: failed before any change, or rolled back to the previous version (a receipt).
/// Also a usage error, which writes no receipt: no operation began.
pub const EXIT_FAILED: u8 = 1;
/// Exit status: the operation was stopped on purpose before it settled. With a receipt its status
/// is [`ReceiptStatus::Held`]. Without one: the machine mutation lock is held by another run, or
/// the request id was already used for a different operation or target; both write nothing.
/// Busy Agents never hold an operation.
pub const EXIT_HELD: u8 = 2;
/// Exit status: rollback failed, or no previous version existed to roll back to (a receipt).
/// Also, without a receipt: recovery state exists and the operation is not `recover` or `repair`;
/// the message names `coforge-installer recover`.
pub const EXIT_UNRESOLVED: u8 = 3;
/// The largest receipt file a reader accepts; it treats a larger one as no receipt.
pub const RECEIPT_MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReceiptStatus {
    Succeeded,
    Failed,
    Held,
}

/// `error_code` of a receipt whose upgrade was rolled back to the previous version.
pub const ERROR_CODE_ROLLED_BACK: &str = "UPGRADE_ROLLED_BACK";
/// `error_code` of a receipt whose rollback failed.
pub const ERROR_CODE_ROLLBACK_FAILED: &str = "UPGRADE_ROLLBACK_FAILED";
/// `error_code` of a failed receipt that refused an upgrade to an older version without
/// `--allow-downgrade`. Nothing changed.
pub const ERROR_CODE_DOWNGRADE_REFUSED: &str = "UPGRADE_DOWNGRADE_REFUSED";

/// How an upgrade ended. It fixes a receipt's status, error code, and exit code together, so a
/// receipt cannot pair them wrongly (`InstallerReceiptSchema` in the product has the table).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptOutcome {
    Succeeded {
        version: String,
    },
    /// Exit 1: failed before any change. `error_code` is one of the SDK's, never a rollback code,
    /// or `None` when none of them describes the failure.
    Failed {
        error: String,
        error_code: Option<String>,
    },
    /// Exit 1, `UPGRADE_ROLLED_BACK`: failed after a change and restored `restored_version`.
    RolledBack {
        error: String,
        restored_version: String,
    },
    Held {
        error: String,
        error_code: Option<String>,
    },
    /// Exit 3: the rollback failed (`UPGRADE_ROLLBACK_FAILED`) or, when `rollback_failed` is
    /// false, no previous version existed to roll back to (no code).
    Unresolved {
        error: String,
        rollback_failed: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidReceipt(String);

impl fmt::Display for InvalidReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid upgrade receipt: {}", self.0)
    }
}

impl std::error::Error for InvalidReceipt {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ReceiptFields {
    schema_version: u32,
    request_id: String,
    operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    status: ReceiptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(
        rename = "restoredVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    restored_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(rename = "errorCode", default, skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(
        rename = "supervisorRunning",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    supervisor_running: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtimes: Option<Vec<RuntimeState>>,
    #[serde(
        rename = "deadProcessIdentities",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    dead_process_identities: Option<Vec<DeadProcessIdentity>>,
    protocol: String,
    exit_code: u8,
    installer_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpgradeReceipt(ReceiptFields);

impl UpgradeReceipt {
    pub fn new(
        request_id: &str,
        outcome: ReceiptOutcome,
        dead_process_identities: Vec<DeadProcessIdentity>,
    ) -> Result<Self, InvalidReceipt> {
        Self::new_for_operation(request_id, "upgrade", outcome, dead_process_identities)
    }

    pub fn new_for_operation(
        request_id: &str,
        operation: &str,
        outcome: ReceiptOutcome,
        dead_process_identities: Vec<DeadProcessIdentity>,
    ) -> Result<Self, InvalidReceipt> {
        let (status, exit_code, version, restored_version, error, error_code, receipt_outcome) =
            match outcome {
                ReceiptOutcome::Succeeded { version } => (
                    ReceiptStatus::Succeeded,
                    EXIT_SUCCEEDED,
                    Some(version),
                    None,
                    None,
                    None,
                    Some(
                        if operation == "repair" {
                            "repaired"
                        } else {
                            "promoted"
                        }
                        .to_owned(),
                    ),
                ),
                ReceiptOutcome::Failed { error, error_code } => (
                    ReceiptStatus::Failed,
                    EXIT_FAILED,
                    None,
                    None,
                    Some(error),
                    error_code,
                    Some("failed".to_owned()),
                ),
                ReceiptOutcome::RolledBack {
                    error,
                    restored_version,
                } => (
                    ReceiptStatus::Failed,
                    EXIT_FAILED,
                    None,
                    Some(restored_version),
                    Some(error),
                    Some(ERROR_CODE_ROLLED_BACK.to_owned()),
                    Some("rolled_back".to_owned()),
                ),
                ReceiptOutcome::Held { error, error_code } => (
                    ReceiptStatus::Held,
                    EXIT_HELD,
                    None,
                    None,
                    Some(error),
                    error_code,
                    Some("held".to_owned()),
                ),
                ReceiptOutcome::Unresolved {
                    error,
                    rollback_failed,
                } => (
                    ReceiptStatus::Failed,
                    EXIT_UNRESOLVED,
                    None,
                    None,
                    Some(error),
                    rollback_failed.then(|| ERROR_CODE_ROLLBACK_FAILED.to_owned()),
                    Some("unresolved".to_owned()),
                ),
            };
        let fields = ReceiptFields {
            schema_version: RECEIPT_SCHEMA_VERSION,
            request_id: request_id.to_owned(),
            operation: operation.to_owned(),
            outcome: receipt_outcome,
            status,
            version,
            restored_version,
            error,
            error_code,
            supervisor_running: None,
            runtimes: None,
            dead_process_identities: (!dead_process_identities.is_empty())
                .then_some(dead_process_identities),
            protocol: INSTALLER_RECEIPT_PROTOCOL.to_owned(),
            exit_code,
            installer_version: env!("CARGO_PKG_VERSION").to_owned(),
        };
        validate(&fields)?;
        Ok(Self(fields))
    }

    /// Adds what `__lifecycle status` said about the supervisor and its Workspace runtimes.
    #[must_use]
    pub fn with_runtimes(mut self, supervisor_running: bool, runtimes: Vec<RuntimeState>) -> Self {
        self.0.supervisor_running = Some(supervisor_running);
        self.0.runtimes = Some(runtimes);
        self
    }

    pub fn request_id(&self) -> &str {
        &self.0.request_id
    }

    pub fn operation(&self) -> &str {
        &self.0.operation
    }

    pub fn status(&self) -> ReceiptStatus {
        self.0.status
    }

    /// The exit status this receipt implies (0, 1, 2, or 3), which a replay exits with.
    pub fn exit_code(&self) -> u8 {
        self.0.exit_code
    }

    pub fn version(&self) -> Option<&str> {
        self.0.version.as_deref()
    }

    pub fn restored_version(&self) -> Option<&str> {
        self.0.restored_version.as_deref()
    }

    pub fn error(&self) -> Option<&str> {
        self.0.error.as_deref()
    }

    pub fn error_code(&self) -> Option<&str> {
        self.0.error_code.as_deref()
    }

    pub fn supervisor_running(&self) -> Option<bool> {
        self.0.supervisor_running
    }

    pub fn runtimes(&self) -> Option<&[RuntimeState]> {
        self.0.runtimes.as_deref()
    }

    /// The processes the installer stopped; present, and never empty, exactly when it stopped any.
    pub fn dead_process_identities(&self) -> Option<&[DeadProcessIdentity]> {
        self.0.dead_process_identities.as_deref()
    }

    pub fn protocol(&self) -> &str {
        &self.0.protocol
    }

    pub fn installer_version(&self) -> &str {
        &self.0.installer_version
    }
}

impl Serialize for UpgradeReceipt {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for UpgradeReceipt {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let fields = ReceiptFields::deserialize(deserializer)?;
        validate(&fields).map_err(serde::de::Error::custom)?;
        Ok(Self(fields))
    }
}

/// The rules of `InstallerReceiptSchema`: fixed fields, the pairing of status, error code, and
/// exit code, and well-formed dead-process evidence.
fn validate(fields: &ReceiptFields) -> Result<(), InvalidReceipt> {
    let invalid = |reason: &str| Err(InvalidReceipt(reason.to_owned()));
    if fields.schema_version != RECEIPT_SCHEMA_VERSION {
        return invalid("schema_version is not 1");
    }
    if fields.operation != "upgrade" && fields.operation != "repair" {
        return invalid("operation is not upgrade or repair");
    }
    if fields.protocol != INSTALLER_RECEIPT_PROTOCOL {
        return invalid("protocol is not coforge-installer/v1");
    }
    if !is_request_id(&fields.request_id) {
        return invalid("request_id is not a UUID");
    }
    let code = fields.error_code.as_deref();
    if code.is_some_and(|code| !is_error_code(code)) {
        return invalid("errorCode is not an upper-case code");
    }
    let has_reason = fields
        .error
        .as_deref()
        .is_some_and(|error| !error.is_empty());
    let restored = fields.restored_version.as_deref();
    let rollback_code = matches!(
        code,
        Some(ERROR_CODE_ROLLED_BACK | ERROR_CODE_ROLLBACK_FAILED)
    );
    let paired = match (fields.status, fields.exit_code) {
        (ReceiptStatus::Succeeded, EXIT_SUCCEEDED) => code.is_none() && restored.is_none(),
        (ReceiptStatus::Held, EXIT_HELD) => has_reason && !rollback_code && restored.is_none(),
        (ReceiptStatus::Failed, EXIT_FAILED) if code == Some(ERROR_CODE_ROLLED_BACK) => {
            has_reason && restored.is_some_and(|version| !version.is_empty())
        }
        (ReceiptStatus::Failed, EXIT_FAILED) => has_reason && !rollback_code && restored.is_none(),
        (ReceiptStatus::Failed, EXIT_UNRESOLVED) => {
            has_reason
                && matches!(code, None | Some(ERROR_CODE_ROLLBACK_FAILED))
                && restored.is_none()
        }
        (status, exit_code) => {
            return Err(InvalidReceipt(format!(
                "a {status:?} receipt cannot exit with {exit_code}"
            )));
        }
    };
    if !paired {
        return Err(InvalidReceipt(format!(
            "a {:?} receipt with exit {} cannot carry error {:?}, errorCode {:?}, restoredVersion {:?}",
            fields.status, fields.exit_code, fields.error, code, restored
        )));
    }
    if let Some(processes) = &fields.dead_process_identities
        && (processes.is_empty() || !processes.iter().all(DeadProcessIdentity::is_identified))
    {
        return invalid("deadProcessIdentities is empty or names a process without an identity");
    }
    Ok(())
}

/// An RFC 9562 UUID in either case, as the product's `request_id` pattern reads it
/// (`RFC_UUID_PATTERN`, case-insensitive): a `1`-`8` version digit and an `8`, `9`, `a`, or `b`
/// variant digit.
pub fn is_request_id(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    let lengths = [8, 4, 4, 4, 12];
    groups.len() == lengths.len()
        && groups.iter().zip(lengths).all(|(group, length)| {
            group.len() == length && group.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        && matches!(groups[2].as_bytes()[0], b'1'..=b'8')
        && matches!(
            groups[3].as_bytes()[0],
            b'8' | b'9' | b'a' | b'b' | b'A' | b'B'
        )
}

/// The shape every upgrade error code has, known or not (`upgrade-error-codes.json`'s `pattern`).
fn is_error_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    (3..=64).contains(&bytes.len())
        && bytes[0].is_ascii_uppercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// A process the installer stopped. The Computer only checks the shape; the installer compares
/// the values, on the machine that wrote them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeadProcessIdentity {
    pub pid: u32,
    /// Opaque, compared only for equality: each platform's own start time, unconverted.
    /// Linux `<boot id>:<start ticks>` (`/proc/sys/kernel/random/boot_id`, field 22 of
    /// `/proc/<pid>/stat`, read after the last `)` because the command name can hold spaces and
    /// parentheses); macOS `<seconds>.<microseconds>` (six digits, from
    /// `proc_pidinfo(PROC_PIDTBSDINFO)`); Windows the decimal `FILETIME` creation time from
    /// `GetProcessTimes`.
    #[serde(rename = "startedAt")]
    pub started_at: String,
    pub executable: String,
}

impl DeadProcessIdentity {
    /// Whether it names a real process: a positive ID, a start time, and an executable.
    fn is_identified(&self) -> bool {
        self.pid > 0 && !self.started_at.is_empty() && !self.executable.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeState {
    #[serde(rename = "bindingId")]
    pub binding_id: String,
    pub running: bool,
}

/// Upgrade error codes a receipt may name (`upgrade-error-codes.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeErrorCodes {
    pub pattern: String,
    pub codes: BTreeMap<String, String>,
}

/// The receipts the product accepts and refuses (`receipt-cases.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReceiptCases {
    pub allowed: Vec<AllowedReceipt>,
    pub rejected: Vec<RejectedReceipt>,
}

/// One allowed row; `slug` names the `receipt.<slug>.json` the installer writes for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AllowedReceipt {
    pub slug: String,
    pub receipt: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RejectedReceipt {
    pub name: String,
    pub receipt: serde_json::Value,
}

/// The installer's exit statuses and the receipt size a reader accepts (`installer-codes.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallerCodes {
    pub exit_codes: BTreeMap<String, u8>,
    pub max_receipt_bytes: u64,
}

#[cfg(test)]
mod tests;
