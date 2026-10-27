use std::fs;
use std::path::PathBuf;

use super::*;
use crate::clock::VirtualClock;
use crate::service::coordinator_service;
use crate::service::fakes::ScriptedRunner;
use crate::test_support::Scratch;

fn definition(manager: &str, contents: &str) -> LifecycleServiceDefinition {
    LifecycleServiceDefinition {
        lifecycle_protocol: 1,
        version: "0.2.0".to_owned(),
        manager: manager.to_owned(),
        contents: contents.to_owned(),
    }
}

fn plist_in(home: &Scratch) -> PathBuf {
    home.path()
        .join("Library")
        .join("LaunchAgents")
        .join("cn.coforge.computer.daemon.plist")
}

/// Installs `definition` for a user whose home is `home`. The runner has an empty script: any
/// `launchctl` call fails the test, because installing only writes the plist.
fn install(home: &Scratch, definition: &LifecycleServiceDefinition) -> Result<(), ServiceError> {
    let runner = ScriptedRunner::new(Vec::new());
    let clock = VirtualClock::new();
    Launchd::new(&runner, &clock, &coordinator_service(), home.path(), 501)
        .unwrap()
        .install(definition)
}

#[test]
fn installing_writes_the_plist_and_runs_nothing() {
    let home = Scratch::new("launchd-install");
    install(&home, &definition("launchd", "<plist>new</plist>")).unwrap();
    assert_eq!(
        fs::read_to_string(plist_in(&home)).unwrap(),
        "<plist>new</plist>"
    );
}

#[cfg(unix)]
#[test]
fn the_plist_is_owner_only_and_replaces_an_earlier_one_without_leftovers() {
    use std::os::unix::fs::PermissionsExt;
    let home = Scratch::new("launchd-install-replace");
    let plist = plist_in(&home);
    fs::create_dir_all(plist.parent().unwrap()).unwrap();
    fs::write(&plist, "<plist>old</plist>").unwrap();
    install(&home, &definition("launchd", "<plist>new</plist>")).unwrap();
    assert_eq!(fs::read_to_string(&plist).unwrap(), "<plist>new</plist>");
    assert_eq!(
        fs::metadata(&plist).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(fs::read_dir(plist.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn a_definition_for_another_manager_is_refused_and_nothing_is_written() {
    let home = Scratch::new("launchd-install-mismatch");
    let error = install(&home, &definition("systemd-user", "[Unit]")).unwrap_err();
    assert_eq!(
        error,
        ServiceError::DefinitionForOtherManager {
            expected: "launchd",
            found: "systemd-user".to_owned()
        }
    );
    assert!(!plist_in(&home).exists());
}

#[test]
fn a_plist_that_cannot_be_written_is_named() {
    let home = Scratch::new("launchd-install-unwritable");
    // `Library` is a file, so `Library/LaunchAgents` cannot be created.
    fs::write(home.path().join("Library"), "").unwrap();
    let error = install(&home, &definition("launchd", "<plist/>")).unwrap_err();
    assert!(
        matches!(error, ServiceError::DefinitionNotWritten { .. }),
        "{error:?}"
    );
    assert!(error.to_string().contains("LaunchAgents"), "{error}");
}
