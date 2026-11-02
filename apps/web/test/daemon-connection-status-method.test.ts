import { expect, test } from "bun:test";
import { createDaemonConnectionStatusMethod } from "#src/server/centrifugo/daemon-connection-status-method.server";

test("an online status refreshes capabilities only for its Centrifugo connection", async () => {
  const refreshed: unknown[] = [];
  const method = createDaemonConnectionStatusMethod(
    { put: async () => {}, get: async () => true, getMany: async () => [] },
    {
      refresh: async (workspaceId, computerId, connectionId) => {
        refreshed.push({ workspaceId, computerId, connectionId });
      },
    },
  );
  await method(
    new TextEncoder().encode(
      JSON.stringify({ workspaceId: "workspace-1", computerId: "computer-1", online: true }),
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
      connectionId: "client-current",
    },
  ]);
});
