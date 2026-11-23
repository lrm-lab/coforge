import { expect, test } from "bun:test";

import { computerDetailUpgradeSlots } from "#src/features/computers/computer-detail-upgrade-slots";
import {
  buildComputerUpgradeProgressView,
  resolveProgressComputerVersion,
} from "#src/features/computers/computer-upgrade-progress-view";
import type {
  ComputerUpgradeProgress,
  ComputerUpgradeStatus,
} from "#src/features/computers/computer.schemas";
import { m } from "#src/paraglide/messages";

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

test("empty phase never marks download or drain complete before stage evidence arrives", () => {
  const view = buildComputerUpgradeProgressView({
    progress: makeProgress({ phase: undefined, switchState: "pending" }),
    now: 10_000,
  });

  expect(view.headline).toBe(m.computer_upgrade_progress_awaiting_stage());
  expect(view.steps.map((step) => step.status)).toEqual([
    "incomplete",
    "incomplete",
    "incomplete",
    "incomplete",
  ]);
});

test("target_online shows new version online and marks step 3 pending or warn after expiry", () => {
  const progress = makeProgress({
    phase: "switching",
    switchState: "target_online",
    expiresAt: 100_000,
  });
  const live = buildComputerUpgradeProgressView({ progress, now: 50_000 });
  expect(live.alertColor).toBe("brand");
  expect(live.headline).toBe(m.computer_upgrade_progress_target_online());
  expect(live.steps.map((step) => step.status)).toEqual([
    "complete",
    "complete",
    "current",
    "incomplete",
  ]);

  const expired = buildComputerUpgradeProgressView({ progress, now: 100_000 });
  expect(expired.alertColor).toBe("warning");
  expect(expired.steps.map((step) => step.status)).toEqual([
    "complete",
    "complete",
    "warn",
    "incomplete",
  ]);

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
});

test("confirmed tracks partial workspace recovery, excludes not_running from total, and flips waiting at reconnectUntil", () => {
  const progress = makeProgress({
    phase: "switching",
    switchState: "confirmed",
    reconnectUntil: 120_000,
    workspaces: [
      { workspaceId: "w1", name: "Infra", state: "restored", confirmedAt: 50_000 },
      { workspaceId: "w2", name: "App Team", state: "waiting" },
      { workspaceId: "w3", name: "Idle WS", state: "not_running" },
    ],
  });

  const active = buildComputerUpgradeProgressView({ progress, now: 90_000 });
  expect(active.alertColor).toBe("brand");
  expect(active.headline).toBe(m.computer_upgrade_progress_confirmed());
  expect(active.detail).toContain("1 / 2");
  expect(active.detail).toContain("30");
  expect(active.steps.map((step) => step.status)).toEqual([
    "complete",
    "complete",
    "complete",
    "current",
  ]);
  expect(active.workspaces.map((row) => [row.name, row.tone])).toEqual([
    ["Infra", "good"],
    ["App Team", "muted"],
    ["Idle WS", "muted"],
  ]);

  const expired = buildComputerUpgradeProgressView({ progress, now: 120_000 });
  expect(expired.alertColor).toBe("warning");
  expect(expired.steps.map((step) => step.status)).toEqual([
    "complete",
    "complete",
    "complete",
    "warn",
  ]);
  expect(expired.workspaces[1]?.tone).toBe("warn");

  const allRestored = buildComputerUpgradeProgressView({
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
  expect(allRestored.alertColor).toBe("success");
  expect(allRestored.steps.map((step) => step.status)).toEqual([
    "complete",
    "complete",
    "complete",
    "complete",
  ]);
});

test("rolled_back and uncertain render exact step markers without back-inferring missing phases", () => {
  const rolledBack = buildComputerUpgradeProgressView({
    progress: makeProgress({
      phase: "switching",
      switchState: "rolled_back",
      restoredVersion: "0.1.35-dev.1",
    }),
    now: 50_000,
  });
  expect(rolledBack.alertColor).toBe("error");
  expect(rolledBack.headline).toBe(
    m.computer_upgrade_progress_rolled_back({ version: "0.1.35-dev.1" }),
  );
  expect(rolledBack.steps.map((step) => step.status)).toEqual([
    "complete",
    "complete",
    "error",
    "incomplete",
  ]);
  expect(rolledBack.canRetry).toBe(true);

  const earlyFailure = buildComputerUpgradeProgressView({
    progress: makeProgress({
      phase: "downloading",
      switchState: "failed",
    }),
    now: 50_000,
  });
  expect(earlyFailure.steps.map((step) => step.status)).toEqual([
    "error",
    "incomplete",
    "incomplete",
    "incomplete",
  ]);

  const uncertain = buildComputerUpgradeProgressView({
    progress: makeProgress({
      phase: "uncertain",
      switchState: "uncertain",
      workspaces: [
        { workspaceId: "w1", name: "Infra", state: "unconfirmed" },
        { workspaceId: "w2", name: "App Team", state: "unknown" },
      ],
    }),
    now: 50_000,
  });
  expect(uncertain.alertColor).toBe("warning");
  expect(uncertain.headline).toBe(m.computer_upgrade_progress_uncertain());
  expect(uncertain.steps.map((step) => step.status)).toEqual([
    "complete",
    "complete",
    "warn",
    "incomplete",
  ]);
  expect(uncertain.workspaces.map((row) => row.tone)).toEqual(["warn", "muted"]);

  const rolledBackUnknown = buildComputerUpgradeProgressView({
    progress: makeProgress({
      phase: "switching",
      switchState: "rolled_back",
      restoredVersion: undefined,
    }),
    now: 50_000,
  });
  expect(rolledBackUnknown.headline).toBe(m.computer_upgrade_progress_rolled_back_unknown());
  expect(rolledBackUnknown.canRetry).toBe(true);

  const conflict = buildComputerUpgradeProgressView({
    progress: makeProgress({
      phase: "switching",
      switchState: "conflict",
    }),
    now: 50_000,
  });
  expect(conflict.alertColor).toBe("error");
  expect(conflict.headline).toBe(m.computer_upgrade_progress_conflict());
  expect(conflict.canRetry).toBe(true);
});

test("local computer slots project progress and restored version from live status", () => {
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
  if (slots.runtimeSlot?.state === "progress") {
    expect(slots.runtimeSlot.offer).toBe("0.1.35-dev.2");
  }
});
