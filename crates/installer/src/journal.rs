//! The recovery journal: `<install root>/installer-transaction.json`.
//!
//! An upgrade records it before it stops anything and clears it once the machine is in a known
//! good state again: the new version running, or the old one restored. A journal that is still
//! there means a run ended without either, killed or with a rollback that failed, and only
//! settling may run until it is resolved. It holds what recovery needs and nothing else.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::lock::MachineMutationLock;
use crate::private_fs::{self, FileMode};

const FILE: &str = "installer-transaction.json";
const SCHEMA_VERSION: u32 = 1;

/// One upgrade in progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transaction {
    pub request_id: String,
    /// The version that was active before, or `None` on a machine with nothing installed.
    pub from: Option<String>,
    /// What `active.json` named as previous before, kept as the previous version again when
    /// `from` is restored.
    pub from_previous: Option<String>,
    pub to: String,
    /// Whether the Computer supervisor was running before; recovery starts it again only then.
    pub supervisor_running: bool,
}

#[derive(Serialize, Deserialize)]
struct Record {
    schema_version: u32,
    request_id: String,
    from: Option<String>,
    from_previous: Option<String>,
    to: String,
    supervisor_running: bool,
}

pub struct Journal {
    install_root: PathBuf,
    path: PathBuf,
}

impl Journal {
    pub fn new(install_root: &Path) -> Self {
        Self {
            install_root: install_root.to_path_buf(),
            path: install_root.join(FILE),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The transaction a run left unresolved, if any. A journal that exists but cannot be read is
    /// an error: treating it as absent would let an upgrade start over a broken one.
    pub fn read(&self) -> io::Result<Option<Transaction>> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let record: Record = serde_json::from_slice(&bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if record.schema_version != SCHEMA_VERSION {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "schema_version {} is not {SCHEMA_VERSION}",
                    record.schema_version
                ),
            ));
        }
        Ok(Some(Transaction {
            request_id: record.request_id,
            from: record.from,
            from_previous: record.from_previous,
            to: record.to,
            supervisor_running: record.supervisor_running,
        }))
    }

    pub fn record(&self, lock: &MachineMutationLock, transaction: &Transaction) -> io::Result<()> {
        self.require_lock(lock)?;
        let record = Record {
            schema_version: SCHEMA_VERSION,
            request_id: transaction.request_id.clone(),
            from: transaction.from.clone(),
            from_previous: transaction.from_previous.clone(),
            to: transaction.to.clone(),
            supervisor_running: transaction.supervisor_running,
        };
        let mut bytes = serde_json::to_vec(&record).map_err(io::Error::other)?;
        bytes.push(b'\n');
        private_fs::create_private_directories(&self.install_root)?;
        private_fs::replace_file(&self.path, &bytes, FileMode::Exact(0o600))
    }

    /// Removes the journal; one that is already gone is not an error.
    pub fn clear(&self, lock: &MachineMutationLock) -> io::Result<()> {
        self.require_lock(lock)?;
        match fs::remove_file(&self.path) {
            Ok(()) => {
                private_fs::sync_directory(&self.install_root);
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn require_lock(&self, lock: &MachineMutationLock) -> io::Result<()> {
        if lock.covers(&self.install_root) {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "the machine mutation lock does not cover {}",
                self.install_root.display()
            )))
        }
    }
}

#[cfg(test)]
mod tests;
