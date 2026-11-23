import { expect, test } from "bun:test";

import { computerDetailUpgradeSlots } from "#src/features/computers/computer-detail-upgrade-slots";
import {
  buildComputerUpgradeProgressView,
  describeComputerUpgradeFailureNotice,
  resolveProgressComputerVersion,
  runtimeUpgradePresentation,
} from "#src/features/computers/computer-upgrade-progress-view";
import type {
  ComputerUpgradeProgress,
  ComputerUpgradeStatus,
} from "#src/features/computers/computer.schemas";

function makeProgress(overrides: Partial<ComputerUpgradeProgress> = {}): ComputerUpgradeProgress {
  return {
    expectedVersion: "0.1.35-dev.2",
    expiresAt: 600_000,
    phase: "switching",
    switchState: "target_online",
    workspaces: [],
    ...overrides,
  };
}

test("active upgrade phases stay quiet without an inline card or countdown seconds", () => {
  const pending = buildComputerUpgradeProgressView({
    progress: makeProgress({ phase: "waiting", switchState: "pending" }),
    now: 10_000,
  });
  expect(pending).toEqual({ kind: "active", version: "0.1.35-dev.2" });

  const targetOnline = buildComputerUpgradeProgressView({
    progress: makeProgress({
      phase: "switching",
      switchState: "target_online",
      expiresAt: 100_000,
    }),
    now: 50_000,
  });
  expect(targetOnline).toEqual({ kind: "active", version: "0.1.35-dev.2" });

  const reconnecting = buildComputerUpgradeProgressView({
    progress: makeProgress({
      phase: "switching",
      switchState: "confirmed",
      reconnectUntil: 120_000,
      workspaces: [
        { workspaceId: "w1", name: "Infra", state: "restored", confirmedAt: 50_000 },
        { workspaceId: "w2", name: "App Team", state: "waiting" },
        { workspaceId: "w3", name: "Idle WS", state: "not_running" },
      ],
    }),
    now: 90_000,
  });
  expect(reconnecting).toEqual({ kind: "active", version: "0.1.35-dev.2" });
});

test("completed upgrade settles without leaving an inline card behind", () => {
  const completed = buildComputerUpgradeProgressView({
    progress: makeProgress({
      phase: "switching",
      switchState: "confirmed",
      workspaces: [
        { workspaceId: "w1", name: "Infra", state: "restored", confirmedAt: 50_000 },
        { workspaceId: "w3", name: "Idle WS", state: "not_running" },
      ],
    }),
    now: 90_000,
  });
  expect(completed).toEqual({ kind: "completed", version: "0.1.35-dev.2" });
});

test("only abnormal states produce an inline issue with unsettled workspace names only", () => {
  const expiredTarget = buildComputerUpgradeProgressView({
    progress: makeProgress({
      phase: "switching",
      switchState: "target_online",
      expiresAt: 100_000,
    }),
    now: 100_000,
  });
  expect(expiredTarget.kind).toBe("issue");
  if (expiredTarget.kind === "issue") {
    expect(expiredTarget.alertColor).toBe("warning");
    expect(expiredTarget.canRetry).toBe(false);
    expect(expiredTarget.unsettledWorkspaces).toEqual([]);
  }

  const expiredReconnect = buildComputerUpgradeProgressView({
    progress: makeProgress({
      phase: "switching",
      switchState: "confirmed",
      reconnectUntil: 120_000,
      workspaces: [
        { workspaceId: "w1", name: "Infra", state: "restored", confirmedAt: 50_000 },
        { workspaceId: "w2", name: "App Team", state: "waiting" },
        { workspaceId: "w3", name: "Idle WS", state: "not_running" },
      ],
    }),
    now: 120_000,
  });
  expect(expiredReconnect.kind).toBe("issue");
  if (expiredReconnect.kind === "issue") {
    expect(expiredReconnect.alertColor).toBe("warning");
    expect(expiredReconnect.canRetry).toBe(false);
    expect(expiredReconnect.unsettledWorkspaces).toEqual(["App Team"]);
  }

  const rolledBack = buildComputerUpgradeProgressView({
    progress: makeProgress({
      phase: "switching",
      switchState: "rolled_back",
      restoredVersion: "0.1.35-dev.1",
    }),
    now: 50_000,
  });
  expect(rolledBack.kind).toBe("issue");
  if (rolledBack.kind === "issue") {
    expect(rolledBack.alertColor).toBe("error");
    expect(rolledBack.detail).toContain("0.1.35-dev.1");
    expect(rolledBack.canRetry).toBe(true);
  }

  const conflict = buildComputerUpgradeProgressView({
    progress: makeProgress({ phase: "switching", switchState: "conflict" }),
    now: 50_000,
  });
  expect(conflict.kind).toBe("issue");
  if (conflict.kind === "issue") {
    expect(conflict.alertColor).toBe("error");
    expect(conflict.canRetry).toBe(true);
  }

  const failed = buildComputerUpgradeProgressView({
    progress: makeProgress({ phase: "downloading", switchState: "failed" }),
    failureHeadline: "Checksum mismatch",
    now: 50_000,
  });
  expect(failed.kind).toBe("issue");
  if (failed.kind === "issue") {
    expect(failed.alertColor).toBe("error");
    expect(failed.detail).toBe("Checksum mismatch");
    expect(failed.canRetry).toBe(true);
  }
});

test("runtimeUpgradePresentation maps available, upgrading, completed, and failed slots to header action and borderless version notice", () => {
  const available = runtimeUpgradePresentation({
    slot: { state: "available", offer: "0.1.35-dev.2" },
    canUpgrade: true,
    online: true,
    upgradeInFlight: false,
    now: 50_000,
  });
  expect(available.headerAction).toEqual({ kind: "upgrade", disabled: false });
  expect(available.versionNotice).toEqual({
    kind: "available",
    version: "0.1.35-dev.2",
    prerelease: true,
    offline: false,
  });

  const upgrading = runtimeUpgradePresentation({
    slot: {
      state: "progress",
      version: "0.1.35-dev.2",
      progress: makeProgress({ phase: "downloading", switchState: "pending" }),
    },
    canUpgrade: true,
    online: true,
    upgradeInFlight: true,
    now: 50_000,
  });
  expect(upgrading.headerAction).toEqual({ kind: "upgrading", disabled: true });
  expect(upgrading.versionNotice).toEqual({ kind: "upgrading", version: "0.1.35-dev.2" });

  const completed = runtimeUpgradePresentation({
    slot: {
      state: "progress",
      version: "0.1.35-dev.2",
      progress: makeProgress({
        switchState: "confirmed",
        workspaces: [{ workspaceId: "w1", name: "Infra", state: "restored", confirmedAt: 50_000 }],
      }),
    },
    canUpgrade: true,
    online: true,
    upgradeInFlight: false,
    now: 60_000,
  });
  expect(completed.headerAction).toBeUndefined();
  expect(completed.versionNotice).toBeUndefined();

  const completedWithNextOffer = runtimeUpgradePresentation({
    slot: {
      state: "progress",
      version: "0.1.35-dev.2",
      offer: "0.1.35-dev.3",
      progress: makeProgress({
        switchState: "confirmed",
        workspaces: [{ workspaceId: "w1", name: "Infra", state: "restored", confirmedAt: 50_000 }],
      }),
    },
    canUpgrade: true,
    online: true,
    upgradeInFlight: false,
    now: 60_000,
  });
  expect(completedWithNextOffer.headerAction).toEqual({ kind: "upgrade", disabled: false });
  expect(completedWithNextOffer.versionNotice).toEqual({
    kind: "available",
    version: "0.1.35-dev.3",
    prerelease: true,
    offline: false,
  });

  const failed = runtimeUpgradePresentation({
    slot: {
      state: "failed",
      version: "0.1.35-dev.2",
      offer: "0.1.35-dev.2",
      failure: { headline: "failed", steps: [] },
    },
    canUpgrade: true,
    online: true,
    upgradeInFlight: false,
    now: 60_000,
  });
  expect(failed.headerAction).toEqual({ kind: "retry", disabled: false });
  expect(failed.versionNotice).toMatchObject({
    kind: "issue",
    tone: "error",
    detail: "failed",
  });
});

test("resolveProgressComputerVersion and local slots keep version resolution intact", () => {
  const progress = makeProgress({
    phase: "switching",
    switchState: "target_online",
    expiresAt: 100_000,
  });
  expect(
    resolveProgressComputerVersion({
      computerVersion: "0.1.35-dev.1",
      liveStatus: {
        requestId: "req-1",
        status: "accepted",
        expectedVersion: "0.1.35-dev.2",
        expiresAt: new Date(100_000).toISOString(),
        progress,
      },
    }),
  ).toBe("0.1.35-dev.2");

  const liveStatus: ComputerUpgradeStatus = {
    requestId: "req-1",
    status: "failed",
    reason: "reported",
    errorCode: "UPGRADE_ROLLED_BACK",
    progress: makeProgress({
      phase: "switching",
      switchState: "rolled_back",
      restoredVersion: "0.1.35-dev.1",
    }),
  };
  const slots = computerDetailUpgradeSlots({
    kind: "local",
    computerVersion: "0.1.35-dev.1",
    upgrade: { state: "failed", failure: { headline: "rolled back", steps: [] } },
    request: { state: "idle" },
    liveStatus,
    latestComputerVersion: "0.1.35-dev.2",
  });

  expect(slots.currentVersion).toBe("0.1.35-dev.1");
  expect(slots.runtimeSlot?.state).toBe("progress");
});

test("describeComputerUpgradeFailureNotice builds system notices for rolled-back, failed, and unconfirmed upgrades", () => {
  expect(
    describeComputerUpgradeFailureNotice({
      upgrade: {
        computerId: "c1",
        requestId: "r1",
        startedHere: true,
        computerName: "s144",
        version: "0.1.34-dev.8",
      },
      status: {
        requestId: "r1",
        status: "completed",
        expectedVersion: "0.1.34-dev.8",
        computerVersion: "0.1.34-dev.8",
        daemonVersion: "0.1.34-dev.8",
        workerInstanceId: "worker-1",
        completedAt: "2026-11-23T00:00:00.000Z",
        progress: makeProgress({
          expectedVersion: "0.1.34-dev.8",
          switchState: "confirmed",
          workspaces: [
            { workspaceId: "w1", name: "Infra", state: "restored", confirmedAt: 50_000 },
          ],
        }),
      },
      now: 60_000,
    }),
  ).toBeNull();

  const rolledBack = describeComputerUpgradeFailureNotice({
    upgrade: {
      computerId: "c1",
      requestId: "r2",
      startedHere: true,
      computerName: "s144",
      version: "0.1.34-dev.8",
    },
    status: {
      requestId: "r2",
      status: "failed",
      reason: "reported",
      errorCode: "UPGRADE_ROLLED_BACK",
      progress: makeProgress({
        expectedVersion: "0.1.34-dev.8",
        switchState: "rolled_back",
        restoredVersion: "0.1.33",
      }),
    },
    now: 60_000,
  });
  expect(rolledBack).not.toBeNull();
  expect(rolledBack?.id).toBe("computer-upgrade:c1");
  expect(rolledBack?.title).toContain("s144");
  expect(rolledBack?.body).toContain("0.1.33");

  const unconfirmed = describeComputerUpgradeFailureNotice({
    upgrade: {
      computerId: "c1",
      requestId: "r3",
      startedHere: true,
      computerName: "s144",
      version: "0.1.34-dev.8",
    },
    status: {
      requestId: "r3",
      status: "completed",
      expectedVersion: "0.1.34-dev.8",
      computerVersion: "0.1.34-dev.8",
      daemonVersion: "0.1.34-dev.8",
      workerInstanceId: "worker-1",
      completedAt: "2026-11-23T00:00:00.000Z",
      progress: makeProgress({
        expectedVersion: "0.1.34-dev.8",
        switchState: "confirmed",
        reconnectUntil: 50_000,
        workspaces: [{ workspaceId: "w1", name: "App Team", state: "waiting" }],
      }),
    },
    now: 60_000,
  });
  expect(unconfirmed).not.toBeNull();
  expect(unconfirmed?.id).toBe("computer-upgrade:c1");
  expect(unconfirmed?.title).toContain("s144");
  expect(unconfirmed?.body).toContain("App Team");

  const plainFailed = describeComputerUpgradeFailureNotice({
    upgrade: {
      computerId: "c1",
      requestId: "r4",
      startedHere: true,
      computerName: "s144",
      version: "0.1.34-dev.8",
    },
    status: {
      requestId: "r4",
      status: "failed",
      reason: "reported",
      errorCode: "UPDATE_INTEGRITY_FAILED",
    },
    now: 60_000,
  });
  expect(plainFailed).not.toBeNull();
  expect(plainFailed?.id).toBe("computer-upgrade:c1");
  expect(plainFailed?.title).toContain("s144");
  expect(plainFailed?.body.length).toBeGreaterThan(0);

  const missingStatus = describeComputerUpgradeFailureNotice({
    upgrade: {
      computerId: "c1",
      requestId: "r5",
      startedHere: true,
      computerName: "s144",
    },
    status: null,
    now: 60_000,
  });
  expect(missingStatus).not.toBeNull();
  expect(missingStatus?.id).toBe("computer-upgrade:c1");
  expect(missingStatus?.title).toContain("s144");
});
