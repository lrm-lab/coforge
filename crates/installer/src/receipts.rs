//! Upgrade requests and their receipts under `<install root>/upgrade-results/`.
//!
//! `<request id>.request.json` records what a request asked for, so the same id is recognised
//! when it comes again; only the installer reads it. `<request id>.result.json` is the receipt
//! ([`UpgradeReceipt`]), the one thing the Computer and its Daemon read back
//! (`readComputerUpgradeReceipt` in packages/daemon/src/platform/computer-upgrade-receipts.ts).
//! A receipt is written once and never overwritten. Both are changed only under the machine
//! mutation lock, which is what makes "does it exist yet" a safe question.

use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::contract::{RECEIPT_MAX_BYTES, UpgradeReceipt};
use crate::lock::MachineMutationLock;
use crate::private_fs::{self, FileMode};

const DIRECTORY: &str = "upgrade-results";
const REQUEST_SCHEMA_VERSION: u32 = 1;

/// What one request id asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RequestRecord {
    schema_version: u32,
    request_id: String,
    operation: String,
    selection: String,
}

/// What [`ReceiptStore::begin`] found for a request id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Begin {
    /// Nothing ran to an end under this id: run the operation.
    Fresh,
    /// This id already ran the same operation for the same target to this receipt: report it
    /// again, with its exit status, and change nothing.
    Replay(Box<UpgradeReceipt>),
    /// This id belongs to another operation or target, or its receipt cannot be read. Nothing
    /// is written: the operation is held (exit 2) without a receipt.
    Conflict(String),
}

#[derive(Debug)]
pub enum ReceiptError {
    /// The lock covers another install root.
    WrongLock {
        install_root: PathBuf,
    },
    /// A receipt already exists for this id.
    AlreadyCommitted {
        path: PathBuf,
    },
    /// The receipt file exists but is over the size limit or is not a valid receipt.
    Unreadable {
        path: PathBuf,
        detail: String,
    },
    Io {
        path: PathBuf,
        error: io::Error,
    },
}

impl fmt::Display for ReceiptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongLock { install_root } => write!(
                formatter,
                "the machine mutation lock does not cover {}",
                install_root.display()
            ),
            Self::AlreadyCommitted { path } => write!(
                formatter,
                "{} already holds a receipt, which is never overwritten",
                path.display()
            ),
            Self::Unreadable { path, detail } => {
                write!(
                    formatter,
                    "{} is not a readable receipt: {detail}",
                    path.display()
                )
            }
            Self::Io { path, error } => write!(formatter, "{}: {error}", path.display()),
        }
    }
}

impl std::error::Error for ReceiptError {}

pub struct ReceiptStore {
    install_root: PathBuf,
    directory: PathBuf,
}

impl ReceiptStore {
    pub fn new(install_root: &Path) -> Self {
        Self {
            install_root: install_root.to_path_buf(),
            directory: install_root.join(DIRECTORY),
        }
    }

    pub fn result_path(&self, request_id: &str) -> PathBuf {
        self.directory.join(format!("{request_id}.result.json"))
    }

    fn request_path(&self, request_id: &str) -> PathBuf {
        self.directory.join(format!("{request_id}.request.json"))
    }

    fn require_lock(&self, lock: &MachineMutationLock) -> Result<(), ReceiptError> {
        if lock.covers(&self.install_root) {
            Ok(())
        } else {
            Err(ReceiptError::WrongLock {
                install_root: self.install_root.clone(),
            })
        }
    }

    /// Decides what an `upgrade` of `selection` under `request_id` does, and records the request
    /// when it is new. `request_id` must already be a valid id.
    pub fn begin(
        &self,
        lock: &MachineMutationLock,
        request_id: &str,
        selection: &str,
    ) -> Result<Begin, ReceiptError> {
        self.begin_operation(lock, request_id, "upgrade", selection)
    }

    /// Decides what an operation under `request_id` does and records its operation name and
    /// selection when it is new. `repair` uses the same durable request store but does not share
    /// request ids with upgrades.
    pub fn begin_operation(
        &self,
        lock: &MachineMutationLock,
        request_id: &str,
        operation: &str,
        selection: &str,
    ) -> Result<Begin, ReceiptError> {
        self.require_lock(lock)?;
        let wanted = RequestRecord {
            schema_version: REQUEST_SCHEMA_VERSION,
            request_id: request_id.to_owned(),
            operation: operation.to_owned(),
            selection: selection.to_owned(),
        };
        let request_path = self.request_path(request_id);
        let recorded = match fs::read(&request_path) {
            Ok(bytes) => Some(serde_json::from_slice::<RequestRecord>(&bytes).ok()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(ReceiptError::Io {
                    path: request_path,
                    error,
                });
            }
        };
        let receipt = match self.read(request_id) {
            Ok(receipt) => receipt,
            Err(ReceiptError::Unreadable { path, detail }) => {
                return Ok(Begin::Conflict(format!(
                    "request {request_id} already has a receipt that cannot be read ({}: {detail})",
                    path.display()
                )));
            }
            Err(error) => return Err(error),
        };
        match (recorded, receipt) {
            (Some(Some(record)), receipt) if record == wanted => Ok(match receipt {
                Some(receipt) => Begin::Replay(Box::new(receipt)),
                None => Begin::Fresh,
            }),
            (Some(_), _) | (None, Some(_)) => Ok(Begin::Conflict(format!(
                "request {request_id} was already used for another operation or version"
            ))),
            (None, None) => {
                self.create_directory()?;
                let bytes = to_file_json(&wanted);
                private_fs::replace_file(&request_path, &bytes, FileMode::Exact(0o600)).map_err(
                    |error| ReceiptError::Io {
                        path: request_path.clone(),
                        error,
                    },
                )?;
                Ok(Begin::Fresh)
            }
        }
    }

    /// Writes `receipt` for its request id. Refused when one is already there.
    pub fn commit(
        &self,
        lock: &MachineMutationLock,
        receipt: &UpgradeReceipt,
    ) -> Result<(), ReceiptError> {
        self.require_lock(lock)?;
        let path = self.result_path(receipt.request_id());
        if path.exists() {
            return Err(ReceiptError::AlreadyCommitted { path });
        }
        self.create_directory()?;
        let bytes = to_file_json(receipt);
        private_fs::replace_file(&path, &bytes, FileMode::Exact(0o600))
            .map_err(|error| ReceiptError::Io { path, error })
    }

    /// The receipt of `request_id`, or `None` when there is none yet.
    pub fn read(&self, request_id: &str) -> Result<Option<UpgradeReceipt>, ReceiptError> {
        let path = self.result_path(request_id);
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(ReceiptError::Io { path, error }),
        };
        // One byte past the limit tells an oversized file apart without reading the rest.
        let mut bytes = Vec::new();
        file.take(RECEIPT_MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| ReceiptError::Io {
                path: path.clone(),
                error,
            })?;
        if bytes.len() as u64 > RECEIPT_MAX_BYTES {
            return Err(ReceiptError::Unreadable {
                path,
                detail: format!("it is over {RECEIPT_MAX_BYTES} bytes"),
            });
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| ReceiptError::Unreadable {
                path,
                detail: error.to_string(),
            })
    }

    fn create_directory(&self) -> Result<(), ReceiptError> {
        private_fs::create_private_directories(&self.directory).map_err(|error| ReceiptError::Io {
            path: self.directory.clone(),
            error,
        })
    }
}

/// One line of JSON and a newline, as the Computer writes its receipts.
fn to_file_json(value: &impl Serialize) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).expect("a receipt serializes");
    bytes.push(b'\n');
    bytes
}

#[cfg(test)]
mod tests;
