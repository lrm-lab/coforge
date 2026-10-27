//! Writing the service definition the Computer reports: the checks and file writes the backends
//! share. The text is the Computer's (`__lifecycle service-definition`); the installer only
//! places it where the service manager reads it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::ServiceError;
use crate::contract::LifecycleServiceDefinition;
use crate::private_fs;

/// Refuses a definition made for another manager than the backend's `expected` one.
pub(super) fn require_manager(
    expected: &'static str,
    definition: &LifecycleServiceDefinition,
) -> Result<(), ServiceError> {
    if definition.manager == expected {
        Ok(())
    } else {
        Err(ServiceError::DefinitionForOtherManager {
            expected,
            found: definition.manager.clone(),
        })
    }
}

/// Writes `contents` to `path` atomically, owner-only (`0600`), creating a missing parent
/// directory owner-only (`0700`): a reader never sees a partial file.
pub(super) fn write_private(path: &Path, contents: &str) -> Result<(), ServiceError> {
    path.parent()
        .map_or(Ok(()), private_fs::create_private_directories)
        .and_then(|()| {
            private_fs::replace_file(
                path,
                contents.as_bytes(),
                private_fs::FileMode::Exact(0o600),
            )
        })
        .map_err(|error| not_written(path, &error))
}

fn not_written(path: &Path, error: &io::Error) -> ServiceError {
    ServiceError::DefinitionNotWritten {
        path: path.display().to_string(),
        detail: error.to_string(),
    }
}

/// A definition written to a uniquely named file that exists only as long as this value does.
pub(super) struct TemporaryDefinition(PathBuf);

impl TemporaryDefinition {
    /// Writes `text` as UTF-16 LE with a byte-order mark, which is what `schtasks /Create /XML`
    /// reads, to a new owner-only file in `directory`.
    pub(super) fn utf16(directory: &Path, text: &str) -> Result<Self, ServiceError> {
        let path = private_fs::temporary_sibling(&directory.join("coforge-daemon-task.xml"));
        let bytes: Vec<u8> = std::iter::once(0xFEFF_u16)
            .chain(text.encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect();
        if let Err(error) = private_fs::create_file(&path, &bytes, 0o600) {
            // A write that failed midway leaves the file behind.
            let _ = fs::remove_file(&path);
            return Err(not_written(&path, &error));
        }
        Ok(Self(path))
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TemporaryDefinition {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
