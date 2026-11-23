import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  settledUpgradeFollow,
  upgradeFollowActive,
  upgradeRunning,
} from "#src/features/computers/computer-upgrade-follow";
import {
  activeUpgradingComputerIds,
  computerUpgradeSettledToastable,
  followComputerUpgrade,
  followedComputerUpgradesQuery,
  isComputerUpgradeSettled,
  markComputerUpgradeSettled,
  settleComputerUpgradeFollow,
  unfollowComputerUpgrade,
} from "#src/features/computers/computer-upgrade-status";
import {
  isUpgradeStatusCheckPending,
  resolveLiveUpgradeOutcome,
} from "#src/features/computers/use-computer-detail-lifecycle";
import type {
  ComputerUpgradeProgress,
  ComputerUpgradeStatus,
} from "#src/features/computers/computer.schemas";

const queryKey = ["computers", "upgrade", "computer-1", "req-1"] as const;

function accepted(now = Date.now()): ComputerUpgradeStatus {
  return {
    requestId: "req-1",
    status: "accepted",
    expectedVersion: "0.1.4-dev.2",
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    target: "runtime",
  };
}

function completed(): ComputerUpgradeStatus {
  return {
    requestId: "req-1",
    status: "completed",
    expectedVersion: "0.1.4-dev.2",
    computerVersion: "0.1.4-dev.2",
    daemonVersion: "0.1.4-dev.2",
    workerInstanceId: "worker-1",
    completedAt: new Date().toISOString(),
    target: "runtime",
  };
}

/** Same rule as `computerUpgradeStatusQuery`: an error is fresh forever, until a new read. */
function observe(client: QueryClient, queryFn: () => Promise<ComputerUpgradeStatus>) {
  return new QueryObserver(client, {
    queryKey,
    queryFn,
    retry: false,
    staleTime: (query) => (query.state.status === "error" ? Number.POSITIVE_INFINITY : 0),
  });
}

test("a running status stays followed and a finished one settles", () => {
  const running = accepted();
  expect(upgradeRunning(running)).toBe(true);
  expect(
    settledUpgradeFollow({ isError: false, isFetching: false, data: running }),
  ).toBeUndefined();

  const done = completed();
  expect(settledUpgradeFollow({ isError: false, isFetching: false, data: done })).toEqual({
    status: done,
  });
  expect(settledUpgradeFollow({ isError: true, isFetching: false, data: undefined })).toEqual({
    status: undefined,
  });
});

test("an in-flight recovery keeps the last error and stays followed", async () => {
  const running = accepted();
  let mode: "ok" | "fail" | "hang" = "ok";
  let releaseHang: (status: ComputerUpgradeStatus) => void = () => {};
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryFn = async () => {
    if (mode === "fail") throw new Error("poll failed");
    if (mode === "hang") {
      return await new Promise<ComputerUpgradeStatus>((resolve) => {
        releaseHang = resolve;
      });
    }
    return running;
  };

  let stopFirst: (() => void) | undefined;
  let stopRecovery: (() => void) | undefined;
  try {
    const first = observe(client, queryFn);
    stopFirst = first.subscribe(() => {});
    await first.refetch();
    expect(first.getCurrentResult().data).toEqual(running);

    mode = "fail";
    await first.refetch();
    const failed = first.getCurrentResult();
    expect(failed.isError).toBe(true);
    expect(failed.isFetching).toBe(false);
    expect(failed.data).toEqual(running);
    // A finished failed read stops the follow. Reopening Computers is what starts the next one.
    expect(settledUpgradeFollow(failed)).toEqual({ status: undefined });
    stopFirst();
    stopFirst = undefined;

    mode = "hang";
    const recovery = observe(client, queryFn);
    stopRecovery = recovery.subscribe(() => {});
    const during = recovery.getCurrentResult();
    expect(during.isError).toBe(true);
    expect(during.isFetching).toBe(true);
    expect(during.data).toEqual(running);
    // The old watcher treated this retained error as terminal and dropped the follow.
    expect(settledUpgradeFollow(during)).toBeUndefined();

    const pending = recovery.getCurrentQuery().fetch(undefined, { cancelRefetch: false });
    releaseHang(running);
    await pending;
    const recovered = recovery.getCurrentResult();
    expect(recovered.isError).toBe(false);
    expect(recovered.isFetching).toBe(false);
    expect(recovered.data).toEqual(running);
    expect(settledUpgradeFollow(recovered)).toBeUndefined();
  } finally {
    releaseHang(running);
    stopFirst?.();
    stopRecovery?.();
    client.clear();
  }
});

function progressBase(overrides: Partial<ComputerUpgradeProgress> = {}): ComputerUpgradeProgress {
  return {
    expectedVersion: "0.1.35-dev.2",
    expiresAt: 100_000,
    phase: "switching",
    switchState: "target_online",
    workspaces: [],
    ...overrides,
  };
}

test("completed status keeps following while target_online or visible workspaces are waiting", () => {
  const targetOnline: ComputerUpgradeStatus = {
    ...completed(),
    progress: progressBase({ switchState: "target_online", expiresAt: 100_000 }),
  };
  expect(upgradeFollowActive(targetOnline, 50_000)).toBe(true);
  expect(
    settledUpgradeFollow({ isError: false, isFetching: false, data: targetOnline }, 50_000),
  ).toBeUndefined();
  expect(upgradeFollowActive(targetOnline, 100_000)).toBe(false);
  expect(
    settledUpgradeFollow({ isError: false, isFetching: false, data: targetOnline }, 100_000),
  ).toEqual({ status: targetOnline });

  const partialRecovery: ComputerUpgradeStatus = {
    ...completed(),
    progress: progressBase({
      switchState: "confirmed",
      reconnectUntil: 80_000,
      workspaces: [
        { workspaceId: "ws-1", name: "Infra", state: "restored", confirmedAt: 20_000 },
        { workspaceId: "ws-2", name: "App", state: "waiting" },
      ],
    }),
  };
  expect(upgradeFollowActive(partialRecovery, 60_000)).toBe(true);
  expect(upgradeFollowActive(partialRecovery, 80_000)).toBe(false);

  const settledRecovery: ComputerUpgradeStatus = {
    ...completed(),
    progress: progressBase({
      switchState: "confirmed",
      reconnectUntil: 80_000,
      workspaces: [
        { workspaceId: "ws-1", name: "Infra", state: "restored", confirmedAt: 20_000 },
        { workspaceId: "ws-2", name: "App", state: "not_running" },
      ],
    }),
  };
  expect(upgradeFollowActive(settledRecovery, 60_000)).toBe(false);
});

test("settled request ids are not re-followed by loader recovery, and toastable gates on full recovery", () => {
  const client = new QueryClient();
  try {
    followComputerUpgrade(client, { computerId: "c1", requestId: "req-1", startedHere: false });
    expect(client.getQueryData(followedComputerUpgradesQuery.queryKey)).toHaveLength(1);

    markComputerUpgradeSettled(client, "req-1");
    expect(isComputerUpgradeSettled(client, "req-1")).toBe(true);
    expect(unfollowComputerUpgrade(client, "req-1")).toBe(true);

    followComputerUpgrade(client, { computerId: "c1", requestId: "req-1", startedHere: false });
    expect(client.getQueryData(followedComputerUpgradesQuery.queryKey)).toEqual([]);

    followComputerUpgrade(client, { computerId: "c1", requestId: "req-2", startedHere: false });
    expect(client.getQueryData(followedComputerUpgradesQuery.queryKey)).toHaveLength(1);
  } finally {
    client.clear();
  }

  expect(computerUpgradeSettledToastable(completed())).toBe(true);
  expect(
    computerUpgradeSettledToastable({
      ...completed(),
      progress: progressBase({ switchState: "target_online" }),
    }),
  ).toBe(false);
  expect(
    computerUpgradeSettledToastable({
      ...completed(),
      progress: progressBase({
        switchState: "confirmed",
        workspaces: [
          { workspaceId: "ws-1", name: "Infra", state: "restored", confirmedAt: 10 },
          { workspaceId: "ws-2", name: "App", state: "unconfirmed" },
        ],
      }),
    }),
  ).toBe(false);
  expect(
    computerUpgradeSettledToastable({
      ...completed(),
      progress: progressBase({
        switchState: "confirmed",
        workspaces: [
          { workspaceId: "ws-1", name: "Infra", state: "restored", confirmedAt: 10 },
          { workspaceId: "ws-2", name: "App", state: "not_running" },
        ],
      }),
    }),
  ).toBe(true);
});

test("read error unfollows without marking settled so revisiting Computers recovers, while terminal status deduplicates", () => {
  const client = new QueryClient();
  try {
    followComputerUpgrade(client, { computerId: "c1", requestId: "req-err", startedHere: false });
    expect(settleComputerUpgradeFollow(client, "req-err", undefined)).toBe(false);
    expect(client.getQueryData(followedComputerUpgradesQuery.queryKey)).toEqual([]);
    expect(isComputerUpgradeSettled(client, "req-err")).toBe(false);

    followComputerUpgrade(client, { computerId: "c1", requestId: "req-err", startedHere: false });
    expect(client.getQueryData(followedComputerUpgradesQuery.queryKey)).toHaveLength(1);

    expect(settleComputerUpgradeFollow(client, "req-err", completed())).toBe(true);
    expect(isComputerUpgradeSettled(client, "req-err")).toBe(true);
    expect(client.getQueryData(followedComputerUpgradesQuery.queryKey)).toEqual([]);

    followComputerUpgrade(client, { computerId: "c1", requestId: "req-err", startedHere: false });
    expect(client.getQueryData(followedComputerUpgradesQuery.queryKey)).toEqual([]);
  } finally {
    client.clear();
  }
});

test("an expired status settles without leaving a recoverable read error", () => {
  const client = new QueryClient();
  try {
    const upgrade = { computerId: "c1", requestId: "req-expired", startedHere: false };
    followComputerUpgrade(client, upgrade);
    const result = settledUpgradeFollow({ isError: false, isFetching: false, data: null });
    expect(result).toEqual({ status: null });
    expect(settleComputerUpgradeFollow(client, upgrade.requestId, result?.status)).toBe(true);
    followComputerUpgrade(client, upgrade);
    expect(client.getQueryData(followedComputerUpgradesQuery.queryKey)).toEqual([]);
  } finally {
    client.clear();
  }
});

test("pointer-only recovery never synthesizes running before the first status read returns", () => {
  const pendingRead = { data: undefined, isError: false, isFetching: true, error: null };
  expect(
    resolveLiveUpgradeOutcome({
      liveStatus: pendingRead,
      upgradeRequestState: "idle",
      storedOutcome: undefined,
    }),
  ).toBeUndefined();
  expect(
    resolveLiveUpgradeOutcome({
      liveStatus: pendingRead,
      upgradeRequestState: "accepted",
      storedOutcome: undefined,
    }),
  ).toEqual({ state: "running" });
  expect(
    resolveLiveUpgradeOutcome({
      liveStatus: pendingRead,
      upgradeRequestState: "idle",
      storedOutcome: { state: "running", version: "0.1.35-dev.5" },
    }),
  ).toBeUndefined();
  expect(
    resolveLiveUpgradeOutcome({
      liveStatus: { data: accepted(), isError: false, isFetching: false, error: null },
      upgradeRequestState: "idle",
      storedOutcome: undefined,
    }),
  ).toEqual({ state: "running", version: "0.1.4-dev.2" });

  expect([
    ...activeUpgradingComputerIds(
      [{ computerId: "c1", requestId: "req-1", startedHere: false }],
      [undefined],
    ),
  ]).toEqual([]);
  expect([
    ...activeUpgradingComputerIds(
      [{ computerId: "c1", requestId: "req-1", startedHere: true }],
      [undefined],
    ),
  ]).toEqual(["c1"]);
  expect([
    ...activeUpgradingComputerIds(
      [{ computerId: "c1", requestId: "req-1", startedHere: false }],
      [accepted()],
    ),
  ]).toEqual(["c1"]);
  expect([
    ...activeUpgradingComputerIds(
      [{ computerId: "c1", requestId: "req-1", startedHere: false }],
      [completed()],
    ),
  ]).toEqual([]);

  expect(
    isUpgradeStatusCheckPending({
      followedUpgradeId: "req-1",
      liveStatus: pendingRead,
    }),
  ).toBe(true);
  expect(
    isUpgradeStatusCheckPending({
      followedUpgradeId: "req-1",
      liveStatus: { data: null, isError: false, isFetching: false },
    }),
  ).toBe(false);
  expect(
    isUpgradeStatusCheckPending({
      followedUpgradeId: "req-1",
      liveStatus: { data: completed(), isError: false, isFetching: false },
    }),
  ).toBe(false);
  expect(
    isUpgradeStatusCheckPending({
      followedUpgradeId: "req-1",
      liveStatus: { data: undefined, isError: true, isFetching: false },
    }),
  ).toBe(true);
  expect(
    isUpgradeStatusCheckPending({
      followedUpgradeId: null,
      liveStatus: undefined,
    }),
  ).toBe(false);
});

test("same-id stale cached accepted never overrides terminal loader failed or completed status", () => {
  const cachedAccepted: ComputerUpgradeStatus = {
    status: "accepted",
    requestId: "req-1",
    expectedVersion: "0.1.35-dev.5",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
  const storedFailed: ComputerUpgradeStatus = {
    status: "failed",
    requestId: "req-1",
    reason: "reported",
    error: "download failed",
  };
  const storedCompleted: ComputerUpgradeStatus = {
    status: "completed",
    requestId: "req-1",
    expectedVersion: "0.1.35-dev.5",
    computerVersion: "0.1.35-dev.5",
    daemonVersion: "0.1.35-dev.5",
    workerInstanceId: "worker-1",
    completedAt: new Date().toISOString(),
  };
  const failedOutcome = {
    state: "failed" as const,
    failure: { headline: "failed", steps: [] },
  };
  expect(
    resolveLiveUpgradeOutcome({
      liveStatus: { data: cachedAccepted, isError: false, isFetching: true, error: null },
      upgradeRequestState: "idle",
      storedOutcome: failedOutcome,
      storedUpgrade: storedFailed,
    }),
  ).toEqual(failedOutcome);
  expect(
    resolveLiveUpgradeOutcome({
      liveStatus: { data: cachedAccepted, isError: false, isFetching: false, error: null },
      upgradeRequestState: "idle",
      storedOutcome: { state: "succeeded", version: "0.1.35-dev.5" },
      storedUpgrade: storedCompleted,
    }),
  ).toEqual({ state: "succeeded", version: "0.1.35-dev.5" });
  expect(
    resolveLiveUpgradeOutcome({
      liveStatus: { data: cachedAccepted, isError: false, isFetching: false, error: null },
      upgradeRequestState: "idle",
      storedOutcome: { state: "running", version: "0.1.35-dev.5" },
      storedUpgrade: cachedAccepted,
    }),
  ).toEqual({ state: "running", version: "0.1.35-dev.5" });
  expect([
    ...activeUpgradingComputerIds(
      [{ computerId: "c1", requestId: "req-1", startedHere: false }],
      [cachedAccepted],
      Date.now(),
      new Set(["req-1"]),
    ),
  ]).toEqual([]);
  expect([
    ...activeUpgradingComputerIds(
      [{ computerId: "c1", requestId: "req-1", startedHere: false }],
      [cachedAccepted],
      Date.now(),
      undefined,
      [1_000],
      2_000,
    ),
  ]).toEqual([]);
  expect([
    ...activeUpgradingComputerIds(
      [{ computerId: "c1", requestId: "req-1", startedHere: false }],
      [cachedAccepted],
      Date.now(),
      undefined,
      [2_500],
      2_000,
    ),
  ]).toEqual(["c1"]);

  expect(
    resolveLiveUpgradeOutcome({
      liveStatus: {
        data: cachedAccepted,
        dataUpdatedAt: 1_000,
        isError: false,
        isFetching: true,
        error: null,
      },
      upgradeRequestState: "idle",
      storedOutcome: { state: "running", version: "0.1.35-dev.5" },
      storedUpgrade: cachedAccepted,
      mountedAt: 2_000,
    }),
  ).toBeUndefined();
  expect(
    isUpgradeStatusCheckPending({
      followedUpgradeId: "req-1",
      liveStatus: {
        data: cachedAccepted,
        dataUpdatedAt: 1_000,
        isError: false,
        isFetching: true,
      },
      upgradeRequestState: "idle",
      mountedAt: 2_000,
    }),
  ).toBe(true);
  expect(
    resolveLiveUpgradeOutcome({
      liveStatus: {
        data: cachedAccepted,
        dataUpdatedAt: 2_500,
        isError: false,
        isFetching: false,
        error: null,
      },
      upgradeRequestState: "idle",
      storedOutcome: { state: "running", version: "0.1.35-dev.5" },
      storedUpgrade: cachedAccepted,
      mountedAt: 2_000,
    }),
  ).toEqual({ state: "running", version: "0.1.35-dev.5" });
  expect(
    isUpgradeStatusCheckPending({
      followedUpgradeId: "req-1",
      liveStatus: {
        data: cachedAccepted,
        dataUpdatedAt: 2_500,
        isError: false,
        isFetching: false,
      },
      upgradeRequestState: "idle",
      mountedAt: 2_000,
    }),
  ).toBe(false);

  const cachedAcceptedWithProgress: ComputerUpgradeStatus = {
    ...cachedAccepted,
    progress: progressBase({ phase: "downloading" }),
  };
  expect(
    resolveLiveUpgradeOutcome({
      liveStatus: {
        data: cachedAcceptedWithProgress,
        dataUpdatedAt: 1_000,
        isError: false,
        isFetching: true,
        error: null,
      },
      upgradeRequestState: "idle",
      storedOutcome: { state: "running", version: "0.1.35-dev.5" },
      storedUpgrade: cachedAccepted,
      mountedAt: 2_000,
    }),
  ).toEqual({ state: "running", version: "0.1.35-dev.5" });
  expect([
    ...activeUpgradingComputerIds(
      [{ computerId: "c1", requestId: "req-1", startedHere: false }],
      [cachedAcceptedWithProgress],
      Date.now(),
      undefined,
      [1_000],
      2_000,
    ),
  ]).toEqual(["c1"]);

  const cachedAcceptedWithEmptyProgress: ComputerUpgradeStatus = {
    ...cachedAccepted,
    progress: progressBase({ phase: undefined, switchState: "pending", workspaces: [] }),
  };
  expect(
    resolveLiveUpgradeOutcome({
      liveStatus: {
        data: cachedAcceptedWithEmptyProgress,
        dataUpdatedAt: 1_000,
        isError: false,
        isFetching: true,
        error: null,
      },
      upgradeRequestState: "idle",
      storedOutcome: { state: "running", version: "0.1.35-dev.5" },
      storedUpgrade: cachedAccepted,
      mountedAt: 2_000,
    }),
  ).toBeUndefined();
  expect(
    isUpgradeStatusCheckPending({
      followedUpgradeId: "req-1",
      liveStatus: {
        data: cachedAcceptedWithEmptyProgress,
        dataUpdatedAt: 1_000,
        isError: false,
        isFetching: true,
      },
      upgradeRequestState: "idle",
      mountedAt: 2_000,
    }),
  ).toBe(true);
  expect([
    ...activeUpgradingComputerIds(
      [{ computerId: "c1", requestId: "req-1", startedHere: false }],
      [cachedAcceptedWithEmptyProgress],
      Date.now(),
      undefined,
      [1_000],
      2_000,
    ),
  ]).toEqual([]);
});
