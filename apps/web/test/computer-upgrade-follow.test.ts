import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  settledUpgradeFollow,
  upgradeRunning,
} from "#src/features/computers/computer-upgrade-follow";
import type { ComputerUpgradeStatus } from "#src/features/computers/computer.schemas";

const queryKey = ["computers", "upgrade", "computer-1", "req-1"] as const;

function accepted(now = Date.now()): ComputerUpgradeStatus {
  return {
    requestId: "req-1",
    status: "accepted",
    expectedVersion: "0.1.4-dev.2",
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
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
