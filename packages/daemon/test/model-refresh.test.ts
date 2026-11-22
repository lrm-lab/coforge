import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { sessionSpy } from "./fixtures/session-spy";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";
import { discoverCodeAgentCatalogs } from "#src/code-agent/runtime-inventory";
import type { DaemonRuntimeProviderModelRefreshRequest } from "@lrm/coforge-sdk/internal";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import { DaemonRuntime, InMemoryDaemonCredentialStore } from "@lrm/coforge-daemon";

const workspaceRoot = await mkdtemp(join(tmpdir(), "coforge-model-refresh-"));
const connection: DaemonConfig = {
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

test("replies to an AGY refresh with confirmed model choices when an effort probe stalls", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const replies: unknown[] = [];
  let refresh: ((request: DaemonRuntimeProviderModelRefreshRequest) => Promise<void>) | undefined;
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
      runtimes: async () => [
        { provider: "antigravity", version: "1.5.10", displayName: "Antigravity CLI" },
      ],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: (runtimes, options) =>
        discoverCodeAgentCatalogs(runtimes, {
          ...options,
          probe: {
            which: (name) => (name === "agy" ? process.execPath : undefined),
            spawn: () => ({ stdout: new Blob(["1.5.10"]).stream(), exited: Promise.resolve(0) }),
          },
          commands: { antigravity: [process.execPath, anvilRuntimeFixtures.antigravityAcp] },
          piModels: async () => [],
          environment: {
            PATH: "",
            AGY_ACP_FIXTURE_HANG_CONFIG: "gemini-4-hydrogen",
            AGY_ACP_FIXTURE_RELEASE_CONFIG_AFTER_MS: "1800",
          },
          catalogDiscoveryTimeoutMs: 600,
        }),
    },
  );

  try {
    await runtime.start(connection);
    expect(refresh).toBeDefined();
    await refresh?.({
      protocolMajor: 1,
      requestId: "agy-catalog-refresh",
      provider: "antigravity",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
    });

    expect(replies).toEqual([
      expect.objectContaining({
        requestId: "agy-catalog-refresh",
        accepted: true,
        results: [
          {
            provider: "antigravity",
            status: "refreshed",
            catalog: {
              provider: "antigravity",
              models: [
                expect.objectContaining({
                  id: "gemini-4-carbon",
                  reasoningEfforts: ["low", "medium", "high"],
                }),
                expect.objectContaining({ id: "gemini-4-hydrogen", reasoningEfforts: undefined }),
                expect.objectContaining({ id: "gpt-oss-120b-medium", reasoningEfforts: undefined }),
              ],
            },
          },
        ],
      }),
    ]);
  } finally {
    await runtime.stop();
  }
}, 8_000);
