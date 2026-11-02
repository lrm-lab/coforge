import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntimeConfig, WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { sessionSpy } from "./fixtures/session-spy";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const workspaceRoot = join(
  realpathSync(tmpdir()),
  `coforge-session-ack-lost-${crypto.randomUUID()}`,
);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

test("cloud-authorized wake restores the acknowledged identity with a successor launch fence", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const exits: Array<() => void> = [];
  const selected: Array<string | undefined> = [];
  const callbacks: Array<(id: string) => Promise<void>> = [];
  const reports: import("@lrm/coforge-sdk/internal").AgentSessionReport[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(options) {
        selected.push(options.sessionId);
        callbacks.push(options.onSessionId!);
        await options.onSessionId!("returned-session");
        return {
          ...sessionSpy(),
          onExit(listener: () => void) {
            exits.push(listener);
            return () => {};
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
        async requestAgentApiKey() {
          return `sk_agent_${"a".repeat(43)}`;
        },
        async reportAgentSession(report) {
          reports.push(report);
          if (reports.length === 3) throw new Error("session ACK lost");
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  try {
    await runtime.start(connection);
    await runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "cloud-start",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "wake-agent",
      ...config,
    });
    for (const exit of exits.splice(0)) exit();
    await runtime.startAgent("wake-agent", config);
    expect(selected).toEqual([undefined, "returned-session"]);
    expect(reports[1]).toMatchObject({
      startRequestId: "cloud-start",
      previousLaunchId: reports[0]!.launchId,
    });
    expect(reports[1]!.launchId).not.toBe(reports[0]!.launchId);
    await expect(callbacks[0]!("late-old-session")).rejects.toThrow("superseded");
    expect(reports).toHaveLength(2);
    for (const exit of exits.splice(0)) exit();
    // A lost session ACK is a deferred cloud observation, not the launch (task #405): the process
    // stays up, and a later cloud-authorized launch still hands over from the launch the server
    // never acknowledged.
    await runtime.startAgent("wake-agent", config);
    expect(reports).toHaveLength(3);
    for (const exit of exits.splice(0)) exit();
    await runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "cloud-start",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "wake-agent",
      ...config,
      sessionId: "returned-session",
      previousLaunchId: reports[2]!.launchId,
    });
    expect(reports[3]!.previousLaunchId).toBe(reports[2]!.launchId);
  } finally {
    await runtime.stop();
  }
});
