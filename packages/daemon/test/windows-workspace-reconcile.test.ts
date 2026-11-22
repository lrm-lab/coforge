import { expect, test } from "bun:test";

import {
  startWorkspaceReconcileLoop,
  WINDOWS_WORKSPACE_RECONCILE_MS,
} from "#src/supervisor/windows-workspace-reconcile";
import { WORKSPACE_RELAUNCH_SECONDS } from "#src/supervisor/workspace-instance";

test("the Coordinator checks Windows Workspace children once per shared relaunch bound", () => {
  expect(WINDOWS_WORKSPACE_RECONCILE_MS).toBe(WORKSPACE_RELAUNCH_SECONDS * 1_000);
});

test("reconcile loop is null outside win32 without upgrade recovery", async () => {
  expect(await startWorkspaceReconcileLoop(async () => {}, { platform: "linux" })).toBeNull();
  expect(await startWorkspaceReconcileLoop(async () => {}, { platform: "darwin" })).toBeNull();
});

test("upgrade recovery can schedule the same reconcile bounds on macOS and Linux", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    let interval: number | undefined;
    const loop = await startWorkspaceReconcileLoop(async () => {}, {
      platform,
      pendingUpgradeWorkspaces: async () => ["beta"],
      setIntervalFn: ((_: unknown, delay?: number) => {
        interval = delay;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });
    expect(interval).toBe(WINDOWS_WORKSPACE_RECONCILE_MS);
    loop?.stop();
  }
});

test("win32 reconcile loop schedules reconcile and stops clearing the timer", async () => {
  const calls: number[] = [];
  let scheduled: (() => void) | undefined;
  let cleared = false;
  const loop = await startWorkspaceReconcileLoop(
    async () => {
      calls.push(Date.now());
    },
    {
      platform: "win32",
      intervalMs: WINDOWS_WORKSPACE_RECONCILE_MS,
      setIntervalFn: ((handler: () => void) => {
        scheduled = handler;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: (() => {
        cleared = true;
      }) as typeof clearInterval,
    },
  );
  expect(loop).not.toBeNull();
  expect(scheduled).toBeTypeOf("function");
  scheduled!();
  await Bun.sleep(0);
  expect(calls).toHaveLength(1);
  // Overlapping ticks are ignored while reconcile is in flight.
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = await startWorkspaceReconcileLoop(() => blocked, {
    platform: "win32",
    setIntervalFn: ((handler: () => void) => {
      scheduled = handler;
      return 2 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: clearInterval,
  });
  scheduled!();
  scheduled!();
  release();
  await Bun.sleep(0);
  slow?.stop();
  loop?.stop();
  expect(cleared).toBe(true);
});

test("win32 reconcile loop reports errors without throwing from the timer", async () => {
  const errors: unknown[] = [];
  let scheduled: (() => void) | undefined;
  const loop = await startWorkspaceReconcileLoop(
    async () => {
      throw new Error("reconcile blew up");
    },
    {
      platform: "win32",
      setIntervalFn: ((handler: () => void) => {
        scheduled = handler;
        return 3 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
      onError: (error) => errors.push(error),
    },
  );
  scheduled!();
  await Bun.sleep(0);
  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toBe("reconcile blew up");
  loop?.stop();
});

test("Unix reconcile waits for one receipt scan and stops when no upgrade work remains", async () => {
  const scan = Promise.withResolvers<string[]>();
  let scheduled!: () => void;
  let scans = 0;
  let reconciles = 0;
  let cleared = false;
  const loop = await startWorkspaceReconcileLoop(
    async () => {
      reconciles++;
    },
    {
      platform: "darwin",
      pendingUpgradeWorkspaces: async () => (++scans === 1 ? ["beta"] : scan.promise),
      setIntervalFn: ((handler: () => void) => {
        scheduled = handler;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: (() => {
        cleared = true;
      }) as typeof clearInterval,
    },
  );
  expect(loop).not.toBeNull();
  scheduled();
  scheduled();
  expect(scans).toBe(2);
  scan.resolve([]);
  await Bun.sleep(0);
  expect(cleared).toBeTrue();
  expect(reconciles).toBe(0);
});
