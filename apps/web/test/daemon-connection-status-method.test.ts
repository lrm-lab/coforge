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

test("an online status reply carries the latest Computer version", async () => {
  const method = createDaemonConnectionStatusMethod(
    { put: async () => {}, get: async () => true, getMany: async () => [] },
    undefined,
    undefined,
    async () => "0.1.26",
  );
  const reply = await method(
    new TextEncoder().encode(
      JSON.stringify({
        workspaceId: "workspace-1",
        computerId: "computer-1",
        online: true,
      }),
    ),
    {
      principal: { userId: "user-1", workspaceId: "workspace-1", computerId: "computer-1" },
      client: "client-current",
    },
  );
  expect(reply).not.toHaveProperty("code");
  expect(JSON.parse(new TextDecoder().decode(reply as Uint8Array))).toEqual({
    latestComputerVersion: "0.1.26",
  });
});

test("a status reply with no latest version answers an empty body", async () => {
  const method = createDaemonConnectionStatusMethod({
    put: async () => {},
    get: async () => true,
    getMany: async () => [],
  });
  const reply = await method(
    new TextEncoder().encode(
      JSON.stringify({
        workspaceId: "workspace-1",
        computerId: "computer-1",
        online: true,
      }),
    ),
    {
      principal: { userId: "user-1", workspaceId: "workspace-1", computerId: "computer-1" },
      client: "client-current",
    },
  );
  expect(JSON.parse(new TextDecoder().decode(reply as Uint8Array))).toEqual({});
});

test("a failed recovery lookup runs alongside the version lookup and preserves the reply", async () => {
  const version = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  let observed = false;
  const method = createDaemonConnectionStatusMethod(
    { put: async () => {}, get: async () => true, getMany: async () => [] },
    undefined,
    undefined,
    () => {
      started.resolve();
      return version.promise;
    },
    undefined,
    {
      observe: async () => {
        observed = true;
        throw new Error("recovery store unavailable");
      },
    },
  );
  const principal = { userId: "user-1", workspaceId: "workspace-1", computerId: "computer-1" };
  const reply = method(new TextEncoder().encode(JSON.stringify({ ...principal, online: true })), {
    principal,
    client: "client-current",
  });
  try {
    await started.promise;
    expect(observed).toBe(true);
  } finally {
    version.resolve("0.1.26");
  }
  expect(JSON.parse(new TextDecoder().decode((await reply) as Uint8Array))).toEqual({
    latestComputerVersion: "0.1.26",
  });
});
