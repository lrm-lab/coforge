import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { sessionSpy } from "./fixtures/session-spy";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { DaemonRuntime, InMemoryDaemonCredentialStore } from "@lrm/coforge-daemon";

const workspaceRoot = await mkdtemp(join(tmpdir(), "coforge-model-refresh-"));
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

test("re-discovers and re-reports catalogs on a model refresh request, then answers it", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const updates: unknown[] = [];
  const replies: unknown[] = [];
  let refresh:
    | ((request: {
        protocolMajor: number;
        requestId: string;
        workspaceId: string;
        computerId: string;
        provider: import("@lrm/coforge-sdk/internal").RuntimeProvider;
      }) => Promise<void>)
    | undefined;
  let discoveryCalls = 0;
  let discoveryOptions: unknown;
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async updateCodeAgents(request) {
          updates.push(request);
        },
        onProviderModelRefresh(callback) {
          refresh = callback;
          return () => {};
        },
        async sendProviderModelRefreshResult(response) {
          replies.push(response);
        },
        async stop() {},
      }),
    },
    undefined,
    {
      runtimes: async () => [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async (_runtimes, options) => {
        discoveryOptions = options;
        discoveryCalls++;
        return { catalogs: [{ provider: "codex", models: [] }], failures: [] };
      },
    },
  );

  await runtime.start(connection);
  expect(updates).toHaveLength(1);
  expect(refresh).toBeDefined();

  await refresh?.({
    protocolMajor: 1,
    requestId: "refresh-1",
    provider: "codex",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
  });

  expect(discoveryCalls).toBe(1);
  expect(discoveryOptions).toEqual({ force: true, provider: "codex" });
  expect(updates).toHaveLength(2);
  expect(updates[1]).toMatchObject({
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    runtimes: [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
    catalogs: [{ provider: "codex", models: [] }],
  });
  expect(replies).toEqual([
    expect.objectContaining({
      requestId: "refresh-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      accepted: true,
      results: [
        {
          provider: "codex",
          status: "refreshed",
          catalog: { provider: "codex", models: [] },
        },
      ],
    }),
  ]);
  await runtime.stop();
});

test("answers a model refresh it cannot satisfy with an error instead of throwing", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const replies: unknown[] = [];
  let refresh:
    | ((request: {
        protocolMajor: number;
        requestId: string;
        workspaceId: string;
        computerId: string;
        provider: import("@lrm/coforge-sdk/internal").RuntimeProvider;
      }) => Promise<void>)
    | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async updateCodeAgents() {},
        onProviderModelRefresh(callback) {
          refresh = callback;
          return () => {};
        },
        async sendProviderModelRefreshResult(response) {
          replies.push(response);
        },
        async stop() {},
      }),
    },
    undefined,
    {
      runtimes: async () => [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => {
        throw new Error("probe exploded");
      },
    },
  );

  await runtime.start(connection);
  await refresh?.({
    protocolMajor: 1,
    requestId: "refresh-2",
    provider: "dsh",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
  });

  expect(replies).toEqual([
    expect.objectContaining({ requestId: "refresh-2", accepted: false, results: [] }),
  ]);
  await runtime.stop();
});
