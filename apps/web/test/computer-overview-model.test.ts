import { expect, test } from "bun:test";

import {
  batchUpgradeCandidates,
  computerNeedsAttention,
  computerRuntimeMeter,
  computerSummaryCounts,
  filterComputers,
  groupComputers,
  sortComputers,
  visibleMeteredProviders,
  type ComputerOverviewItem,
} from "#src/features/computers/computer-overview-model";

function makeComputer(overrides: Partial<ComputerOverviewItem> = {}): ComputerOverviewItem {
  return {
    id: "c1",
    kind: "local",
    name: "s144",
    displayName: "s144",
    online: true,
    ownedByCurrentUser: true,
    computerVersion: "0.1.33",
    releaseChannel: "latest",
    platform: "linux",
    osVersion: "Ubuntu 24.04",
    creator: { username: "frank", displayName: "Frank", avatarUrl: null },
    machine: {
      disk: {
        availableBytes: 89_000_000_000,
        totalBytes: 100_000_000_000,
        reportedAt: "2026-11-24T00:00:00Z",
      },
      memory: {
        availableBytes: 78_000_000_000,
        totalBytes: 100_000_000_000,
        reportedAt: "2026-11-24T00:00:00Z",
      },
    },
    runtimes: [
      { id: "r1", provider: "codex", version: "1.0", displayName: "Codex", isPublic: true },
      { id: "r2", provider: "pi", version: "1.0", displayName: "Pi", isPublic: true },
    ],
    agents: [{ id: "a1", name: "dax", displayName: "Dax", avatarUrl: null, provider: "codex" }],
    runtimeAuth: {
      codex: { provider: "codex", state: "logged_in" },
    },
    runtimeUsages: {
      codex: {
        state: "fresh",
        result: {
          workspaceId: "w",
          computerId: "c1",
          provider: "codex",
          scanId: "s1",
          status: "available",
          collectedAt: "2026-11-24T00:00:00Z",
          snapshot: {
            provider: "codex",
            primary: { usedPercent: 40, windowDurationMinutes: 300 },
          },
        },
      },
    },
    ...overrides,
  };
}

test("computerRuntimeMeter classifies used percent, limit reached, signed out, and unmeasured", () => {
  const normal = makeComputer();
  expect(computerRuntimeMeter(normal, "codex")).toEqual({
    kind: "meter",
    usedPercent: 40,
    leftPercent: 60,
    level: "plenty",
    limitReached: false,
  });

  const signedOut = makeComputer({
    runtimeAuth: { "claude-code": { provider: "claude-code", state: "logged_out" } },
    runtimeUsages: {},
  });
  expect(computerRuntimeMeter(signedOut, "claude-code")).toEqual({ kind: "attention" });

  const exhausted = makeComputer({
    runtimeUsages: {
      codex: {
        state: "fresh",
        result: {
          workspaceId: "w",
          computerId: "c1",
          provider: "codex",
          scanId: "s1",
          status: "available",
          collectedAt: "2026-11-24T00:00:00Z",
          snapshot: {
            provider: "codex",
            primary: { usedPercent: 100, status: "limit_reached", windowDurationMinutes: 300 },
          },
        },
      },
    },
  });
  expect(computerRuntimeMeter(exhausted, "codex")).toEqual({
    kind: "meter",
    usedPercent: 100,
    leftPercent: 0,
    level: "empty",
    limitReached: true,
  });

  const unmeasured = makeComputer({ runtimeUsages: {} });
  expect(computerRuntimeMeter(unmeasured, "codex")).toEqual({ kind: "unmeasured" });
});

test("computerNeedsAttention and computerSummaryCounts surface offline, failed upgrades, low disk, and runtime issues", () => {
  const healthy = makeComputer({ id: "ok", computerVersion: "0.1.34" });
  const offline = makeComputer({ id: "off", online: false, computerVersion: "0.1.34" });
  const failedUpgrade = makeComputer({
    id: "fail",
    upgrade: {
      requestId: "req1",
      status: "failed",
      reason: "reported",
      errorCode: "UPGRADE_ROLLED_BACK",
    },
  });
  const lowDisk = makeComputer({
    id: "disk",
    computerVersion: "0.1.34",
    machine: {
      disk: {
        availableBytes: 5_000_000_000,
        totalBytes: 100_000_000_000,
        reportedAt: "2026-11-24T00:00:00Z",
      },
      memory: null,
    },
  });
  const signedOut = makeComputer({
    id: "auth",
    computerVersion: "0.1.34",
    runtimes: [
      { id: "r1", provider: "claude-code", version: "1", displayName: "Claude", isPublic: true },
    ],
    runtimeAuth: { "claude-code": { provider: "claude-code", state: "logged_out" } },
    runtimeUsages: {},
  });

  expect(computerNeedsAttention(healthy)).toBe(false);
  expect(computerNeedsAttention(offline)).toBe(true);
  expect(computerNeedsAttention(failedUpgrade)).toBe(true);
  expect(computerNeedsAttention(lowDisk)).toBe(true);
  expect(computerNeedsAttention(signedOut)).toBe(true);

  const summary = computerSummaryCounts([healthy, offline, failedUpgrade, lowDisk, signedOut]);
  expect(summary).toEqual({
    total: 5,
    online: 4,
    agents: 5,
    attention: 4,
  });
});

test("filterComputers, sortComputers, groupComputers, and visibleMeteredProviders handle multi-computer views", () => {
  const c1 = makeComputer({
    id: "c1",
    name: "prod-web-01",
    displayName: "prod-web-01",
    online: true,
    ownedByCurrentUser: false,
    machine: {
      disk: {
        availableBytes: 5_000_000_000,
        totalBytes: 100_000_000_000,
        reportedAt: "2026-11-24T00:00:00Z",
      },
      memory: {
        availableBytes: 60_000_000_000,
        totalBytes: 100_000_000_000,
        reportedAt: "2026-11-24T00:00:00Z",
      },
    },
  });
  const c2 = makeComputer({
    id: "c2",
    name: "prod-api-02",
    displayName: "prod-api-02",
    kind: "cloud",
    online: true,
    ownedByCurrentUser: true,
    runtimes: [
      { id: "r1", provider: "claude-code", version: "1", displayName: "Claude", isPublic: true },
      { id: "r2", provider: "codex", version: "1", displayName: "Codex", isPublic: true },
    ],
    runtimeAuth: {
      "claude-code": { provider: "claude-code", state: "logged_in" },
      codex: { provider: "codex", state: "logged_in" },
    },
    runtimeUsages: {
      codex: {
        state: "fresh",
        result: {
          workspaceId: "w",
          computerId: "c2",
          provider: "codex",
          scanId: "s2",
          status: "available",
          collectedAt: "2026-11-24T00:00:00Z",
          snapshot: {
            provider: "codex",
            primary: { usedPercent: 15, windowDurationMinutes: 300 },
          },
        },
      },
    },
    machine: {
      disk: {
        availableBytes: 70_000_000_000,
        totalBytes: 100_000_000_000,
        reportedAt: "2026-11-24T00:00:00Z",
      },
      memory: {
        availableBytes: 20_000_000_000,
        totalBytes: 100_000_000_000,
        reportedAt: "2026-11-24T00:00:00Z",
      },
    },
  });
  const c3 = makeComputer({
    id: "c3",
    name: "mac-studio",
    displayName: "mac-studio",
    online: false,
    ownedByCurrentUser: true,
    runtimes: [{ id: "r3", provider: "pi", version: "1", displayName: "Pi", isPublic: true }],
    runtimeAuth: {},
    runtimeUsages: {},
    agents: [{ id: "a3", name: "builder", displayName: "Builder Bot", avatarUrl: null }],
  });

  const all = [c1, c2, c3];
  expect(
    filterComputers(all, { query: "builder", status: "all", runtime: "all" }).map((c) => c.id),
  ).toEqual(["c3"]);
  expect(
    filterComputers(all, { query: "", status: "online", runtime: "claude-code" }).map((c) => c.id),
  ).toEqual(["c2"]);
  expect(
    filterComputers(all, { query: "", status: "all", runtime: "other" }).map((c) => c.id),
  ).toEqual(["c1", "c3"]);
  expect(
    filterComputers(all, { query: "", status: "attention", runtime: "all" }).map((c) => c.id),
  ).toEqual(["c1", "c3"]);

  expect(sortComputers(all, "disk").map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  expect(sortComputers(all, "memory").map((c) => c.id)).toEqual(["c2", "c1", "c3"]);
  expect(sortComputers(all, "runtime:codex").map((c) => c.id)).toEqual(["c2", "c1", "c3"]);
  expect(sortComputers(all, "attention").map((c) => c.id)).toEqual(["c3", "c1", "c2"]);

  expect(groupComputers(all, "owner").map((g) => [g.key, g.items.map((c) => c.id)])).toEqual([
    ["mine", ["c2", "c3"]],
    ["others", ["c1"]],
  ]);
  expect(groupComputers(all, "kind").map((g) => [g.key, g.items.map((c) => c.id)])).toEqual([
    ["cloud", ["c2"]],
    ["local", ["c1", "c3"]],
  ]);
  expect(groupComputers(all, "prefix").map((g) => [g.key, g.items.map((c) => c.id)])).toEqual([
    ["prod", ["c1", "c2"]],
    ["mac", ["c3"]],
  ]);

  expect(visibleMeteredProviders(all)).toEqual(["claude-code", "codex"]);
});

test("batchUpgradeCandidates returns owned online non-upgrading computers with newer runtime offers", () => {
  const ownAvailable = makeComputer({ id: "c1", computerVersion: "0.1.33" });
  const ownUpgrading = makeComputer({ id: "c2", computerVersion: "0.1.33" });
  const ownOffline = makeComputer({ id: "c3", online: false, computerVersion: "0.1.33" });
  const ownLatest = makeComputer({ id: "c4", computerVersion: "0.1.34" });
  const otherOwned = makeComputer({
    id: "c5",
    ownedByCurrentUser: false,
    computerVersion: "0.1.33",
  });

  const candidates = batchUpgradeCandidates(
    [ownAvailable, ownUpgrading, ownOffline, ownLatest, otherOwned],
    {
      latestVersions: new Map([["latest", "0.1.34"]]),
      upgradingIds: new Set(["c2"]),
    },
  );
  expect(candidates).toEqual([
    {
      computerId: "c1",
      label: "s144",
      currentVersion: "0.1.33",
      targetVersion: "0.1.34",
    },
  ]);
});
