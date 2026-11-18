import { sessionSpy } from "./fixtures/session-spy";
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const workspaceRoot = join(realpathSync(tmpdir()), `coforge-wake-cooldown-${crypto.randomUUID()}`);
const connection: DaemonConfig = {
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

test("a message for an Agent whose wake launch just failed waits out the cooldown, then one launch carries every waiting message", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const exits = new Set<() => void>();
  const notices: string[] = [];
  const acknowledgements: string[] = [];
  let allAcknowledged!: () => void;
  const bothAcknowledged = new Promise<void>((resolve) => {
    allAcknowledged = resolve;
  });
  let launchAttempts = 0;
  let broken = false;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      createAgentSession: async () => {
        launchAttempts++;
        if (broken) throw new Error("pi: command not found");
        return {
          ...sessionSpy(),
          notify: async (notice) => {
            notices.push(notice);
          },
          onExit(listener) {
            exits.add(listener);
            return () => exits.delete(listener);
          },
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        sendAgentStatus() {},
        async sendAgentDeliveryAck(ack) {
          acknowledgements.push(ack.deliveryId);
          if (acknowledgements.length === 2) allAcknowledged();
        },
        async requestAgentApiKey() {
          return `sk_agent_${"a".repeat(43)}`;
        },
        async revokeAgentApiKey() {},
        async stop() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  const delivery = (sequence: number) => ({
    protocolMajor: 1 as const,
    requestId: `message-request-${sequence}`,
    messageId: `message-${sequence}`,
    deliveryId: `delivery-${sequence}`,
    sequence,
    workspaceId: connection.workspaceId,
    conversationId: "conversation-1",
    agentId: "agent-a",
    body: `body ${sequence}`,
    method: "agent:v1:message:deliver" as const,
    target: "@agent",
  });
  try {
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    for (const exit of exits) exit();
    broken = true;
    await expect(runtime.handleAgentMessage(delivery(1))).rejects.toThrow("pi: command not found");
    expect(launchAttempts).toBe(2);
    await runtime.handleAgentMessage(delivery(2));
    expect(launchAttempts).toBe(2);
    expect(acknowledgements).toEqual(["delivery-1", "delivery-2"]);
    broken = false;
    await Bun.sleep(1300);
    await bothAcknowledged;
    expect(launchAttempts).toBe(3);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("@agent 2 new messages");
    expect(acknowledgements).toEqual(["delivery-1", "delivery-2"]);
  } finally {
    await runtime.stop();
  }
});
