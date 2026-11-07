import { test, expect, mock } from "bun:test";
import {
  UPGRADE_ERROR_CODE,
  type DaemonCommandRequest,
  type ManagedRuntimeIdentity,
} from "@lrm/coforge-sdk/internal";

import { runWorkspaceLifecycleCommand } from "#src/supervisor/run-supervisor-workspace-lifecycle";
import { UpgradeOperationPendingError } from "#src/supervisor/upgrade-error";

/** `command()`'s workspace-scoped lifecycle (task #417 step 3): upgrade records and launches,
 * upgrade_ack acknowledges, detach detaches and answers the view — start/stop/restart are not
 * this branch's and come back `undefined` for the caller's own dispatch. */
const deps = (overrides: Partial<Parameters<typeof runWorkspaceLifecycleCommand>[0]> = {}) => ({
  method: "",
  request: {} as DaemonCommandRequest,
  supervisor: {} as Parameters<typeof runWorkspaceLifecycleCommand>[0]["supervisor"],
  workspaceDirectory: (id: string) => `/ws/${id}`,
  stateDirectory: "/state",
  refreshChildUpgradeConfig: mock(async () => {}),
  completeUpgrade: mock(async () => {}),
  watchPendingUpgrade: mock(async () => {}),
  launchComputerUpgrade: mock(async () => {}),
  makeSelfClient: () => ({
    detach: async () => ({ ok: true as const, value: "detached" as const }),
  }),
  view: async () => [] as ManagedRuntimeIdentity[],
  ownServerUrl: "http://server",
  ...overrides,
});

test("daemon:start, daemon:stop and daemon:restart are not this branch's", async () => {
  for (const method of ["daemon:start", "daemon:stop", "daemon:restart"]) {
    expect(await runWorkspaceLifecycleCommand(deps({ method }))).toBeUndefined();
  }
});

test("daemon:upgrade records, launches and watches, answering undefined for the caller's view", async () => {
  const supervisor = {
    recordUpgrade: mock(async () => true),
  };
  const d = deps({
    method: "daemon:upgrade",
    request: {
      workspaceId: "ws",
      requestId: "req",
      expectedVersion: "2",
    } as DaemonCommandRequest,
    supervisor: supervisor as never,
  });
  expect(await runWorkspaceLifecycleCommand(d)).toBeUndefined();
  expect(supervisor.recordUpgrade).toHaveBeenCalledWith("ws", "req", "2");
  expect(d.refreshChildUpgradeConfig).toHaveBeenCalledWith("ws");
  expect(d.launchComputerUpgrade).toHaveBeenCalled();
  expect(d.watchPendingUpgrade).toHaveBeenCalledWith("ws", "req", expect.any(Number));
});

test("daemon:upgrade_ack acknowledges and refreshes, answering undefined", async () => {
  const supervisor = {
    acknowledgeUpgrade: mock(async () => true),
  };
  const d = deps({
    method: "daemon:upgrade_ack",
    request: { workspaceId: "ws", requestId: "req" } as DaemonCommandRequest,
    supervisor: supervisor as never,
  });
  expect(await runWorkspaceLifecycleCommand(d)).toBeUndefined();
  expect(supervisor.acknowledgeUpgrade).toHaveBeenCalledWith("ws", "req");
  expect(d.refreshChildUpgradeConfig).toHaveBeenCalledWith("ws");
});

test("daemon:detach detaches and answers the view; an unconfirmed answer refuses", async () => {
  const supervisor = {
    detach: mock(async () => ({ detached: true })),
  };
  const d = deps({
    method: "daemon:detach",
    request: { workspaceId: "ws" } as DaemonCommandRequest,
    supervisor: supervisor as never,
  });
  // The keyed marker rides the view: a revoked key's detach answers detach_key_revoked so the
  // caller says "key revoked", not "detached" (task #417).
  expect(await runWorkspaceLifecycleCommand(d)).toEqual({
    runtimes: [],
    detachKeyRevoked: false,
  });
  expect(supervisor.detach).toHaveBeenCalledWith("ws", expect.objectContaining({}));

  supervisor.detach = mock(async () => ({ detached: false, reason: "unconfirmed" as const }));
  await expect(runWorkspaceLifecycleCommand(d)).rejects.toMatchObject({
    code: "detach_unconfirmed",
    workspaceId: "ws",
  });
});

test("daemon:detach passes the request's target to the supervisor only on this server's origin", async () => {
  // The sk_computer goes only to a serverHttpUrl naming THIS Coordinator — a request naming
  // another drops the target so the key never leaves here (task #417).
  const supervisor = {
    detach: mock(async () => ({ detached: true })),
  };
  const detach = (serverHttpUrl: string) =>
    runWorkspaceLifecycleCommand(
      deps({
        method: "daemon:detach",
        request: {
          workspaceId: "ws",
          computerId: "computer-a",
          serverHttpUrl,
        } as DaemonCommandRequest,
        supervisor: supervisor as never,
      }),
    );

  await detach("http://server");
  expect(supervisor.detach).toHaveBeenLastCalledWith(
    "ws",
    expect.objectContaining({
      target: { computerId: "computer-a", serverHttpUrl: "http://server" },
    }),
  );
  await detach("http://server.evil.example");
  expect(supervisor.detach).toHaveBeenLastCalledWith(
    "ws",
    expect.objectContaining({ target: undefined }),
  );
});

test("daemon:computer_upgrade admits machine-wide, refreshes every child, launches and watches each copy", async () => {
  const pending = {
    requestId: "req",
    expectedVersion: "2",
    state: "pending" as const,
    requestedAt: 7,
  };
  const supervisor = {
    snapshot: mock(async () => [
      { workspaceId: "a", upgradeOperations: [pending] },
      { workspaceId: "b", upgradeOperations: [pending] },
    ]),
    recordUpgrade: mock(async () => true),
  };
  const d = deps({
    method: "daemon:computer_upgrade",
    request: { requestId: "req", expectedVersion: "2" } as DaemonCommandRequest,
    supervisor: supervisor as never,
  });
  expect(await runWorkspaceLifecycleCommand(d)).toBeUndefined();
  // Admission names no Workspace: any current binding satisfies recordUpgrade's local check,
  // and the record it writes fans out onto every binding.
  expect(supervisor.recordUpgrade).toHaveBeenCalledWith("a", "req", "2");
  expect(d.refreshChildUpgradeConfig).toHaveBeenCalledTimes(2);
  expect(d.refreshChildUpgradeConfig).toHaveBeenCalledWith("a");
  expect(d.refreshChildUpgradeConfig).toHaveBeenCalledWith("b");
  expect(d.launchComputerUpgrade).toHaveBeenCalledWith("req", "2", { stateDirectory: "/state" });
  expect(d.watchPendingUpgrade).toHaveBeenCalledWith("a", "req", 7);
  expect(d.watchPendingUpgrade).toHaveBeenCalledWith("b", "req", 7);
});

test("daemon:computer_upgrade replay and pending refusal never launch a second job", async () => {
  const replay = deps({
    method: "daemon:computer_upgrade",
    request: { requestId: "req", expectedVersion: "2" } as DaemonCommandRequest,
    supervisor: {
      snapshot: mock(async () => [{ workspaceId: "a", upgradeOperations: [] }]),
      recordUpgrade: mock(async () => false),
    } as never,
  });
  expect(await runWorkspaceLifecycleCommand(replay)).toBeUndefined();
  expect(replay.launchComputerUpgrade).not.toHaveBeenCalled();
  expect(replay.watchPendingUpgrade).not.toHaveBeenCalled();
  expect(replay.refreshChildUpgradeConfig).not.toHaveBeenCalled();

  const refused = deps({
    method: "daemon:computer_upgrade",
    request: { requestId: "req", expectedVersion: "2" } as DaemonCommandRequest,
    supervisor: {
      snapshot: mock(async () => [{ workspaceId: "a", upgradeOperations: [] }]),
      recordUpgrade: mock(async () => {
        throw new UpgradeOperationPendingError("still pending");
      }),
    } as never,
  });
  await expect(runWorkspaceLifecycleCommand(refused)).rejects.toBeInstanceOf(
    UpgradeOperationPendingError,
  );
  expect(refused.launchComputerUpgrade).not.toHaveBeenCalled();
});

test("daemon:computer_upgrade with no bindings launches unrecorded; a launch failure settles every copy", async () => {
  const recordUpgrade = mock(async () => true);
  const empty = deps({
    method: "daemon:computer_upgrade",
    request: { requestId: "req", expectedVersion: "2" } as DaemonCommandRequest,
    supervisor: {
      snapshot: mock(async () => []),
      recordUpgrade,
    } as never,
  });
  expect(await runWorkspaceLifecycleCommand(empty)).toBeUndefined();
  // No binding means no recordUpgrade call at all — the installer lock is the only guard.
  expect(recordUpgrade).not.toHaveBeenCalled();
  expect(empty.launchComputerUpgrade).toHaveBeenCalledWith("req", "2", {
    stateDirectory: "/state",
  });

  const pending = {
    requestId: "req",
    expectedVersion: "2",
    state: "pending" as const,
    requestedAt: 7,
  };
  const failed = deps({
    method: "daemon:computer_upgrade",
    request: { requestId: "req", expectedVersion: "2" } as DaemonCommandRequest,
    supervisor: {
      snapshot: mock(async () => [
        { workspaceId: "a", upgradeOperations: [pending] },
        { workspaceId: "b", upgradeOperations: [pending] },
      ]),
      recordUpgrade: mock(async () => true),
    } as never,
    launchComputerUpgrade: mock(async () => {
      throw new Error("spawn refused");
    }),
    completeUpgrade: mock(async () => true),
  });
  await expect(runWorkspaceLifecycleCommand(failed)).rejects.toMatchObject({
    name: "UpgradeLaunchFailedError",
    code: UPGRADE_ERROR_CODE.LAUNCH_FAILED,
  });
  // The launch failure settles the pending copy on every binding that carries it.
  expect(failed.completeUpgrade).toHaveBeenCalledTimes(2);
  expect(failed.completeUpgrade).toHaveBeenCalledWith("a", "req", {
    requestId: "req",
    status: "failed",
    at: expect.any(Number),
    error: "spawn refused",
    errorCode: UPGRADE_ERROR_CODE.LAUNCH_FAILED,
  });
  expect(failed.completeUpgrade).toHaveBeenCalledWith("b", "req", expect.anything());
  expect(failed.watchPendingUpgrade).not.toHaveBeenCalled();
});

test("daemon:detach answers detach_not_bound when the supervisor holds no such binding", async () => {
  const supervisor = {
    detach: mock(async () => ({ detached: false, reason: "not_bound" as const })),
  };
  await expect(
    runWorkspaceLifecycleCommand(
      deps({
        method: "daemon:detach",
        request: { workspaceId: "ws" } as DaemonCommandRequest,
        supervisor: supervisor as never,
      }),
    ),
  ).rejects.toMatchObject({ code: "detach_not_bound", workspaceId: "ws" });
});
