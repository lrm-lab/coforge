use super::*;

#[test]
fn an_upgrade_killed_after_activation_keeps_a_new_version_that_is_healthy() {
    let fixture = Fixture::new("recover-healthy-new");
    fixture.install(OLD);
    fixture.install(NEW);
    fixture.activate(NEW, Some(OLD));
    record_journal(&fixture, &journal(Some(OLD), None, true));
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    table.spawn(200, 2, &fixture.canonical_computer(NEW));
    let service = FakeService::new(ServiceState::Stopped);
    let lifecycle = FakeLifecycle::default();
    fixture.answers_protocol(&lifecycle, NEW);
    lifecycle.answers_status(&fixture.computer(NEW), vec![Some(running(NEW, "new-id"))]);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = recover_with(&ports);

    assert_eq!(
        outcome,
        RecoverOutcome::Recovered {
            version: NEW.to_owned()
        }
    );
    assert_eq!(active(&fixture), active_state(NEW, Some(OLD)));
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    assert_eq!(service.calls(), ["stop", "start"]);
    let receipt = stored(&fixture).expect("a receipt");
    assert_eq!(receipt.status(), crate::contract::ReceiptStatus::Succeeded);
    assert_eq!(receipt.version(), Some(NEW));
}

#[test]
fn an_upgrade_killed_after_activation_restores_a_new_version_that_is_broken() {
    let fixture = Fixture::new("recover-broken-new");
    fixture.install(OLD);
    fixture.install(NEW);
    fixture.activate(NEW, Some(OLD));
    record_journal(&fixture, &journal(Some(OLD), None, true));
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, &fixture.canonical_computer(OLD));
    table.spawn(200, 2, &fixture.canonical_computer(NEW));
    let service = FakeService::new(ServiceState::Stopped);
    let lifecycle = FakeLifecycle::default();
    // Both switches probe the executable they start: on Windows each version runs from its own.
    fixture.answers_protocols(&lifecycle);
    // The new supervisor never comes up; the previous one does.
    lifecycle.answers_status(&fixture.computer(NEW), vec![Some(stopped(NEW))]);
    lifecycle.answers_status(
        &fixture.computer(OLD),
        vec![Some(running(OLD, "restored-id"))],
    );
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);

    let (outcome, _) = recover_with(&ports);

    assert_eq!(
        outcome,
        RecoverOutcome::Recovered {
            version: OLD.to_owned()
        }
    );
    assert_eq!(active(&fixture), active_state(OLD, None));
    assert_eq!(Journal::new(fixture.root()).read().unwrap(), None);
    assert_eq!(service.calls(), ["stop", "start", "stop", "start"]);
    assert!(clock.elapsed() >= std::time::Duration::from_secs(60));
    let receipt = stored(&fixture).expect("a receipt");
    assert_eq!(receipt.status(), crate::contract::ReceiptStatus::Failed);
    assert_eq!(
        receipt.error_code(),
        Some(crate::contract::ERROR_CODE_ROLLED_BACK)
    );
    assert_eq!(receipt.restored_version(), Some(OLD));
}
