use super::*;
use crate::contract::tests::{emit, golden};
use crate::contract::to_file_json;

#[test]
fn active_state_v1() {
    let active: ActiveState = golden("active.v1.json");
    assert_eq!(active.schema_version, ACTIVE_STATE_SCHEMA_VERSION);
    assert!(active.previous.is_some());
}

#[test]
fn installed_identity_v2_v3_v4() {
    let v2: InstalledIdentity = golden("installation.v2.json");
    assert_eq!(v2.schema_version, 2);
    assert!(v2.github_cli.is_none() && v2.photon_wasm.is_none());
    let v3: InstalledIdentity = golden("installation.v3.json");
    assert_eq!(v3.schema_version, 3);
    assert!(v3.github_cli.is_some() && v3.photon_wasm.is_none());
    let v4: InstalledIdentity = golden("installation.v4.json");
    assert_eq!(v4.schema_version, INSTALLED_IDENTITY_SCHEMA_VERSION);
    assert!(v4.github_cli.is_some() && v4.photon_wasm.is_some());
}

#[test]
fn launchers() {
    let posix: Launchers = golden("launchers.posix.json");
    assert_eq!(posix.agent_cli.file, "coforge");
    assert!(posix.agent_cli.contents.starts_with("#!/bin/sh\n"));
    let windows: WindowsLaunchers = golden("launchers.windows.json");
    assert_eq!(windows.launchers.agent_cli.file, "coforge.cmd");
    assert_eq!(windows.launchers.github_cli.file, "gh.cmd");
    // Byte for byte, CRLF included: what this crate would write is what the product writes.
    assert_eq!(posix.agent_cli.contents, agent_cli_launcher(false));
    assert_eq!(posix.github_cli.contents, github_cli_launcher(false));
    assert_eq!(
        windows.launchers.agent_cli.contents,
        agent_cli_launcher(true)
    );
    assert_eq!(
        windows.launchers.github_cli.contents,
        github_cli_launcher(true)
    );
    assert_eq!(windows.shim.file, "coforge-computer.cmd");
    assert_eq!(
        windows.shim.contents,
        windows_computer_launcher(&windows.shim.install_root)
    );
    for contents in [
        &windows.launchers.agent_cli.contents,
        &windows.launchers.github_cli.contents,
        &windows.shim.contents,
    ] {
        assert!(contents.ends_with("\r\n") && !contents.replace("\r\n", "").contains('\n'));
    }
}

fn identity(size: u64, byte: char) -> ArtifactIdentity {
    ArtifactIdentity {
        size,
        checksum: byte.to_string().repeat(64),
    }
}

#[test]
fn emits_installed_identity() {
    emit(
        "installation.v4.json",
        &to_file_json(&InstalledIdentity {
            schema_version: INSTALLED_IDENTITY_SCHEMA_VERSION,
            version: "0.2.0".into(),
            computer: identity(71_303_168, 'a'),
            agent_cli: identity(63, 'b'),
            github_cli: Some(identity(74, 'c')),
            photon_wasm: Some(identity(1_843_200, 'd')),
        }),
    );
}
