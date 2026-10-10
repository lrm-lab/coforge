//! Test doubles for the upgrade transaction and its recovery: a scripted [`ComputerLifecycle`] and
//! [`SupervisorService`], and a fixture that installs real versions from a loopback release feed
//! into a scratch install root. Processes come from [`crate::processes::fakes::FakeTable`] and
//! time from the virtual clock.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use crate::active::activate;
use crate::clock::Clock;
use crate::contract::{
    ACTIVE_STATE_SCHEMA_VERSION, ActiveState, LIFECYCLE_PROTOCOL, LifecycleBinding,
    LifecycleProblem, LifecycleProtocol, LifecycleStatus, SupervisorState,
};
use crate::feed::Feed;
use crate::lifecycle::{ComputerLifecycle, LifecycleFailure};
use crate::lock::MachineMutationLock;
use crate::prepare::prepare_version;
use crate::processes::ProcessTable;
use crate::service::{
    ServiceError, ServiceState, StartOutcome, StopOutcome, SupervisorService, coordinator_service,
};
use crate::store::VersionStore;
use crate::switch::Ports;
use crate::test_support::{Release, Scratch, Server};

/// The release target of the machine the tests run on: `activate` switches by the target's
/// platform (a symlink on Unix, a junction on Windows), so a fixture claiming another platform
/// than the host's would exercise a switch the host cannot perform.
#[cfg(not(windows))]
pub(crate) const TARGET: &str = "linux-x64";
#[cfg(all(windows, target_arch = "aarch64"))]
pub(crate) const TARGET: &str = "windows-arm64";
#[cfg(all(windows, not(target_arch = "aarch64")))]
pub(crate) const TARGET: &str = "windows-x64";
pub(crate) const OLD: &str = "0.1.0";
pub(crate) const NEW: &str = "0.2.0";
/// A valid RFC 9562 UUID (version 4, variant 9).
pub(crate) const REQUEST: &str = "0b7d2c9e-3a1f-4c8e-9d2b-5f6a7b8c9d0e";

/// Answers in order; the last answer repeats. `None` is a failed call.
struct Script<T>(VecDeque<Option<T>>);

impl<T: Clone> Script<T> {
    fn next(&mut self) -> Option<T> {
        if self.0.len() > 1 {
            self.0.pop_front().flatten()
        } else {
            self.0.front().cloned().flatten()
        }
    }
}

/// A lifecycle whose answers are scripted per executable path.
#[derive(Default)]
pub(crate) struct FakeLifecycle {
    protocols: RefCell<BTreeMap<PathBuf, Script<LifecycleProtocol>>>,
    statuses: RefCell<BTreeMap<PathBuf, Script<LifecycleStatus>>>,
}

impl FakeLifecycle {
    /// Replaces the answers the executable at `executable` gives to `protocol`.
    pub(crate) fn answers_protocol(
        &self,
        executable: &Path,
        answers: Vec<Option<LifecycleProtocol>>,
    ) {
        self.protocols.borrow_mut().insert(
            executable.to_path_buf(),
            Script(answers.into_iter().collect()),
        );
    }

    /// Replaces the answers the executable at `executable` gives to `status`.
    pub(crate) fn answers_status(&self, executable: &Path, answers: Vec<Option<LifecycleStatus>>) {
        self.statuses.borrow_mut().insert(
            executable.to_path_buf(),
            Script(answers.into_iter().collect()),
        );
    }
}

fn scripted_failure(executable: &Path, command: &str) -> LifecycleFailure {
    LifecycleFailure::NotRun {
        command: format!("{} __lifecycle {command}", executable.display()),
        detail: "scripted failure".to_owned(),
    }
}

impl ComputerLifecycle for FakeLifecycle {
    fn protocol(&self, executable: &Path) -> Result<LifecycleProtocol, LifecycleFailure> {
        self.protocols
            .borrow_mut()
            .get_mut(executable)
            .and_then(Script::next)
            .ok_or_else(|| scripted_failure(executable, "protocol"))
    }

    fn status(&self, executable: &Path) -> Result<LifecycleStatus, LifecycleFailure> {
        self.statuses
            .borrow_mut()
            .get_mut(executable)
            .and_then(Script::next)
            .ok_or_else(|| scripted_failure(executable, "status"))
    }
}

pub(crate) fn protocol(version: &str) -> LifecycleProtocol {
    LifecycleProtocol {
        lifecycle_protocol: LIFECYCLE_PROTOCOL,
        version: version.to_owned(),
    }
}

/// A healthy running supervisor of `version` with two Workspace runtimes: one running, one stopped.
pub(crate) fn running(version: &str, id: &str) -> LifecycleStatus {
    LifecycleStatus {
        lifecycle_protocol: LIFECYCLE_PROTOCOL,
        version: version.to_owned(),
        supervisor: SupervisorState {
            running: true,
            id: Some(id.to_owned()),
            version: Some(version.to_owned()),
        },
        bindings: vec![
            LifecycleBinding {
                binding_id: "workspace-a".to_owned(),
                enabled: true,
                running: true,
                process_id: Some(4001),
            },
            LifecycleBinding {
                binding_id: "workspace-b".to_owned(),
                enabled: true,
                running: false,
                process_id: None,
            },
        ],
        healthy: true,
        problems: Vec::new(),
    }
}

/// No supervisor running; the persisted state of `version`.
pub(crate) fn stopped(version: &str) -> LifecycleStatus {
    LifecycleStatus {
        lifecycle_protocol: LIFECYCLE_PROTOCOL,
        version: version.to_owned(),
        supervisor: SupervisorState {
            running: false,
            id: None,
            version: None,
        },
        bindings: Vec::new(),
        healthy: true,
        problems: Vec::new(),
    }
}

/// A runtime set that reports `messages` as its problems.
pub(crate) fn unhealthy(version: &str, messages: &[&str]) -> LifecycleStatus {
    LifecycleStatus {
        healthy: false,
        problems: messages
            .iter()
            .map(|message| LifecycleProblem {
                code: "WORKSPACE_NOT_RUNNING".to_owned(),
                binding_id: Some("workspace-b".to_owned()),
                message: (*message).to_owned(),
            })
            .collect(),
        ..running(version, "unhealthy-id")
    }
}

/// A supervisor service whose state changes with `stop` and `start`, recording each call.
pub(crate) struct FakeService {
    state: Cell<ServiceState>,
    calls: RefCell<Vec<&'static str>>,
    next_pid: Cell<u32>,
    inside: Cell<bool>,
}

impl FakeService {
    pub(crate) fn new(state: ServiceState) -> Self {
        Self {
            state: Cell::new(state),
            calls: RefCell::new(Vec::new()),
            next_pid: Cell::new(9000),
            inside: Cell::new(false),
        }
    }

    /// The caller runs inside this service's unit. Not a call: it is not recorded.
    pub(crate) fn inside_unit(self) -> Self {
        self.inside.set(true);
        self
    }

    pub(crate) fn calls(&self) -> Vec<&'static str> {
        self.calls.borrow().clone()
    }
}

impl SupervisorService for FakeService {
    fn display_name(&self) -> String {
        coordinator_service().systemd_user_unit
    }

    fn caller_is_inside_unit(&self) -> Result<bool, ServiceError> {
        Ok(self.inside.get())
    }

    fn state(&self) -> Result<ServiceState, ServiceError> {
        self.calls.borrow_mut().push("state");
        Ok(self.state.get())
    }

    fn stop(&self) -> Result<StopOutcome, ServiceError> {
        self.calls.borrow_mut().push("stop");
        let before = self.state.get();
        self.state.set(ServiceState::Stopped);
        Ok(StopOutcome { before })
    }

    fn start(&self) -> Result<StartOutcome, ServiceError> {
        self.calls.borrow_mut().push("start");
        let pid = self.next_pid.get();
        self.next_pid.set(pid + 1);
        self.state.set(ServiceState::Running { pid: Some(pid) });
        Ok(StartOutcome { pid: Some(pid) })
    }
}

/// A scratch install root with a loopback feed serving [`OLD`] and [`NEW`] (`latest` is [`NEW`]).
pub(crate) struct Fixture {
    _scratch: Scratch,
    root: PathBuf,
    binary_directory: PathBuf,
    store: VersionStore,
    feed: Feed,
    _server: Server,
}

impl Fixture {
    pub(crate) fn new(label: &str) -> Self {
        Self::with_latest(label, NEW)
    }

    /// A fixture whose feed's `latest` pointer names `latest` (one of [`OLD`] and [`NEW`]).
    pub(crate) fn with_latest(label: &str, latest: &str) -> Self {
        let scratch = Scratch::new(label);
        let mut routes = Release::new(OLD, TARGET).routes();
        routes.extend(Release::new(NEW, TARGET).routes());
        routes.insert(
            "/latest".to_owned(),
            crate::test_support::Response::ok(format!("{latest}\n")),
        );
        let server = Server::start(routes);
        let root = scratch.path().join("install");
        let feed = Feed::new(
            &server.base_url(),
            crate::fetch::agent(crate::fetch::Transport::LoopbackHttp),
        );
        Self {
            binary_directory: scratch.path().join("bin"),
            store: VersionStore::new(&root, TARGET),
            root,
            feed,
            _server: server,
            _scratch: scratch,
        }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// The loopback feed this fixture installs from.
    pub(crate) fn feed(&self) -> &Feed {
        &self.feed
    }

    /// The executable of `version` in this install root.
    pub(crate) fn computer(&self, version: &str) -> PathBuf {
        self.store.computer_path(version)
    }

    /// The same executable, as a process table names it (symlinks resolved).
    pub(crate) fn canonical_computer(&self, version: &str) -> String {
        fs::canonicalize(self.computer(version))
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    /// Installs `version` from the feed into the store, as a completed preparation leaves it.
    pub(crate) fn install(&self, version: &str) {
        let lock = MachineMutationLock::acquire(&self.root).unwrap();
        prepare_version(&lock, &self.feed, &self.store, version, None).unwrap();
    }

    /// Installs [`OLD`] as the active version, with no previous one, the way a first install
    /// leaves the machine.
    pub(crate) fn install_old(&self) {
        self.install(OLD);
        self.activate(OLD, None);
    }

    /// Creates `version`'s executable path without installing the version, so that a process
    /// table can name it (a process of an interrupted candidate that was never verified).
    pub(crate) fn place_executable(&self, version: &str) {
        fs::create_dir_all(self.computer(version).parent().unwrap()).unwrap();
        fs::write(self.computer(version), b"").unwrap();
    }

    /// Points `active.json` and the links at `current`, as a completed switch would.
    pub(crate) fn activate(&self, current: &str, previous: Option<&str>) {
        activate(
            &self.root,
            &self.binary_directory,
            TARGET,
            &ActiveState {
                schema_version: ACTIVE_STATE_SCHEMA_VERSION,
                current: current.to_owned(),
                previous: previous.map(str::to_owned),
            },
        )
        .unwrap();
    }

    /// The ports the transaction runs through, the doubles given by the test.
    pub(crate) fn ports<'a>(
        &'a self,
        lifecycle: &'a dyn ComputerLifecycle,
        service: &'a dyn SupervisorService,
        processes: &'a dyn ProcessTable,
        clock: &'a dyn Clock,
    ) -> Ports<'a> {
        Ports {
            install_root: &self.root,
            binary_directory: &self.binary_directory,
            store: &self.store,
            release: &self.feed,
            lifecycle,
            service,
            processes,
            clock,
        }
    }
}
