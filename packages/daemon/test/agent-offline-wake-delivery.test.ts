import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity, AgentStatus } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeConfig, AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
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
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const activities: AgentActivity[] = [];
  const statuses: AgentStatus[] = [];
  const rejections: { reason: string }[] = [];
  const acknowledgements: string[] = [];
  const notices: string[] = [];
  let launches = 0;
  const session = {
    async sendMessage() {},
    async notify(notice: string) {
      notices.push(notice);
    },
    subscribe(listener: (event: AgentRuntimeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
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
        // Only the wake launch fails: a person's later Start succeeds, as after re-login.
        if (launches === 2) throw new Error("Claude Code is not logged in on this Computer");
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
  const appItem = {
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: "123e4567-e89b-42d3-a456-426614174000", revision: "1" },
    title: "Due",
    summary: "Now",
  };
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
    // An App Inbox notice reaches the same dead end: the hold keeps the closed Agent from being
    // started for it, so minting and draining it launches nothing and the item waits.
    await runtime.mintAppItem("agent-a", appItem);
    await runtime.drainAppInboxNotices("agent-a");
    expect(launches).toBe(2);
    expect(notices).toEqual([]);
    // A person's Start launches it again; once its model answers, the credential works and the
    // held notice is delivered to the new session.
    await runtime.startAgent("agent-a", config);
    expect(launches).toBe(3);
    for (const listener of listeners) listener({ type: "progress" });
    for (const listener of listeners) listener({ type: "text-delta", text: "hello" });
    await Bun.sleep(10);
    for (const listener of listeners) listener({ type: "completed", status: "completed" });
    await Bun.sleep(10);
    expect(notices).toContain("New app item available. Run coforge inbox check.");
  } finally {
    await runtime.stop();
  }
});
