//! The active version: which installed version is selected, and how it is exposed.
//!
//! `<install root>/active.json` names the current and the previous version. On POSIX targets the
//! version's payload is then copied into `<install root>/current/` ([`crate::current`]), where
//! `<install root>/active` points for good, and the `coforge-computer` shim on the user's PATH
//! points through `active`: switching versions replaces files in `current/` and rewrites no link,
//! so the executable keeps one real path. On Windows `active` is a junction to
//! `versions/<current>` and the `.cmd` shim reads `active.json`. `active.json` is the
//! Computer's `#readJson("active.json")` / `#writeJsonAtomic` (packages/computer/src/updater.ts)
//! and is written with the same bytes.
//!
//! Activation trusts its caller: the version's installed bytes must already have been verified
//! (another module's job), and its directory must exist.

use std::fmt;
use std::fs;
use std::io;
use std::path::Path;

use serde::Deserialize;

use crate::contract::{
    ACTIVE_STATE_SCHEMA_VERSION, ActiveState, to_file_json, windows_computer_launcher,
};
#[cfg(unix)]
use crate::current;
pub use crate::current::Activation;
use crate::private_fs::{self, FileMode};
use crate::store::VersionStore;
use crate::version::is_valid_release_version;

/// The state file, relative to the install root.
pub const ACTIVE_FILE: &str = "active.json";

/// The link, relative to the install root: `current` on POSIX, a junction to `versions/<current>`
/// on Windows.
const ACTIVE_LINK: &str = "active";

/// The PATH shim's file name on Windows, where a symlink needs privileges the user may lack.
const WINDOWS_SHIM_FILE: &str = "coforge-computer.cmd";

/// The error code for an `active.json` (or a state to write) that names no valid version.
pub const INVALID_ACTIVE_ERROR_CODE: &str = "UPDATE_FEED_INVALID";

#[derive(Debug)]
pub enum ActiveError {
    /// `active.json` is not JSON, not the `active.json` schema, or names a version that is not a
    /// safe release version (which would otherwise become part of a path).
    Invalid,
    /// A file or link could not be read or replaced.
    Io(io::Error),
}

impl ActiveError {
    /// The Computer's `UpdateError` code, the only kind a receipt carries. A file-system failure
    /// has none, as in the Computer.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Invalid => Some(INVALID_ACTIVE_ERROR_CODE),
            Self::Io(_) => None,
        }
    }
}

impl fmt::Display for ActiveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("active version is invalid"),
            Self::Io(error) => write!(
                formatter,
                "the active version could not be read or switched: {error}"
            ),
        }
    }
}

impl From<io::Error> for ActiveError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// `active.json` as read: `previous` is whatever JSON was written there.
#[derive(Deserialize)]
struct StoredActiveState {
    schema_version: u32,
    current: String,
    #[serde(default)]
    previous: serde_json::Value,
}

/// The state in `<install_root>/active.json`: `None` before the first install. A file that is
/// not the schema, or whose `current` is not a valid version, is `ActiveError::Invalid`; one that
/// cannot be read is `Io`. A `previous` that is not a valid version string reads as `None`, as
/// the Computer's rollback treats an invalid one ("nothing to roll back to"); it must not stop a
/// forward upgrade either. Its writer only ever stores a version string or `null`.
pub fn read_active(install_root: &Path) -> Result<Option<ActiveState>, ActiveError> {
    let bytes = match fs::read(install_root.join(ACTIVE_FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let stored: StoredActiveState =
        serde_json::from_slice(&bytes).map_err(|_| ActiveError::Invalid)?;
    if stored.schema_version != ACTIVE_STATE_SCHEMA_VERSION
        || !is_valid_release_version(&stored.current)
    {
        return Err(ActiveError::Invalid);
    }
    let previous = match stored.previous {
        serde_json::Value::String(previous) if is_valid_release_version(&previous) => {
            Some(previous)
        }
        _ => None,
    };
    Ok(Some(ActiveState {
        schema_version: stored.schema_version,
        current: stored.current,
        previous,
    }))
}

/// Replaces `<install_root>/active.json` atomically (a temporary file beside it, renamed over
/// it), creating the install root owner-only when missing. A state that names an invalid
/// `current` or `previous` is refused here, before anything is written: both become paths.
pub fn write_active_state(install_root: &Path, state: &ActiveState) -> Result<(), ActiveError> {
    validate(state)?;
    private_fs::create_private_directories(install_root)?;
    private_fs::replace_file(
        &install_root.join(ACTIVE_FILE),
        to_file_json(state).as_bytes(),
        FileMode::Umask(0o600),
    )?;
    Ok(())
}

/// Makes `state.current` the active version: writes `active.json`, then exposes the version, in
/// that order. The shim directory is created 0755 when missing. A `windows-*` target gets a
/// junction to the version and a `.cmd` shim. Any other target gets `current/` synced from the
/// version, `active` -> `current` when it points anywhere else (an install from before `current/`
/// points at the version), and a symlink shim through `active`.
///
/// If a step fails, `active.json` already names the new version, as it does after a crash between
/// the steps; running `activate` again finishes the switch. The caller stops the product's
/// processes first: `current/` is replaced under the executable's path. A caller that cannot
/// (repair) passes `spare_executable`: a `current/coforge-computer` that differs from the
/// version's is then left alone, with the `version` marker, and the result says so.
///
/// The POSIX links are each replaced by a rename, so a reader never sees one missing. Windows
/// cannot rename over a junction: there `active` is briefly absent between removing the old
/// junction and renaming the new one into place, and nothing is replaced in place.
pub fn activate(
    store: &VersionStore,
    binary_directory: &Path,
    state: &ActiveState,
    spare_executable: bool,
) -> Result<Activation, ActiveError> {
    let install_root = store.install_root();
    write_active_state(install_root, state)?;
    // 0755, not the owner-only mode used below `~/.coforge`: the shim directory is a shared
    // conventional location (`~/.local/bin`) that other tools install into, and a recursive
    // create would otherwise leave `~/.local` itself owner-only for every one of them.
    private_fs::create_directories(binary_directory, 0o755)?;
    let version_directory = store.version_directory(&state.current);
    if store.targets_windows() {
        write_windows_launcher(install_root, binary_directory)?;
        switch_junction(install_root, &version_directory)?;
        Ok(Activation::Complete)
    } else {
        Ok(switch_posix_links(
            install_root,
            binary_directory,
            &version_directory,
            spare_executable,
        )?)
    }
}

/// Whether `version`, which must be installed and verified, is fully activated: `active`, the
/// PATH shim, and on POSIX the `current/` copy it points at, which must equal the version's files
/// (its `version` marker then names it). An install from before `current/`, an `active` an older
/// installer re-pointed at a version, and a half-finished or damaged sync are all not activated.
pub fn is_activated(store: &VersionStore, binary_directory: &Path, version: &str) -> bool {
    let install_root = store.install_root();
    let version_directory = store.version_directory(version);
    if store.targets_windows() {
        // A junction reads back as its absolute target, never a relative path a Unix symlink
        // stores, so compare where both resolve to.
        let junction = fs::canonicalize(install_root.join(ACTIVE_LINK));
        let version = fs::canonicalize(&version_directory);
        matches!((junction, version), (Ok(junction), Ok(version)) if junction == version)
            && binary_directory.join(WINDOWS_SHIM_FILE).is_file()
    } else {
        posix_is_activated(install_root, binary_directory, &version_directory)
    }
}

fn validate(state: &ActiveState) -> Result<(), ActiveError> {
    let valid = state.schema_version == ACTIVE_STATE_SCHEMA_VERSION
        && is_valid_release_version(&state.current)
        && state
            .previous
            .as_deref()
            .is_none_or(is_valid_release_version);
    if valid {
        Ok(())
    } else {
        Err(ActiveError::Invalid)
    }
}

/// `current/` <- the version directory; `active` -> `current` (relative, so the installation can
/// move as a whole); the shim -> `<install root>/active/coforge-computer` (absolute: it lives in
/// another directory). `active` is replaced only when it points anywhere else.
#[cfg(unix)]
fn switch_posix_links(
    install_root: &Path,
    binary_directory: &Path,
    version_directory: &Path,
    spare_executable: bool,
) -> io::Result<Activation> {
    let activation = current::sync(
        version_directory,
        &current::directory(install_root),
        spare_executable,
    )?;
    let active = install_root.join(ACTIVE_LINK);
    if !points_at_current(&active) {
        replace_symlink(Path::new(current::DIRECTORY), &active)?;
    }
    replace_symlink(
        &active.join(current::EXECUTABLE),
        &binary_directory.join(current::EXECUTABLE),
    )?;
    Ok(activation)
}

#[cfg(not(unix))]
fn switch_posix_links(_: &Path, _: &Path, _: &Path, _: bool) -> io::Result<Activation> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "symlink activation is for POSIX targets",
    ))
}

#[cfg(unix)]
fn points_at_current(active: &Path) -> bool {
    fs::read_link(active).ok().as_deref() == Some(Path::new(current::DIRECTORY))
}

#[cfg(unix)]
fn posix_is_activated(
    install_root: &Path,
    binary_directory: &Path,
    version_directory: &Path,
) -> bool {
    let active = install_root.join(ACTIVE_LINK);
    points_at_current(&active)
        && current::in_sync(version_directory, &current::directory(install_root))
        && fs::read_link(binary_directory.join(current::EXECUTABLE))
            .ok()
            .as_deref()
            == Some(active.join(current::EXECUTABLE).as_path())
}

#[cfg(not(unix))]
fn posix_is_activated(_: &Path, _: &Path, _: &Path) -> bool {
    false
}

/// Points `link` at `target` by creating a symlink beside it and renaming it into place, which
/// replaces an existing symlink in one step.
#[cfg(unix)]
fn replace_symlink(target: &Path, link: &Path) -> io::Result<()> {
    let temporary = private_fs::temporary_sibling(link);
    std::os::unix::fs::symlink(target, &temporary)?;
    fs::rename(&temporary, link).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

/// Windows' PATH shim, `coforge-computer.cmd`: it reads `active.json` on every run, so switching
/// versions never rewrites it, but an installation moved to another root needs it rewritten.
fn write_windows_launcher(install_root: &Path, binary_directory: &Path) -> io::Result<()> {
    let root = install_root.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the install root is not valid Unicode, so a .cmd shim cannot name it",
        )
    })?;
    let launcher = windows_computer_launcher(root.trim_end_matches(['\\', '/']));
    private_fs::replace_file(
        &binary_directory.join(WINDOWS_SHIM_FILE),
        launcher.as_bytes(),
        FileMode::Umask(0o700),
    )
}

/// Makes `active` a junction to the version directory. A junction needs no
/// elevation (a symlink does) and, unlike a symlink, must name an absolute path. The new junction
/// is created under a temporary name first, so a failure to create it leaves the old one alone.
fn switch_junction(install_root: &Path, version_directory: &Path) -> io::Result<()> {
    let active = install_root.join(ACTIVE_LINK);
    let temporary = private_fs::temporary_sibling(&active);
    // The crate creates the directory, then makes it a junction; the second step can fail.
    create_junction(version_directory, &temporary)
        .inspect_err(|error| remove_what_creation_left(&temporary, error))?;
    private_fs::remove_existing(&active)
        .and_then(|()| fs::rename(&temporary, &active))
        .inspect_err(|_| {
            let _ = private_fs::remove_existing(&temporary);
        })
}

/// Removes what a failed creation left at `path`, unless it failed because something was already
/// there: that is not ours to remove.
fn remove_what_creation_left(path: &Path, error: &io::Error) {
    if error.kind() != io::ErrorKind::AlreadyExists {
        let _ = private_fs::remove_existing(path);
    }
}

#[cfg(windows)]
fn create_junction(target: &Path, junction: &Path) -> io::Result<()> {
    ::junction::create(target, junction)
}

#[cfg(not(windows))]
fn create_junction(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "junctions exist only on Windows",
    ))
}

#[cfg(test)]
mod tests;
