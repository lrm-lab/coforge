import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig, CodeAgentProvider } from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { sessionSpy } from "./fixtures/session-spy";

// The transport a DaemonRuntime starts receives the Computer it runs for. Split from
// daemon-runtime.test.ts, which is over the size limit.

const workspaceRoot = join(tmpdir(), `coforge-daemon-runtime-transport-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

function agentLaunchConfig(agentApiKey: string) {
  return { agentApiKey, providerConfig: undefined };
}

test("owns one AgentProcessManager for its workspace", async () => {
  const adapter: CodeAgentProvider = {
    provider: "pi",
    async createAgentSession() {
      return sessionSpy();
    },
  };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const transportCalls: unknown[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => adapter,
    credentials,
    {
      create: () => ({
        async start(token, config) {
          transportCalls.push([token, config]);
        },
        async ready() {},
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
        },
        async stop() {
          transportCalls.push("stop");
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );

  await runtime.start(connection);
  await runtime.startAgent("agent-a", config);

  expect(runtime.agentProcessManager.size).toBe(1);
  await runtime.stop();
  expect(runtime.agentProcessManager.size).toBe(0);
  expect(transportCalls).toEqual([
    [
      "token-a",
      {
        computerId: "computer-a",
        workspaceId: "workspace-a",
        // The worker identity the server fences capability leases with.
        workerInstanceId: expect.any(String),
        startedAt: expect.any(Number),
        signal: expect.any(AbortSignal),
      },
    ],
    "stop",
  ]);
});
