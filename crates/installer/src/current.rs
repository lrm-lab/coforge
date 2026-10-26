//! The `current/` directory: the copy of the active version's payload that actually runs.
//!
//! macOS keys a privacy grant (TCC) partly on the executable's resolved real path. A symlink
//! re-pointed at a new `versions/<v>` changes that path with every upgrade, and the grant is
//! lost; a file replaced at the same path by a rename keeps it. So on POSIX targets `active` is
//! the fixed symlink `current`, and `<install root>/current/` holds a copy of
//! `versions/<active>/`, replaced file by file in place. `versions/<v>` stays the verified
//! store and the rollback source; nothing runs from it.
//!
//! [`sync`] makes `current/` equal to a version directory and is safe to run again after a crash:
//!
//! - each file is copied to a temporary file inside `current/` (a new inode, never an overwrite of
//!   the file a running process maps), fsynced, given the source's mode, and renamed over the
//!   destination;
//! - a file that already matches is left alone;
//! - the executable is replaced after the other files, and the `version` marker last of all, so
//!   `current/version` names a version only once every other file of it is in place.
//!
//! Callers stop every process of the product first; a process that outlives its file keeps the
//! old inode (Linux then lists its executable as `(deleted)`). A caller that cannot stop them
//! (repair) passes `spare_executable`: a differing executable and the marker are then left alone,
//! and the sync reports [`Activation::ExecutableSpared`]. That is a conservative choice, not the
//! only way to find such a process: macOS keeps the original path of a renamed-over executable.
//!
//! Only POSIX targets have a `current/`; the Windows install is described in [`crate::active`].

use std::path::{Path, PathBuf};

/// The directory, relative to the install root, that `active` points at.
pub(crate) const DIRECTORY: &str = "current";

/// The executable inside it and inside each version directory, on POSIX targets.
#[cfg(unix)]
pub(crate) const EXECUTABLE: &str = "coforge-computer";

/// The commit marker: a version directory's `version` file, replaced last.
#[cfg(unix)]
const MARKER: &str = "version";

/// What an activation left undone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activation {
    Complete,
    /// `current/coforge-computer` differs from the version's and was not replaced, and neither was
    /// the `version` marker. Everything else was activated.
    ExecutableSpared,
}

pub(crate) fn directory(install_root: &Path) -> PathBuf {
    install_root.join(DIRECTORY)
}

#[cfg(unix)]
mod unix {
    use std::ffi::OsString;
    use std::fs::{self, File, Metadata};
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    use crate::digest::measure_file;
    use crate::private_fs::{self, FileMode, PendingFile};

    use super::{Activation, EXECUTABLE, MARKER};

    /// One regular file of a version directory.
    struct Payload {
        name: OsString,
        mode: u32,
    }

    /// Makes `destination` hold exactly the files of `source`, as the module comment describes.
    /// A `source` entry that is not a regular file is an error and changes nothing. With
    /// `spare_executable`, an executable that exists and differs is not replaced, and neither is
    /// the marker; everything else is synced.
    pub(crate) fn sync(
        source: &Path,
        destination: &Path,
        spare_executable: bool,
    ) -> io::Result<Activation> {
        let payload = read_payload(source)?;
        private_fs::create_private_directories(destination)?;
        remove_strangers(destination, &payload)?;
        let mut spared = false;
        for file in &payload {
            let from = source.join(&file.name);
            let to = destination.join(&file.name);
            if matches(&from, file.mode, &to)? {
                continue;
            }
            if file.name == EXECUTABLE && spare_executable && fs::symlink_metadata(&to).is_ok() {
                spared = true;
                continue;
            }
            // The marker is last, so a spared executable always precedes it.
            if file.name == MARKER && spared {
                continue;
            }
            replace(&from, file.mode, &to)?;
        }
        Ok(if spared {
            Activation::ExecutableSpared
        } else {
            Activation::Complete
        })
    }

    /// Whether `destination` holds exactly the files of `source`, with their bytes and modes.
    /// Anything unreadable counts as not in sync.
    pub(crate) fn in_sync(source: &Path, destination: &Path) -> bool {
        let Ok(payload) = read_payload(source) else {
            return false;
        };
        let Ok(entries) = fs::read_dir(destination) else {
            return false;
        };
        entries.count() == payload.len()
            && payload.iter().all(|file| {
                matches(
                    &source.join(&file.name),
                    file.mode,
                    &destination.join(&file.name),
                )
                .unwrap_or(false)
            })
    }

    /// The regular files of `source` in replacement order: the others, then the executable,
    /// then the marker.
    fn read_payload(source: &Path) -> io::Result<Vec<Payload>> {
        let mut payload = Vec::new();
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{} is not a regular file", entry.path().display()),
                ));
            }
            payload.push(Payload {
                name: entry.file_name(),
                mode: mode_of(&metadata),
            });
        }
        payload.sort_by_key(|file| {
            (
                file.name == MARKER,
                file.name == EXECUTABLE,
                file.name.clone(),
            )
        });
        Ok(payload)
    }

    fn mode_of(metadata: &Metadata) -> u32 {
        metadata.permissions().mode() & 0o777
    }

    /// Removes what `destination` holds beyond `payload`, and what is in a payload file's way: a
    /// stale version's extra file, a temporary a killed run left, a directory or link.
    fn remove_strangers(destination: &Path, payload: &[Payload]) -> io::Result<()> {
        for entry in fs::read_dir(destination)? {
            let entry = entry?;
            let path = entry.path();
            let wanted = fs::symlink_metadata(&path)?.is_file()
                && payload.iter().any(|file| file.name == entry.file_name());
            if !wanted {
                private_fs::remove_existing(&path)?;
            }
        }
        Ok(())
    }

    /// Whether `to` is a regular file with the mode and the bytes of `from`.
    fn matches(from: &Path, mode: u32, to: &Path) -> io::Result<bool> {
        let metadata = match fs::symlink_metadata(to) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        if !metadata.is_file()
            || mode_of(&metadata) != mode
            || metadata.len() != fs::metadata(from)?.len()
        {
            return Ok(false);
        }
        Ok(measure_file(from)? == measure_file(to)?)
    }

    /// Copies `from` to a new file beside `to` with exactly `mode`, then renames it over `to`.
    fn replace(from: &Path, mode: u32, to: &Path) -> io::Result<()> {
        let mut input = File::open(from)?;
        let pending =
            PendingFile::create(private_fs::temporary_sibling(to), FileMode::Exact(mode))?;
        let mut output = pending.file();
        io::copy(&mut input, &mut output)?;
        pending.commit(to)
    }
}

#[cfg(unix)]
pub(crate) use unix::{in_sync, sync};

#[cfg(all(test, unix))]
mod tests;
