import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  settledUpgradeFollow,
  upgradeFollowActive,
  upgradeRunning,
} from "#src/features/computers/computer-upgrade-follow";
import {
  computerUpgradeSettledToastable,
  followComputerUpgrade,
  followedComputerUpgradesQuery,
  isComputerUpgradeSettled,
  markComputerUpgradeSettled,
  settleComputerUpgradeFollow,
  unfollowComputerUpgrade,
} from "#src/features/computers/computer-upgrade-status";
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
