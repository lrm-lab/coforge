use std::fs;
use std::io::{self, ErrorKind};
use std::os::unix::fs::symlink;
use std::path::Path;

use crate::contract::agent_cli_launcher;
use crate::digest::measure_file;

const CLI: &str = "coforge";
const STANDALONE_RELEASES: &str = include_str!("standalone-cli-identities.txt");

enum Shim {
    Missing,
    LegacyCopy,
    LeaveAsIs,
}

pub(super) fn sync(active: &Path, bin: &Path) -> io::Result<()> {
    let target = active.join(CLI);
    if !target.is_file() {
        return Ok(());
    }
    let path = bin.join(CLI);
    match inspect(&path)? {
        Shim::Missing => match symlink(target, path) {
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(()),
            result => result,
        },
        Shim::LegacyCopy => super::replace_symlink(&target, &path),
        Shim::LeaveAsIs => Ok(()),
    }
}

pub(super) fn is_ready(active: &Path, bin: &Path) -> bool {
    !active.join(CLI).is_file() || matches!(inspect(&bin.join(CLI)), Ok(Shim::LeaveAsIs))
}

fn inspect(path: &Path) -> io::Result<Shim> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && is_legacy_copy(path, metadata.len()) => {
            Ok(Shim::LegacyCopy)
        }
        Ok(_) => Ok(Shim::LeaveAsIs),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Shim::Missing),
        Err(error) => Err(error),
    }
}

fn is_legacy_copy(path: &Path, size: u64) -> bool {
    let launcher = agent_cli_launcher(false).as_bytes();
    if size == launcher.len() as u64 {
        return fs::read(path).is_ok_and(|bytes| bytes == launcher);
    }

    let size = size.to_string();
    let mut checksums = STANDALONE_RELEASES.lines().filter_map(|line| {
        let (identity, _) = line.split_once(' ')?;
        let (release_size, checksum) = identity.split_once(':')?;
        (release_size == size).then_some(checksum)
    });
    let Some(first) = checksums.next() else {
        return false;
    };
    measure_file(path).is_ok_and(|identity| {
        identity.checksum == first || checksums.any(|checksum| identity.checksum == checksum)
    })
}
