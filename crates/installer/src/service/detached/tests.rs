use std::cell::RefCell;
use std::fs;

use super::*;
use crate::clock::VirtualClock;
use crate::processes::fakes::{FakeTable, Signal};
use crate::service::fakes::definition;
use crate::test_support::Scratch;

const SPEC: &str =
    r#"{"program":"/install/coforge-computer","args":["foreground"],"env":{"COFORGE_HOME":"/h"}}"#;

/// Starts a fake process in `table` and answers its pid; records what it was asked to run.
struct FakeSpawn<'a> {
    table: &'a FakeTable<'a>,
    pid: u32,
    started: RefCell<Vec<(Spec, PathBuf)>>,
    fails: bool,
}

impl Spawn for FakeSpawn<'_> {
    fn spawn(&self, spec: &Spec, log: &Path) -> io::Result<u32> {
        if self.fails {
            return Err(io::Error::other("no such program"));
        }
        self.started
            .borrow_mut()
            .push((spec.clone(), log.to_owned()));
        self.table.spawn(self.pid, 900, &spec.program);
        Ok(self.pid)
    }
}

struct World {
    state: Scratch,
    clock: VirtualClock,
}

fn world() -> World {
    World {
        state: Scratch::new("detached"),
        clock: VirtualClock::new(),
    }
}

fn detached<'a>(w: &'a World, table: &'a FakeTable<'a>, spawn: &'a FakeSpawn<'a>) -> Detached<'a> {
    Detached::new(w.state.path(), table, &w.clock, spawn)
}

fn spawner<'a>(table: &'a FakeTable<'a>, fails: bool) -> FakeSpawn<'a> {
    FakeSpawn {
        table,
        pid: 4000,
        started: RefCell::new(Vec::new()),
        fails,
    }
}

#[test]
fn nothing_is_installed_until_a_definition_is_registered() {
    let w = world();
    let table = FakeTable::new(&w.clock);
    let spawn = spawner(&table, false);
    let service = detached(&w, &table, &spawn);
    assert_eq!(service.state().unwrap(), ServiceState::NotInstalled);
    assert!(matches!(
        service.start(),
        Err(ServiceError::NotInstalled { .. })
    ));
}

#[test]
fn install_writes_the_spec_once_and_refuses_another_manager() {
    let w = world();
    let table = FakeTable::new(&w.clock);
    let spawn = spawner(&table, false);
    let service = detached(&w, &table, &spawn);
    let def = definition("detached", SPEC);
    assert_eq!(service.install(&def).unwrap(), Registered::Written);
    assert_eq!(service.install(&def).unwrap(), Registered::AlreadyInPlace);
    assert_eq!(
        fs::read_to_string(w.state.path().join(SPEC_FILE)).unwrap(),
        SPEC
    );
    assert_eq!(service.state().unwrap(), ServiceState::Stopped);
    assert!(matches!(
        service.install(&definition("systemd-user", SPEC)),
        Err(ServiceError::DefinitionForOtherManager { .. })
    ));
}

#[test]
fn a_spec_may_not_carry_a_credential() {
    let w = world();
    let table = FakeTable::new(&w.clock);
    let spawn = spawner(&table, false);
    let service = detached(&w, &table, &spawn);
    for name in [
        "COFORGE_DAEMON_API_KEY",
        "login_token",
        "Secret",
        "DB_PASSWORD",
    ] {
        let spec = format!(r#"{{"program":"/p","env":{{"{name}":"x"}}}}"#);
        assert!(
            matches!(
                service.install(&definition("detached", &spec)),
                Err(ServiceError::DefinitionNotWritten { .. })
            ),
            "{name} must be refused"
        );
    }
    assert!(!w.state.path().join(SPEC_FILE).exists());
}

#[test]
fn start_runs_the_spec_detached_into_the_log_and_records_the_identity() {
    let w = world();
    let table = FakeTable::new(&w.clock);
    let spawn = spawner(&table, false);
    let service = detached(&w, &table, &spawn);
    service.install(&definition("detached", SPEC)).unwrap();
    assert_eq!(service.start().unwrap(), StartOutcome { pid: Some(4000) });
    let started = spawn.started.borrow();
    assert_eq!(started[0].0.args, ["foreground"]);
    assert_eq!(started[0].1, w.state.path().join(LOG_FILE));
    assert_eq!(
        fs::read_to_string(w.state.path().join(PID_FILE)).unwrap(),
        "4000 900"
    );
    assert_eq!(
        service.state().unwrap(),
        ServiceState::Running { pid: Some(4000) }
    );
}

#[test]
fn a_running_service_is_not_started_twice() {
    let w = world();
    let table = FakeTable::new(&w.clock);
    let spawn = spawner(&table, false);
    let service = detached(&w, &table, &spawn);
    service.install(&definition("detached", SPEC)).unwrap();
    service.start().unwrap();
    service.start().unwrap();
    assert_eq!(spawn.started.borrow().len(), 1);
}

#[test]
fn a_reused_pid_or_a_dead_process_is_stopped_not_running() {
    let w = world();
    let table = FakeTable::new(&w.clock);
    let spawn = spawner(&table, false);
    let service = detached(&w, &table, &spawn);
    service.install(&definition("detached", SPEC)).unwrap();
    service.start().unwrap();
    table.reuse_pid(4000, 31337, "/usr/bin/other");
    assert_eq!(service.state().unwrap(), ServiceState::Stopped);
    table.vanish(4000);
    assert_eq!(service.state().unwrap(), ServiceState::Stopped);
}

#[test]
fn a_spawn_that_fails_is_reported_with_the_program() {
    let w = world();
    let table = FakeTable::new(&w.clock);
    let spawn = spawner(&table, true);
    let service = detached(&w, &table, &spawn);
    service.install(&definition("detached", SPEC)).unwrap();
    let error = service.start().unwrap_err();
    assert!(
        error.to_string().contains("/install/coforge-computer"),
        "{error}"
    );
}

#[test]
fn stop_asks_then_forces_and_clears_the_pid_file() {
    let w = world();
    let table = FakeTable::new(&w.clock);
    let spawn = spawner(&table, false);
    let service = detached(&w, &table, &spawn);
    service.install(&definition("detached", SPEC)).unwrap();
    service.start().unwrap();
    table.ignores_the_request_to_exit(4000);
    let outcome = service.stop().unwrap();
    assert_eq!(outcome.before, ServiceState::Running { pid: Some(4000) });
    assert_eq!(
        table.signals(),
        [(4000, Signal::Exit), (4000, Signal::Kill)]
    );
    assert!(!w.state.path().join(PID_FILE).exists());
    assert_eq!(service.state().unwrap(), ServiceState::Stopped);
}

#[test]
fn stopping_a_stopped_service_is_not_an_error() {
    let w = world();
    let table = FakeTable::new(&w.clock);
    let spawn = spawner(&table, false);
    let service = detached(&w, &table, &spawn);
    assert_eq!(service.stop().unwrap().before, ServiceState::NotInstalled);
}

#[test]
fn a_log_past_the_limit_is_rotated_at_start() {
    let w = world();
    let table = FakeTable::new(&w.clock);
    let spawn = spawner(&table, false);
    let service = detached(&w, &table, &spawn);
    service.install(&definition("detached", SPEC)).unwrap();
    let log = w.state.path().join(LOG_FILE);
    fs::write(&log, vec![b'x'; usize::try_from(LOG_LIMIT).unwrap() + 1]).unwrap();
    service.start().unwrap();
    assert!(!log.exists() || fs::metadata(&log).unwrap().len() == 0);
    assert!(w.state.path().join("detached.log.1").exists());
}

#[cfg(unix)]
mod real_spawn {
    use super::*;

    fn run_sh(script: &str, env: &[(&str, &str)]) -> String {
        let dir = Scratch::new("spawn-real");
        let log = dir.path().join("out.log");
        let spec = Spec {
            program: "/bin/sh".to_owned(),
            args: vec!["-c".to_owned(), script.to_owned()],
            env: env
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        };
        let pid = SystemSpawn.spawn(&spec, &log).unwrap();
        for _ in 0..200 {
            if fs::read_to_string(&log).is_ok_and(|text| text.contains("done")) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let _ = pid;
        fs::read_to_string(&log).unwrap()
    }

    #[test]
    fn the_process_starts_from_the_specs_environment_alone() {
        // SAFETY: this test is the only one that sets this variable, and no thread reads it.
        unsafe { std::env::set_var("INSTALLER_ONLY_SECRET_TOKEN", "leaked") };
        let out = run_sh("env; echo done", &[("KEEP", "yes")]);
        assert!(out.contains("KEEP=yes"), "{out}");
        assert!(!out.contains("INSTALLER_ONLY_SECRET_TOKEN"), "{out}");
        assert!(!out.contains("leaked"), "{out}");
    }

    // macOS `ps` has no session id column; the Linux run is the one that matters here.
    #[test]
    #[cfg_attr(not(target_os = "linux"), ignore)]
    fn the_process_leads_a_session_of_its_own() {
        let out = run_sh(
            r#"echo "pid=$$ sid=$(ps -o sid= -p $$ | tr -d ' ')"; echo done"#,
            &[("PATH", "/bin:/usr/bin")],
        );
        let line = out.lines().find(|l| l.starts_with("pid=")).unwrap();
        let (pid, sid) = line.split_once(" sid=").unwrap();
        assert_eq!(pid.trim_start_matches("pid="), sid, "{out}");
    }
}
