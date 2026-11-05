//! The unit a person's own supervisor runs the Computer under, as `coforge-computer foreground`
//! recorded it in `<state>/supervisor.json` after systemd confirmed it (task #538). The installer
//! only reads it; an upgrade then stops and starts that unit and never registers another service.

use std::fs;
use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    User,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SupervisedUnit {
    pub scope: Scope,
    pub unit: String,
}

#[derive(Deserialize)]
struct Record {
    kind: String,
    scope: Scope,
    unit: String,
}

/// The recorded supervisor, or `None` when there is none or the record is not one this installer
/// understands (an unreadable record is never a reason to start a service of its own beside a
/// supervised one, but it is also not a unit to control).
pub fn read(state_directory: &Path) -> Option<SupervisedUnit> {
    let text = fs::read_to_string(state_directory.join("supervisor.json")).ok()?;
    let record: Record = serde_json::from_str(&text).ok()?;
    (record.kind == "systemd").then_some(SupervisedUnit {
        scope: record.scope,
        unit: record.unit,
    })
}

#[cfg(test)]
mod tests;
