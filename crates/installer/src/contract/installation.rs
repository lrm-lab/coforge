//! `active.json`, `installation.json`, and the launchers written into each version directory.

use serde::{Deserialize, Serialize};

use super::ArtifactIdentity;

/// `schema_version` of `active.json`.
pub const ACTIVE_STATE_SCHEMA_VERSION: u32 = 1;
/// `schema_version` of a newly written `installation.json`; 2 and 3 are still read.
pub const INSTALLED_IDENTITY_SCHEMA_VERSION: u32 = 4;

/// `<install root>/active.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveState {
    pub schema_version: u32,
    pub current: String,
    /// Always written, as `null` when there is no previous version.
    pub previous: Option<String>,
}

/// `versions/<version>/installation.json`. Schema 3 added `githubCli`, schema 4 `photonWasm`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledIdentity {
    pub schema_version: u32,
    pub version: String,
    pub computer: ArtifactIdentity,
    #[serde(rename = "agentCli")]
    pub agent_cli: ArtifactIdentity,
    #[serde(rename = "githubCli", default, skip_serializing_if = "Option::is_none")]
    pub github_cli: Option<ArtifactIdentity>,
    #[serde(
        rename = "photonWasm",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub photon_wasm: Option<ArtifactIdentity>,
}

/// One launcher file written into each version directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LauncherFile {
    pub file: String,
    pub contents: String,
}

/// The `coforge` and `gh` launchers of one platform family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Launchers {
    #[serde(rename = "agentCli")]
    pub agent_cli: LauncherFile,
    #[serde(rename = "githubCli")]
    pub github_cli: LauncherFile,
}

/// Windows launchers plus the `coforge-computer.cmd` PATH shim, rendered for an example root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowsLaunchers {
    #[serde(flatten)]
    pub launchers: Launchers,
    pub shim: WindowsShim,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowsShim {
    pub file: String,
    pub install_root: String,
    pub contents: String,
}

/// The version-local `coforge` launcher that runs the adjacent executable's Agent CLI.
pub fn agent_cli_launcher(windows: bool) -> &'static str {
    if windows {
        "@echo off\r\n\"%~dp0coforge-computer.exe\" __agent-cli %*\r\n"
    } else {
        "#!/bin/sh\nexec \"${0%/*}/coforge-computer\" __agent-cli \"$@\"\n"
    }
}

/// The version-local `gh` launcher that runs the adjacent executable's GitHub CLI bridge.
pub fn github_cli_launcher(windows: bool) -> &'static str {
    if windows {
        "@echo off\r\n\"%~dp0coforge-computer.exe\" __agent-cli github gh %*\r\n"
    } else {
        "#!/bin/sh\nexec \"${0%/*}/coforge-computer\" __agent-cli github gh \"$@\"\n"
    }
}

/// Windows' PATH shim `coforge-computer.cmd`: reads `active.json` on every run and starts that
/// version's executable. `install_root` is a Windows path without a trailing separator.
pub fn windows_computer_launcher(install_root: &str) -> String {
    let active_json = format!("{install_root}\\active.json").replace('\'', "''");
    [
        "@echo off".to_owned(),
        format!(
            "for /f \"usebackq tokens=*\" %%i in (`powershell -NoProfile -Command \"(Get-Content -Raw '{active_json}' | ConvertFrom-Json).current\"`) do set COFORGE_ACTIVE=%%i"
        ),
        format!("\"{install_root}\\versions\\%COFORGE_ACTIVE%\\coforge-computer.exe\" %*"),
        String::new(),
    ]
    .join("\r\n")
}

#[cfg(test)]
mod tests;
