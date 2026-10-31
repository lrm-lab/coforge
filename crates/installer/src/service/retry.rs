//! The trigger that runs `coforge-installer settle` again, per service manager: a LaunchAgent
//! that fires every minute (macOS), a user timer (Linux), a scheduled task (Windows). It exists
//! only while an upgrade is left unfinished; [`crate::auto_recover`] arms it and takes it away.
//!
//! None of them restarts the supervisor: they only run the installer, which settles the journal
//! (and starts the service when that is what the journal asks for). `settle` arms the next one
//! itself when it fails, and each also fires after a reboot or a new login, so a machine that was
//! off at the time is still settled. They are installer-private: no other program reads their
//! names.

use std::path::Path;
use std::time::Duration;

use super::{CommandLine, CommandRunner, ServiceError, execute};
use crate::clock::Clock;
use crate::paths::Platform;
use crate::retry_trigger::RetryTrigger;

mod launchd;
mod systemd;
mod windows;

const COMMAND_BOUND: Duration = Duration::from_secs(30);

/// The trigger for `platform`'s service manager. `installer` is the executable to run.
pub fn for_platform<'a>(
    platform: Platform,
    home: &Path,
    uid: Option<u32>,
    installer: &Path,
    runner: &'a dyn CommandRunner,
    clock: &'a dyn Clock,
) -> Result<Box<dyn RetryTrigger + 'a>, ServiceError> {
    Ok(match platform {
        Platform::Darwin => {
            let uid = uid.ok_or_else(|| ServiceError::InvalidIdentity {
                what: "user id",
                value: "none".to_owned(),
            })?;
            Box::new(launchd::LaunchdSettle::new(runner, home, uid, installer))
        }
        Platform::Linux => Box::new(systemd::SystemdSettle::new(
            runner,
            home,
            installer,
            &super::OwnSessionBus,
        )),
        Platform::Windows => {
            let system_root =
                std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_owned());
            Box::new(windows::WindowsSettle::new(
                runner,
                clock,
                &system_root,
                installer,
                &task_user(|name| std::env::var(name).ok())?,
            ))
        }
    })
}

/// `DOMAIN\user` for the scheduled task's principal: both variables when they are there (as the
/// Computer's `windowsTaskUserId` resolves it), the bare user name otherwise. `env` reads the
/// process environment.
fn task_user(env: impl Fn(&str) -> Option<String>) -> Result<String, ServiceError> {
    let domain = env("USERDOMAIN").unwrap_or_default();
    let domain = domain.trim();
    let user = env("USERNAME").unwrap_or_default();
    let user = user.trim();
    match (domain.is_empty(), user.is_empty()) {
        (false, false) => Ok(format!(r"{domain}\{user}")),
        (_, false) => Ok(user.to_owned()),
        _ => Err(ServiceError::InvalidIdentity {
            what: "user name",
            value: "none".to_owned(),
        }),
    }
}

/// Runs `command`, turning a command that could not run, or that failed, into the error text the
/// trigger reports.
fn run(runner: &dyn CommandRunner, command: &CommandLine) -> Result<(), String> {
    let attempt = execute(runner, command.clone(), COMMAND_BOUND).map_err(|e| e.to_string())?;
    if attempt.succeeded() {
        Ok(())
    } else {
        Err(format!(
            "`{command}` failed ({}): {}",
            attempt.output.code,
            attempt.diagnostic()
        ))
    }
}

/// Text that is safe inside an XML element.
fn xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests;
