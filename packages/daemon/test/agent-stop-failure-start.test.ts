import { expect, test } from "bun:test";
import type { AgentRuntimeConfig, AgentSession } from "@lrm/coforge-anvil";
import { AgentProcessCleanupError } from "@lrm/coforge-anvil";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/coforge-stop-failure-start-runtime",
};

const config: AgentRuntimeConfig = { provider: "pi", model: "default", reasoning: "balanced" };

const start = {
  protocolMajor: 1,
  requestId: "start-agent-a",
  workspaceId: connection.workspaceId,
  computerId: connection.computerId,
  agentId: "agent-a",
  provider: "pi" as const,
  model: "default",
  reasoning: "balanced",
};

/**
 * A runtime whose every teardown fails to confirm the process exited. The person's next Start is
 * the whole subject: the failure's own message tells them to press it, so it has to reach the
 * re-clear instead of being answered with "already active".
 */
function harness() {
  const launches = { count: 0 };
  const activities: Array<{ detailKind: string; detail: string }> = [];
  const credentials = new InMemoryDaemonCredentialStore();
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        launches.count += 1;
        return {
          async sendMessage() {},
          subscribe: () => () => undefined,
          async interrupt() {},
          onExit: () => () => undefined,
          async dispose() {
            throw new AgentProcessCleanupError();
          },
        } satisfies AgentSession;
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"c".repeat(43)}`, providerConfig: undefined };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity(activity: { detailKind: string; detail: string }) {
          activities.push(activity);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  return { runtime, launches, activities, credentials };
}

test("a Start after a failed Stop re-clears the old tree instead of being refused as active", async () => {
  const { runtime, launches, activities, credentials } = harness();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  await runtime.start(connection);
  try {
    await runtime.handleAgentStart(start);
    await expect(runtime.stopAgent("agent-a")).rejects.toThrow("process tree did not exit");
    // The old tree still will not go, so the Start is refused — with that reason, and with no
    // second process launched beside it (task #705).
    const refused = await runtime.startAgent("agent-a", config).catch((error) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).not.toContain("already active");
    expect((refused as Error).message).toContain("process tree did not exit");
    expect(launches.count).toBe(1);
    // What the profile page and the DM header show: a way out, not a dead end.
    expect(activities.at(-1)?.detail).toContain("Start again to clear it");
  } finally {
    await runtime.stop().catch(() => undefined);
  }
});
