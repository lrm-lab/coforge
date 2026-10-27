//! What `coforge-computer __lifecycle` prints.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Version of the JSON `coforge-computer __lifecycle` prints.
pub const LIFECYCLE_PROTOCOL: u32 = 1;

/// `coforge-computer __lifecycle protocol`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleProtocol {
    pub lifecycle_protocol: u32,
    pub version: String,
}

/// `coforge-computer __lifecycle status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleStatus {
    pub lifecycle_protocol: u32,
    pub version: String,
    pub supervisor: SupervisorState,
    pub bindings: Vec<LifecycleBinding>,
    pub healthy: bool,
    /// Why the runtime set is not healthy; empty exactly when `healthy` is true.
    pub problems: Vec<LifecycleProblem>,
}

/// One reason a runtime set is not healthy. `message` names the command that fixes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleProblem {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupervisorState {
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleBinding {
    pub binding_id: String,
    pub enabled: bool,
    pub running: bool,
    pub process_id: Option<u32>,
}

/// `__lifecycle` exit statuses, error codes, and status problem codes (`lifecycle-codes.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleCodes {
    pub exit_codes: BTreeMap<String, u8>,
    pub error_codes: BTreeMap<String, String>,
    pub problem_codes: BTreeMap<String, String>,
}

/// Any failed `__lifecycle` call, printed with a non-zero exit status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleError {
    pub lifecycle_protocol: u32,
    pub ok: bool,
    pub code: String,
    pub message: String,
}

#[cfg(test)]
mod tests;
