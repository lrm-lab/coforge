//! The systemd backend (Linux): the user unit `coforge-daemon.service`, under `systemctl --user`.
//!
//! Ported from `SystemdUserDaemonHost` (packages/daemon/src/daemon-host/systemd-user.ts).
//! `systemctl stop` and `start` wait for their job, so there is no launchd-style race, but the
//! state is still read back: stopped is `inactive` or `failed`, started is `active` with a main
//! process. A start is preceded by `reset-failed`, as the Computer's own `restart` does.
//!
//! [`install`](SupervisorService::install) is the Computer's own registration
//! (`SystemdUserDaemonHost.ensureStarted`) without its start: the unit file under
//! `~/.config/systemd/user/`, `daemon-reload`, `enable`.
//!
//! `systemctl --user` needs this user's session bus, which a `su` or `sudo` shell never has. That
//! failure (2026-09-20) reads like nothing else, so it has its own error with the way out.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{
    Attempt, CommandLine, CommandRunner, Registered, ServiceError, ServiceState, StartOutcome,
    StopOutcome, SupervisorService, definition, execute,
};
use crate::clock::{Clock, poll_until};
use crate::contract::{CoordinatorService, LifecycleServiceDefinition};

const SYSTEMCTL: &str = "systemctl";

const COMMAND_BOUND: Duration = Duration::from_secs(30);
/// `systemctl stop` returns when the unit is down, and systemd's own `TimeoutStopSec` (90 s by
/// default) ends a unit that will not go. The bound is above it so systemd, not the installer,
/// has the last word on a slow stop.
const STOP_BOUND: Duration = Duration::from_secs(120);
/// After a `stop` that has already returned: the unit should be inactive at once.
const STOP_WAIT: Duration = Duration::from_secs(15);
const START_WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(50);

/// The calling process's cgroup listing (`/proc/self/cgroup` on Linux): the systemd unit a process
/// runs in appears in it as a path component.
pub trait ProcessCgroup {
    fn read(&self) -> io::Result<String>;
}

/// The listing of the process running this installer.
pub struct OwnCgroup;

impl ProcessCgroup for OwnCgroup {
    fn read(&self) -> io::Result<String> {
        read_own_listing()
    }
}

#[cfg(target_os = "linux")]
fn read_own_listing() -> io::Result<String> {
    std::fs::read_to_string("/proc/self/cgroup")
}

/// Off Linux there is no systemd unit to be inside, so the listing is empty.
#[cfg(not(target_os = "linux"))]
fn read_own_listing() -> io::Result<String> {
    Ok(String::new())
}

/// Whether a cgroup listing places the process in `unit`: some line's path has `unit` as a whole
/// component. Covers cgroup v2 (`0::/...`) and v1 (`N:name=systemd:/...`) lines alike.
pub(crate) fn cgroup_names_unit(listing: &str, unit: &str) -> bool {
    listing.lines().any(|line| {
        line.splitn(3, ':')
            .nth(2)
            .is_some_and(|path| path.split('/').any(|component| component == unit))
    })
}

/// What the caller's environment lacks for `systemctl --user` to find this user's session bus.
/// A provider-spawned shell can carry neither variable — an Agent's Codex shell on a Linux
/// host had no `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` (2026-10-29, s144) even though the
/// user bus was there — so when `/run/user/<uid>/bus` exists and is this user's, the backend
/// adds both itself. Anything else leaves `systemctl` to report its own failure.
pub trait UserSessionBus {
    /// `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` pairs to give a `systemctl` command, or none.
    fn environment(&self) -> Vec<(String, String)>;
}

/// The calling process's own bus probe: its environment, effective uid, and the filesystem.
pub struct OwnSessionBus;

impl UserSessionBus for OwnSessionBus {
    fn environment(&self) -> Vec<(String, String)> {
        detected_session_bus()
    }
}

/// The bus `/run/user/<uid>` provides when the environment names none. Pure decision for the
/// tests: `has_env` whether the caller already has a variable, `owns_bus` whether the socket
/// path exists and is `uid`'s.
#[cfg(any(target_os = "linux", test))]
fn session_bus_environment(
    has_env: impl Fn(&str) -> bool,
    uid: u32,
    owns_bus: impl Fn(&Path) -> bool,
) -> Vec<(String, String)> {
    // With either variable the environment already finds the bus; nothing is added.
    if has_env("XDG_RUNTIME_DIR") || has_env("DBUS_SESSION_BUS_ADDRESS") {
        return Vec::new();
    }
    // A Unix path, spelled with `/` whatever host this is compiled for: a `PathBuf` join would
    // write `\bus` into the address on Windows, where these tests also run.
    let directory = format!("/run/user/{uid}");
    let bus = format!("{directory}/bus");
    if !owns_bus(Path::new(&bus)) {
        return Vec::new();
    }
    vec![
        ("XDG_RUNTIME_DIR".to_owned(), directory),
        (
            "DBUS_SESSION_BUS_ADDRESS".to_owned(),
            format!("unix:path={bus}"),
        ),
    ]
}

#[cfg(target_os = "linux")]
fn detected_session_bus() -> Vec<(String, String)> {
    use std::os::unix::fs::MetadataExt;
    let uid = unsafe { libc::geteuid() };
    session_bus_environment(
        |name| std::env::var_os(name).is_some(),
        uid,
        |bus| bus.metadata().is_ok_and(|meta| meta.uid() == uid),
    )
}

/// Off Linux there is no user systemd to reach, so nothing is supplied.
#[cfg(not(target_os = "linux"))]
fn detected_session_bus() -> Vec<(String, String)> {
    Vec::new()
}

pub struct SystemdUser<'a> {
    runner: &'a dyn CommandRunner,
    clock: &'a dyn Clock,
    cgroup: &'a dyn ProcessCgroup,
    unit: String,
    /// `<home>/.config/systemd/user/<unit>`.
    unit_file: PathBuf,
    /// The session-bus variables `systemctl --user` gets when the caller's own environment
    /// lacks them (`UserSessionBus`); empty when nothing was supplied.
    bus_env: Vec<(String, String)>,
}

impl<'a> SystemdUser<'a> {
    /// The Coordinator's user unit for the user whose home directory is `home`.
    pub fn new(
        runner: &'a dyn CommandRunner,
        clock: &'a dyn Clock,
        service: &CoordinatorService,
        cgroup: &'a dyn ProcessCgroup,
        bus: &'a dyn UserSessionBus,
        home: &Path,
    ) -> Result<Self, ServiceError> {
        let unit = &service.systemd_user_unit;
        if !is_valid_unit_name(unit) {
            return Err(ServiceError::InvalidIdentity {
                what: "systemd user unit",
                value: unit.clone(),
            });
        }
        Ok(Self {
            runner,
            clock,
            cgroup,
            unit: unit.clone(),
            unit_file: home.join(".config").join("systemd").join("user").join(unit),
            bus_env: bus.environment(),
        })
    }

    /// One `systemctl` command with the session-bus environment, when there is one to add.
    fn line(&self, args: &[&str]) -> CommandLine {
        CommandLine::new(SYSTEMCTL, args.iter().copied()).with_env(self.bus_env.iter().cloned())
    }

    fn systemctl(&self, verb: &str, bound: Duration) -> Result<Attempt, ServiceError> {
        execute(self.runner, self.line(&["--user", verb, &self.unit]), bound)
    }

    /// What systemd says about the unit, in one read-only call.
    fn read(&self) -> Result<Unit, ServiceError> {
        let attempt = execute(
            self.runner,
            self.line(&[
                "--user",
                "show",
                &self.unit,
                "--property=LoadState",
                "--property=ActiveState",
                "--property=SubState",
                "--property=MainPID",
            ]),
            COMMAND_BOUND,
        )?;
        if !attempt.succeeded() {
            return Err(self.refused(&attempt));
        }
        parse_unit(&attempt)
    }

    /// systemd's refusal, turned into what a person should do next. Ported from `systemctlFailure`
    /// and `systemctlRemedy` (systemd-user.ts).
    fn refused(&self, attempt: &Attempt) -> ServiceError {
        let diagnostic = attempt.diagnostic();
        let lowered = diagnostic.to_lowercase();
        // The first three are older systemd releases' wording (the Computer's own hosts match the
        // first two); systemd 257 says the fourth, measured 2026-09-30.
        if [
            "failed to connect to bus",
            "no medium found",
            "failed to get d-bus connection",
            "failed to connect to user scope bus",
        ]
        .iter()
        .any(|needle| lowered.contains(needle))
        {
            return ServiceError::NoSystemdUserSession {
                command: attempt.command_text(),
                diagnostic,
            };
        }
        if ["not loaded", "not found", "no such unit"]
            .iter()
            .any(|needle| lowered.contains(needle))
        {
            return ServiceError::NotInstalled {
                service: self.unit.clone(),
            };
        }
        ServiceError::CommandFailed {
            command: attempt.command_text(),
            code: attempt.code(),
            diagnostic,
            hint: format!(
                "Check `systemctl --user status {}` for the unit's own account of it.",
                self.unit
            ),
        }
    }

    fn status_hint(&self) -> String {
        format!(
            "Check `systemctl --user status {}` and `journalctl --user -u {} -n 50` for the \
             unit's own account of it.",
            self.unit, self.unit
        )
    }
}

impl SupervisorService for SystemdUser<'_> {
    fn display_name(&self) -> String {
        self.unit.clone()
    }

    fn caller_is_inside_unit(&self) -> Result<bool, ServiceError> {
        let listing = self
            .cgroup
            .read()
            .map_err(|error| ServiceError::FileUnreadable {
                path: "/proc/self/cgroup".to_owned(),
                detail: error.to_string(),
            })?;
        Ok(cgroup_names_unit(&listing, &self.unit))
    }

    fn state(&self) -> Result<ServiceState, ServiceError> {
        Ok(self.read()?.state())
    }

    fn stop(&self) -> Result<StopOutcome, ServiceError> {
        let unit = self.read()?;
        let before = unit.state();
        // Stopped is `inactive` or `failed`; anything else, including a unit waiting out its
        // restart delay, has a job to cancel.
        if !matches!(before, ServiceState::Running { .. }) {
            return Ok(StopOutcome { before });
        }
        let stop = self.systemctl("stop", STOP_BOUND)?;
        if !stop.succeeded() {
            return Err(self.refused(&stop));
        }
        let mut observed = String::new();
        let down = poll_until(self.clock, STOP_WAIT, POLL, || {
            let unit = self.read()?;
            if matches!(unit.state(), ServiceState::Running { .. }) {
                observed = unit.describe();
                Ok(None)
            } else {
                Ok(Some(()))
            }
        })?;
        match down {
            Some(()) => Ok(StopOutcome { before }),
            None => Err(ServiceError::StopTimedOut {
                service: self.unit.clone(),
                waited: STOP_WAIT,
                observed,
                hint: self.status_hint(),
            }),
        }
    }

    fn install(&self, definition: &LifecycleServiceDefinition) -> Result<Registered, ServiceError> {
        definition::require_manager("systemd-user", definition)?;
        // A unit file that already holds the definition is the registration: the Computer wrote
        // it with its own reload and enable, so neither is repeated, and a `systemctl --user
        // disable` a person ran since stays theirs. `daemon-reload` and `enable` do not restart
        // a running unit.
        if definition::is_in_place(&self.unit_file, &definition.contents) {
            return Ok(Registered::AlreadyInPlace);
        }
        definition::write_private(&self.unit_file, &definition.contents)?;
        let reload = execute(
            self.runner,
            self.line(&["--user", "daemon-reload"]),
            COMMAND_BOUND,
        )?;
        if !reload.succeeded() {
            return Err(self.refused(&reload));
        }
        let enable = self.systemctl("enable", COMMAND_BOUND)?;
        if !enable.succeeded() {
            return Err(self.refused(&enable));
        }
        Ok(Registered::Written)
    }

    fn start(&self) -> Result<StartOutcome, ServiceError> {
        let unit = self.read()?;
        if unit.load_state == "not-found" {
            return Err(ServiceError::NotInstalled {
                service: self.unit.clone(),
            });
        }
        if unit.is_up() {
            return Ok(StartOutcome { pid: unit.main_pid });
        }
        // As the Computer's own `restart` does (systemd-user.ts:93-97): a unit that hit its start
        // limit refuses `start` until its failed state is cleared. Usually there is nothing to
        // clear, so the answer is ignored, whatever it is.
        let _ = self.systemctl("reset-failed", COMMAND_BOUND);
        let start = self.systemctl("start", COMMAND_BOUND)?;
        if !start.succeeded() {
            return Err(self.refused(&start));
        }
        let mut observed = String::new();
        let started = poll_until(self.clock, START_WAIT, POLL, || {
            let unit = self.read()?;
            if unit.is_up() {
                return Ok(Some(StartOutcome { pid: unit.main_pid }));
            }
            observed = unit.describe();
            Ok(None)
        })?;
        started.ok_or_else(|| ServiceError::StartTimedOut {
            service: self.unit.clone(),
            waited: START_WAIT,
            observed,
            hint: self.status_hint(),
        })
    }
}

/// The properties of a unit, from `systemctl show`.
#[derive(Debug)]
struct Unit {
    load_state: String,
    active_state: String,
    sub_state: String,
    main_pid: Option<u32>,
}

impl Unit {
    fn state(&self) -> ServiceState {
        if self.load_state == "not-found" {
            ServiceState::NotInstalled
        } else if matches!(self.active_state.as_str(), "inactive" | "failed") {
            ServiceState::Stopped
        } else {
            ServiceState::Running { pid: self.main_pid }
        }
    }

    /// The unit is up: active, with a main process.
    fn is_up(&self) -> bool {
        self.active_state == "active" && self.main_pid.is_some()
    }

    fn describe(&self) -> String {
        format!(
            "systemd reports LoadState={}, ActiveState={}, SubState={}",
            self.load_state, self.active_state, self.sub_state
        )
    }
}

fn parse_unit(attempt: &Attempt) -> Result<Unit, ServiceError> {
    let mut load_state = None;
    let mut active_state = None;
    let mut sub_state = String::new();
    let mut main_pid = None;
    for line in attempt.output.stdout.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key {
            "LoadState" => load_state = Some(value.to_owned()),
            "ActiveState" => active_state = Some(value.to_owned()),
            "SubState" => sub_state = value.to_owned(),
            "MainPID" => main_pid = value.parse::<u32>().ok().filter(|pid| *pid > 0),
            _ => {}
        }
    }
    match (load_state, active_state) {
        (Some(load_state), Some(active_state)) => Ok(Unit {
            load_state,
            active_state,
            sub_state,
            main_pid,
        }),
        _ => Err(ServiceError::UnexpectedOutput {
            command: attempt.command_text(),
            output: attempt.output.stdout.clone(),
        }),
    }
}

/// A `.service` unit name systemd accepts and the shell cannot misread
/// (`isValidServiceName`, systemd-user.ts).
fn is_valid_unit_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".service") else {
        return false;
    };
    name.len() <= 255
        && stem
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '@' | ':' | '-'))
}

#[cfg(test)]
mod install_tests;
#[cfg(test)]
mod tests;
