import { expect, test } from "bun:test";
import { createDaemonConnectionStatusMethod } from "#src/server/centrifugo/daemon-connection-status-method.server";

test("an online status refreshes capabilities for its daemon worker identity", async () => {
  const refreshed: unknown[] = [];
  const method = createDaemonConnectionStatusMethod(
    { put: async () => {}, get: async () => true, getMany: async () => [] },
    {
      refresh: async (workspaceId, computerId, identity) => {
        refreshed.push({ workspaceId, computerId, identity });
      },
    },
  );
  await method(
    new TextEncoder().encode(
      JSON.stringify({
        workspaceId: "workspace-1",
        computerId: "computer-1",
        workerInstanceId: "worker-current",
        startedAt: 10,
        online: true,
      }),
    ),
    {
      principal: {
        userId: "user-1",
        workspaceId: "workspace-1",
        computerId: "computer-1",
      },
      client: "client-current",
    },
  );
  expect(refreshed).toEqual([
    {
      workspaceId: "workspace-1",
      computerId: "computer-1",
      identity: { workerInstanceId: "worker-current", startedAt: 10 },
    },
  ]);
});
