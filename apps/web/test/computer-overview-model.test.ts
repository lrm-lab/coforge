import { expect, test } from "bun:test";

import {
  batchUpgradeCandidates,
  computerHasRuntimeAttention,
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

  const signedOutUsed = makeComputer({
    agents: [
      {
        id: "a1",
        name: "claude-bot",
        displayName: "Claude Bot",
        avatarUrl: null,
        provider: "claude-code",
      },
    ],
    runtimeAuth: { "claude-code": { provider: "claude-code", state: "logged_out" } },
    runtimeUsages: {},
  });
  expect(computerRuntimeMeter(signedOutUsed, "claude-code")).toEqual({ kind: "attention" });

  const signedOutUnused = makeComputer({
    runtimeAuth: { "claude-code": { provider: "claude-code", state: "logged_out" } },
    runtimeUsages: {},
  });
  expect(computerRuntimeMeter(signedOutUnused, "claude-code")).toEqual({ kind: "unmeasured" });

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
    agents: [
      {
        id: "a-claude",
        name: "claude-bot",
        displayName: "Claude Bot",
        avatarUrl: null,
        provider: "claude-code",
      },
    ],
    runtimeAuth: { "claude-code": { provider: "claude-code", state: "logged_out" } },
    runtimeUsages: {},
  });
  const signedOutUnused = makeComputer({
    id: "unused-auth",
    computerVersion: "0.1.34",
    runtimes: [
      { id: "r1", provider: "claude-code", version: "1", displayName: "Claude", isPublic: true },
      { id: "r2", provider: "codex", version: "1", displayName: "Codex", isPublic: true },
    ],
    agents: [
      {
        id: "a-codex",
        name: "codex-bot",
        displayName: "Codex Bot",
        avatarUrl: null,
        provider: "codex",
      },
    ],
    runtimeAuth: {
      "claude-code": { provider: "claude-code", state: "logged_out" },
      codex: { provider: "codex", state: "logged_in" },
    },
  });

  expect(computerNeedsAttention(healthy)).toBe(false);
  expect(computerNeedsAttention(offline)).toBe(true);
  expect(computerNeedsAttention(failedUpgrade)).toBe(true);
  expect(computerNeedsAttention(lowDisk)).toBe(true);
  expect(computerNeedsAttention(signedOut)).toBe(true);
  expect(computerNeedsAttention(signedOutUnused)).toBe(false);
  expect(computerHasRuntimeAttention(signedOutUnused)).toBe(false);

  const summary = computerSummaryCounts([
    healthy,
    offline,
    failedUpgrade,
    lowDisk,
    signedOut,
    signedOutUnused,
  ]);
  expect(summary).toEqual({
    total: 6,
    online: 5,
    agents: 6,
    attention: 4,
  });
  expect(
    filterComputers([healthy, signedOut, signedOutUnused], {
      query: "",
      status: "attention",
      runtime: "all",
    }).map((c) => c.id),
  ).toEqual(["auth"]);
  expect(
    sortComputers([healthy, signedOutUnused, signedOut], "attention").map((c) => c.id),
  ).toEqual(["auth", "ok", "unused-auth"]);
});

test("unused exhausted runtime does not mark a healthy computer as needing attention", () => {
  const exhaustedUnused = makeComputer({
    id: "exhausted-unused",
    runtimes: [
      { id: "r1", provider: "claude-code", version: "1", displayName: "Claude", isPublic: true },
      { id: "r2", provider: "codex", version: "1", displayName: "Codex", isPublic: true },
    ],
    agents: [
      { id: "a1", name: "codex-bot", displayName: "Codex Bot", avatarUrl: null, provider: "codex" },
    ],
    runtimeAuth: {
      "claude-code": { provider: "claude-code", state: "logged_in" },
      codex: { provider: "codex", state: "logged_in" },
    },
    runtimeUsages: {
      "claude-code": {
        state: "fresh",
        result: {
          workspaceId: "w",
          computerId: "exhausted-unused",
          provider: "claude-code",
          scanId: "s1",
          status: "available",
          collectedAt: "2026-11-24T00:00:00Z",
          snapshot: {
            provider: "claude-code",
            primary: { usedPercent: 100, status: "limit_reached", windowDurationMinutes: 300 },
          },
        },
      },
    },
  });
  expect(computerRuntimeMeter(exhaustedUnused, "claude-code")).toEqual({
    kind: "meter",
    usedPercent: 100,
    leftPercent: 0,
    level: "empty",
    limitReached: true,
  });
  expect(computerHasRuntimeAttention(exhaustedUnused)).toBe(false);
  expect(computerNeedsAttention(exhaustedUnused)).toBe(false);

  const exhaustedUsed = {
    ...exhaustedUnused,
    agents: [
      ...exhaustedUnused.agents,
      {
        id: "a2",
        name: "claude-bot",
        displayName: "Claude Bot",
        avatarUrl: null,
        provider: "claude-code" as const,
      },
    ],
  };
  expect(computerHasRuntimeAttention(exhaustedUsed)).toBe(true);
  expect(computerNeedsAttention(exhaustedUsed)).toBe(true);

  const offlineNoAgents = makeComputer({ id: "offline-empty", online: false, agents: [] });
  expect(computerNeedsAttention(offlineNoAgents)).toBe(true);
});

test("Claude Agent with own or unknown credentials does not trigger computer shared-auth attention", () => {
  const ownCredentialOnly = makeComputer({
    id: "own-cred",
    runtimes: [
      { id: "r1", provider: "claude-code", version: "1", displayName: "Claude", isPublic: true },
      { id: "r2", provider: "codex", version: "1", displayName: "Codex", isPublic: true },
    ],
    agents: [
      {
        id: "a-claude-own",
        name: "claude-own",
        displayName: "Claude Own",
        avatarUrl: null,
        provider: "claude-code",
        runtimeAuthSource: "own",
      },
    ],
    runtimeAuth: {
      "claude-code": { provider: "claude-code", state: "logged_out" },
      codex: { provider: "codex", state: "logged_in" },
    },
    runtimeUsages: {},
  });
  expect(computerRuntimeMeter(ownCredentialOnly, "claude-code")).toEqual({ kind: "unmeasured" });
  expect(computerHasRuntimeAttention(ownCredentialOnly)).toBe(false);
  expect(computerNeedsAttention(ownCredentialOnly)).toBe(false);
  expect(computerSummaryCounts([ownCredentialOnly]).attention).toBe(0);
  expect(
    filterComputers([ownCredentialOnly], { query: "", status: "attention", runtime: "all" }),
  ).toEqual([]);

  const unknownCredential = {
    ...ownCredentialOnly,
    agents: [
      {
        id: "a-claude-unknown",
        name: "claude-unknown",
        displayName: "Claude Unknown",
        avatarUrl: null,
        provider: "claude-code" as const,
        runtimeAuthSource: "unknown" as const,
      },
    ],
  };
  expect(computerRuntimeMeter(unknownCredential, "claude-code")).toEqual({ kind: "unmeasured" });
  expect(computerHasRuntimeAttention(unknownCredential)).toBe(false);
  expect(computerNeedsAttention(unknownCredential)).toBe(false);

  const sharedCredential = {
    ...ownCredentialOnly,
    agents: [
      ...ownCredentialOnly.agents,
      {
        id: "a-claude-shared",
        name: "claude-shared",
        displayName: "Claude Shared",
        avatarUrl: null,
        provider: "claude-code" as const,
        runtimeAuthSource: "shared" as const,
      },
    ],
  };
  expect(computerRuntimeMeter(sharedCredential, "claude-code")).toEqual({ kind: "attention" });
  expect(computerHasRuntimeAttention(sharedCredential)).toBe(true);
  expect(computerNeedsAttention(sharedCredential)).toBe(true);
  expect(computerSummaryCounts([sharedCredential]).attention).toBe(1);
});

test("Grok exhausted quota alerts only when a default shared-source Grok Agent exists", () => {
  const exhaustedGrokUsage = {
    grok: {
      state: "fresh" as const,
      result: {
        workspaceId: "w",
        computerId: "grok-1",
        provider: "grok" as const,
        scanId: "s-grok",
        status: "available" as const,
        collectedAt: "2026-11-24T00:00:00Z",
        snapshot: {
          provider: "grok" as const,
          primary: {
            usedPercent: 100,
            status: "limit_reached" as const,
            windowDurationMinutes: 300,
          },
        },
      },
    },
  };
  const grokBase = makeComputer({
    id: "grok-1",
    runtimes: [
      { id: "r-grok", provider: "grok", version: "1", displayName: "Grok", isPublic: true },
    ],
    runtimeAuth: {},
    runtimeUsages: exhaustedGrokUsage,
  });

  const grokNoAgent = { ...grokBase, agents: [] };
  expect(computerHasRuntimeAttention(grokNoAgent)).toBe(false);
  expect(computerNeedsAttention(grokNoAgent)).toBe(false);

  const grokOwnAgent = {
    ...grokBase,
    agents: [
      {
        id: "g-own",
        name: "grok-own",
        displayName: "Grok Own",
        avatarUrl: null,
        provider: "grok" as const,
        runtimeAuthSource: "own" as const,
      },
    ],
  };
  expect(computerHasRuntimeAttention(grokOwnAgent)).toBe(false);
  expect(computerNeedsAttention(grokOwnAgent)).toBe(false);

  const grokSharedAgent = {
    ...grokBase,
    agents: [
      {
        id: "g-shared",
        name: "grok-shared",
        displayName: "Grok Shared",
        avatarUrl: null,
        provider: "grok" as const,
        runtimeAuthSource: "shared" as const,
      },
    ],
  };
  expect(computerHasRuntimeAttention(grokSharedAgent)).toBe(true);
  expect(computerNeedsAttention(grokSharedAgent)).toBe(true);
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
