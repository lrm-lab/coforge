use std::fs;
use std::path::Path;
use std::time::Duration;

use super::*;
use crate::clock::{VirtualClock, WALL_ORIGIN};
use crate::service::fakes::{ScriptedBus, ScriptedRunner, exits, ok};
use crate::test_support::Scratch;

const INSTALLER: &str = "/home/u/.coforge/computer/bin/coforge-installer";

#[test]
fn launchd_bootstraps_a_minute_job_only_when_launchd_does_not_have_it() {
    let home = Scratch::new("retry-launchd");
    let target = "gui/501/cn.coforge.installer.settle";
    let runner = ScriptedRunner::new(vec![
        ok(&format!("/bin/launchctl enable {target}"), ""),
        exits(
            &format!("/bin/launchctl print {target}"),
            113,
            "Could not find service",
        ),
        ok(
            &format!(
                "/bin/launchctl bootstrap gui/501 {}/Library/LaunchAgents/cn.coforge.installer.settle.plist",
                home.path().display()
            ),
            "",
        ),
        ok(&format!("/bin/launchctl enable {target}"), ""),
        ok(&format!("/bin/launchctl print {target}"), "state = running"),
    ]);
    let trigger = launchd::LaunchdSettle::new(&runner, home.path(), 501, Path::new(INSTALLER));

    trigger.schedule(Duration::from_secs(60)).unwrap();
    // An already-loaded job needs nothing: no bootout and no bootstrap, so a `settle` the job
    // itself fired can re-arm without killing itself.
    trigger.schedule(Duration::from_secs(300)).unwrap();

    let plist = fs::read_to_string(
        home.path()
            .join("Library/LaunchAgents/cn.coforge.installer.settle.plist"),
    )
    .unwrap();
    assert!(plist.contains("<key>StartInterval</key><integer>60</integer>"));
    assert!(plist.contains(&format!(
        "<string>{INSTALLER}</string><string>settle</string>"
    )));
    assert!(!plist.contains("KeepAlive"));
    assert!(!plist.contains("RunAtLoad"));
}

#[test]
fn launchd_reports_a_bootstrap_launchctl_refused() {
    let home = Scratch::new("retry-launchd-refused");
    let target = "gui/501/cn.coforge.installer.settle";
    let runner = ScriptedRunner::new(vec![
        ok(&format!("/bin/launchctl enable {target}"), ""),
        exits(
            &format!("/bin/launchctl print {target}"),
            113,
            "Could not find service",
        ),
        exits(
            &format!(
                "/bin/launchctl bootstrap gui/501 {}/Library/LaunchAgents/cn.coforge.installer.settle.plist",
                home.path().display()
            ),
            5,
            "Bootstrap failed: 5: Input/output error",
        ),
    ]);
    let trigger = launchd::LaunchdSettle::new(&runner, home.path(), 501, Path::new(INSTALLER));

    let error = trigger.schedule(Duration::from_secs(60)).unwrap_err();

    assert!(error.contains("Input/output error"));
}

#[test]
fn launchd_cancel_disables_then_removes_the_file_and_boots_the_job_out_twice() {
    let home = Scratch::new("retry-launchd-cancel");
    let plist = home
        .path()
        .join("Library/LaunchAgents/cn.coforge.installer.settle.plist");
    fs::create_dir_all(plist.parent().unwrap()).unwrap();
    fs::write(&plist, "x").unwrap();
    let target = "gui/501/cn.coforge.installer.settle";
    let runner = ScriptedRunner::new(vec![
        ok(&format!("/bin/launchctl disable {target}"), ""),
        ok(&format!("/bin/launchctl bootout {target}"), ""),
        exits(
            &format!("/bin/launchctl disable {target}"),
            113,
            "Could not find",
        ),
        exits(
            &format!("/bin/launchctl bootout {target}"),
            113,
            "Could not find",
        ),
    ]);
    let trigger = launchd::LaunchdSettle::new(&runner, home.path(), 501, Path::new(INSTALLER));

    // Disable comes first so a `settle` the job itself fired is not killed mid-cancel; errors
    // after it are not errors.
    trigger.cancel().unwrap();
    trigger.cancel().unwrap();

    assert!(!plist.exists());
}

#[test]
fn systemd_writes_a_timer_and_a_oneshot_service_enables_the_timer_and_restarts_it() {
    let home = Scratch::new("retry-systemd");
    let runner = ScriptedRunner::new(vec![
        ok("systemctl --user daemon-reload", ""),
        ok("systemctl --user enable coforge-installer-settle.timer", ""),
        ok(
            "systemctl --user restart coforge-installer-settle.timer",
            "",
        ),
    ]);
    let trigger = systemd::SystemdSettle::new(
        &runner,
        home.path(),
        Path::new(INSTALLER),
        &ScriptedBus(&[]),
    );

    trigger.schedule(Duration::from_secs(900)).unwrap();

    let directory = home.path().join(".config/systemd/user");
    let timer = fs::read_to_string(directory.join("coforge-installer-settle.timer")).unwrap();
    assert!(timer.contains("OnActiveSec=900"));
    assert!(timer.contains("OnBootSec=120"));
    assert!(timer.contains("WantedBy=timers.target"));
    let service = fs::read_to_string(directory.join("coforge-installer-settle.service")).unwrap();
    assert!(service.contains("Type=oneshot"));
    assert!(service.contains(&format!("ExecStart=\"{INSTALLER}\" settle")));
}

#[test]
fn systemd_cancel_disables_the_timer_and_removes_both_units() {
    let home = Scratch::new("retry-systemd-cancel");
    let directory = home.path().join(".config/systemd/user");
    fs::create_dir_all(&directory).unwrap();
    for name in [
        "coforge-installer-settle.timer",
        "coforge-installer-settle.service",
    ] {
        fs::write(directory.join(name), "x").unwrap();
    }
    let runner = ScriptedRunner::new(vec![
        ok(
            "systemctl --user disable --now coforge-installer-settle.timer",
            "",
        ),
        ok("systemctl --user daemon-reload", ""),
    ]);
    let trigger = systemd::SystemdSettle::new(
        &runner,
        home.path(),
        Path::new(INSTALLER),
        &ScriptedBus(&[]),
    );

    trigger.cancel().unwrap();

    assert!(fs::read_dir(&directory).unwrap().next().is_none());
}

#[test]
fn systemd_commands_carry_the_session_bus_the_environment_lacks() {
    let home = Scratch::new("retry-systemd-bus");
    let runner = ScriptedRunner::new(vec![
        ok(
            "XDG_RUNTIME_DIR=/run/user/501 \
             DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/501/bus \
             systemctl --user daemon-reload",
            "",
        ),
        ok(
            "XDG_RUNTIME_DIR=/run/user/501 \
             DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/501/bus \
             systemctl --user enable coforge-installer-settle.timer",
            "",
        ),
        ok(
            "XDG_RUNTIME_DIR=/run/user/501 \
             DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/501/bus \
             systemctl --user restart coforge-installer-settle.timer",
            "",
        ),
    ]);
    let trigger = systemd::SystemdSettle::new(
        &runner,
        home.path(),
        Path::new(INSTALLER),
        &ScriptedBus(&[
            ("XDG_RUNTIME_DIR", "/run/user/501"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/501/bus"),
        ]),
    );

    trigger.schedule(Duration::from_secs(60)).unwrap();
}

#[test]
fn systemd_cancel_twice_is_not_an_error() {
    let home = Scratch::new("retry-systemd-cancel-twice");
    let runner = ScriptedRunner::new(vec![
        exits(
            "systemctl --user disable --now coforge-installer-settle.timer",
            1,
            "Failed to disable unit",
        ),
        ok("systemctl --user daemon-reload", ""),
        ok(
            "systemctl --user disable --now coforge-installer-settle.timer",
            "",
        ),
        ok("systemctl --user daemon-reload", ""),
    ]);
    let trigger = systemd::SystemdSettle::new(
        &runner,
        home.path(),
        Path::new(INSTALLER),
        &ScriptedBus(&[]),
    );

    trigger.cancel().unwrap();
    trigger.cancel().unwrap();
}

#[test]
fn windows_registers_a_task_that_starts_at_the_time_asked_for_and_at_logon() {
    let clock = VirtualClock::new();
    let command = |verb: &str| format!(r"C:\Windows\System32\schtasks.exe {verb}");
    let runner = ScriptedRunner::new(vec![ok(
        &command("/Delete /TN \"CoForge Installer Settle\" /F"),
        "",
    )]);
    let trigger = windows::WindowsSettle::new(
        &runner,
        &clock,
        r"C:\Windows",
        Path::new(r"C:\Users\u\bin\coforge-installer.exe"),
        r"DESKTOP-1\u",
    );

    trigger.cancel().unwrap();

    let xml = windows::task_xml(
        r"C:\Users\u\bin\coforge-installer.exe",
        r"DESKTOP-1\u",
        "2027-01-15T08:00:00Z",
    );
    assert!(xml.contains("<StartBoundary>2027-01-15T08:00:00Z</StartBoundary>"));
    assert!(xml.contains("<LogonTrigger><Enabled>true</Enabled><UserId>DESKTOP-1\\u</UserId>"));
    assert!(xml.contains("<UserId>DESKTOP-1\\u</UserId><LogonType>InteractiveToken</LogonType>"));
    assert!(xml.contains("<Arguments>settle</Arguments>"));
    assert!(xml.contains("<StartWhenAvailable>true</StartWhenAvailable>"));
}

#[test]
fn for_platform_gives_each_manager_its_trigger() {
    let home = Scratch::new("retry-dispatch");
    let runner = ScriptedRunner::new(vec![]);
    let clock = VirtualClock::new();
    let installer = Path::new(INSTALLER);
    // Windows also reads USERNAME from the environment, which a POSIX host does not have.
    for platform in [Platform::Darwin, Platform::Linux] {
        for_platform(platform, home.path(), Some(501), installer, &runner, &clock).unwrap();
    }
}

#[test]
fn the_task_user_is_domain_backslash_user_or_the_bare_name() {
    let env = |name: &str| match name {
        "USERDOMAIN" => Some("DESKTOP-1".to_owned()),
        "USERNAME" => Some("u".to_owned()),
        _ => None,
    };
    assert_eq!(task_user(env).unwrap(), r"DESKTOP-1\u");
    assert_eq!(
        task_user(|name| (name == "USERNAME").then(|| "u".to_owned())).unwrap(),
        "u"
    );
    assert!(task_user(|_| None).is_err());
}

#[test]
fn instants_are_utc_iso_times() {
    assert_eq!(windows::instant(0), "1970-01-01T00:00:00Z");
    assert_eq!(windows::instant(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(windows::instant(WALL_ORIGIN), "2027-01-15T08:00:00Z");
    assert_eq!(
        windows::instant(WALL_ORIGIN + 3_661),
        "2027-01-15T09:01:01Z"
    );
}

#[test]
fn xml_text_is_escaped() {
    assert_eq!(xml_text("a&b<c>"), "a&amp;b&lt;c&gt;");
}
