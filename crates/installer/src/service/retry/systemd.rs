//! Linux: a user timer `coforge-installer-settle.timer` that starts the oneshot service
//! `coforge-installer-settle.service` (`coforge-installer settle`). The timer is enabled, so a
//! reboot or a new login arms it again (`OnBootSec`), and `OnActiveSec` is the delay asked for.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{CommandLine, CommandRunner, RetryTrigger, run};
use crate::service::definition::write_private;
use crate::service::systemd::UserSessionBus;

pub(super) const UNIT: &str = "coforge-installer-settle";
const SYSTEMCTL: &str = "systemctl";
/// How long after a boot or login the first try is made.
const AFTER_BOOT: Duration = Duration::from_secs(120);

pub(super) struct SystemdSettle<'a> {
    runner: &'a dyn CommandRunner,
    directory: PathBuf,
    installer: PathBuf,
    /// The session-bus variables `systemctl --user` gets when the caller's own environment
    /// lacks them (`UserSessionBus`); empty when nothing was supplied.
    bus_env: Vec<(String, String)>,
}

impl<'a> SystemdSettle<'a> {
    pub(super) fn new(
        runner: &'a dyn CommandRunner,
        home: &Path,
        installer: &Path,
        bus: &dyn UserSessionBus,
    ) -> Self {
        Self {
            runner,
            directory: home.join(".config/systemd/user"),
            installer: installer.to_path_buf(),
            bus_env: bus.environment(),
        }
    }

    fn systemctl(&self, args: &[&str]) -> Result<(), String> {
        let mut line = vec!["--user".to_owned()];
        line.extend(args.iter().map(|arg| (*arg).to_owned()));
        run(
            self.runner,
            &CommandLine::new(SYSTEMCTL, line).with_env(self.bus_env.iter().cloned()),
        )
    }
}

pub(super) fn service_unit(installer: &Path) -> String {
    let executable = installer
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!(
        "[Unit]\nDescription=CoForge installer: settle an unfinished upgrade\n\n\
[Service]\nType=oneshot\nExecStart=\"{executable}\" settle\n"
    )
}

pub(super) fn timer_unit(delay: Duration) -> String {
    format!(
        "[Unit]\nDescription=CoForge installer: settle an unfinished upgrade, again\n\n\
[Timer]\nOnBootSec={}\nOnActiveSec={}\nAccuracySec=1s\n\n[Install]\nWantedBy=timers.target\n",
        AFTER_BOOT.as_secs(),
        delay.as_secs().max(1)
    )
}

impl RetryTrigger for SystemdSettle<'_> {
    fn schedule(&self, delay: Duration) -> Result<(), String> {
        write_private(
            &self.directory.join(format!("{UNIT}.service")),
            &service_unit(&self.installer),
        )
        .and_then(|()| {
            write_private(
                &self.directory.join(format!("{UNIT}.timer")),
                &timer_unit(delay),
            )
        })
        .map_err(|error| error.to_string())?;
        let timer = format!("{UNIT}.timer");
        self.systemctl(&["daemon-reload"])?;
        self.systemctl(&["enable", &timer])?;
        // A restart starts the delay again, which `start` on an active timer would not.
        self.systemctl(&["restart", &timer])
    }

    fn cancel(&self) -> Result<(), String> {
        let timer = format!("{UNIT}.timer");
        // Not enabled is the usual answer; nothing to do about any other.
        let _ = self.systemctl(&["disable", "--now", &timer]);
        for extension in ["timer", "service"] {
            match fs::remove_file(self.directory.join(format!("{UNIT}.{extension}"))) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        let _ = self.systemctl(&["daemon-reload"]);
        Ok(())
    }
}
