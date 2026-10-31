//! Windows: a scheduled task `CoForge Installer Settle` that runs `coforge-installer settle` once
//! at a time (`TimeTrigger`) and again at the next logon (`LogonTrigger`), registered from XML
//! the way the supervisor's own task is.

use std::path::Path;
use std::time::Duration;

use super::{CommandLine, CommandRunner, RetryTrigger, run, xml_text};
use crate::clock::Clock;
use crate::service::definition::TemporaryDefinition;

pub(super) const TASK: &str = "CoForge Installer Settle";

pub(super) struct WindowsSettle<'a> {
    runner: &'a dyn CommandRunner,
    clock: &'a dyn Clock,
    schtasks: String,
    installer: String,
    user: String,
}

impl<'a> WindowsSettle<'a> {
    pub(super) fn new(
        runner: &'a dyn CommandRunner,
        clock: &'a dyn Clock,
        system_root: &str,
        installer: &Path,
        user: &str,
    ) -> Self {
        Self {
            runner,
            clock,
            schtasks: format!(r"{system_root}\System32\schtasks.exe"),
            installer: installer.to_string_lossy().into_owned(),
            user: user.to_owned(),
        }
    }
}

/// `seconds` since the epoch as the UTC instant Task Scheduler reads (`2026-10-31T08:30:00Z`).
pub(super) fn instant(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// Task Scheduler 1.2 XML: a one-time trigger at `start` plus a logon trigger for the same user,
/// run as that interactive, least-privilege user — the shape `schtasks /Create /XML` accepts
/// without elevation (as the Coordinator's own task and the upgrade task register).
pub(super) fn task_xml(installer: &str, user: &str, start: &str) -> String {
    let user = xml_text(user);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n  \
<Triggers>\n    <TimeTrigger><StartBoundary>{start}</StartBoundary><Enabled>true</Enabled></TimeTrigger>\n    \
<LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger>\n  </Triggers>\n  \
<Principals>\n    <Principal id=\"Author\"><UserId>{user}</UserId>\
<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>\n  </Principals>\n  \
<Settings>\n    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n    \
<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n    \
<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n    <StartWhenAvailable>true</StartWhenAvailable>\n    \
<AllowStartOnDemand>true</AllowStartOnDemand>\n    \
<ExecutionTimeLimit>PT1H</ExecutionTimeLimit>\n  </Settings>\n  \
<Actions Context=\"Author\">\n    <Exec><Command>{}</Command><Arguments>settle</Arguments></Exec>\n  </Actions>\n</Task>\n",
        xml_text(installer)
    )
}

impl RetryTrigger for WindowsSettle<'_> {
    fn schedule(&self, delay: Duration) -> Result<(), String> {
        let start = instant(self.clock.unix_seconds() + delay.as_secs().max(1));
        let xml = TemporaryDefinition::utf16(
            &std::env::temp_dir(),
            &task_xml(&self.installer, &self.user, &start),
        )
        .map_err(|error| error.to_string())?;
        run(
            self.runner,
            &CommandLine::new(
                &self.schtasks,
                [
                    "/Create".to_owned(),
                    "/TN".to_owned(),
                    TASK.to_owned(),
                    "/XML".to_owned(),
                    xml.path().to_string_lossy().into_owned(),
                    "/F".to_owned(),
                ],
            ),
        )
    }

    fn cancel(&self) -> Result<(), String> {
        // No such task is the usual answer; nothing to do about any other.
        let _ = run(
            self.runner,
            &CommandLine::new(&self.schtasks, ["/Delete", "/TN", TASK, "/F"]),
        );
        Ok(())
    }
}
