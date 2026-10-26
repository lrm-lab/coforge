//! `VersionStore::executables_to_stop` and `running_computer_path` on real directories.

use std::fs;

use super::*;
use crate::test_support::Scratch;

#[test]
fn the_executables_to_stop_are_the_running_one_and_each_existing_version_once() {
    let root = Scratch::new("store-stop-set");
    let posix = VersionStore::new(root.path(), "linux-x64");
    let windows = VersionStore::new(root.path(), "windows-x64");
    let place = |relative: &str, name: &str| {
        let directory = root.path().join(relative);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(name), "").unwrap();
    };
    place("versions/0.1.0", "coforge-computer");
    place("versions/0.2.0", "coforge-computer");
    place("versions/0.1.0", "coforge-computer.exe");

    // Without a `current/` yet, only the versions that exist; a repeated version once.
    assert_eq!(
        posix.executables_to_stop(["0.1.0", "0.2.0", "0.3.0", "0.1.0"]),
        [posix.computer_path("0.1.0"), posix.computer_path("0.2.0")]
    );
    place("current", "coforge-computer");
    assert_eq!(
        posix.executables_to_stop(["0.2.0"]),
        [
            posix.running_computer_path("0.2.0"),
            posix.computer_path("0.2.0")
        ]
    );
    // Windows runs from the version directory and has no `current/`.
    assert_eq!(
        windows.executables_to_stop(["0.1.0"]),
        [windows.running_computer_path("0.1.0")]
    );
    assert_eq!(
        windows.running_computer_path("0.1.0"),
        windows.computer_path("0.1.0")
    );
}
