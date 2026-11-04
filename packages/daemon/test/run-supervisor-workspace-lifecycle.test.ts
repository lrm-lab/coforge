import { test, expect, mock } from "bun:test";
import type { DaemonCommandRequest, ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";

import { runWorkspaceLifecycleCommand } from "#src/supervisor/run-supervisor-workspace-lifecycle";

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
