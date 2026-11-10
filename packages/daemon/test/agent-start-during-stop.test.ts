import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import { AGENT_STARTUP_TIMEOUT_MS } from "#src/agent-runtime/agent-startup";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { captureDaemonLogs } from "./log-capture";

const tempRoot = realpathSync(tmpdir());
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(tempRoot, `coforge-start-during-stop-${crypto.randomUUID()}`),
};
afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

const config: AgentRuntimeConfig = { provider: "pi", model: "default", reasoning: "balanced" };

function managedStart(requestId: string, epoch: number, launchId: string) {
  return {
    protocolMajor: 1,
    requestId,
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    ...config,
    controlEpoch: epoch,
    launchId,
  };
}

afterEach(() => jest.useRealTimers());

/** A runtime over one Pi-like session whose dispose waits for `exitGate`; `sessions()` counts
 * launches. The state directory is the caller's to remove. */
async function runtimeWith(exitGate: PromiseWithResolvers<void>) {
  const stateDirectory = join(tempRoot, `coforge-start-during-stop-state-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const exitListeners = new Set<() => void>();
  let sessions = 0;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        sessions++;
        return {
          async sendMessage() {},
          subscribe: () => () => undefined,
          async interrupt() {},
          readSessionIdentity: async () => ({
            sessionId: "session-a",
            state: "resumable" as const,
          }),
          onExit(listener: () => void) {
            exitListeners.add(listener);
            return () => exitListeners.delete(listener);
          },
          async dispose() {
            await exitGate.promise;
            for (const listener of exitListeners) listener();
          },
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
  return { runtime, stateDirectory, sessions: () => sessions };
}

test("a Start that arrives while the Agent's process is being stopped does not rebind to it", async () => {
  const exitGate = Promise.withResolvers<void>();
  const { runtime, stateDirectory, sessions } = await runtimeWith(exitGate);
  try {
    await runtime.start(connection);
    await runtime.handleAgentStart(managedStart("start-1", 1, "launch-1"));
    // The daemon ends this process by its own decision, so no control record holds the Agent.
    const stopping = runtime.stopAgent("agent-a");

    const { records } = await captureDaemonLogs(async () => {
      const starting = runtime.handleAgentStart(managedStart("start-2", 2, "launch-2"));
      exitGate.resolve();
      await stopping;
      await starting;
    });

    expect(records.some((r) => r.properties.event === "agent_control:start_rebound")).toBe(false);
    // The Start waited for the stop and launched its own process.
    expect(sessions()).toBe(2);
  } finally {
    exitGate.resolve();
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("a Start that arrives while a timed-out startup is being abandoned does not rebind to it", async () => {
  const exitGate = Promise.withResolvers<void>();
  const { runtime, stateDirectory, sessions } = await runtimeWith(exitGate);
  try {
    await runtime.start(connection);
    jest.useFakeTimers();
    await runtime.handleAgentStart(managedStart("start-1", 1, "launch-1"));
    // The session never answers: after the startup window the daemon abandons the launch, and
    // that teardown is slow.
    const { records } = await captureDaemonLogs(async () => {
      jest.advanceTimersByTime(AGENT_STARTUP_TIMEOUT_MS);
      await Promise.resolve();
      const starting = runtime.handleAgentStart(managedStart("start-2", 2, "launch-2"));
      void starting.catch(() => undefined);
      exitGate.resolve();
      await starting.catch(() => undefined);
    });

    expect(records.some((r) => r.properties.event === "agent_runtime:startup_timed_out")).toBe(
      true,
    );
    expect(records.some((r) => r.properties.event === "agent_control:start_rebound")).toBe(false);
    expect(sessions()).toBe(1);
  } finally {
    exitGate.resolve();
    jest.useRealTimers();
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
