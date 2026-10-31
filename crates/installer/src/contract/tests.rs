use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

pub(super) const REQUEST_ID: &str = "0f8b6d5e-2a41-4c3b-9e7d-1a2b3c4d5e6f";

fn contract_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contract")
}

pub(super) fn read_text(name: &str) -> String {
    let path = contract_directory().join(name);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Reads a TypeScript golden, round-trips it, and checks that future fields are ignored.
pub(super) fn golden<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let original: Value = serde_json::from_str(&read_text(name))
        .unwrap_or_else(|error| panic!("{name} is not JSON: {error}"));
    let parsed: T = serde_json::from_value(original.clone())
        .unwrap_or_else(|error| panic!("{name} does not match its type: {error}"));
    assert_eq!(
        serde_json::to_value(&parsed).unwrap(),
        original,
        "{name} does not round-trip"
    );

    let mut extended = original;
    extended
        .as_object_mut()
        .unwrap_or_else(|| panic!("{name} is not a JSON object"))
        .insert("x_field_from_a_later_version".into(), Value::Bool(true));
    serde_json::from_value::<T>(extended)
        .unwrap_or_else(|error| panic!("{name} rejects an unknown field: {error}"));
    parsed
}

/// Writes installer output into `contract/rust/` for the TypeScript contract test.
pub(super) fn emit(name: &str, contents: &str) {
    let directory = contract_directory().join("rust");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(name), contents).unwrap();
}

#[test]
fn every_golden_is_covered_by_a_test() {
    let names: BTreeSet<String> = fs::read_dir(contract_directory())
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().unwrap().is_file())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.') && !name.ends_with(".schema.json"))
        .collect();
    let covered: BTreeSet<String> = [
        "active.v1.json",
        "feed-environments.json",
        "installation.v2.json",
        "installation.v3.json",
        "installation.v4.json",
        "installer-codes.json",
        "installer-manifest.v1.json",
        "launchers.posix.json",
        "launchers.windows.json",
        "lifecycle-codes.json",
        "lifecycle.error.json",
        "lifecycle.protocol.json",
        "lifecycle.service-definition.json",
        "lifecycle.status.absent.json",
        "lifecycle.status.running.json",
        "lock.json",
        "manifest.v2.json",
        "paths.json",
        "release-versions.json",
        "receipt-cases.json",
        "receipt.held.json",
        "receipt.rolled-back.json",
        "receipt.succeeded.json",
        "receipt.unresolved.json",
        "recovery-report.failed.json",
        "recovery-report.recovered.json",
        "service-identities.json",
        "supervisor-lock-owner.txt",
        "upgrade-error-codes.json",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(names, covered);
}

#[test]
fn json_schemas_are_draft_2020_12() {
    for entry in fs::read_dir(contract_directory()).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        if !name.ends_with(".schema.json") {
            continue;
        }
        let schema: Value = serde_json::from_str(&read_text(&name)).unwrap();
        assert_eq!(
            schema["$schema"], "https://json-schema.org/draft/2020-12/schema",
            "{name}"
        );
    }
}
