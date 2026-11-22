use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::contract::{ReceiptStatus, UpgradeReceipt};
use crate::private_fs::{FileMode, replace_file};

#[derive(Deserialize)]
struct Context {
    generation: String,
    version: String,
}

pub(crate) struct UpgradeProgress {
    directory: PathBuf,
    context: Context,
}

impl UpgradeProgress {
    pub(crate) fn open(root: &Path, request_id: &str, target: &str) -> Option<Self> {
        let directory = root
            .join("upgrade-progress")
            .join(request_id.to_ascii_lowercase());
        let path = directory.join("context.json");
        let metadata = fs::symlink_metadata(&path).ok()?;
        if !metadata.is_file() || metadata.len() > 16 * 1024 {
            return None;
        }
        let context: Context = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
        (context.version == target).then_some(Self { directory, context })
    }

    pub(crate) fn phase(&self, phase: &str) {
        self.write(phase, json!({ "kind": "phase", "phase": phase }));
    }

    pub(crate) fn activated(&self) {
        self.write("activated", json!({ "kind": "activated" }));
    }

    pub(crate) fn healthy(&self) {
        self.write("healthy", json!({ "kind": "healthy" }));
    }

    pub(crate) fn terminal(&self, receipt: &UpgradeReceipt) {
        let outcome = match receipt.status() {
            ReceiptStatus::Succeeded => "promoted",
            _ if receipt.restored_version().is_some() => "rolled_back",
            _ if receipt.exit_code() == crate::contract::EXIT_UNRESOLVED => "unresolved",
            _ => "failed",
        };
        let old_processes = if receipt.dead_process_identities().is_some() {
            "verified"
        } else if receipt.supervisor_running() == Some(false) {
            "none"
        } else {
            "unknown"
        };
        self.write(
            "receipt",
            json!({
                "kind": "receipt",
                "outcome": outcome,
                "oldProcesses": old_processes,
                "restoredVersion": receipt.restored_version(),
            }),
        );
    }

    fn write(&self, name: &str, mut fact: Value) {
        let Ok(at) = SystemTime::now().duration_since(UNIX_EPOCH) else {
            return;
        };
        let Ok(at) = u64::try_from(at.as_millis()) else {
            return;
        };
        fact["version"] = json!(self.context.version);
        fact["generation"] = json!(self.context.generation);
        fact["at"] = json!(at);
        if let Ok(bytes) = serde_json::to_vec(&fact) {
            let _ = replace_file(
                &self.directory.join(format!("{name}.json")),
                &bytes,
                FileMode::Exact(0o600),
            );
        }
    }
}
