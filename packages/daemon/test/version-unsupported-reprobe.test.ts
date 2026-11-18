import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStartFailedError, RuntimeVersionUnsupportedError } from "@lrm/coforge-anvil";
import {
  RUNTIME_PROVIDER,
  type AgentControlResult,
  type AgentStartIntent,
  type ProviderModelRefreshResult,
  type RuntimeMetadata,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import {
  CodeAgentInventorySync,
  REPROBE_MIN_INTERVAL_MS,
  type CodeAgentDiscovery,
} from "#src/daemon-runtime/code-agent-inventory-sync";
import { DaemonRuntime, type DaemonConfig } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const tempRoot = realpathSync(tmpdir());
const connection: DaemonConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(tempRoot, `coforge-reprobe-${crypto.randomUUID()}`),
};
afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

function startIntent(
  requestId: string,
  epoch: number,
  launchId: string,
  provider: RuntimeProvider = RUNTIME_PROVIDER.DROID,
): AgentStartIntent {
  return {
    protocolMajor: 1,
    requestId,
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    provider,
    model: "default",
    reasoning: "balanced",
    controlEpoch: epoch,
    launchId,
  };
}

function makeInventorySync(options: {
  catalogs?: (
    runtimes: Parameters<CodeAgentDiscovery["catalogs"]>[0],
    opts?: Parameters<CodeAgentDiscovery["catalogs"]>[1],
  ) => ReturnType<CodeAgentDiscovery["catalogs"]>;
  now?: () => number;
}) {
  const probedProviders: Array<RuntimeProvider | undefined> = [];
  const inventories: Array<{ runtimes: RuntimeMetadata[] }> = [];
  const refreshResults: ProviderModelRefreshResult[][] = [];
  const transport = {
    async start() {},
    async ready() {},
    async stop() {},
    async updateCodeAgents(inventory: { runtimes: RuntimeMetadata[] }) {
      inventories.push(inventory);
    },
    async sendProviderModelRefreshResult(reply: { results: ProviderModelRefreshResult[] }) {
      refreshResults.push(reply.results);
    },
  };
  const discovery: CodeAgentDiscovery = {
    ...emptyCodeAgentDiscovery,
    async runtimes() {
      return [
        {
          provider: RUNTIME_PROVIDER.DROID,
          displayName: "Droid",
          installed: true,
          version: "1.12.1",
          detail: "ok",
        },
        {
          provider: RUNTIME_PROVIDER.GROK,
          displayName: "Grok",
          installed: true,
          version: "1.0.77",
          detail: "ok",
        },
      ];
    },
    async catalogs(runtimes, opts) {
      probedProviders.push(opts?.provider);
      if (options.catalogs) return options.catalogs(runtimes, opts);
      return {
        catalogs: [
          {
            provider: opts?.provider ?? RUNTIME_PROVIDER.DROID,
            models: [
              {
                id: "default",
                displayName: "Default",
                description: "",
                modelProvider: "",
                reasoningEfforts: [],
                defaultReasoning: "",
                recommended: true,
              },
            ],
          },
        ],
        failures: [],
      };
    },
  };
  const sync = new CodeAgentInventorySync(
    discovery,
    { workspaceId: connection.workspaceId, computerId: connection.computerId },
    () => true,
    undefined,
    undefined,
    undefined,
    options.now,
  );
  return { sync, transport, probedProviders, inventories, refreshResults };
}

test("reprobe and refreshModels share one in-flight probe; only refreshModels waits out the cooldown", async () => {
  let nowMs = 100_000;
  const gate = Promise.withResolvers<void>();
  const h = makeInventorySync({
    now: () => nowMs,
    catalogs: async (_runtimes, opts) => {
      await gate.promise;
      return {
        catalogs: [
          {
            provider: opts?.provider ?? RUNTIME_PROVIDER.DROID,
            models: [
              {
                id: "default",
                displayName: "Default",
                description: "",
                modelProvider: "",
                reasoningEfforts: [],
                defaultReasoning: "",
                recommended: true,
              },
            ],
          },
        ],
        failures: [],
      };
    },
  });

  const p1 = h.sync.reprobe(RUNTIME_PROVIDER.DROID, "launch_refused", h.transport as never);
  const p2 = h.sync.reprobe(RUNTIME_PROVIDER.DROID, "launch_refused", h.transport as never);
  const p3 = h.sync.refreshModels(
    {
      protocolMajor: 1,
      requestId: "req-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      provider: RUNTIME_PROVIDER.DROID,
    },
    h.transport as never,
  );
  gate.resolve();
  await Promise.all([p1, p2, p3]);

  expect(h.probedProviders).toEqual([RUNTIME_PROVIDER.DROID]);
  expect(h.refreshResults).toHaveLength(1);
  expect(h.refreshResults[0]?.[0]?.status).toBe("refreshed");

  nowMs += 10_000;
  await h.sync.refreshModels(
    {
      protocolMajor: 1,
      requestId: "req-2",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      provider: RUNTIME_PROVIDER.DROID,
    },
    h.transport as never,
  );
  expect(h.probedProviders).toEqual([RUNTIME_PROVIDER.DROID]);

  await h.sync.reprobe(RUNTIME_PROVIDER.DROID, "launch_refused", h.transport as never);
  expect(h.probedProviders).toEqual([RUNTIME_PROVIDER.DROID, RUNTIME_PROVIDER.DROID]);

  nowMs += REPROBE_MIN_INTERVAL_MS;
  await h.sync.refreshModels(
    {
      protocolMajor: 1,
      requestId: "req-3",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      provider: RUNTIME_PROVIDER.DROID,
    },
    h.transport as never,
  );
  expect(h.probedProviders).toEqual([
    RUNTIME_PROVIDER.DROID,
    RUNTIME_PROVIDER.DROID,
    RUNTIME_PROVIDER.DROID,
  ]);
});

test("version_unsupported launch refusal reprobes only that provider and lets a subsequent Start succeed", async () => {
  const stateDirectory = join(tempRoot, `coforge-reprobe-state-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");

  let upgraded = false;
  let sessionCalls = 0;
  const probedProviders: Array<RuntimeProvider | undefined> = [];
  const inventories: Array<{ runtimes: RuntimeMetadata[] }> = [];
  const results: AgentControlResult[] = [];
  const discovery: CodeAgentDiscovery = {
    ...emptyCodeAgentDiscovery,
    async runtimes() {
      return [
        {
          provider: RUNTIME_PROVIDER.DROID,
          displayName: "Droid",
          installed: true,
          version: upgraded ? "1.12.1" : "0.223.0",
          detail: upgraded ? "ok" : "version_unsupported",
          ...(upgraded ? {} : { unavailableCode: "version_unsupported" }),
        },
        {
          provider: RUNTIME_PROVIDER.GROK,
          displayName: "Grok",
          installed: true,
          version: "1.0.77",
          detail: "ok",
        },
      ];
    },
    async catalogs(_runtimes, opts) {
      probedProviders.push(opts?.provider);
      return { catalogs: [], failures: [] };
    },
  };

  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: RUNTIME_PROVIDER.DROID,
      async createAgentSession() {
        if (sessionCalls++ === 0) {
          upgraded = true;
          throw new RuntimeVersionUnsupportedError("droid 0.223.0 is too old; upgrade to >= 1.0.0");
        }
        return {
          sendMessage: async () => {},
          notify: async () => {},
          subscribe: () => () => {},
          interrupt: async () => {},
          readSessionIdentity: async () => ({
            sessionId: "session-a",
            state: "resumable" as const,
          }),
          onExit: () => () => {},
          dispose: async () => {},
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity() {},
        async sendAgentControlResult(result: AgentControlResult) {
          results.push(result);
        },
        async updateCodeAgents(inventory: { runtimes: RuntimeMetadata[] }) {
          inventories.push(inventory);
        },
        async reportAgentSession() {},
        async sendAgentDeliveryAck() {},
      }),
    },
    undefined,
    discovery,
    stateDirectory,
  );
  await runtime.start(connection);
  try {
    await runtime.handleAgentStart(startIntent("start-1", 1, "launch-1")).catch(() => {});
    await Bun.sleep(30);
    expect(probedProviders).toContain(RUNTIME_PROVIDER.DROID);
    expect(probedProviders).not.toContain(RUNTIME_PROVIDER.GROK);
    expect(
      inventories.some((inv) =>
        inv.runtimes.some(
          (entry) => entry.provider === RUNTIME_PROVIDER.DROID && entry.version === "1.12.1",
        ),
      ),
    ).toBe(true);

    await runtime.handleAgentStart(startIntent("start-2", 2, "launch-2"));
    expect(
      results.some((result) => result.requestId === "start-2" && result.phase === "started"),
    ).toBe(true);
  } finally {
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("a second refusal right after an upgrade reprobes again and the next Start succeeds", async () => {
  const stateDirectory = join(tempRoot, `coforge-reprobe-again-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");

  let upgraded = false;
  let sessionCalls = 0;
  const droidVersions: string[] = [];
  const results: AgentControlResult[] = [];
  const discovery: CodeAgentDiscovery = {
    ...emptyCodeAgentDiscovery,
    async runtimes() {
      return [
        {
          provider: RUNTIME_PROVIDER.DROID,
          displayName: "Droid",
          installed: true,
          version: upgraded ? "1.12.1" : "0.223.0",
          detail: upgraded ? "ok" : "version_unsupported",
          ...(upgraded ? {} : { unavailableCode: "version_unsupported" }),
        },
      ];
    },
    async catalogs() {
      return { catalogs: [], failures: [] };
    },
  };

  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: RUNTIME_PROVIDER.DROID,
      async createAgentSession() {
        const call = sessionCalls++;
        if (call < 2) {
          if (call === 1) upgraded = true;
          throw new RuntimeVersionUnsupportedError("droid 0.223.0 is too old; upgrade to >= 1.0.0");
        }
        return {
          sendMessage: async () => {},
          notify: async () => {},
          subscribe: () => () => {},
          interrupt: async () => {},
          readSessionIdentity: async () => ({
            sessionId: "session-a",
            state: "resumable" as const,
          }),
          onExit: () => () => {},
          dispose: async () => {},
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity() {},
        async sendAgentControlResult(result: AgentControlResult) {
          results.push(result);
        },
        async updateCodeAgents(inventory: { runtimes: RuntimeMetadata[] }) {
          const droid = inventory.runtimes.find(
            (entry) => entry.provider === RUNTIME_PROVIDER.DROID,
          );
          if (droid?.version) droidVersions.push(droid.version);
        },
        async reportAgentSession() {},
        async sendAgentDeliveryAck() {},
      }),
    },
    undefined,
    discovery,
    stateDirectory,
  );
  await runtime.start(connection);
  try {
    await runtime.handleAgentStart(startIntent("start-1", 1, "launch-1")).catch(() => {});
    await Bun.sleep(30);
    expect(droidVersions.at(-1)).toBe("0.223.0");

    await runtime.handleAgentStart(startIntent("start-2", 2, "launch-2")).catch(() => {});
    await Bun.sleep(30);
    expect(droidVersions.at(-1)).toBe("1.12.1");

    await runtime.handleAgentStart(startIntent("start-3", 3, "launch-3"));
    expect(
      results.some((result) => result.requestId === "start-3" && result.phase === "started"),
    ).toBe(true);
  } finally {
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("connection or start_failed launch refusal does not trigger reprobe", async () => {
  const stateDirectory = join(tempRoot, `coforge-reprobe-conn-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");

  const probedProviders: Array<RuntimeProvider | undefined> = [];
  const discovery: CodeAgentDiscovery = {
    ...emptyCodeAgentDiscovery,
    async runtimes() {
      return [];
    },
    async catalogs(_runtimes, opts) {
      probedProviders.push(opts?.provider);
      return { catalogs: [], failures: [] };
    },
  };
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: RUNTIME_PROVIDER.DROID,
      async createAgentSession() {
        throw new RuntimeStartFailedError("connection reset by peer");
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity() {},
        async sendAgentControlResult() {},
        async sendCodeAgentRuntimes() {},
        async reportAgentSession() {},
        async sendAgentDeliveryAck() {},
      }),
    },
    undefined,
    discovery,
    stateDirectory,
  );
  await runtime.start(connection);
  try {
    await runtime.handleAgentStart(startIntent("start-1", 1, "launch-1")).catch(() => {});
    await Bun.sleep(30);
    expect(probedProviders).not.toContain(RUNTIME_PROVIDER.DROID);
  } finally {
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
