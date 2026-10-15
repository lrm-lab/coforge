import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity, MentionDeliveryEnvelope } from "@lrm/coforge-sdk/internal";
import type {
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionOptions,
} from "#src/code-agent/contract";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import {
  ProviderProgress,
  STALLED_RECOVERY_SILENCE_MS,
  shouldRecoverStalledRuntime,
} from "#src/daemon-runtime/stalled-recovery";

const tempRoot = realpathSync(tmpdir());
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(tempRoot, `coforge-stalled-recovery-${crypto.randomUUID()}`),
};
const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};
const START = new Date("2026-10-15T00:00:00.000Z");
const minutes = (count: number) => new Date(START.getTime() + count * 60_000);

afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));
afterEach(() => setSystemTime());

test("a busy turn with no provider event for 15 minutes, no open tool call and a resumable session is recovered", () => {
  const stalled = {
    turnBusy: true,
    silentForMs: STALLED_RECOVERY_SILENCE_MS,
    hasOpenToolCall: false,
    resumable: true,
  };
  expect(STALLED_RECOVERY_SILENCE_MS).toBe(15 * 60_000);
  expect(shouldRecoverStalledRuntime(stalled)).toBe(true);
  expect(
    shouldRecoverStalledRuntime({ ...stalled, silentForMs: STALLED_RECOVERY_SILENCE_MS - 1 }),
  ).toBe(false);
  expect(shouldRecoverStalledRuntime({ ...stalled, turnBusy: false })).toBe(false);
  // A long build or test run is silent until it ends; it is never killed for a message.
  expect(shouldRecoverStalledRuntime({ ...stalled, hasOpenToolCall: true })).toBe(false);
  // A restart that cannot resume the session would start the conversation over.
  expect(shouldRecoverStalledRuntime({ ...stalled, resumable: false })).toBe(false);
});

test("provider progress counts every provider event and tracks open tool calls by id", () => {
  setSystemTime(START);
  const progress = new ProviderProgress();
  setSystemTime(minutes(10));
  expect(progress.silentForMs()).toBe(10 * 60_000);
  progress.observe({ type: "tool-start", id: "tool-1", name: "bash" });
  progress.observe({ type: "tool-start", id: "tool-2", name: "bash" });
  expect(progress.silentForMs()).toBe(0);
  expect(progress.hasOpenToolCall).toBe(true);
  progress.observe({ type: "tool-end", id: "tool-1", isError: false });
  expect(progress.hasOpenToolCall).toBe(true);
  progress.observe({ type: "tool-end", id: "tool-2", isError: false });
  expect(progress.hasOpenToolCall).toBe(false);
  progress.observe({ type: "tool-start", id: "tool-3", name: "bash" });
  progress.observe({ type: "completed", status: "interrupted" });
  expect(progress.hasOpenToolCall).toBe(false);
});

/** One managed Agent whose sessions can be driven, stopped and counted. */
async function harness(
  options: {
    /** Holds the first session's `dispose` open until it settles. */
    disposeGate?: Promise<void>;
    disposeFails?: boolean;
    relaunchFails?: boolean;
  } = {},
) {
  setSystemTime(START);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const sessions: Array<{
    options: AgentSessionOptions;
    notices: string[];
    /** Every input the session was handed: startup messages and notices. */
    inputs: string[];
    disposed: boolean;
    emit(event: AgentRuntimeEvent): void;
  }> = [];
  const activities: AgentActivity[] = [];
  const reportedLaunchIds: string[] = [];
  const acks: string[] = [];
  const terminals: Array<{ deliveryId: string; code: string }> = [];
  /** What the daemon told the cloud, in order. */
  const cloud: string[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(sessionOptions: AgentSessionOptions) {
        if (sessions.length > 0 && options.relaunchFails) throw new Error("relaunch failed");
        const first = sessions.length === 0;
        const listeners = new Set<(event: AgentRuntimeEvent) => void>();
        const exitListeners = new Set<() => void>();
        const record = {
          options: sessionOptions,
          notices: [] as string[],
          inputs: [] as string[],
          disposed: false,
          emit(event: AgentRuntimeEvent) {
            for (const listener of listeners) listener(event);
          },
        };
        sessions.push(record);
        await sessionOptions.onSessionId?.("native-1");
        return {
          async sendMessage(text: string) {
            record.inputs.push(text);
            for (const listener of listeners) listener({ type: "completed", status: "completed" });
          },
          async notify(notice: string) {
            record.notices.push(notice);
            record.inputs.push(notice);
          },
          get hasLiveTurn() {
            return true;
          },
          readSessionIdentity: async () => ({ sessionId: "native-1", state: "resumable" as const }),
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async interrupt() {},
          onExit(listener) {
            exitListeners.add(listener);
            return () => exitListeners.delete(listener);
          },
          async dispose() {
            if (first && options.disposeGate) await options.disposeGate;
            if (first && options.disposeFails) throw new Error("the process would not exit");
            record.disposed = true;
            for (const listener of Array.from(exitListeners)) listener();
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
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        async sendAgentControlResult() {},
        async reportAgentSession(report) {
          reportedLaunchIds.push(report.launchId);
          cloud.push(`session ${report.launchId}`);
        },
        async sendAgentDeliveryAck(ack) {
          acks.push(ack.deliveryId);
        },
        async sendAgentDeliveryRejection() {},
        async sendAgentMentionDeliveryTransition() {},
        async sendAgentMentionDeliveryTerminalError(report) {
          terminals.push({ deliveryId: report.deliveryId, code: report.code });
          cloud.push(`terminal ${report.deliveryId} ${report.code}`);
        },
      }),
    },
  );
  await runtime.start(connection);
  await runtime.handleAgentStart({
    protocolMajor: 1,
    requestId: "start-1",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    ...config,
    controlEpoch: 1,
    launchId: "launch-1",
  });
  const deliver = (sequence: number, mentionDelivery?: MentionDeliveryEnvelope) =>
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
    });
  const mention = (sequence: number): MentionDeliveryEnvelope => ({
    messageId: `message-${sequence}`,
    launchId: reportedLaunchIds.at(-1)!,
    sessionId: "native-1",
    computerId: connection.computerId,
  });
  return {
    runtime,
    sessions,
    activities,
    reportedLaunchIds,
    acks,
    terminals,
    cloud,
    deliver,
    mention,
  };
}

test("a message for a turn silent for 15 minutes restarts the provider, resuming its session, and reaches the new one", async () => {
  const h = await harness();
  try {
    h.sessions[0]!.emit({ type: "progress" });
    setSystemTime(minutes(15));
    h.activities.length = 0;
    await h.deliver(1);

    expect(h.sessions[0]!.disposed).toBe(true);
    // Never steered into the stalled turn first.
    expect(h.sessions[0]!.notices).toHaveLength(0);
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]!.options.sessionId).toBe("native-1");
    // The waiting delivery is what the relaunched session is told about.
    expect(h.sessions[1]!.inputs.join("\n")).toContain("#general");
    expect(h.reportedLaunchIds.at(-1)).toBe("launch-1");
    expect(h.acks).toContain("delivery-1");
    const kinds = h.activities.map((activity) => activity.detailKind);
    expect(kinds[0]).toBe("stalled_recovery");
    expect(h.activities[0]).toMatchObject({
      level: "info",
      detail: "Restarting stalled Pi runtime for queued message",
    });
    expect(kinds).not.toContain("stopped");
    expect(kinds).not.toContain("runtime_crashed");
    expect(h.activities.every((activity) => activity.launchId === "launch-1")).toBe(true);
  } finally {
    await h.runtime.stop();
  }
});

test("a turn that is silent for less than 15 minutes, or inside an open tool call, takes the message as usual", async () => {
  const h = await harness();
  try {
    h.sessions[0]!.emit({ type: "progress" });
    setSystemTime(minutes(14));
    await h.deliver(1);
    h.sessions[0]!.emit({ type: "tool-start", id: "tool-1", name: "bash" });
    setSystemTime(minutes(40));
    await h.deliver(2);

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.sessions[0]!.notices).toHaveLength(2);
    expect(h.activities.map((activity) => activity.detailKind)).not.toContain("stalled_recovery");
  } finally {
    await h.runtime.stop();
  }
});

test("a tracked @mention pending in the stalled turn is handed back as unknown before the relaunch reports its session", async () => {
  const h = await harness();
  try {
    h.sessions[0]!.emit({ type: "progress" });
    await h.deliver(1, h.mention(1));
    setSystemTime(minutes(20));
    h.cloud.length = 0;
    await h.deliver(2);

    // Nothing settles a mention when its process exits; refused as unknown, the server keeps it
    // pending and issues it again for the relaunch's session report.
    expect(h.sessions).toHaveLength(2);
    expect(h.cloud).toEqual(["terminal delivery-1 IDENTITY_UNKNOWN", "session launch-1"]);
  } finally {
    await h.runtime.stop();
  }
});

test("a second message during the restart waits for the new session instead of the stalled one", async () => {
  const h = await harness();
  try {
    h.sessions[0]!.emit({ type: "progress" });
    setSystemTime(minutes(16));
    const first = h.deliver(1);
    const second = h.deliver(2);
    await Promise.all([first, second]);

    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0]!.notices).toHaveLength(0);
    expect(h.acks).toEqual(expect.arrayContaining(["delivery-1", "delivery-2"]));
    expect(
      h.activities.filter((activity) => activity.detailKind === "stalled_recovery"),
    ).toHaveLength(1);
  } finally {
    await h.runtime.stop();
  }
});

test("a turn that just started after a quiet spell is measured from its start, not the silence before", async () => {
  const h = await harness();
  try {
    // Idle for 30 minutes, then two messages a second apart: the second steers the new turn.
    setSystemTime(minutes(30));
    await h.deliver(1);
    setSystemTime(new Date(minutes(30).getTime() + 1_000));
    await h.deliver(2);

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.notices).toHaveLength(2);
  } finally {
    await h.runtime.stop();
  }
});

test("a tracked @mention arriving during the restart is refused as unknown, never told to the dying session", async () => {
  const disposeGate = Promise.withResolvers<void>();
  const h = await harness({ disposeGate: disposeGate.promise });
  try {
    h.sessions[0]!.emit({ type: "progress" });
    setSystemTime(minutes(16));
    const recovery = h.deliver(1);
    await h.deliver(2, h.mention(2));
    disposeGate.resolve();
    await recovery;

    expect(h.terminals).toEqual([{ deliveryId: "delivery-2", code: "IDENTITY_UNKNOWN" }]);
    expect(h.sessions[0]!.notices).toHaveLength(0);
  } finally {
    disposeGate.resolve();
    await h.runtime.stop();
  }
});

test.each([
  [
    "the stalled process will not exit",
    { disposeFails: true },
    "Restarting the stalled Pi runtime failed",
  ],
  [
    "the relaunch fails",
    { relaunchFails: true },
    "Agent runtime could not be started. See `coforge-computer logs` for the cause, then start the Agent again.",
  ],
] as const)(
  "when %s, the restart ends in one visible error and is not tried again",
  async (_, options, detail) => {
    const h = await harness(options);
    try {
      h.sessions[0]!.emit({ type: "progress" });
      setSystemTime(minutes(16));
      await h.deliver(1);
      await h.deliver(2).catch(() => {});

      const kinds = h.activities.map((activity) => activity.detailKind);
      expect(kinds.filter((kind) => kind === "stalled_recovery")).toHaveLength(1);
      const failures = h.activities.filter((activity) => activity.level === "error");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ detailKind: "runtime_error", detail });
      expect(kinds.indexOf("runtime_error")).toBeGreaterThan(kinds.indexOf("stalled_recovery"));
    } finally {
      await h.runtime.stop().catch(() => {});
    }
  },
);
