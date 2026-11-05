use std::fs;

use super::*;
use crate::test_support::Scratch;

fn record(dir: &Scratch, text: &str) {
    fs::write(dir.path().join("supervisor.json"), text).unwrap();
}

#[test]
fn a_recorded_systemd_unit_is_read() {
    let dir = Scratch::new("supervised");
    record(
        &dir,
        r#"{"kind":"systemd","scope":"user","unit":"mine.service","invocationId":"i","pid":7,"recordedAt":"t"}"#,
    );
    assert_eq!(
        read(dir.path()),
        Some(SupervisedUnit {
            scope: Scope::User,
            unit: "mine.service".to_owned()
        })
    );
}

#[test]
fn no_record_or_a_record_of_another_kind_is_none() {
    let dir = Scratch::new("supervised-none");
    assert_eq!(read(dir.path()), None);
    record(
        &dir,
        r#"{"kind":"launchd","scope":"user","unit":"x.service"}"#,
    );
    assert_eq!(read(dir.path()), None);
    record(&dir, "not json");
    assert_eq!(read(dir.path()), None);
    record(
        &dir,
        r#"{"kind":"systemd","scope":"galaxy","unit":"x.service"}"#,
    );
    assert_eq!(read(dir.path()), None);
}
