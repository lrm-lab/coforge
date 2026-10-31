use super::*;
use crate::contract::tests::{REQUEST_ID, emit, golden};
use crate::contract::to_file_json;

#[test]
fn recovery_reports() {
    let recovered: RecoveryReport = golden("recovery-report.recovered.json");
    assert_eq!(recovered.schema_version, RECOVERY_REPORT_SCHEMA_VERSION);
    assert_eq!(recovered.request_id.as_deref(), Some(REQUEST_ID));
    assert_eq!(recovered.outcome, RecoveryOutcome::Recovered);
    assert_eq!(recovered.restored_version.as_deref(), Some("0.1.0"));
    assert_eq!(recovered.attempts, 3);
    assert!(recovered.message.is_none());

    let failed: RecoveryReport = golden("recovery-report.failed.json");
    assert_eq!(failed.outcome, RecoveryOutcome::Failed);
    assert!(failed.restored_version.is_none());
    assert_eq!(failed.attempts, 8);
    assert!(failed.message.is_some());
}

#[test]
fn emits_recovery_reports() {
    for (name, report) in [
        (
            "recovered",
            RecoveryReport {
                schema_version: RECOVERY_REPORT_SCHEMA_VERSION,
                request_id: Some(REQUEST_ID.to_owned()),
                outcome: RecoveryOutcome::Recovered,
                restored_version: Some("0.1.0".to_owned()),
                attempts: 3,
                finished_at: 1_759_200_000,
                message: None,
            },
        ),
        (
            "failed",
            RecoveryReport {
                schema_version: RECOVERY_REPORT_SCHEMA_VERSION,
                request_id: Some(REQUEST_ID.to_owned()),
                outcome: RecoveryOutcome::Failed,
                restored_version: None,
                attempts: 8,
                finished_at: 1_759_200_000,
                message: Some("0.1.0 could not be verified".to_owned()),
            },
        ),
    ] {
        emit(
            &format!("recovery-report.{name}.json"),
            &to_file_json(&report),
        );
    }
}
