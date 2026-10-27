use super::*;
use crate::contract::tests::golden;

#[test]
fn lifecycle_responses() {
    let protocol: LifecycleProtocol = golden("lifecycle.protocol.json");
    assert_eq!(protocol.lifecycle_protocol, LIFECYCLE_PROTOCOL);
    let running: LifecycleStatus = golden("lifecycle.status.running.json");
    assert!(running.supervisor.running && running.supervisor.id.is_some());
    assert!(
        running
            .bindings
            .iter()
            .any(|binding| binding.process_id.is_some())
    );
    assert!(running.healthy && running.problems.is_empty());
    let absent: LifecycleStatus = golden("lifecycle.status.absent.json");
    assert!(!absent.supervisor.running && absent.supervisor.id.is_none());
    assert!(!absent.healthy && !absent.problems.is_empty());
    let codes: LifecycleCodes = golden("lifecycle-codes.json");
    assert_eq!(
        absent.problems[0].code,
        codes.problem_codes["SUPERVISOR_NOT_RUNNING"]
    );
    assert!(
        absent
            .bindings
            .iter()
            .all(|binding| binding.process_id.is_none())
    );
    let error: LifecycleError = golden("lifecycle.error.json");
    assert!(!error.ok);
    assert_eq!(error.code, codes.error_codes["FAILED"]);
}

#[test]
fn lifecycle_codes() {
    let codes: LifecycleCodes = golden("lifecycle-codes.json");
    assert_eq!(codes.exit_codes["OK"], 0);
    assert_eq!(codes.exit_codes["FAILED"], 1);
    assert_eq!(codes.exit_codes["USAGE"], 2);
    assert_eq!(codes.error_codes["USAGE"], "LIFECYCLE_USAGE");
}

#[test]
fn the_service_definition_is_read() {
    let definition: LifecycleServiceDefinition = golden("lifecycle.service-definition.json");
    assert_eq!(definition.lifecycle_protocol, LIFECYCLE_PROTOCOL);
    assert_eq!(definition.manager, "launchd");
    assert!(definition.contents.starts_with("<?xml"));
    let protocol: LifecycleProtocol = golden("lifecycle.protocol.json");
    assert!(
        protocol
            .commands
            .is_some_and(|commands| commands.iter().any(|name| name == "service-definition"))
    );
}
