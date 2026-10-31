//! macOS: a LaunchAgent `cn.coforge.installer.settle` that runs `coforge-installer settle` every
//! [`INTERVAL`] until it is disabled and booted out. The interval never changes: the real delay
//! lives in `recovery-state.json`, which `settle` checks before it does anything, so a fire that
//! comes early costs one quiet no-op run.
//!
//! `bootout` is never part of arming: the `settle` this job fires is usually the caller of
//! `schedule`, and booting out a job SIGTERMs its process — the caller dies before it can finish
//! (the same reason `cleanupComputerUpgradeJob` in the Computer tolerates bootout failures of its
//! own job). Cancelling disables first, which stops future fires without killing the run that is
//! asking, and only then boots the job out.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{CommandLine, CommandRunner, RetryTrigger, run, xml_text};
use crate::service::definition::write_private;

pub(super) const LABEL: &str = "cn.coforge.installer.settle";
const LAUNCHCTL: &str = "/bin/launchctl";
/// How often the job fires: the shortest wait the backoff ever asks for.
const INTERVAL: Duration = Duration::from_secs(60);

pub(super) struct LaunchdSettle<'a> {
    runner: &'a dyn CommandRunner,
    plist: PathBuf,
    domain: String,
    installer: PathBuf,
}

impl<'a> LaunchdSettle<'a> {
    pub(super) fn new(
        runner: &'a dyn CommandRunner,
        home: &Path,
        uid: u32,
        installer: &Path,
    ) -> Self {
        Self {
            runner,
            plist: home
                .join("Library/LaunchAgents")
                .join(format!("{LABEL}.plist")),
            domain: format!("gui/{uid}"),
            installer: installer.to_path_buf(),
        }
    }

    fn target(&self) -> String {
        format!("{}/{LABEL}", self.domain)
    }

    fn launchctl(&self, args: &[String]) -> Result<(), String> {
        run(
            self.runner,
            &CommandLine::new(LAUNCHCTL, args.iter().cloned()),
        )
    }
}

pub(super) fn plist(installer: &Path) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n\
<dict>\n  <key>Label</key><string>{LABEL}</string>\n  \
<key>ProgramArguments</key>\n  <array><string>{}</string><string>settle</string></array>\n  \
<key>StartInterval</key><integer>{}</integer>\n  \
<key>ProcessType</key><string>Background</string>\n</dict>\n</plist>\n",
        xml_text(&installer.to_string_lossy()),
        INTERVAL.as_secs()
    )
}

impl RetryTrigger for LaunchdSettle<'_> {
    /// `delay` is honoured by `recovery-state.json`, not the job: the job fires every
    /// [`INTERVAL`] and a fire before its time does nothing. Arming writes the plist, undoes any
    /// `disable` a cancel left, and bootstraps only when launchd does not already have the job —
    /// a job that is already firing needs nothing changed.
    fn schedule(&self, _delay: Duration) -> Result<(), String> {
        write_private(&self.plist, &plist(&self.installer)).map_err(|e| e.to_string())?;
        // A cancel may have left the job disabled; `enable` also succeeds when there is no job.
        let _ = self.launchctl(&["enable".to_owned(), self.target()]);
        if self.launchctl(&["print".to_owned(), self.target()]).is_ok() {
            return Ok(());
        }
        self.launchctl(&[
            "bootstrap".to_owned(),
            self.domain.clone(),
            self.plist.to_string_lossy().into_owned(),
        ])
    }

    /// Stops future fires first (`disable` never kills the run that is asking), then removes the
    /// plist and asks for the job itself; a `bootout` that fails or kills the caller leaves a
    /// disabled job that cannot fire again either way.
    fn cancel(&self) -> Result<(), String> {
        let _ = self.launchctl(&["disable".to_owned(), self.target()]);
        match fs::remove_file(&self.plist) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        let _ = self.launchctl(&["bootout".to_owned(), self.target()]);
        Ok(())
    }
}
