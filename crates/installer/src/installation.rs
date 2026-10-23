//! The installation a command acts on: where it lives, which release this build is for, and the
//! ports the transaction runs through on this machine (the real service manager, process table,
//! clock, and feed). The commands call these use cases; they build no ports of their own.

use std::path::PathBuf;
use std::rc::Rc;

use crate::clock::SystemClock;
use crate::compiled_feed::FeedEndpoint;
use crate::contract::EXIT_FAILED;
use crate::feed::Feed;
use crate::fetch;
use crate::lifecycle::Lifecycle;
use crate::paths::{self, InstallPaths, Platform};
use crate::prepare::ReleaseSource;
use crate::processes::{OsProcesses, VerifiedCaller};
use crate::recover::{RecoverOutcome, recover as recover_installation};
use crate::release_directory::ReleaseDirectory;
use crate::repair::repair as repair_installation;
use crate::service::{self, SystemRunner};
use crate::status::{self, StatusReport};
use crate::store::VersionStore;
use crate::switch::Ports;
use crate::upgrade::{Outcome, UpgradeRequest, upgrade};

/// Where an install or upgrade takes its release from: the compiled feed, or a directory laid out
/// as one version's objects are (`--from-directory`).
pub enum ReleaseOrigin {
    Feed,
    Directory(PathBuf),
}

/// Where this machine's installation is and which release target and feed it uses.
pub struct Setup {
    paths: InstallPaths,
    home: PathBuf,
    target: &'static str,
    feed: FeedEndpoint,
}

impl Setup {
    /// The setup for the user running this process, or why there is none.
    pub fn current(feed: FeedEndpoint) -> Result<Self, String> {
        let home = std::env::home_dir().ok_or("no home directory can be determined")?;
        let paths = InstallPaths::current().ok_or("no home directory can be determined")?;
        let target = paths::release_target().ok_or_else(|| {
            format!(
                "no CoForge Computer release is built for this machine ({} {})",
                std::env::consts::OS,
                std::env::consts::ARCH
            )
        })?;
        Ok(Self {
            paths,
            home,
            target,
            feed,
        })
    }

    fn store(&self) -> VersionStore {
        VersionStore::new(&self.paths.install_root, self.target)
    }
}

/// Builds the real ports for `setup` and runs `body` with them. Nothing is built before this, so
/// a refusal that needs no ports (a malformed request, an unfinished journal read) never starts a
/// service manager.
fn with_ports<T>(
    setup: &Setup,
    origin: &ReleaseOrigin,
    body: impl FnOnce(&Ports<'_>) -> T,
) -> Result<T, String> {
    let runner = SystemRunner;
    let clock = SystemClock::new();
    let processes = OsProcesses;
    let lifecycle = Lifecycle::new(&runner);
    let service = service::for_platform(
        Platform::current(),
        &setup.home,
        service::current_uid(),
        &runner,
        &clock,
    )
    .map_err(|error| error.to_string())?;
    let store = setup.store();
    let agent = fetch::agent(setup.feed.transport);
    let feed = Feed::new(&setup.feed.base_url, agent, Rc::new(clock));
    let directory;
    let release: &dyn ReleaseSource = match origin {
        ReleaseOrigin::Feed => &feed,
        ReleaseOrigin::Directory(path) => {
            directory = ReleaseDirectory::new(path);
            &directory
        }
    };
    let ports = Ports {
        install_root: &setup.paths.install_root,
        binary_directory: &setup.paths.binary_directory,
        store: &store,
        release,
        lifecycle: &lifecycle,
        service: service.as_ref(),
        processes: &processes,
        clock: &clock,
    };
    Ok(body(&ports))
}

/// Runs one upgrade (or install) request. `caller_pid` is the `upgrade` command that launched
/// this installer; it is verified before anything is done and never stopped. `allow_downgrade`
/// lets the target be older than the installed version.
pub fn transaction(
    setup: &Setup,
    request_id: &str,
    selection: &str,
    caller_pid: Option<u32>,
    origin: &ReleaseOrigin,
    allow_downgrade: bool,
    stage: &mut dyn FnMut(&str),
) -> Result<Outcome, String> {
    with_ports(setup, origin, |ports| {
        let caller = match verify_caller(ports, caller_pid) {
            Ok(caller) => caller,
            Err(message) => {
                return Outcome::NoReceipt {
                    exit: EXIT_FAILED,
                    message: format!("{message}. Nothing was changed."),
                };
            }
        };
        let request = UpgradeRequest {
            request_id,
            selection,
            caller,
            allow_downgrade,
        };
        upgrade(ports, &request, stage)
    })
}

/// Settles an upgrade that did not finish. `caller_pid` is the `coforge-computer recover` process
/// that launched this installer and waits for it; it is verified and never stopped.
pub fn recover(
    setup: &Setup,
    caller_pid: Option<u32>,
    stage: &mut dyn FnMut(&str),
) -> Result<RecoverOutcome, String> {
    with_ports(setup, &ReleaseOrigin::Feed, |ports| {
        verify_caller(ports, caller_pid).map(|caller| recover_installation(ports, caller, stage))
    })
    .and_then(std::convert::identity)
}

/// Repairs activation links or quarantines and redownloads a damaged immutable payload. The
/// operation uses the same machine lock and receipt directory as upgrades.
pub fn repair(
    setup: &Setup,
    request_id: &str,
    selection: Option<&str>,
    allow_downgrade: bool,
    stage: &mut dyn FnMut(&str),
) -> Result<Outcome, String> {
    with_ports(setup, &ReleaseOrigin::Feed, |ports| {
        repair_installation(ports, request_id, selection, allow_downgrade, stage)
    })
}

/// The launching process, verified as this installer's parent, or none when no pid was given.
fn verify_caller(
    ports: &Ports<'_>,
    caller_pid: Option<u32>,
) -> Result<Option<VerifiedCaller>, String> {
    match caller_pid {
        None => Ok(None),
        Some(pid) => VerifiedCaller::verify(ports.processes, std::process::id(), pid)
            .map(Some)
            .map_err(|error| error.to_string()),
    }
}

/// The installation's state, read without the lock.
pub fn status(setup: &Setup) -> StatusReport {
    let runner = SystemRunner;
    status::report(&setup.store(), &Lifecycle::new(&runner))
}
