import { expect, jest, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKSPACE_PROTOCOL_MAJOR,
  type AgentMessageDelivery,
  type AgentMessageResponse,
} from "@lrm/coforge-sdk/internal";
import type { AgentSession, CodeAgentProvider } from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { WAKE_LOOP_BACKOFF_MS } from "#src/daemon-runtime/wake-loop-guard";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { messageRecord } from "./fixtures/message-record";
import { captureDaemonLogs } from "./log-capture";

function makeDelivery(
  sequence: number,
  overrides: Partial<AgentMessageDelivery> = {},
): AgentMessageDelivery {
  return {
    protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
    method: "agent:v1:message:deliver",
    requestId: `req-${sequence}-${crypto.randomUUID()}`,
    messageId: `msg-${sequence}`,
    deliveryId: `del-${sequence}`,
    workspaceId: "workspace-wake-mention",
    agentId: "agent-a",
    conversationId: "conv-general",
    target: "#general",
    sequence,
    body: `message ${sequence}`,
    ...overrides,
  };
}

test("WakeLoopGuard handles tracked @mentions across live backoff/park, exited park, and consumed deliveries", async () => {
  await captureDaemonLogs(async () => {
    jest.useFakeTimers();
    const notices: string[] = [];
    const terminals: Array<{ deliveryId: string; code: string }> = [];
    const acks: string[] = [];
    const launchIds: string[] = [];
    let launches = 0;
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
    const exitListeners = new Set<() => void>();
    let live = false;

    const tempDir = await mkdtemp(join(tmpdir(), "coforge-wake-loop-mention-"));
    const connection = {
      computerId: "computer-wake-mention",
      workspaceId: "workspace-wake-mention",
      workspaceRoot: join(tempDir, "workspace"),
    };
    const provider: CodeAgentProvider = {
      provider: "pi",
      async createAgentSession(options) {
        launches++;
        await options.onSessionId?.("native-mention-1");
        return {
          get hasLiveTurn() {
            return live;
          },
          async sendMessage() {
            live = true;
            listener({ type: "text-delta", text: "ready" });
            live = false;
            listener({ type: "completed", status: "completed" });
          },
          async notify(text) {
            notices.push(text);
            live = true;
          },
          subscribe(next) {
            listener = next;
            return () => undefined;
          },
          async interrupt() {},
          onExit(next) {
            const fn = () => next();
            exitListeners.add(fn);
            return () => exitListeners.delete(fn);
          },
          async dispose() {
            for (const fn of exitListeners) fn();
          },
        };
      },
    };

    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const runtime = new DaemonRuntime(
      connection,
      () => provider,
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async reportAgentSession(report) {
            launchIds.push(report.launchId);
          },
          async sendAgentDeliveryAck(ack) {
            acks.push(ack.deliveryId);
          },
          async sendAgentMentionDeliveryTransition() {},
          async sendAgentMentionDeliveryTerminalError(report) {
            terminals.push({ deliveryId: report.deliveryId, code: report.code });
          },
          async requestAgentLaunchConfig() {
            return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
          },
          async revokeAgentApiKey() {},
          async agentMessage(request): Promise<AgentMessageResponse> {
            return {
              idempotencyKey: request.idempotencyKey,
              accepted: true,
              attentionCount: 0,
              messageId: "m-0",
              hasMore: false,
              messages:
                request.operation === "check"
                  ? [messageRecord(10, "@ada", "#general", "msg-consumed-1")]
                  : [],
              summaries: [],
            };
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      join(tempDir, "state"),
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", {
      provider: "pi",
      model: "default",
      modelProvider: "anthropic",
      reasoning: "balanced",
    });

    const mention = (seq: number, messageId: string, deliveryId: string) =>
      makeDelivery(seq, {
        workspaceId: connection.workspaceId,
        requestId: `req-${deliveryId}`,
        deliveryId,
        messageId,
        mentionDelivery: {
          messageId,
          computerId: connection.computerId,
          launchId: launchIds.at(-1)!,
          sessionId: "native-mention-1",
        },
      });

    try {
      const ctx = runtime.issueAgentContext("agent-a");
      await runtime.agentMessage(
        ctx,
        { idempotencyKey: "chk-1", context: ctx, operation: "check", target: "#general" },
        `sk_agent_${"a".repeat(43)}`,
      );
      await runtime.handleAgentMessage(
        makeDelivery(10, {
          workspaceId: connection.workspaceId,
          requestId: "req-consumed-10",
          deliveryId: "del-consumed-10",
          messageId: "msg-consumed-1",
        }),
      );
      expect(acks).toContain("del-consumed-10");
      expect(notices).toHaveLength(0);
      listener({ type: "text-delta", text: "unrelated turn" });
      live = false;
      listener({ type: "completed", status: "completed" });
      expect(runtime.currentActivityLaunch("agent-a")).toBeDefined();

      await runtime.handleAgentMessage(mention(20, "msg-mention-loop", "del-m-1"));
      expect(notices).toHaveLength(1);
      listener({ type: "text-delta", text: "reply 1" });
      live = false;
      listener({ type: "completed", status: "completed" });

      await runtime.handleAgentMessage(mention(20, "msg-mention-loop", "del-m-2"));
      expect(notices).toHaveLength(2);
      listener({ type: "text-delta", text: "reply 2" });
      live = false;
      listener({ type: "completed", status: "completed" });

      await runtime.handleAgentMessage(mention(20, "msg-mention-loop", "del-m-3"));
      expect(terminals).toEqual([]);
      expect(notices).toHaveLength(2);

      jest.advanceTimersByTime(WAKE_LOOP_BACKOFF_MS + 50);
      for (let i = 0; i < 20 && !acks.includes("del-m-3"); i++) await Promise.resolve();
      expect(notices).toHaveLength(3);
      expect(acks).toContain("del-m-3");
      listener({ type: "text-delta", text: "reply 3" });
      live = false;
      listener({ type: "completed", status: "completed" });

      await runtime.handleAgentMessage(mention(20, "msg-mention-loop", "del-m-4"));
      expect(terminals).toEqual([{ deliveryId: "del-m-4", code: "DELIVERY_REJECTED" }]);

      for (const fn of exitListeners) fn();
      await Promise.resolve();

      await runtime.handleAgentMessage(mention(20, "msg-mention-loop", "del-m-5"));
      expect(terminals).toEqual([
        { deliveryId: "del-m-4", code: "DELIVERY_REJECTED" },
        { deliveryId: "del-m-5", code: "DELIVERY_REJECTED" },
      ]);

      jest.useRealTimers();
      const launchesBefore = launches;
      await runtime.handleAgentMessage(mention(21, "msg-mention-fresh", "del-m-fresh"));
      for (let i = 0; i < 50 && !acks.includes("del-m-fresh"); i++) {
        await Bun.sleep(10);
      }
      expect(launches).toBeGreaterThan(launchesBefore);
      expect(acks).toContain("del-m-fresh");
    } finally {
      jest.useRealTimers();
      await runtime.stop();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
