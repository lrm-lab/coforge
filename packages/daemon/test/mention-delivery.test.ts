import { afterAll, afterEach, beforeEach, expect, jest, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import type {
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionOptions,
} from "#src/code-agent/contract";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { RUNNER_HOLD_REASONS } from "@lrm/coforge-sdk/internal";
import type { MentionDeliveryEnvelope } from "@lrm/coforge-sdk/internal";
import { MentionDeliveryTracker } from "#src/daemon-runtime/mention-delivery-tracker";
import { captureDaemonLogs } from "./log-capture";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const tempRoot = realpathSync(tmpdir());
const workspaceRoot = join(tempRoot, `coforge-mention-delivery-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
afterEach(() => jest.useRealTimers());
// The consumed cursor outlives a runtime (it is durable), so each test starts from a clean one.
beforeEach(() =>
  new AgentConsumedSeqStore().write("agent-a", { targets: {}, aliases: {}, nextReadOrder: 1 }),
);

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

/** One frame the daemon sent the cloud about a delivery, in the order it sent them. */
type Frame =
  | { kind: "ack"; deliveryId: string; mentionDelivery?: MentionDeliveryEnvelope }
  | { kind: "transition"; deliveryId: string; stage: string; outcome: string }
  | { kind: "terminal"; deliveryId: string; code: string }
  | { kind: "reject"; deliveryId: string; reason: string };

/**
 * Boots a runtime with one Agent whose session reports the native session `native-1`, and hands
 * the test every frame the daemon sends about a delivery. `emit` drives the session's events:
 * any activity makes the Agent busy, `completed` ends its turn.
 */
async function harness(
  options: {
    reportSession?: boolean;
    refuseNotice?: boolean;
    /** Holds every notice write open until it settles. */
    noticeGate?: Promise<void>;
    /** Holds every launch after the first open until it settles. */
    launchGate?: Promise<void>;
  } = {},
) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const frames: Frame[] = [];
  const waiters: Array<{ matches: (frame: Frame) => boolean; resolve: () => void }> = [];
  const record = (frame: Frame) => {
    frames.push(frame);
    for (const waiter of waiters.splice(0))
      if (waiter.matches(frame)) waiter.resolve();
      else waiters.push(waiter);
  };
  const notices: string[] = [];
  /** The tracked deliveries each notice carried, as the session was told them. */
  const noticeDeliveryIds: Array<readonly string[] | undefined> = [];
  const noticeWritten = Promise.withResolvers<void>();
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const exitListeners = new Set<() => void>();
  let launches = 0;
  const launchIds: string[] = [];
  const launchStarted = Promise.withResolvers<void>();
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(sessionOptions: AgentSessionOptions) {
        launches++;
        if (launches > 1 && options.launchGate) {
          launchStarted.resolve();
          await options.launchGate;
        }
        if (options.reportSession !== false) await sessionOptions.onSessionId?.("native-1");
        return {
          async sendMessage() {
            // Mention delivery starts from a ready Agent, after its startup turn has ended.
            for (const listener of listeners) listener({ type: "completed", status: "completed" });
          },
          async notify(notice: string, noticeOptions?: { deliveryIds?: readonly string[] }) {
            if (options.refuseNotice) throw new Error("the session refused the notice");
            notices.push(notice);
            noticeDeliveryIds.push(noticeOptions?.deliveryIds);
            noticeWritten.resolve();
            await options.noticeGate;
          },
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async interrupt() {},
          onExit(listener) {
            exitListeners.add(listener);
            return () => exitListeners.delete(listener);
          },
          async dispose() {},
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
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity() {},
        async sendAgentControlResult() {},
        async reportAgentSession(report) {
          launchIds.push(report.launchId);
        },
        async sendAgentDeliveryAck(ack) {
          record({
            kind: "ack",
            deliveryId: ack.deliveryId,
            ...(ack.mentionDelivery ? { mentionDelivery: ack.mentionDelivery } : {}),
          });
        },
        async sendAgentDeliveryRejection(rejection) {
          record({ kind: "reject", deliveryId: rejection.deliveryId, reason: rejection.reason });
        },
        async sendAgentMentionDeliveryTransition(report) {
          record({
            kind: "transition",
            deliveryId: report.deliveryId,
            stage: report.stage,
            outcome: report.outcome,
          });
        },
        async sendAgentMentionDeliveryTerminalError(report) {
          record({ kind: "terminal", deliveryId: report.deliveryId, code: report.code });
        },
      }),
    },
  );
  await runtime.start(connection);
  await runtime.startAgent("agent-a", config);
  const envelope = (
    sequence: number,
    overrides: Partial<MentionDeliveryEnvelope> = {},
  ): MentionDeliveryEnvelope => ({
    messageId: `message-${sequence}`,
    launchId: launchIds.at(-1) ?? "launch-never-reported",
    sessionId: "native-1",
    computerId: connection.computerId,
    ...overrides,
  });
  return {
    runtime,
    frames,
    notices,
    noticeDeliveryIds,
    /** Resolves once the session has been handed its first notice. */
    noticeWritten: noticeWritten.promise,
    /** Resolves once a launch after the first has reached `launchGate`. */
    launchStarted: launchStarted.promise,
    launches: () => launches,
    envelope,
    emit(event: AgentRuntimeEvent) {
      for (const listener of listeners) listener(event);
    },
    /** Simulates the Agent's process exiting unexpectedly. */
    exit() {
      for (const listener of exitListeners) listener();
    },
    /** Resolves once the daemon has sent a frame matching `matches` — the observable completion
     * of work the daemon does not hand back to the caller (docs/agents/testing.md). */
    frameSent(matches: (frame: Frame) => boolean): Promise<void> {
      if (frames.some(matches)) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ matches, resolve }));
    },
    /** A delivery of message `sequence`; tracked when it carries an envelope. */
    deliver: (sequence: number, mentionDelivery?: MentionDeliveryEnvelope) =>
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
        target: "#general",
        mentionsAgent: true,
        ...(mentionDelivery ? { mentionDelivery } : {}),
      }),
  };
}

test("an idle Agent is told the mention, and only then is it ACKed with its envelope", async () => {
  const { runtime, frames, notices, envelope, deliver } = await harness();
  try {
    await deliver(1, envelope(1));

    expect(notices).toHaveLength(1);
    expect(frames).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_received",
        outcome: "accepted",
      },
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_drained",
        outcome: "accepted",
      },
      { kind: "ack", deliveryId: "delivery-1", mentionDelivery: envelope(1) },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("an envelope issued to another Computer is refused as drift, before anything is told", async () => {
  const { runtime, frames, notices, envelope, deliver } = await harness();
  try {
    await deliver(1, envelope(1, { computerId: "computer-b" }));

    expect(notices).toEqual([]);
    expect(frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "IDENTITY_DRIFT" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("an envelope naming another message is refused as an instrument failure", async () => {
  const { runtime, frames, notices, envelope, deliver } = await harness();
  try {
    await deliver(1, envelope(1, { messageId: "message-2" }));

    expect(notices).toEqual([]);
    expect(frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "INSTRUMENT_FAILED" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("an envelope for another launch or another session is refused as drift", async () => {
  const { runtime, frames, notices, envelope, deliver } = await harness();
  try {
    await deliver(1, envelope(1, { launchId: "launch-before" }));
    await deliver(2, envelope(2, { sessionId: "native-before" }));

    expect(notices).toEqual([]);
    expect(frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "IDENTITY_DRIFT" },
      { kind: "terminal", deliveryId: "delivery-2", code: "IDENTITY_DRIFT" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a running Agent that never reported its session refuses the mention as unknown", async () => {
  const { runtime, frames, notices, envelope, deliver } = await harness({ reportSession: false });
  try {
    await deliver(1, envelope(1));

    expect(notices).toEqual([]);
    expect(frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "IDENTITY_UNKNOWN" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a mention for an Agent whose process exited is refused as unknown and wakes nothing", async () => {
  const { runtime, frames, notices, envelope, deliver, exit, launches } = await harness();
  try {
    const mention = envelope(1);
    exit();
    await deliver(1, mention);

    // An untracked delivery here would relaunch the Agent from its restart config; a tracked one
    // names a launch that is gone, so the server decides what happens next.
    expect(launches()).toBe(1);
    expect(notices).toEqual([]);
    expect(frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "IDENTITY_UNKNOWN" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("stop settles a mention pending in a busy turn as rejected, never as drained", async () => {
  const h = await harness();
  try {
    h.emit({ type: "progress" });
    await h.deliver(1, h.envelope(1));
    await h.runtime.stopAgent("agent-a");
    expect(h.frames.at(-1)).toEqual({
      kind: "terminal",
      deliveryId: "delivery-1",
      code: "DELIVERY_REJECTED",
    });
    h.emit({ type: "completed", status: "interrupted" });
    expect(h.frames.some((frame) => frame.kind === "ack")).toBe(false);
  } finally {
    await h.runtime.stop();
  }
});

test("stop rejects tracked mentions still queued behind a blocked notice", async () => {
  const pending = Promise.withResolvers<void>();
  const h = await harness({ noticeGate: pending.promise });
  const first = h.deliver(1, h.envelope(1));
  void first.catch(() => {});
  await h.noticeWritten;
  const queued = h.deliver(2, h.envelope(2));
  void queued.catch(() => {});
  try {
    await h.runtime.stopAgent("agent-a");
    await Promise.allSettled([first, queued]);
    expect(h.frames.filter((frame) => frame.kind === "terminal")).toEqual([
      { kind: "terminal", deliveryId: "delivery-2", code: "DELIVERY_REJECTED" },
      { kind: "terminal", deliveryId: "delivery-1", code: "DELIVERY_REJECTED" },
    ]);
    expect(h.frames.some((frame) => frame.kind === "ack")).toBe(false);
    await h.runtime.startAgent("agent-a", config);
    pending.resolve();
    h.emit({ type: "completed", status: "completed" });
    expect(h.frames.some((frame) => frame.kind === "ack")).toBe(false);
  } finally {
    pending.resolve();
    await Promise.allSettled([first, queued]);
    await h.runtime.stop();
  }
});

test("a mention for a stopped Agent is refused as unknown, not handed back as no_process", async () => {
  const { runtime, frames, envelope, deliver } = await harness();
  try {
    const mention = envelope(1);
    await runtime.stopAgent("agent-a");
    await deliver(1, mention);

    expect(frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "IDENTITY_UNKNOWN" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a busy Agent is steered the mention, which stays pending without an ACK", async () => {
  const { runtime, frames, notices, envelope, deliver, emit } = await harness();
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));

    expect(notices).toHaveLength(1);
    expect(frames).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_received",
        outcome: "accepted",
      },
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_pending",
        outcome: "accepted",
      },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a repeat of a pending mention is coalesced without an ACK or a second notice", async () => {
  const { runtime, frames, notices, envelope, deliver, emit } = await harness();
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));
    await deliver(1, envelope(1));

    expect(notices).toHaveLength(1);
    expect(frames.slice(2)).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_pending",
        outcome: "coalesced",
      },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a repeat of a drained mention is ACKed again without a second notice", async () => {
  const { runtime, frames, notices, envelope, deliver } = await harness();
  try {
    await deliver(1, envelope(1));
    await deliver(1, envelope(1));

    expect(notices).toHaveLength(1);
    expect(frames.slice(3)).toEqual([
      { kind: "ack", deliveryId: "delivery-1", mentionDelivery: envelope(1) },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a mention the Agent was told in a turn that has ended is drained without a second notice", async () => {
  const { runtime, frames, notices, envelope, deliver, emit } = await harness();
  try {
    // The same delivery first arrived without an envelope (the server woke the Agent with it),
    // and is issued again with one once the Agent's session is known.
    await deliver(1);
    emit({ type: "completed", status: "completed" });
    await deliver(1, envelope(1));

    expect(notices).toHaveLength(1);
    expect(frames).toEqual([
      { kind: "ack", deliveryId: "delivery-1" },
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_received",
        outcome: "accepted",
      },
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_drained",
        outcome: "accepted",
      },
      { kind: "ack", deliveryId: "delivery-1", mentionDelivery: envelope(1) },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a notice the session refuses rejects the mention", async () => {
  const { runtime, frames, envelope, deliver } = await harness({ refuseNotice: true });
  try {
    await expect(deliver(1, envelope(1))).rejects.toThrow("the session refused the notice");

    expect(frames).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_received",
        outcome: "accepted",
      },
      { kind: "terminal", deliveryId: "delivery-1", code: "DELIVERY_REJECTED" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a rate-limit backoff refuses a mention as quota-limited instead of holding it", async () => {
  const { runtime, frames, notices, envelope, deliver, emit } = await harness();
  jest.useFakeTimers();
  try {
    emit({ type: "error", message: "429 Too Many Requests" });
    emit({ type: "completed", status: "failed" });
    await deliver(1, envelope(1));

    expect(notices).toEqual([]);
    expect(frames).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_received",
        outcome: "accepted",
      },
      { kind: "terminal", deliveryId: "delivery-1", code: "QUOTA_LIMITED" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("any other runtime-error backoff refuses a mention as rejected instead of holding it", async () => {
  const { runtime, frames, notices, envelope, deliver, emit } = await harness();
  jest.useFakeTimers();
  try {
    emit({ type: "error", message: "connect ECONNRESET" });
    emit({ type: "completed", status: "failed" });
    await deliver(1, envelope(1));

    expect(notices).toEqual([]);
    expect(frames).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_received",
        outcome: "accepted",
      },
      { kind: "terminal", deliveryId: "delivery-1", code: "DELIVERY_REJECTED" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a mention behind a runner hold waits unacknowledged and is told once the hold lifts", async () => {
  const { runtime, frames, notices, envelope, deliver, frameSent } = await harness();
  try {
    runtime.holdRunners(RUNNER_HOLD_REASONS.WORKSPACE_RESTART);
    await deliver(1, envelope(1));
    expect(frames).toEqual([]);

    runtime.releaseRunners();
    await frameSent((frame) => frame.kind === "ack");
    expect(notices).toHaveLength(1);
    expect(frames.at(-1)).toEqual({
      kind: "ack",
      deliveryId: "delivery-1",
      mentionDelivery: envelope(1),
    });
  } finally {
    await runtime.stop();
  }
});

test("a mention whose process exits while it is being told is rejected, not left accepted", async () => {
  const noticeGate = Promise.withResolvers<void>();
  const { runtime, frames, envelope, deliver, exit, noticeWritten } = await harness({
    noticeGate: noticeGate.promise,
  });
  try {
    const delivery = deliver(1, envelope(1));
    await noticeWritten;
    exit();
    noticeGate.resolve();
    await delivery;

    expect(frames).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_received",
        outcome: "accepted",
      },
      { kind: "terminal", deliveryId: "delivery-1", code: "DELIVERY_REJECTED" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a mention for an Agent whose server Start is still launching is refused as unknown", async () => {
  const launchGate = Promise.withResolvers<void>();
  const { runtime, frames, envelope, deliver, launchStarted } = await harness({
    launchGate: launchGate.promise,
  });
  try {
    await runtime.stopAgent("agent-a");
    const start = runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "start-2",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      ...config,
      controlEpoch: 1,
      launchId: "launch-2",
    });
    await launchStarted;
    await deliver(1, envelope(1, { launchId: "launch-2" }));
    expect(frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "IDENTITY_UNKNOWN" },
    ]);

    launchGate.resolve();
    await start;
    // Nothing held it for the Start: the launch that came up is told nothing about it.
    expect(frames).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("a mention a runner hold kept for an Agent whose process exited is refused when the hold lifts", async () => {
  const { runtime, frames, envelope, deliver, exit } = await harness();
  try {
    runtime.holdRunners(RUNNER_HOLD_REASONS.WORKSPACE_RESTART);
    await deliver(1, envelope(1));
    exit();

    runtime.releaseRunners();
    expect(frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "IDENTITY_UNKNOWN" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a pending mention issued again for the next launch is told to that launch afresh", async () => {
  const { runtime, frames, notices, envelope, deliver, emit, exit } = await harness();
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));
    exit();
    await runtime.startAgent("agent-a", config);
    frames.length = 0;

    await deliver(1, envelope(1));
    expect(notices).toHaveLength(2);
    expect(frames).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_received",
        outcome: "accepted",
      },
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_drained",
        outcome: "accepted",
      },
      { kind: "ack", deliveryId: "delivery-1", mentionDelivery: envelope(1) },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a mention the Agent already consumed is drained without a running process", async () => {
  new AgentConsumedSeqStore().write("agent-a", {
    targets: { "#general": { conversationId: "conversation-a", seq: 5 } },
    aliases: {},
    nextReadOrder: 1,
  });
  const { runtime, frames, notices, envelope, deliver, exit, launches } = await harness();
  try {
    const mention = envelope(1);
    exit();
    await deliver(1, mention);

    expect(launches()).toBe(1);
    expect(notices).toEqual([]);
    expect(frames).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_drained",
        outcome: "accepted",
      },
      { kind: "ack", deliveryId: "delivery-1", mentionDelivery: mention },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a mention drained as already consumed logs why the Agent was not told", async () => {
  new AgentConsumedSeqStore().write("agent-a", {
    targets: { "#general": { conversationId: "conversation-a", seq: 5 } },
    aliases: {},
    nextReadOrder: 1,
  });
  const { runtime, notices, envelope, deliver } = await harness();
  try {
    const { records } = await captureDaemonLogs(() => deliver(1, envelope(1)));

    expect(notices).toEqual([]);
    const decision = records.find(
      (record) => record.properties.event === "agent.message.attention_decision",
    );
    expect(decision?.properties).toMatchObject({
      agent_id: "agent-a",
      delivery_id: "delivery-1",
      target: "#general",
      sequence: 1,
      tracked_mention: true,
      outcome: "consumed",
      model_seen_seq: 5,
    });
  } finally {
    await runtime.stop();
  }
});

test("a mention the Agent already consumed is drained even when its envelope names an older launch", async () => {
  new AgentConsumedSeqStore().write("agent-a", {
    targets: { "#general": { conversationId: "conversation-a", seq: 5 } },
    aliases: {},
    nextReadOrder: 1,
  });
  const { runtime, frames, notices, envelope, deliver } = await harness();
  try {
    const mention = envelope(2, { launchId: "launch-before" });
    await deliver(2, mention);

    expect(notices).toEqual([]);
    expect(frames).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-2",
        stage: "daemon_drained",
        outcome: "accepted",
      },
      { kind: "ack", deliveryId: "delivery-2", mentionDelivery: mention },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a mention already steered into the running turn is pending, not drained", async () => {
  const { runtime, frames, notices, envelope, deliver, emit } = await harness();
  try {
    emit({ type: "progress" });
    // The same delivery first arrived untracked and was steered into this turn.
    await deliver(1);
    await deliver(1, envelope(1));

    expect(notices).toHaveLength(1);
    expect(frames).toEqual([
      { kind: "ack", deliveryId: "delivery-1" },
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_received",
        outcome: "accepted",
      },
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_pending",
        outcome: "accepted",
      },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a mention told during a turn is drained and ACKed when that turn ends", async () => {
  const { runtime, frames, envelope, deliver, emit, frameSent } = await harness();
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));
    expect(frames.some((frame) => frame.kind === "ack")).toBe(false);

    emit({ type: "completed", status: "completed" });
    await frameSent((frame) => frame.kind === "ack");
    expect(frames.slice(2)).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_drained",
        outcome: "accepted",
      },
      { kind: "ack", deliveryId: "delivery-1", mentionDelivery: envelope(1) },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a mention whose steered notice was lost is drained once that notice is redelivered", async () => {
  const { runtime, frames, notices, noticeDeliveryIds, envelope, deliver, emit, frameSent } =
    await harness();
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));
    // The session is told which tracked deliveries its notice carries, and names them back if the
    // notice never reaches the model.
    expect(noticeDeliveryIds).toEqual([["delivery-1"]]);
    emit({ type: "notice-undelivered", text: "the steered notice", deliveryIds: ["delivery-1"] });

    emit({ type: "completed", status: "completed" });
    await frameSent((frame) => frame.kind === "ack");
    expect(notices.at(-1)).toBe("the steered notice");
    expect(noticeDeliveryIds.at(-1)).toEqual(["delivery-1"]);
    expect(frames.slice(2)).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_drained",
        outcome: "accepted",
      },
      { kind: "ack", deliveryId: "delivery-1", mentionDelivery: envelope(1) },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a mention whose lost notice is refused again on redelivery is rejected", async () => {
  const options = { refuseNotice: false };
  const { runtime, frames, envelope, deliver, emit, frameSent } = await harness(options);
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));
    emit({ type: "notice-undelivered", text: "the steered notice", deliveryIds: ["delivery-1"] });
    options.refuseNotice = true;

    emit({ type: "completed", status: "completed" });
    await frameSent((frame) => frame.kind === "terminal");
    expect(frames.slice(2)).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "DELIVERY_REJECTED" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a mention left pending by a launch that exited is rejected when the next launch's turn ends", async () => {
  const { runtime, frames, envelope, deliver, emit, exit, frameSent } = await harness();
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));
    // The process exits mid-turn: nothing is reported then.
    exit();
    expect(frames.some((frame) => frame.kind === "terminal")).toBe(false);

    await runtime.startAgent("agent-a", config);
    emit({ type: "completed", status: "completed" });
    await frameSent((frame) => frame.kind === "terminal");
    expect(frames.at(-1)).toEqual({
      kind: "terminal",
      deliveryId: "delivery-1",
      code: "DELIVERY_REJECTED",
    });
    expect(frames.some((frame) => frame.kind === "ack")).toBe(false);
  } finally {
    await runtime.stop();
  }
});

test("group completion settles only that group's tracked mentions", async () => {
  const acked: string[] = [];
  const refused: string[] = [];
  const tracker = new MentionDeliveryTracker("computer", {
    transition: async () => {},
    terminalError: async (report) => {
      refused.push(report.deliveryId);
    },
    acknowledge: async (message) => {
      acked.push(message.deliveryId);
    },
    running: () => ({ launchId: "launch", sessionId: "control" }),
    consumed: () => false,
    told: () => true,
    announce: async () => "told",
    busy: () => true,
    blocked: () => undefined,
  });
  const message = (group: string) => ({
    protocolMajor: 1,
    requestId: group,
    workspaceId: "workspace",
    agentId: "memory",
    messageId: group,
    deliveryId: group,
    conversationId: group,
    sequence: 1,
    body: "question",
    method: "agent:v1:message:deliver" as const,
    target: `#${group}`,
    mentionDelivery: {
      messageId: group,
      launchId: "launch",
      sessionId: "control",
      computerId: "computer",
    },
  });
  await tracker.deliver(message("alpha"));
  await tracker.deliver(message("beta"));
  await tracker.settleTurnEnd("memory", "alpha");
  expect(acked).toEqual(["alpha"]);
  expect(refused).toEqual([]);
  await tracker.settleTurnEnd("memory", "beta");
  expect(acked).toEqual(["alpha", "beta"]);
});

test("a new group can finish during notice admission without inheriting another group's busy state", async () => {
  const acked: string[] = [];
  const tracker = new MentionDeliveryTracker("computer", {
    transition: async () => {},
    terminalError: async () => {},
    acknowledge: async (message) => {
      acked.push(message.deliveryId);
    },
    running: () => ({ launchId: "launch", sessionId: "control" }),
    consumed: () => false,
    told: () => false,
    announce: async () => {
      await tracker.settleTurnEnd("memory", "beta");
      return "told";
    },
    busy: (_agent, conversationId) => conversationId !== "beta",
    blocked: () => undefined,
  });
  await tracker.deliver({
    protocolMajor: 1,
    requestId: "beta",
    workspaceId: "workspace",
    agentId: "memory",
    messageId: "beta",
    deliveryId: "beta",
    conversationId: "beta",
    sequence: 1,
    body: "question",
    method: "agent:v1:message:deliver",
    target: "#beta",
    mentionDelivery: {
      messageId: "beta",
      launchId: "launch",
      sessionId: "control",
      computerId: "computer",
    },
  });
  expect(acked).toEqual(["beta"]);
});

test.each(["accepted", "rejected"] as const)(
  "a handed-back notice that is later %s cannot settle the reissued delivery",
  async (outcome) => {
    const previous = Promise.withResolvers<"told">();
    const current = Promise.withResolvers<"told">();
    let attempts = 0;
    const terminals: string[] = [];
    const acked: string[] = [];
    const tracker = new MentionDeliveryTracker("computer", {
      transition: async () => {},
      terminalError: async (report) => {
        terminals.push(report.code);
      },
      acknowledge: async (message) => {
        acked.push(message.deliveryId);
      },
      running: () => ({ launchId: "launch", sessionId: "native" }),
      consumed: () => false,
      told: () => false,
      announce: () => (attempts++ === 0 ? previous.promise : current.promise),
      busy: () => false,
      blocked: () => undefined,
    });
    const message = {
      protocolMajor: 1,
      requestId: "original-request",
      workspaceId: "workspace",
      agentId: "agent",
      messageId: "message",
      deliveryId: "delivery",
      conversationId: "conversation",
      sequence: 1,
      body: "question",
      method: "agent:v1:message:deliver" as const,
      target: "#general",
      mentionDelivery: {
        messageId: "message",
        launchId: "launch",
        sessionId: "native",
        computerId: "computer",
      },
    };
    const oldDelivery = tracker.deliver(message).catch(() => undefined);
    await tracker.handBackForRelaunch("agent");
    const newDelivery = tracker.deliver({ ...message, requestId: "reissued-request" });
    try {
      if (outcome === "accepted") previous.resolve("told");
      else previous.reject(new Error("old session disposed"));
      await oldDelivery;
      expect(terminals).toEqual(["IDENTITY_UNKNOWN"]);
      expect(acked).toEqual([]);
      current.resolve("told");
      await newDelivery;
      expect(acked).toEqual(["delivery"]);
    } finally {
      previous.resolve("told");
      current.resolve("told");
      await Promise.allSettled([oldDelivery, newDelivery]);
    }
  },
);

test("a turn ending before notice acceptance still drains its tracked mention", async () => {
  const accepted = Promise.withResolvers<void>();
  const h = await harness({ noticeGate: accepted.promise });
  try {
    h.emit({ type: "progress" });
    const delivery = h.deliver(1, h.envelope(1));
    await h.noticeWritten;
    h.emit({ type: "completed", status: "completed" });
    accepted.resolve();
    await delivery;
    expect(h.frames).toContainEqual({
      kind: "ack",
      deliveryId: "delivery-1",
      mentionDelivery: h.envelope(1),
    });
    const count = h.notices.length;
    await h.deliver(1, h.envelope(1));
    expect(h.notices).toHaveLength(count);
    expect(h.frames.filter((frame) => frame.kind === "ack")).toHaveLength(2);
  } finally {
    accepted.resolve();
    await h.runtime.stop();
  }
});
