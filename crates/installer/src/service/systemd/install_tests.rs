use std::fs;
use std::path::Path;

use super::*;
use crate::clock::VirtualClock;
use crate::service::coordinator_service;
use crate::service::fakes::{
    FixedCgroup, ScriptedRunner, Step, definition, exits, modified, ok, place_dated,
};
use crate::test_support::Scratch;

const RELOAD: &str = "systemctl --user daemon-reload";
const ENABLE: &str = "systemctl --user enable coforge-daemon.service";

fn unit_in(home: &Path) -> std::path::PathBuf {
    home.join(".config/systemd/user/coforge-daemon.service")
}

/// Installs `definition` for a user whose home is `home`, against `script`; returns the commands
/// run.
fn install(
    home: &Path,
    definition: &LifecycleServiceDefinition,
    script: Vec<Step>,
) -> (Result<Registered, ServiceError>, Vec<String>) {
    let runner = ScriptedRunner::new(script);
    let clock = VirtualClock::new();
    let result = SystemdUser::new(
        &runner,
        &clock,
        &coordinator_service(),
        &FixedCgroup(Some("")),
        home,
    )
    .unwrap()
    .install(definition);
    (result, runner.ran())
}

#[test]
fn installing_writes_the_unit_then_reloads_and_enables_without_starting() {
    let home = Scratch::new("systemd-install");
    let (result, ran) = install(
        home.path(),
        &definition("systemd-user", "[Service]\nExecStart=/x\n"),
        vec![ok(RELOAD, ""), ok(ENABLE, "")],
    );
    assert_eq!(result.unwrap(), Registered::Written);
    assert_eq!(ran, [RELOAD, ENABLE]);
    assert_eq!(
        fs::read_to_string(unit_in(home.path())).unwrap(),
        "[Service]\nExecStart=/x\n"
    );
}

#[test]
fn a_unit_that_already_holds_the_definition_is_left_alone_and_nothing_is_run() {
    let home = Scratch::new("systemd-install-identical");
    let unit = unit_in(home.path());
    let placed = place_dated(&unit, "[Service]\nExecStart=/x\n");
    let (result, ran) = install(
        home.path(),
        &definition("systemd-user", "[Service]\nExecStart=/x\n"),
        Vec::new(),
    );
    assert_eq!(result.unwrap(), Registered::AlreadyInPlace);
    assert!(ran.is_empty(), "{ran:?}");
    assert_eq!(modified(&unit), placed);
}

#[test]
fn a_unit_that_differs_is_rewritten_then_reloaded_and_enabled() {
    let home = Scratch::new("systemd-install-differs");
    let unit = unit_in(home.path());
    let placed = place_dated(&unit, "[Service]\nExecStart=/old\n");
    let (result, ran) = install(
        home.path(),
        &definition("systemd-user", "[Service]\nExecStart=/new\n"),
        vec![ok(RELOAD, ""), ok(ENABLE, "")],
    );
    assert_eq!(result.unwrap(), Registered::Written);
    assert_eq!(ran, [RELOAD, ENABLE]);
    assert_eq!(
        fs::read_to_string(&unit).unwrap(),
        "[Service]\nExecStart=/new\n"
    );
    assert_ne!(modified(&unit), placed);
}

#[cfg(unix)]
#[test]
fn the_unit_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let home = Scratch::new("systemd-install-mode");
    let (result, _) = install(
        home.path(),
        &definition("systemd-user", "[Service]\n"),
        vec![ok(RELOAD, ""), ok(ENABLE, "")],
    );
    result.unwrap();
    let mode = fs::metadata(unit_in(home.path()))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn a_definition_for_another_manager_is_refused_before_anything_is_written() {
    let home = Scratch::new("systemd-install-mismatch");
    let (result, ran) = install(home.path(), &definition("launchd", "<plist/>"), Vec::new());
    assert_eq!(
        result.unwrap_err(),
        ServiceError::DefinitionForOtherManager {
            expected: "systemd-user",
            found: "launchd".to_owned()
        }
    );
    assert!(ran.is_empty());
    assert!(!unit_in(home.path()).exists());
}

#[test]
fn a_failed_reload_is_refused_and_the_unit_is_not_enabled() {
    let home = Scratch::new("systemd-install-reload");
    let (result, ran) = install(
        home.path(),
        &definition("systemd-user", "[Service]\n"),
        vec![exits(RELOAD, 1, "Failed to reload daemon: Access denied\n")],
    );
    let message = result.unwrap_err().to_string();
    assert!(message.contains("Access denied"), "{message}");
    assert_eq!(ran, [RELOAD]);
}

#[test]
fn a_failed_enable_is_refused() {
    let home = Scratch::new("systemd-install-enable");
    let (result, _) = install(
        home.path(),
        &definition("systemd-user", "[Service]\n"),
        vec![ok(RELOAD, ""), exits(ENABLE, 1, "Failed to enable unit\n")],
    );
    let message = result.unwrap_err().to_string();
    assert!(message.contains("Failed to enable unit"), "{message}");
}

#[test]
fn no_user_session_is_named_as_it_is_for_every_other_command() {
    let home = Scratch::new("systemd-install-no-bus");
    let (result, _) = install(
        home.path(),
        &definition("systemd-user", "[Service]\n"),
        vec![exits(
            RELOAD,
            1,
            "Failed to connect to bus: No medium found\n",
        )],
    );
    assert!(matches!(
        result.unwrap_err(),
        ServiceError::NoSystemdUserSession { .. }
    ));
}
