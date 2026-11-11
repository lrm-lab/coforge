import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { AgentStartIntent } from "@lrm/coforge-sdk/internal";
import {
  AGENT_STARTUP_TIMEOUT_MS,
  SLOW_STARTUP_TIMEOUT_MS,
} from "#src/agent-runtime/agent-startup";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { captureDaemonLogs } from "./log-capture";

const tempRoot = realpathSync(tmpdir());
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(tempRoot, `coforge-startup-window-${crypto.randomUUID()}`),
};
afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

function managedStart(
  provider: AgentRuntimeConfig["provider"],
  requestId: string,
  launchId: string,
) {
  return {
    protocolMajor: 1,
    requestId,
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    provider,
    model: "default",
    reasoning: "balanced",
    controlEpoch: 1,
    launchId,
  } satisfies AgentStartIntent;
}

afterEach(() => jest.useRealTimers());

/** A runtime over a session that never answers, so only the startup window can end the launch. */
async function runtimeWith(provider: AgentRuntimeConfig["provider"]) {
  const stateDirectory = join(tempRoot, `coforge-startup-window-state-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider,
      async createAgentSession() {
        return {
          async sendMessage() {},
          subscribe: () => () => undefined,
          async interrupt() {},
          readSessionIdentity: async () => ({
            sessionId: "session-a",
            state: "resumable" as const,
          }),
          onExit: () => () => undefined,
          async dispose() {},
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
        async sendAgentControlResult() {},
        async reportAgentSession() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  return { runtime, stateDirectory };
}

/** How long a launch may stay silent before the daemon reports the Agent as failed to start. Raft
 * 1.0.69 item 11: OpenCode, Grok and Antigravity legitimately take minutes on a cold start. */
test.each(["opencode", "grok", "antigravity"])(
  "a silent %s launch is still starting after two minutes and fails at ten",
  async (provider) => {
    const { runtime, stateDirectory } = await runtimeWith(
      provider as AgentRuntimeConfig["provider"],
    );
    try {
      await runtime.start(connection);
      jest.useFakeTimers();
      await runtime.handleAgentStart(
        managedStart(provider as AgentRuntimeConfig["provider"], "start-1", "launch-1"),
      );
      const early = await captureDaemonLogs(async () => {
        jest.advanceTimersByTime(AGENT_STARTUP_TIMEOUT_MS + 1_000);
        await Promise.resolve();
      });
      expect(
        early.records.some((r) => r.properties.event === "agent_runtime:startup_timed_out"),
      ).toBe(false);
      const late = await captureDaemonLogs(async () => {
        jest.advanceTimersByTime(SLOW_STARTUP_TIMEOUT_MS - AGENT_STARTUP_TIMEOUT_MS);
        await Promise.resolve();
      });
      const timeout = late.records.find(
        (r) => r.properties.event === "agent_runtime:startup_timed_out",
      );
      expect(timeout?.properties.timeout_ms).toBe(SLOW_STARTUP_TIMEOUT_MS);
    } finally {
      jest.useRealTimers();
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test("a silent Codex launch still fails to start at two minutes", async () => {
  const { runtime, stateDirectory } = await runtimeWith("codex");
  try {
    await runtime.start(connection);
    jest.useFakeTimers();
    await runtime.handleAgentStart(managedStart("codex", "start-1", "launch-1"));
    const { records } = await captureDaemonLogs(async () => {
      jest.advanceTimersByTime(AGENT_STARTUP_TIMEOUT_MS);
      await Promise.resolve();
    });
    const timeout = records.find((r) => r.properties.event === "agent_runtime:startup_timed_out");
    expect(timeout?.properties.timeout_ms).toBe(AGENT_STARTUP_TIMEOUT_MS);
  } finally {
    jest.useRealTimers();
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
