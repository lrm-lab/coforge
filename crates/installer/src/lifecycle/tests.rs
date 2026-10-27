#[cfg(unix)]
use std::fs;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

use super::*;
use crate::service::SystemRunner;
use crate::test_support::Scratch;
use crate::upgrade::fakes::{
    FakeLifecycle, protocol, protocol_with_service_definition, service_definition,
};

#[cfg(unix)]
fn golden(name: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("contract")
            .join(name),
    )
    .unwrap()
}

/// Runs the calling test again in a process of its own, and returns `false` in the test process.
/// A test that writes a script and then executes it cannot share a process with tests that spawn
/// children: a child forked while the script is still open for writing holds that descriptor until
/// it execs, and executing the script meanwhile fails with ETXTBSY ("Text file busy").
#[cfg(unix)]
fn isolated(test: &str) -> bool {
    crate::test_support::in_child(&format!("lifecycle::tests::{test}"), ":")
}

/// A stand-in `coforge-computer` that answers `__lifecycle <command>` with `stdout` and `code`.
#[cfg(unix)]
fn computer(scratch: &Scratch, command: &str, stdout: &str, code: i32) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = scratch.path().join("coforge-computer");
    let body = stdout.replace('\'', "'\\''");
    fs::write(
        &path,
        format!(
            "#!/bin/sh\n[ \"$1\" = __lifecycle ] && [ \"$2\" = {command} ] && [ $# -eq 2 ] || exit 64\nprintf '%s\\n' '{body}'\nexit {code}\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(unix)]
#[test]
fn the_status_of_a_running_computer_is_read() {
    if !isolated("the_status_of_a_running_computer_is_read") {
        return;
    }
    let scratch = Scratch::new("lifecycle-status");
    let computer = computer(
        &scratch,
        "status",
        &golden("lifecycle.status.running.json"),
        0,
    );
    let status = Lifecycle::new(&SystemRunner).status(&computer).unwrap();
    assert_eq!(status.version, "0.1.0");
    assert!(status.supervisor.running);
    assert_eq!(status.supervisor.id.as_deref(), Some("supervisor_example"));
    assert_eq!(status.bindings.len(), 2);
    assert!(status.healthy);
}

#[cfg(unix)]
#[test]
fn the_protocol_names_the_version_of_the_executable() {
    if !isolated("the_protocol_names_the_version_of_the_executable") {
        return;
    }
    let scratch = Scratch::new("lifecycle-protocol");
    let computer = computer(&scratch, "protocol", &golden("lifecycle.protocol.json"), 0);
    let protocol = Lifecycle::new(&SystemRunner).protocol(&computer).unwrap();
    assert_eq!(protocol.version, "0.2.0");
}

#[cfg(unix)]
#[test]
fn the_service_definition_of_a_computer_is_read() {
    if !isolated("the_service_definition_of_a_computer_is_read") {
        return;
    }
    let scratch = Scratch::new("lifecycle-service-definition");
    let computer = computer(
        &scratch,
        "service-definition",
        &golden("lifecycle.service-definition.json"),
        0,
    );
    let definition = Lifecycle::new(&SystemRunner)
        .service_definition(&computer)
        .unwrap();
    assert_eq!(definition.manager, "launchd");
    assert!(definition.contents.contains("cn.coforge.computer.daemon"));
}

#[test]
fn only_a_protocol_listing_the_command_gets_its_service_definition_asked() {
    let computer = Path::new("/install/current/coforge-computer");
    let reported = |protocol: Option<LifecycleProtocol>| {
        let lifecycle = FakeLifecycle::default();
        lifecycle.answers_protocol(computer, vec![protocol]);
        lifecycle.answers_service_definition(computer, vec![Some(service_definition("0.2.0"))]);
        reported_service_definition(&lifecycle, computer)
    };
    assert_eq!(
        reported(Some(protocol_with_service_definition("0.2.0"))).unwrap(),
        Some(service_definition("0.2.0"))
    );
    assert_eq!(reported(Some(protocol("0.2.0"))).unwrap(), None);
    let without = LifecycleProtocol {
        commands: Some(vec!["protocol".to_owned(), "status".to_owned()]),
        ..protocol("0.2.0")
    };
    assert_eq!(reported(Some(without)).unwrap(), None);
    assert!(reported(None).is_err());
}

#[test]
fn a_protocol_that_was_already_read_is_not_asked_for_again() {
    let computer = Path::new("/install/current/coforge-computer");
    // The protocol is answered once: a second `protocol` call would fail.
    let lifecycle = FakeLifecycle::default();
    lifecycle.answers_protocol(
        computer,
        vec![Some(protocol_with_service_definition("0.2.0")), None],
    );
    lifecycle.answers_service_definition(computer, vec![Some(service_definition("0.2.0"))]);
    let read = lifecycle.protocol(computer).unwrap();

    assert_eq!(
        service_definition_if_listed(&lifecycle, computer, &read).unwrap(),
        Some(service_definition("0.2.0"))
    );
    assert_eq!(
        service_definition_if_listed(&lifecycle, computer, &protocol("0.2.0")).unwrap(),
        None
    );
    assert!(lifecycle.protocol(computer).is_err());
}

#[cfg(unix)]
#[test]
fn a_failed_call_carries_the_computers_own_message() {
    if !isolated("a_failed_call_carries_the_computers_own_message") {
        return;
    }
    let scratch = Scratch::new("lifecycle-failed");
    let computer = computer(&scratch, "status", &golden("lifecycle.error.json"), 1);
    let error = Lifecycle::new(&SystemRunner).status(&computer).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("invalid process identity"), "{message}");
    assert!(message.contains("__lifecycle status"), "{message}");
}

#[cfg(unix)]
#[test]
fn another_lifecycle_protocol_is_refused() {
    if !isolated("another_lifecycle_protocol_is_refused") {
        return;
    }
    let scratch = Scratch::new("lifecycle-version");
    let computer = computer(
        &scratch,
        "protocol",
        r#"{"lifecycle_protocol":2,"answer":{"version":"0.2.0"}}"#,
        0,
    );
    let error = Lifecycle::new(&SystemRunner)
        .protocol(&computer)
        .unwrap_err();
    assert!(
        matches!(error, LifecycleFailure::Protocol { found: 2, .. }),
        "{error:?}"
    );
}

#[cfg(unix)]
#[test]
fn output_that_is_not_the_contract_is_unreadable() {
    if !isolated("output_that_is_not_the_contract_is_unreadable") {
        return;
    }
    let scratch = Scratch::new("lifecycle-garbage");
    let computer = computer(&scratch, "status", "Usage: coforge-computer [command]", 0);
    let error = Lifecycle::new(&SystemRunner).status(&computer).unwrap_err();
    assert!(
        matches!(error, LifecycleFailure::Unreadable { .. }),
        "{error:?}"
    );
}

#[test]
fn an_executable_that_is_not_there_cannot_be_asked() {
    let scratch = Scratch::new("lifecycle-missing");
    let error = Lifecycle::new(&SystemRunner)
        .protocol(&scratch.path().join("coforge-computer"))
        .unwrap_err();
    assert!(
        matches!(error, LifecycleFailure::NotRun { .. }),
        "{error:?}"
    );
}
