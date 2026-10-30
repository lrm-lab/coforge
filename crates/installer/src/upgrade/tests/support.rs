use super::*;

pub(crate) fn run(
    ports: &Ports<'_>,
    request_id: &str,
    selection: &str,
    caller: Option<VerifiedCaller>,
) -> (Outcome, Vec<String>) {
    run_with(ports, request_id, selection, caller, false)
}

pub(crate) fn run_with(
    ports: &Ports<'_>,
    request_id: &str,
    selection: &str,
    caller: Option<VerifiedCaller>,
    allow_downgrade: bool,
) -> (Outcome, Vec<String>) {
    let mut stages = Vec::new();
    let request = UpgradeRequest {
        request_id,
        selection,
        caller,
        allow_downgrade,
    };
    let outcome = upgrade(ports, &request, &mut |stage| stages.push(stage.to_owned()));
    (outcome, stages)
}

pub(crate) fn exit_of(outcome: &Outcome) -> u8 {
    match outcome {
        Outcome::Receipt(receipt) => receipt.exit_code(),
        Outcome::NoReceipt { exit, .. } => *exit,
    }
}

pub(crate) fn receipt(outcome: &Outcome) -> &UpgradeReceipt {
    match outcome {
        Outcome::Receipt(receipt) => receipt,
        other => panic!("expected a receipt, got {other:?}"),
    }
}

/// The receipt the outcome reports is on disk, and it reads back through the store's validation.
pub(crate) fn committed(fixture: &Fixture, outcome: &Outcome) -> UpgradeReceipt {
    let stored = ReceiptStore::new(fixture.root())
        .read(REQUEST)
        .unwrap()
        .expect("a committed receipt");
    assert_eq!(&stored, receipt(outcome));
    stored
}

pub(crate) fn active(fixture: &Fixture) -> Option<ActiveState> {
    read_active(fixture.root()).unwrap()
}

pub(crate) fn active_state(current: &str, previous: Option<&str>) -> Option<ActiveState> {
    Some(ActiveState {
        schema_version: ACTIVE_STATE_SCHEMA_VERSION,
        current: current.to_owned(),
        previous: previous.map(str::to_owned),
    })
}

pub(crate) fn pids(receipt: &UpgradeReceipt) -> Vec<u32> {
    receipt
        .dead_process_identities()
        .unwrap_or_default()
        .iter()
        .map(|process| process.pid)
        .collect()
}

/// The lifecycle answers of an upgrade from a running [`OLD`] supervisor to [`NEW`].
pub(crate) fn script_running_upgrade(fixture: &Fixture, lifecycle: &FakeLifecycle) {
    fixture.answers_protocols(lifecycle);
    lifecycle.answers_status(&fixture.computer(OLD), vec![Some(running(OLD, "old-id"))]);
    lifecycle.answers_status(
        &fixture.computer(NEW),
        vec![Some(stopped(NEW)), Some(running(NEW, "new-id"))],
    );
}
