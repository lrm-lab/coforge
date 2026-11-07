import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity, AgentStatus } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeConfig, AgentSession } from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const workspaceRoot = join(realpathSync(tmpdir()), `coforge-offline-wake-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
const config: AgentRuntimeConfig = {
  provider: "claude-code",
  model: "claude-opus",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

test("a wake launch that fails login-required keeps later deliveries from relaunching", async () => {
  const exitListeners = new Set<() => void>();
  const activities: AgentActivity[] = [];
  const statuses: AgentStatus[] = [];
  const rejections: { reason: string }[] = [];
  const acknowledgements: string[] = [];
  let launches = 0;
  const session = {
    async sendMessage() {},
    async notify() {},
    subscribe() {
      return () => {};
    },
    async interrupt() {},
    onExit(listener: () => void) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    async dispose() {
      for (const listener of exitListeners) listener();
    },
  } satisfies AgentSession;
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "claude-code",
      createAgentSession: async () => {
        launches++;
        if (launches > 1) throw new Error("Claude Code is not logged in on this Computer");
        return session;
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
        async revokeAgentApiKey() {},
        async sendAgentDeliveryAck(ack) {
          acknowledgements.push(ack.deliveryId);
        },
        async sendAgentDeliveryRejection(rejection) {
          rejections.push(rejection);
        },
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        sendAgentStatus(status) {
          statuses.push(status);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
  );
  const deliver = (sequence: number) =>
    runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: `request-${sequence}`,
      messageId: `message-${sequence}`,
      deliveryId: `delivery-${sequence}`,
      sequence,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: `body-${sequence}`,
      method: "agent:v1:message:deliver",
      target: "@ada",
    });
  try {
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    // The process exits on its own: the session is gone but the daemon-side restart config
    // survives, so the next delivery may wake it (the cold-recycle shape).
    await session.dispose();
    // The wake launch fails login-required: the delivery request rejects with the launch
    // failure while the offline record is written — the server's retry then takes custody.
    await deliver(1).catch(() => {});
    expect(launches).toBe(2);
    expect(statuses.at(-1)?.status).toBe("inactive");
    // Past the first failure's one-second cooldown, another delivery must not launch again:
    // the offline record keeps custody until a person acts.
    await Bun.sleep(1_100);
    await deliver(2);
    await deliver(3);
    expect(launches).toBe(2);
    expect(rejections).toEqual([]);
    expect(acknowledgements).toEqual(["delivery-1", "delivery-2", "delivery-3"]);
  } finally {
    await runtime.stop();
  }
});
