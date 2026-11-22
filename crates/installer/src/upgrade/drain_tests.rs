use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::clock::{Clock, VirtualClock};
use crate::contract::{LifecycleServiceDefinition, ReceiptStatus};
use crate::drain::{DRAIN_REQUEST_FILE, DRAIN_STATE_FILE};
use crate::processes::fakes::FakeTable;
use crate::service::{
    Registered, ServiceError, ServiceState, StartOutcome, StopOutcome, SupervisorService,
};
use crate::switch::Ports;
use crate::test_support::Scratch;
use crate::upgrade::fakes::{FakeLifecycle, FakeService, Fixture, NEW, OLD, REQUEST, running};
use crate::upgrade::{Outcome, UpgradeRequest, upgrade};

struct ObservingService<'a> {
    inner: &'a FakeService,
    state_dir: PathBuf,
    request_present_at_stop: Cell<Option<bool>>,
    request_present_at_start: Cell<Option<bool>>,
    state_present_at_start: Cell<Option<bool>>,
}

impl<'a> ObservingService<'a> {
    fn new(inner: &'a FakeService, state_dir: &Path) -> Self {
        Self {
            inner,
            state_dir: state_dir.to_path_buf(),
            request_present_at_stop: Cell::new(None),
            request_present_at_start: Cell::new(None),
            state_present_at_start: Cell::new(None),
        }
    }
}

impl SupervisorService for ObservingService<'_> {
    fn display_name(&self) -> String {
        self.inner.display_name()
    }

    fn state(&self) -> Result<ServiceState, ServiceError> {
        self.inner.state()
    }

    fn caller_is_inside_unit(&self) -> Result<bool, ServiceError> {
        self.inner.caller_is_inside_unit()
    }

    fn install(&self, definition: &LifecycleServiceDefinition) -> Result<Registered, ServiceError> {
        self.inner.install(definition)
    }

    fn stop(&self) -> Result<StopOutcome, ServiceError> {
        self.request_present_at_stop
            .set(Some(self.state_dir.join(DRAIN_REQUEST_FILE).exists()));
        self.inner.stop()
    }

    fn start(&self) -> Result<StartOutcome, ServiceError> {
        self.request_present_at_start
            .set(Some(self.state_dir.join(DRAIN_REQUEST_FILE).exists()));
        self.state_present_at_start
            .set(Some(self.state_dir.join(DRAIN_STATE_FILE).exists()));
        self.inner.start()
    }
}

struct DrainClock {
    inner: VirtualClock,
    state_dir: PathBuf,
}

impl Clock for DrainClock {
    fn now(&self) -> Duration {
        self.inner.now()
    }

    fn sleep(&self, duration: Duration) {
        self.inner.sleep(duration);
        let elapsed = self.inner.now();
        if self.state_dir.join(DRAIN_REQUEST_FILE).exists() {
            let busy_count = if elapsed < Duration::from_millis(500) {
                1
            } else {
                0
            };
            let body = serde_json::json!({
                "schemaVersion": 1,
                "drainId": REQUEST,
                "held": true,
                "busyCount": busy_count,
                "updatedAtMs": 1_760_000_000_000u64,
            });
            fs::write(self.state_dir.join(DRAIN_STATE_FILE), body.to_string()).unwrap();
        }
    }
}

#[test]
fn upgrade_drains_before_stop_keeps_request_across_stop_and_clears_before_start() {
    check_upgrade_drain_ordering(false);
}

#[test]
fn a_remote_upgrade_records_wait_switch_health_and_receipt() {
    check_upgrade_drain_ordering(true);
}

fn check_upgrade_drain_ordering(report_progress: bool) {
    let fixture = Fixture::new("upgrade-drain-ordering");
    fixture.install_old();
    let state_scratch = Scratch::new("upgrade-drain-state");
    let clock = DrainClock {
        inner: VirtualClock::new(),
        state_dir: state_scratch.path().to_path_buf(),
    };
    let table = FakeTable::new(&clock.inner);
    let inner_service = FakeService::new(ServiceState::Running { pid: Some(100) });
    let service = ObservingService::new(&inner_service, state_scratch.path());
    let lifecycle = FakeLifecycle::default();
    lifecycle.answers_status(&fixture.computer(OLD), vec![Some(running(OLD, "sup-old"))]);
    lifecycle.answers_status(&fixture.computer(NEW), vec![Some(running(NEW, "sup-new"))]);
    fixture.answers_protocol(&lifecycle, OLD);
    fixture.answers_protocol(&lifecycle, NEW);
    let ports = Ports {
        state_directory: Some(state_scratch.path()),
        ..fixture.ports(&lifecycle, &service, &table, &clock)
    };
    let progress = ports.install_root.join("upgrade-progress").join(REQUEST);
    if report_progress {
        fs::create_dir_all(&progress).unwrap();
        fs::write(
            progress.join("context.json"),
            serde_json::json!({ "version": NEW, "generation": "activation" }).to_string(),
        )
        .unwrap();
    }
    let mut stages = Vec::new();
    let request = UpgradeRequest {
        request_id: REQUEST,
        selection: NEW,
        caller: None,
        allow_downgrade: false,
    };

    let outcome = upgrade(&ports, &request, &mut |line| stages.push(line.to_owned()));

    let Outcome::Receipt(receipt) = outcome else {
        panic!("expected receipt, got {outcome:?}");
    };
    assert_eq!(receipt.status(), ReceiptStatus::Succeeded);
    assert_eq!(service.request_present_at_stop.get(), Some(true));
    assert_eq!(service.request_present_at_start.get(), Some(false));
    assert_eq!(service.state_present_at_start.get(), Some(false));
    assert!(!state_scratch.path().join(DRAIN_REQUEST_FILE).exists());
    assert!(!state_scratch.path().join(DRAIN_STATE_FILE).exists());
    let drain_idx = stages
        .iter()
        .position(|line| line == "Draining (1 busy Agent)")
        .expect("drain stage line emitted");
    let stop_idx = stages
        .iter()
        .position(|line| line.starts_with("Stopping"))
        .expect("stopping stage line emitted");
    assert!(drain_idx < stop_idx);
    if report_progress {
        for name in ["verifying", "waiting", "switching", "healthy", "receipt"] {
            let bytes = fs::read(progress.join(format!("{name}.json"))).unwrap();
            let fact: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(fact["version"], NEW);
            assert_eq!(fact["generation"], "activation");
        }
        assert!(!progress.join("uncertain.json").exists());
    }
}
