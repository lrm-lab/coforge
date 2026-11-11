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
} from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { captureDaemonLogs } from "./log-capture";

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

/** One managed Agent whose sessions can be driven, stopped and counted. */
async function harness(
  options: {
    /** Holds the first session's `dispose` open until it settles. */
    disposeGate?: Promise<void>;
    disposeFails?: boolean;
    relaunchFails?: boolean;
    holdFirstSessionNotices?: boolean;
    /** Whether the session reports a live turn; false models a delivery whose turn never began. */
    sessionLiveTurn?: () => boolean;
    /** Whether the server refuses the session report (a 403 stale reference). */
    reportSessionFails?: boolean;
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
  const noticeEntered = Promise.withResolvers<void>();
  const noticeAccepted = Promise.withResolvers<void>();
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
            if (first && options.holdFirstSessionNotices) {
              noticeEntered.resolve();
              await noticeAccepted.promise;
            }
            record.inputs.push(notice);
          },
          get hasLiveTurn() {
            return options.sessionLiveTurn?.() ?? true;
          },
          // The fake stands in for a steer-capable provider (pi): the 15-minute fuse applies.
          steersBusyTurn: true,
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
            if (first && options.holdFirstSessionNotices)
              noticeAccepted.reject(new Error("code agent session was disposed"));
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
          if (options.reportSessionFails)
            throw Object.assign(new Error("Agent session report is stale or unauthorized"), {
              code: 403,
            });
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
    undefined,
    emptyCodeAgentDiscovery,
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
    noticeEntered: noticeEntered.promise,
    deliver,
    mention,
  };
}

test("a refused session report does not roll back a provider that already started", async () => {
  const { result: h, records } = await captureDaemonLogs(() =>
    harness({ reportSessionFails: true }),
  );
  try {
    h.sessions[0]!.emit({ type: "progress" });
    await h.deliver(1);

    // The report is refused, yet the launched process keeps serving: the launch is local work,
    // the report a cloud observation.
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.sessions[0]!.notices).toHaveLength(1);
    expect(h.acks).toContain("delivery-1");
    expect(records.map((record) => record.properties.event)).toContain(
      "agent_session:report_deferred",
    );
  } finally {
    await h.runtime.stop();
  }
});

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
    // The page is told why the runtime goes (task #41), then that the restart is under way.
    expect(kinds.slice(0, 2)).toEqual(["runtime_stalled", "stalled_recovery"]);
    expect(h.activities[0]).toMatchObject({ level: "error" });
    expect(h.activities[1]).toMatchObject({
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

test("a message to an idle provider whose turn never began is delivered, not treated as stalled", async () => {
  const h = await harness({ sessionLiveTurn: () => false });
  try {
    // The provider has been quiet for a while, but this delivery has just arrived: the stall
    // clock is the delivery's wait, so an idle Agent receives it instead of being restarted.
    h.sessions[0]!.emit({ type: "progress" });
    setSystemTime(minutes(15));
    await h.deliver(1);

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.sessions[0]!.notices).toHaveLength(1);
    expect(h.activities.map((activity) => activity.detailKind)).not.toContain("stalled_recovery");
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

test("a tracked @mention pending in the stalled turn is left pending for the resumed session, not handed back", async () => {
  const h = await harness();
  try {
    h.sessions[0]!.emit({ type: "progress" });
    await h.deliver(1, h.mention(1));
    setSystemTime(minutes(20));
    h.cloud.length = 0;
    await h.deliver(2);

    // Nothing settles a mention when its process exits; the resumed session holds its notice.
    expect(h.sessions).toHaveLength(2);
    expect(h.cloud).toEqual(["session launch-1"]);
  } finally {
    await h.runtime.stop();
  }
});

test.each([false, true])(
  "a provider notice still pending is kept for the relaunch during stalled recovery (slow disposal: %s)",
  async (slowDisposal) => {
    const disposeGate = Promise.withResolvers<void>();
    const h = await harness({
      holdFirstSessionNotices: true,
      ...(slowDisposal ? { disposeGate: disposeGate.promise } : {}),
    });
    try {
      h.sessions[0]!.emit({ type: "progress" });
      const pending = h.deliver(1, h.mention(1)).catch(() => undefined);
      await h.noticeEntered;
      setSystemTime(minutes(20));
      h.cloud.length = 0;
      const recovery = h.deliver(2);
      if (slowDisposal) {
        await pending;
        disposeGate.resolve();
      }
      await recovery;
      await pending;

      expect(h.sessions).toHaveLength(2);
      expect(h.terminals).toEqual([]);
      expect(h.cloud).toEqual(["session launch-1"]);
    } finally {
      disposeGate.resolve();
      await h.runtime.stop();
    }
  },
);

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

test("a tracked @mention arriving during the restart is kept for the new session, never told to the dying one", async () => {
  const disposeGate = Promise.withResolvers<void>();
  const h = await harness({ disposeGate: disposeGate.promise });
  try {
    h.sessions[0]!.emit({ type: "progress" });
    setSystemTime(minutes(16));
    const recovery = h.deliver(1);
    await h.deliver(2, h.mention(2));
    disposeGate.resolve();
    await recovery;

    expect(h.terminals).toEqual([]);
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
      // The stall's own reason is an error Activity too (task #41); the restart's failure is the
      // one this test is about.
      const failures = h.activities.filter(
        (activity) => activity.level === "error" && activity.detailKind === "runtime_error",
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ detailKind: "runtime_error", detail });
      expect(kinds.indexOf("runtime_error")).toBeGreaterThan(kinds.indexOf("stalled_recovery"));
    } finally {
      await h.runtime.stop().catch(() => {});
    }
  },
);

test("a Stop during the restart wins: the Agent is not woken again", async () => {
  const disposeGate = Promise.withResolvers<void>();
  const h = await harness({ disposeGate: disposeGate.promise });
  try {
    h.sessions[0]!.emit({ type: "progress" });
    setSystemTime(minutes(16));
    const recovery = h.deliver(1);
    const stopped = h.runtime.stopAgent("agent-a");
    disposeGate.resolve();
    await Promise.all([recovery, stopped]);

    expect(h.sessions).toHaveLength(1);
    expect(h.runtime.agentProcessManager.restartConfig("agent-a")).toBeUndefined();
  } finally {
    disposeGate.resolve();
    await h.runtime.stop();
  }
});
