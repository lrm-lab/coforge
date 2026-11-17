import { expect, jest, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKSPACE_PROTOCOL_MAJOR,
  type AgentActivity,
  type AgentMessageDelivery,
  type AgentMessageResponse,
} from "@lrm/coforge-sdk/internal";
import type { AgentSession, CodeAgentProvider } from "@lrm/coforge-anvil";
import {
  classifyRuntimeError,
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
} from "#src/agent-runtime/runtime-error-classification";
import { TurnEvidenceLedger } from "#src/agent-runtime/turn-evidence";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import {
  deliveryWakeKey,
  WAKE_LOOP_BACKOFF_MS,
  WakeLoopGuard,
} from "#src/daemon-runtime/wake-loop-guard";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
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
    workspaceId: "workspace-wake-loop",
    agentId: "agent-a",
    conversationId: "conv-general",
    target: "#general",
    sequence,
    body: `message ${sequence}`,
    ...overrides,
  };
}

test("WakeLoopGuard backs off 60s at streak 2 and parks at streak 3 on consecutive unproductive wakes", async () => {
  let now = Date.parse("2026-11-17T12:00:00Z");
  const { records } = await captureDaemonLogs(async () => {
    const guard = new WakeLoopGuard({ now: () => now });
    const key = deliveryWakeKey([makeDelivery(1)])!;

    // Streak 1: allowed, then armed on unproductive completion.
    expect(guard.admitWake("agent-a", key)).toEqual({ status: "allow" });
    guard.noteWakeStarted("agent-a", key);
    expect(guard.noteTurnCompleted("agent-a", { status: "completed" })).toEqual({
      action: "armed",
      streak: 1,
      key,
    });

    // Streak 2: allowed to run, then arms 60s backoff on unproductive completion.
    expect(guard.admitWake("agent-a", key)).toEqual({ status: "allow" });
    guard.noteWakeStarted("agent-a", key);
    expect(guard.noteTurnCompleted("agent-a", { status: "completed" })).toEqual({
      action: "backoff",
      streak: 2,
      key,
      backoffUntilMs: now + WAKE_LOOP_BACKOFF_MS,
    });

    // Blocked during the 60s window.
    now += 15_000;
    expect(guard.admitWake("agent-a", key)).toEqual({
      status: "backoff",
      untilMs: now + (WAKE_LOOP_BACKOFF_MS - 15_000),
      remainingMs: WAKE_LOOP_BACKOFF_MS - 15_000,
    });

    // Allowed once the 60s backoff elapses; streak 3 parks the key.
    now += WAKE_LOOP_BACKOFF_MS;
    expect(guard.admitWake("agent-a", key)).toEqual({ status: "allow" });
    guard.noteWakeStarted("agent-a", key);
    expect(guard.noteTurnCompleted("agent-a", { status: "completed" })).toEqual({
      action: "parked",
      streak: 3,
      key,
    });

    // Remains parked even hours later until new work arrives.
    now += 3_600_000;
    expect(guard.admitWake("agent-a", key)).toEqual({ status: "parked" });
  });

  expect(records.some((r) => r.properties.event === "agent.wake_loop.backoff")).toBe(true);
  expect(records.some((r) => r.properties.event === "agent.wake_loop.parked")).toBe(true);
});

test("WakeLoopGuard resets streak when a new delivery key arrives or tool/coforge work happens", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  const guard = new WakeLoopGuard({ now: () => now });

  // Build up to parked on key-1, then verify a new delivery key unparks immediately.
  for (let i = 0; i < 3; i++) {
    guard.noteWakeStarted("agent-a", "msg-1");
    guard.noteTurnCompleted("agent-a", { status: "completed" });
  }
  expect(guard.admitWake("agent-a", "msg-1")).toEqual({ status: "parked" });
  expect(guard.noteDeliveryArrival("agent-a", "msg-2")).toBe(true);
  expect(guard.admitWake("agent-a", "msg-2")).toEqual({ status: "allow" });

  // Tool call resets an armed streak.
  guard.noteWakeStarted("agent-a", "msg-2");
  guard.noteTurnCompleted("agent-a", { status: "completed" });
  guard.noteWakeStarted("agent-a", "msg-2");
  guard.noteToolCall("agent-a");
  expect(guard.noteTurnCompleted("agent-a", { status: "completed" })).toEqual({
    action: "reset",
    streak: 0,
    key: "msg-2",
  });

  // Coforge message/task write or freshness hold resets even with toolCalls === 0.
  guard.noteWakeStarted("agent-a", "msg-3");
  guard.noteTurnCompleted("agent-a", { status: "completed" });
  guard.noteWakeStarted("agent-a", "msg-3");
  guard.noteCoforgeWriteOrHold("agent-a");
  expect(guard.noteTurnCompleted("agent-a", { status: "completed" })).toEqual({
    action: "reset",
    streak: 0,
    key: "msg-3",
  });
});

test("classifyRuntimeError classifies zero_evidence_turn_completed as retryable provider_server", () => {
  for (const message of [
    "Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)",
    "Agent runtime completed a turn with no assistant text or tool calls (zero_evidence_turn_completed).",
  ]) {
    expect(classifyRuntimeError({ message })).toMatchObject({
      errorClass: RUNTIME_ERROR_CLASS.PROVIDER_SERVER,
      errorReason: "provider_server_error",
      retryDecision: RUNTIME_ERROR_RETRY_DECISION.RETRY,
      takesAgentOffline: false,
    });
  }
});

test("TurnEvidenceLedger flags observed turns with 0 assistant text and 0 tool calls", () => {
  const ledger = new TurnEvidenceLedger();
  ledger.observe({ type: "thinking-delta", text: "planning..." });
  ledger.observe({ type: "context-usage", usedTokens: 12_000, windowTokens: 200_000 });
  const anomaly = ledger.finish("completed");
  expect(anomaly).toMatchObject({
    type: "error",
    retryable: true,
    providerErrorReason: "zero_evidence_turn_completed",
  });

  // A turn with >= 1 tool call and 0 text is valid.
  ledger.observe({ type: "thinking-delta", text: "" });
  ledger.observe({ type: "tool-start", id: "t1", name: "bash", input: {} });
  ledger.observe({ type: "tool-end", id: "t1", isError: false });
  expect(ledger.finish("completed")).toBeUndefined();

  // A turn with >= 1 assistant text event and 0 tool calls is valid.
  ledger.observe({ type: "thinking-delta", text: "" });
  ledger.observe({ type: "text-delta", text: "Done." });
  expect(ledger.finish("completed")).toBeUndefined();
});

test("DaemonRuntime treats a live zero-evidence turn as retryable failure and guards wake loops end to end", async () => {
  jest.useFakeTimers();
  const notices: string[] = [];
  let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
  let live = false;
  const provider: CodeAgentProvider = {
    provider: "pi",
    async createAgentSession() {
      return {
        get hasLiveTurn() {
          return live;
        },
        async sendMessage() {
          live = true;
          listener({ type: "text-delta", text: "bootstrapped" });
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
        onExit() {
          return () => undefined;
        },
        async dispose() {},
      };
    },
  };

  const tempDir = await mkdtemp(join(tmpdir(), "coforge-wake-loop-"));
  const connection = {
    computerId: "computer-wake-loop",
    workspaceId: "workspace-wake-loop",
    workspaceRoot: join(tempDir, "workspace"),
  };
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const activities: AgentActivity[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => provider,
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
        async agentMessage(): Promise<AgentMessageResponse> {
          return {
            idempotencyKey: "k1",
            accepted: true,
            attentionCount: 0,
            messageId: "sent-1",
            messages: [],
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

  try {
    // 1. Normalized zero-evidence turn: progress + 0 text + 0 toolCalls -> runtime_error + backoff.
    await runtime.handleAgentMessage(makeDelivery(1));
    expect(notices).toHaveLength(1);
    listener({ type: "thinking-delta", text: "silent chain of thought" });
    live = false;
    listener({ type: "completed", status: "completed" });
    expect(activities.some((a) => a.detailKind === "runtime_error")).toBe(true);
    // Clear the zero-evidence retry backoff by advancing past the first provider backoff window.
    jest.advanceTimersByTime(65_000);

    // 2. WakeLoopGuard end-to-end: same delivery key completing with text-only (0 tools, 0 coforge writes).
    notices.length = 0;
    const repeat = (reqSuffix: string) =>
      makeDelivery(2, {
        requestId: `req-repeat-${reqSuffix}`,
        deliveryId: `del-repeat-${reqSuffix}`,
        messageId: "msg-stuck-2",
      });

    // Streak 1
    await runtime.handleAgentMessage(repeat("1"));
    expect(notices).toHaveLength(1);
    listener({ type: "text-delta", text: "I have nothing to do." });
    live = false;
    listener({ type: "completed", status: "completed" });

    // Streak 2 -> arms 60s backoff
    await runtime.handleAgentMessage(repeat("2"));
    expect(notices).toHaveLength(2);
    listener({ type: "text-delta", text: "Still nothing to do." });
    live = false;
    listener({ type: "completed", status: "completed" });

    // Arrival inside 60s backoff is held rather than immediately notifying.
    await runtime.handleAgentMessage(repeat("3"));
    expect(notices).toHaveLength(2);

    // Advancing 60s flushes the held wake (Streak 3), which then parks the key on unproductive completion.
    jest.advanceTimersByTime(WAKE_LOOP_BACKOFF_MS + 50);
    await Promise.resolve();
    expect(notices).toHaveLength(3);
    listener({ type: "text-delta", text: "Still stuck." });
    live = false;
    listener({ type: "completed", status: "completed" });

    // Parked: further wakes on the same message key do not notify even after an hour.
    await runtime.handleAgentMessage(repeat("4"));
    jest.advanceTimersByTime(3_600_000);
    await Promise.resolve();
    expect(notices).toHaveLength(3);

    // A new message key unparks immediately and notifies!
    await runtime.handleAgentMessage(
      makeDelivery(3, {
        requestId: "req-new-3",
        deliveryId: "del-new-3",
        messageId: "msg-fresh-3",
      }),
    );
    expect(notices).toHaveLength(4);
    listener({ type: "text-delta", text: "Armed streak 1 on msg-fresh-3." });
    live = false;
    listener({ type: "completed", status: "completed" });

    // Sending a coforge message on streak 2 resets the streak instead of arming a 60s backoff.
    const ctx = runtime.issueAgentContext("agent-a");
    await runtime.handleAgentMessage(
      makeDelivery(3, {
        requestId: "req-new-3b",
        deliveryId: "del-new-3b",
        messageId: "msg-fresh-3",
      }),
    );
    expect(notices).toHaveLength(5);
    await runtime.agentMessage(
      ctx,
      {
        idempotencyKey: "send-reset-1",
        context: ctx,
        operation: "send",
        target: "#general",
        content: "acknowledged",
        continueAnyway: true,
      },
      `sk_agent_${"a".repeat(43)}`,
    );
    listener({ type: "text-delta", text: "Sent reply via coforge CLI." });
    live = false;
    listener({ type: "completed", status: "completed" });

    // Because coforge send reset the streak, another wake on msg-fresh-3 notifies immediately with no 60s backoff.
    await runtime.handleAgentMessage(
      makeDelivery(3, {
        requestId: "req-new-3c",
        deliveryId: "del-new-3c",
        messageId: "msg-fresh-3",
      }),
    );
    expect(notices).toHaveLength(6);
  } finally {
    jest.useRealTimers();
    await runtime.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
