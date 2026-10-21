import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import type {
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentSession,
  CodeAgentProvider,
} from "#src/code-agent/contract";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { CodexProvider } from "#src/code-agent/codex/provider";
import { PROCESS_TREE_EXIT_GRACE_MS } from "#src/code-agent/process-tree-cleanup";
import { DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS } from "#src/connection/shutdown-notice-timeout";
import { COMPACTION_STALE_MS, REVIEW_STALE_MS } from "#src/agent-runtime/runtime-phases";
import type { AgentActivity, AgentActivityDetailKind } from "@lrm/coforge-sdk/internal";
import { backgroundBash, claudeEventFeed, claudeFixtureProvider } from "./fixtures/claude-feed";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { activityHarness } from "./fixtures/activity-runtime";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const tempRoot = realpathSync(tmpdir());
const workspaceRoot = join(tempRoot, `coforge-activity-heartbeat-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
afterEach(() => jest.useRealTimers());

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

function sessionSpy() {
  return {
    async sendMessage() {},
    subscribe() {
      return () => undefined;
    },
    async interrupt() {},
    onExit() {
      return () => undefined;
    },
    async dispose() {},
  } satisfies AgentSession;
}

const harness = (provider?: CodeAgentProvider) => activityHarness(connection, provider);

for (const completionOrder of ["running", "before-start-response"] as const) {
  test(
    `Codex late items cannot restart Busy or its heartbeat (${completionOrder})`,
    async () => {
      const provider = new CodexProvider({
        command: [
          process.execPath,
          new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
        ],
      });
      const { runtime, session, activities } = await harness(provider);
      try {
        // The shared launch now opens a startup turn. End it through the fixture's native
        // turn protocol before exercising a separate turn's late-event reconciliation.
        let unsubscribeStartup = () => {};
        const startupEnded = new Promise<void>((resolve) => {
          unsubscribeStartup = session.subscribe((event) => {
            if (event.type === "completed") resolve();
          });
        });
        try {
          await session.notify!("finish-with-late-events");
          await startupEnded;
        } finally {
          unsubscribeStartup();
        }
        jest.useFakeTimers();
        activities.length = 0;
        if (completionOrder === "running") {
          await session.sendMessage("hold");
          await session.notify!("finish-with-late-events");
        } else {
          await session.sendMessage("finish-before-response");
        }
        const idleIndex = activities.findIndex((activity) => activity.detailKind === "idle");
        expect(idleIndex).toBeGreaterThanOrEqual(0);
        expect(activities.slice(idleIndex + 1)).toEqual([]);
        expect(runtime.busyAgents()).toEqual([]);

        const countAfterCompletion = activities.length;
        jest.advanceTimersByTime(600_000);
        expect(activities).toHaveLength(countAfterCompletion);
        jest.useRealTimers();

        // The session remains usable: an idle notice starts a fresh native turn.
        activities.length = 0;
        let unsubscribe = () => {};
        const responded = new Promise<void>((resolve) => {
          unsubscribe = session.subscribe((event) => {
            if (event.type === "tool-start" && event.id === "current-command") resolve();
          });
        });
        try {
          await session.notify!("hold-tool");
          await responded;
        } finally {
          unsubscribe();
        }
        expect(runtime.busyAgents().map((agent) => agent.agentId)).toEqual(["agent-a"]);
        expect(activities.some((activity) => activity.detailKind === "running_command")).toBe(true);
      } finally {
        jest.useRealTimers();
        await runtime.stop();
      }
    },
    5_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS + DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS,
  );
}

for (const event of [
  { type: "tool-start", id: "real-tool", name: "Read" },
  { type: "compaction-started", occurredAt: new Date().toISOString() },
] satisfies AgentRuntimeEvent[]) {
  test(`heartbeat verifies live turn state before extending Busy (${event.type})`, async () => {
    let live = true;
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => {};
    const { runtime, activities } = await harness({
      provider: "pi",
      async createAgentSession() {
        return {
          ...sessionSpy(),
          get hasLiveTurn() {
            return live;
          },
          subscribe(next) {
            listener = next;
            return () => {};
          },
        };
      },
    });
    jest.useFakeTimers();
    try {
      activities.length = 0;
      listener(event);
      jest.advanceTimersByTime(60_000);
      expect(activities.at(-1)?.isHeartbeat).toBe(true);
      live = false; // The adapter finished; its normalized completion was lost.
      jest.advanceTimersByTime(60_000);
      expect(activities.at(-1)).toMatchObject({ detailKind: "idle", detail: "Idle" });
      expect(runtime.busyAgents()).toEqual([]);
      const count = activities.length;
      listener({ type: "tool-end", id: "real-tool", isError: false });
      listener({ type: "thinking-delta", text: "late summary" });
      jest.advanceTimersByTime(600_000);
      expect(activities).toHaveLength(count);
    } finally {
      await runtime.stop();
    }
  });
}

for (const type of ["text-delta", "thinking-delta"] as const) {
  test(`native Idle flushes valid buffered ${type} before discarding late events`, async () => {
    let live = true;
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => {};
    const { runtime, activities } = await harness({
      provider: "pi",
      async createAgentSession() {
        return {
          ...sessionSpy(),
          get hasLiveTurn() {
            return live;
          },
          subscribe(next) {
            listener = next;
            return () => {};
          },
        };
      },
    });
    jest.useFakeTimers();
    try {
      activities.length = 0;
      listener({ type, text: "valid final output" });
      live = false;
      listener({ type: "tool-end", id: "late-tool", isError: false });
      expect(activities.at(-1)?.detailKind).toBe("idle");
      expect(
        activities.some((activity) =>
          activity.entries?.some(
            (entry) =>
              (entry.kind === "text" || entry.kind === "thinking") &&
              entry.text === "valid final output",
          ),
        ),
      ).toBe(true);
      const count = activities.length;
      jest.advanceTimersByTime(600_000);
      expect(activities).toHaveLength(count);
      expect(runtime.busyAgents()).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });
}

for (const stillLive of [false, true]) {
  test(`a rejected notice restores Idle only if the provider has no live turn (${stillLive})`, async () => {
    let live = true;
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => {};
    const { runtime, activities } = await harness({
      provider: "pi",
      async createAgentSession() {
        return {
          ...sessionSpy(),
          get hasLiveTurn() {
            return live;
          },
          subscribe(next) {
            listener = next;
            return () => {};
          },
          async notify() {
            throw new Error("notice rejected");
          },
        };
      },
    });
    try {
      listener({ type: "tool-start", id: "tool", name: "Read" });
      live = stillLive;
      await expect(
        runtime.handleAgentMessage({
          protocolMajor: 1,
          requestId: "request",
          messageId: "message",
          deliveryId: "delivery",
          sequence: 1,
          workspaceId: connection.workspaceId,
          conversationId: "conversation",
          agentId: "agent-a",
          body: "hello",
          method: "agent:v1:message:deliver",
          target: "@agent",
        }),
      ).rejects.toThrow("notice rejected");
      expect(runtime.busyAgents().length).toBe(stillLive ? 1 : 0);
      if (!stillLive) expect(activities.at(-1)?.detailKind).toBe("idle");
    } finally {
      await runtime.stop();
    }
  });
}

test("re-sends the last busy Activity every heartbeat interval while the Agent stays busy", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "tool_started", level: "info", detail: "Read" });
    expect(activities).toHaveLength(1);
    const seqAfterFirst = activities[0]!.clientSeq;

    jest.advanceTimersByTime(60_000);
    expect(activities).toHaveLength(2);
    expect(activities[1]).toMatchObject({ detailKind: "tool_started", isHeartbeat: true });
    expect(activities[1]!.clientSeq).toBeGreaterThan(seqAfterFirst);
    expect(activities[1]!.entries ?? []).toHaveLength(0);

    jest.advanceTimersByTime(60_000);
    expect(activities).toHaveLength(3);
    expect(activities[2]).toMatchObject({ detailKind: "tool_started", isHeartbeat: true });
    expect(activities[2]!.clientSeq).toBeGreaterThan(activities[1]!.clientSeq);
  } finally {
    await runtime.stop();
  }
});

test("idle stops the heartbeat", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "thinking_started", level: "info", detail: "" });
    emit({ detailKind: "idle", level: "info", detail: "" });
    const countAfterIdle = activities.length;
    jest.advanceTimersByTime(600_000);
    expect(activities).toHaveLength(countAfterIdle);
  } finally {
    await runtime.stop();
  }
});

test("runtime_error stops the heartbeat", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "running_command", level: "info", detail: "ls" });
    emit({ detailKind: "runtime_error", level: "error", detail: "boom" });
    const countAfterError = activities.length;
    jest.advanceTimersByTime(600_000);
    expect(activities).toHaveLength(countAfterError);
  } finally {
    await runtime.stop();
  }
});

test("stopping the Agent's launch stops the heartbeat without leaking a timer", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "model_response_started", level: "info", detail: "" });
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await runtime.stopAgent("agent-a");
    expect(jest.getTimerCount()).toBe(0);
    const countAfterStop = activities.length;
    jest.advanceTimersByTime(600_000);
    expect(activities).toHaveLength(countAfterStop);
  } finally {
    await runtime.stop();
  }
});

test("stopping the runtime clears every pending heartbeat timer", async () => {
  const { runtime, emit } = await harness();
  jest.useFakeTimers();
  emit({ detailKind: "running_command", level: "info", detail: "ls" });
  expect(jest.getTimerCount()).toBeGreaterThan(0);
  await runtime.stop();
  expect(jest.getTimerCount()).toBe(0);
});

test("no heartbeat is scheduled once Activity is disabled", async () => {
  const { runtime, activities, emit } = await harness();
  await runtime.stop();
  jest.useFakeTimers();
  const countAfterStop = activities.length;
  emit({ detailKind: "tool_started", level: "info", detail: "Read" });
  jest.advanceTimersByTime(600_000);
  expect(activities).toHaveLength(countAfterStop);
});

test("busy Agent replies to an activity probe with the remembered activity and re-arms the heartbeat", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "tool_started", level: "info", detail: "Read" });
    expect(activities).toHaveLength(1);

    jest.advanceTimersByTime(30_000);
    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      probeId: "probe-1",
    });

    expect(activities).toHaveLength(2);
    expect(activities[1]).toMatchObject({
      detailKind: "tool_started",
      probeId: "probe-1",
      isHeartbeat: false,
    });
    expect(activities[1]!.entries ?? []).toHaveLength(0);

    // The original 60s heartbeat (armed at t=0) would have fired at t=60_000; the probe reply at
    // t=30_000 re-arms it, so nothing more is due until t=90_000.
    jest.advanceTimersByTime(59_999);
    expect(activities).toHaveLength(2);

    jest.advanceTimersByTime(1);
    expect(activities).toHaveLength(3);
    expect(activities[2]).toMatchObject({ detailKind: "tool_started", isHeartbeat: true });
  } finally {
    await runtime.stop();
  }
});

test("a heartbeat after a busy probe reply re-sends the turn's own frame, without the probe id", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "tool_started", level: "info", detail: "Read" });
    const busySince = runtime.busyAgents()[0]!.busySinceMs;
    jest.advanceTimersByTime(30_000);
    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request-4",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      probeId: "probe-4",
    });
    expect(activities[1]).toMatchObject({ detailKind: "tool_started", probeId: "probe-4" });
    // The reply is no new busy evidence: the turn is still busy since its own frame.
    expect(runtime.busyAgents()).toEqual([
      { agentId: "agent-a", detailKind: "tool_started", busySinceMs: busySince },
    ]);

    jest.advanceTimersByTime(60_000);
    expect(activities).toHaveLength(3);
    expect(activities[2]).toMatchObject({ detailKind: "tool_started", isHeartbeat: true });
    expect(activities[2]!.probeId).toBeUndefined();
  } finally {
    await runtime.stop();
  }
});

test("idle launched Agent replies to an activity probe with idle", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "idle", level: "info", detail: "" });
    expect(activities).toHaveLength(1);

    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request-2",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      probeId: "probe-2",
    });

    expect(activities).toHaveLength(2);
    expect(activities[1]).toMatchObject({ detailKind: "idle", detail: "Idle", probeId: "probe-2" });
  } finally {
    await runtime.stop();
  }
});

test("an activity probe for an unknown Agent sends nothing", async () => {
  const { runtime, activities } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request-3",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-unknown",
      probeId: "probe-3",
    });

    expect(activities).toHaveLength(0);
  } finally {
    await runtime.stop();
  }
});

test("a progress event announces runtime_progress while the Agent is not yet visibly busy", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "progress" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ detailKind: "runtime_progress", detail: "" });
    // The first announcement makes this launch busy, so another ping stays silent.
    emitEvent({ type: "progress" });
    expect(activities).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("a progress event is suppressed once the Agent already looks busy", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-start", id: "tool-1", name: "Bash" });
    emitEvent({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "ls",
        observedAtMs: Date.now(),
      },
    });
    activities.length = 0;
    emitEvent({ type: "progress" });
    emitEvent({ type: "progress" });
    // Suppressed: the Agent's last announced activity is already a visible busy kind.
    expect(activities).toHaveLength(0);
  } finally {
    await runtime.stop();
  }
});

test("a progress event announces again after the turn becomes idle", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "progress" });
    emitEvent({ type: "completed", status: "completed" });
    expect(activities.map((a) => a.detailKind)).toEqual(["runtime_progress", "idle"]);
    emitEvent({ type: "progress" });
    expect(activities.map((a) => a.detailKind)).toEqual([
      "runtime_progress",
      "idle",
      "runtime_progress",
    ]);
    expect(activities[2]).toMatchObject({ agentId: "agent-a", level: "info", detail: "" });
  } finally {
    await runtime.stop();
  }
});

test.each([
  ["text-delta", "model_response_started", "text"],
  ["thinking-delta", "thinking_started", "thinking"],
] as const)(
  "a progress event never flushes buffered %s or ends its run",
  async (type, detailKind, entryKind) => {
    const { runtime, activities, emitEvent } = await harness();
    jest.useFakeTimers();
    try {
      activities.length = 0;
      emitEvent({ type: "progress" });
      // Not yet busy: the ping announces runtime_progress.
      expect(activities.map((a) => a.detailKind)).toEqual(["runtime_progress"]);
      emitEvent({ type, text: "still writing" });
      emitEvent({ type: "progress" });
      // Already busy (the run-start frame): the ping announces nothing and flushes nothing.
      expect(activities.map((a) => a.detailKind)).toEqual(["runtime_progress", detailKind]);
      jest.advanceTimersByTime(350);
      expect(activities.map((a) => a.detailKind)).toEqual([
        "runtime_progress",
        detailKind,
        detailKind,
      ]);
      expect(activities[2]?.entries).toMatchObject([{ kind: entryKind, text: "still writing" }]);
    } finally {
      await runtime.stop();
    }
  },
);

test.each([
  ["warning", "runtime_progress", 463],
  ["info", "running_command", 151],
  ["info", "tool_started", 463],
  ["info", "checking_messages", 463],
  ["info", "runtime_reconnecting", 463],
  ["info", "thinking_end", 463],
] as const)(
  "scrubs %s %s Activity text and preserves its Unicode cap",
  async (level, detailKind, emojiCount) => {
    const { runtime, activities, emit } = await harness();
    try {
      activities.length = 0;
      emit({
        detailKind,
        level,
        detail: `password=fixture-secret Bearer fixture-token sk-fixture-key ${"🙂".repeat(600)}`,
      });
      expect(activities).toHaveLength(1);
      // The redacted prefix is 49 code points: 463 more fill the 512-point cap,
      // while a command's 200-point cap leaves room for 151. Emoji must stay whole.
      expect(activities[0]).toMatchObject({
        agentId: "agent-a",
        detailKind,
        level,
        detail: `password=[REDACTED] Bearer [REDACTED] [REDACTED] ${"🙂".repeat(emojiCount)}`,
      });
    } finally {
      await runtime.stop();
    }
  },
);

test("compaction-started reports Compacting context once, and a repeat is deduped", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "compaction-started" });
    emitEvent({ type: "compaction-started" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "compacting_context",
      detail: "Compacting context",
    });
  } finally {
    await runtime.stop();
  }
});

test("compaction-finished ends an open compaction, and without one is a no-op", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "compaction-finished" });
    expect(activities).toHaveLength(0);
    emitEvent({ type: "compaction-started" });
    activities.length = 0;
    emitEvent({ type: "compaction-finished" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      agentId: "agent-a",
      detailKind: "compaction_finished",
      level: "info",
      detail: "Context compaction finished",
    });
    emitEvent({ type: "compaction-finished" });
    expect(activities).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("a compaction still open after its stale window broadcasts compaction_stale once", async () => {
  const { runtime, activities, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    emitEvent({ type: "compaction-started" });
    activities.length = 0;
    jest.advanceTimersByTime(COMPACTION_STALE_MS);
    // Heartbeats re-send the last busy activity; the stale notice itself is not a heartbeat.
    const staleNotices = activities.filter(
      (a) => a.detailKind === "compaction_stale" && !a.isHeartbeat,
    );
    expect(staleNotices).toHaveLength(1);
    expect(staleNotices[0]).toMatchObject({
      level: "info",
      detail: "Context compaction still running; no finish event observed",
    });
    // One-shot: the same episode never re-arms the notice; only a fresh start would.
    jest.advanceTimersByTime(COMPACTION_STALE_MS);
    expect(
      activities.filter((a) => a.detailKind === "compaction_stale" && !a.isHeartbeat),
    ).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("a finished compaction never broadcasts compaction_stale", async () => {
  const { runtime, activities, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    emitEvent({ type: "compaction-started" });
    emitEvent({ type: "compaction-finished" });
    activities.length = 0;
    jest.advanceTimersByTime(2 * COMPACTION_STALE_MS);
    expect(activities.filter((a) => a.detailKind === "compaction_stale")).toHaveLength(0);
  } finally {
    await runtime.stop();
  }
});

test("resumed text after an open compaction infers it finished, reported before the resumed text", async () => {
  const { runtime, activities, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    emitEvent({ type: "compaction-started" });
    activities.length = 0;
    emitEvent({ type: "text-delta", text: "back to work" });
    jest.advanceTimersByTime(350);
    // Inferred finish, then the run-start frame, then the text.
    expect(activities.map((a) => a.detailKind)).toEqual([
      "compaction_finished",
      "model_response_started",
      "model_response_started",
    ]);
    expect(activities[0]).toMatchObject({
      agentId: "agent-a",
      level: "info",
      detail: "Context compaction finished (inferred from resumed output)",
    });
    emitEvent({ type: "compaction-finished" });
    expect(activities).toHaveLength(3);
  } finally {
    await runtime.stop();
  }
});

test("a started tool after an open compaction infers it finished, reported before the tool", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    emitEvent({ type: "compaction-started" });
    activities.length = 0;
    emitEvent({ type: "tool-start", id: "tool-1", name: "Bash", input: { command: "ls" } });
    expect(activities.map((a) => a.detailKind)).toEqual(["compaction_finished", "running_command"]);
    expect(activities[0]).toMatchObject({
      agentId: "agent-a",
      level: "info",
      detail: "Context compaction finished (inferred from resumed tool use)",
    });
    emitEvent({ type: "compaction-finished" });
    expect(activities).toHaveLength(2);
  } finally {
    await runtime.stop();
  }
});

test("a turn ending after an open compaction infers it finished, reported before idle", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    emitEvent({ type: "compaction-started" });
    activities.length = 0;
    emitEvent({ type: "completed", status: "completed" });
    expect(activities.map((a) => a.detailKind)).toEqual(["compaction_finished", "idle"]);
    expect(activities[0]).toMatchObject({
      agentId: "agent-a",
      level: "info",
      detail: "Context compaction finished (inferred from turn end)",
    });
    emitEvent({ type: "compaction-finished" });
    expect(activities).toHaveLength(2);
  } finally {
    await runtime.stop();
  }
});

test("compaction-interrupted reports an open compaction as interrupted, once", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "compaction-interrupted" });
    expect(activities).toHaveLength(0);
    emitEvent({ type: "compaction-started" });
    activities.length = 0;
    emitEvent({ type: "compaction-interrupted" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      agentId: "agent-a",
      detailKind: "system_message",
      level: "info",
      detail: "Context compaction interrupted; completion was not confirmed",
    });
    // Cleared: a repeated interrupt and a later explicit finish are no-ops.
    emitEvent({ type: "compaction-interrupted" });
    emitEvent({ type: "compaction-finished" });
    expect(activities).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("stopping the Agent's launch clears its compaction watchdog without leaking a timer", async () => {
  const { runtime, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    emitEvent({ type: "compaction-started" });
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await runtime.stopAgent("agent-a");
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    await runtime.stop();
  }
});

test("review-started reports Reviewing changes once, and a repeat is deduped", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "review-started" });
    emitEvent({ type: "review-started" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      agentId: "agent-a",
      detailKind: "reviewing_changes",
      level: "info",
      detail: "Reviewing changes",
    });
  } finally {
    await runtime.stop();
  }
});

test("review-finished ends an open review, and without one is a no-op", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "review-finished" });
    expect(activities).toHaveLength(0);
    emitEvent({ type: "review-started" });
    activities.length = 0;
    emitEvent({ type: "review-finished" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      agentId: "agent-a",
      detailKind: "review_finished",
      level: "info",
      detail: "Review finished",
    });
    emitEvent({ type: "review-finished" });
    expect(activities).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("review mode does not end on the tool calls and output it is made of", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    emitEvent({ type: "review-started" });
    activities.length = 0;
    emitEvent({ type: "tool-start", id: "tool-1", name: "Bash", input: { command: "git diff" } });
    emitEvent({ type: "tool-end", id: "tool-1", isError: false });
    expect(activities.map((a) => a.detailKind)).toEqual(["running_command", "tool_end"]);
    emitEvent({ type: "review-finished" });
    expect(activities.at(-1)).toMatchObject({ detailKind: "review_finished" });
  } finally {
    await runtime.stop();
  }
});

test("a review still open after its longer stale window broadcasts review_stale once", async () => {
  const { runtime, activities, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    emitEvent({ type: "review-started" });
    activities.length = 0;
    // Past the compaction window, a review is not stale yet.
    jest.advanceTimersByTime(COMPACTION_STALE_MS);
    expect(activities.filter((a) => a.detailKind === "review_stale")).toHaveLength(0);
    jest.advanceTimersByTime(REVIEW_STALE_MS - COMPACTION_STALE_MS);
    const staleNotices = activities.filter(
      (a) => a.detailKind === "review_stale" && !a.isHeartbeat,
    );
    expect(staleNotices).toHaveLength(1);
    expect(staleNotices[0]).toMatchObject({
      level: "info",
      detail: "Review mode still active; no finish event observed",
    });
    jest.advanceTimersByTime(REVIEW_STALE_MS);
    expect(
      activities.filter((a) => a.detailKind === "review_stale" && !a.isHeartbeat),
    ).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("a turn ending closes an open review without a row, so it never goes stale while idle", async () => {
  const { runtime, activities, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    emitEvent({ type: "review-started" });
    activities.length = 0;
    emitEvent({ type: "completed", status: "completed" });
    expect(activities.map((a) => a.detailKind)).toEqual(["idle"]);
    jest.advanceTimersByTime(2 * REVIEW_STALE_MS);
    expect(activities.map((a) => a.detailKind)).toEqual(["idle"]);
    // Closed: a late finish reports nothing.
    emitEvent({ type: "review-finished" });
    expect(activities.map((a) => a.detailKind)).toEqual(["idle"]);
  } finally {
    await runtime.stop();
  }
});

test("stopping the Agent's launch clears its review watchdog without leaking a timer", async () => {
  const { runtime, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    emitEvent({ type: "review-started" });
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await runtime.stopAgent("agent-a");
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    await runtime.stop();
  }
});

// tool_end/thinking_end/compaction_finished/review_finished are busy-but-filler,
// exactly like runtime_progress — they re-arm the heartbeat.
for (const detailKind of [
  "tool_end",
  "thinking_end",
  "compaction_finished",
  "review_finished",
] as const) {
  test(`${detailKind} is busy-but-filler: it re-arms the heartbeat`, async () => {
    const { runtime, activities, emit } = await harness();
    jest.useFakeTimers();
    try {
      activities.length = 0;
      emit({ detailKind, level: "info", detail: "" });
      expect(activities).toHaveLength(1);
      jest.advanceTimersByTime(60_000);
      expect(activities).toHaveLength(2);
      expect(activities[1]).toMatchObject({ detailKind, isHeartbeat: true });
    } finally {
      await runtime.stop();
    }
  });
}

test("tool-end AgentRuntimeEvent reports as tool_end", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-end", id: "tool-1", isError: false });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "tool_end",
      level: "info",
      detail: "Tool finished",
    });
  } finally {
    await runtime.stop();
  }
});

test("compacting_context and subagent_activity are visible busy kinds that re-arm the heartbeat", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "compacting_context", level: "info", detail: "" });
    emit({ detailKind: "subagent_activity", level: "info", detail: "" });
    expect(activities).toHaveLength(2);
    jest.advanceTimersByTime(60_000);
    expect(activities).toHaveLength(3);
    expect(activities[2]).toMatchObject({ detailKind: "subagent_activity", isHeartbeat: true });
  } finally {
    await runtime.stop();
  }
});

test("a subagent-scoped activity is reclassified as subagent_activity", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "",
        observedAtMs: Date.now(),
        entries: [{ kind: "tool_start", toolName: "Bash", subagent: { parentToolUseId: "t1" } }],
      },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ detailKind: "subagent_activity" });
  } finally {
    await runtime.stop();
  }
});

test("a subagent-scoped error activity keeps its error classification", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "activity",
      activity: {
        detailKind: "runtime_error",
        level: "error",
        detail: "subagent failed",
        observedAtMs: Date.now(),
        entries: [{ kind: "text", text: "boom", subagent: { parentToolUseId: "t1" } }],
      },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ detailKind: "runtime_error", level: "error" });
  } finally {
    await runtime.stop();
  }
});

// A `tool-start` AgentRuntimeEvent carries only the provider's raw name/input;
// the daemon core is the single place that turns it into an Activity, via the
// same `toolActivity` allowlist every provider used to call for itself.
test("a bash tool-start reports running_command with a generic detail label, the command in toolInput", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-start", id: "1", name: "Bash", input: { command: "ls -la" } });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "running_command",
      level: "info",
      detail: "Running command…",
      entries: [{ kind: "tool_start", toolName: "bash", toolInput: "ls -la" }],
    });
  } finally {
    await runtime.stop();
  }
});

test("a Codex-shaped bash tool-start resolves `coforge message send` to send_message, not a generic command", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "item-1",
      name: "bash",
      input: {
        command: [
          "coforge message send --target '#x' <<'COFORGE_MESSAGE'",
          "hi",
          "COFORGE_MESSAGE",
        ].join("\n"),
      },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "tool_started",
      detail: "Sending message…",
      entries: [{ kind: "tool_start", toolName: "send_message", toolInput: "#x" }],
    });
  } finally {
    await runtime.stop();
  }
});

test("`coforge message check` reports checking_messages with a generic detail label", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "1",
      name: "bash",
      input: { command: "coforge message check" },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "checking_messages",
      detail: "Checking messages…",
      entries: [{ kind: "tool_start", toolName: "check_messages" }],
    });
  } finally {
    await runtime.stop();
  }
});

test("a file tool-start reports a generic detail label, its path in toolInput", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "1",
      name: "read_file",
      input: { file_path: "src/a.ts" },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "tool_started",
      detail: "Reading file…",
      entries: [{ kind: "tool_start", toolName: "read_file", toolInput: "src/a.ts" }],
    });
  } finally {
    await runtime.stop();
  }
});

test("an unrecognized tool-start reports a generic unknown-tool label built from its name alone", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "1",
      name: "MysteryTool",
      input: { secret: "private" },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "tool_started",
      detail: "Using MysteryTool…",
      entries: [{ kind: "tool_start", toolName: "MysteryTool" }],
    });
    expect(activities[0]!.entries![0]).not.toHaveProperty("toolInput");
  } finally {
    await runtime.stop();
  }
});

test("the busy heartbeat and an activity probe reply re-send only the generic detail label, never the command", async () => {
  const { runtime, activities, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "1",
      name: "Bash",
      input: { command: 'mise exec -- bun test 2>&1 | grep -iE "error:|DATABASE_URL"' },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "running_command",
      detail: "Running command…",
    });
    expect(activities[0]!.entries).toHaveLength(1);

    jest.advanceTimersByTime(60_000);
    expect(activities).toHaveLength(2);
    expect(activities[1]).toMatchObject({
      detailKind: "running_command",
      detail: "Running command…",
      isHeartbeat: true,
    });
    expect(activities[1]!.entries ?? []).toHaveLength(0);
    expect(JSON.stringify(activities[1])).not.toContain("mise exec");
    expect(JSON.stringify(activities[1])).not.toContain("DATABASE_URL");

    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request-heartbeat-label",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      probeId: "probe-heartbeat-label",
    });
    expect(activities).toHaveLength(3);
    expect(activities[2]).toMatchObject({
      detailKind: "running_command",
      detail: "Running command…",
      probeId: "probe-heartbeat-label",
    });
    expect(activities[2]!.entries ?? []).toHaveLength(0);
    expect(JSON.stringify(activities[2])).not.toContain("mise exec");
  } finally {
    await runtime.stop();
  }
});

test("pending text is flushed before a tool-start's Activity", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "text-delta", text: "Thinking about it" });
    emitEvent({ type: "tool-start", id: "1", name: "Bash", input: { command: "ls" } });
    // The run-start frame announces the response first, then the buffered text lands
    // before the tool's own Activity.
    expect(activities.map((activity) => activity.detailKind)).toEqual([
      "model_response_started",
      "model_response_started",
      "running_command",
    ]);
    expect(activities[0]?.entries ?? []).toHaveLength(0);
    expect(activities[1]).toMatchObject({
      entries: [{ kind: "text", text: "Thinking about it" }],
    });
    expect(activities[2]).toMatchObject({
      detail: "Running command…",
      entries: [{ kind: "tool_start", toolName: "bash", toolInput: "ls" }],
    });
  } finally {
    await runtime.stop();
  }
});

test.each([
  {
    name: "Bash",
    input: { command: "ls" },
    detail: "Running command…",
    detailKind: "running_command",
    toolName: "bash",
    toolInput: "ls",
  },
  {
    name: "Read",
    input: { file_path: "src/a.ts", content: "private contents" },
    detail: "Reading file…",
    detailKind: "tool_started",
    toolName: "read_file",
    toolInput: "src/a.ts",
  },
])("a subagent-scoped $name tool-start retains its entry and classification", async (tool) => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "1",
      name: tool.name,
      input: tool.input,
      subagent: { parentToolUseId: "t1" },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "subagent_activity",
      level: "info",
      detail: tool.detail,
    });
    expect(activities[0]?.entries).toEqual([
      {
        kind: "tool_start",
        toolName: tool.toolName,
        toolInput: tool.toolInput,
        callId: "1",
        subagent: { parentToolUseId: "t1" },
      },
    ]);

    // A subsequent parent tool keeps its ordinary kind and carries no child scope.
    emitEvent({ type: "tool-start", id: "2", name: tool.name, input: tool.input });
    expect(activities).toHaveLength(2);
    expect(activities[1]).toMatchObject({
      detailKind: tool.detailKind,
      level: "info",
      detail: tool.detail,
    });
    expect(activities[1]?.entries).toEqual([
      { kind: "tool_start", toolName: tool.toolName, toolInput: tool.toolInput, callId: "2" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test.each(["runtime_crashed", "runtime_interrupted"] as const)(
  "%s stops the heartbeat like other terminal kinds",
  async (detailKind) => {
    const { runtime, activities, emit } = await harness();
    jest.useFakeTimers();
    try {
      activities.length = 0;
      emit({ detailKind: "running_command", level: "info", detail: "ls" });
      emit({ detailKind, level: detailKind === "runtime_crashed" ? "error" : "info", detail: "" });
      const countAfter = activities.length;
      jest.advanceTimersByTime(600_000);
      expect(activities).toHaveLength(countAfter);
    } finally {
      await runtime.stop();
    }
  },
);

test("a completed event's interrupted status reports runtime_interrupted", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "completed", status: "interrupted" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ detailKind: "runtime_interrupted", level: "info" });
  } finally {
    await runtime.stop();
  }
});

test("stopAgent reports runtime_interrupted before stopped when it cuts a busy turn", async () => {
  const { runtime, activities, emit } = await harness();
  try {
    activities.length = 0;
    emit({ detailKind: "running_command", level: "info", detail: "ls" });
    activities.length = 0;
    await runtime.stopAgent("agent-a");
    const kinds = activities.map((activity) => activity.detailKind);
    expect(kinds).toEqual(["runtime_interrupted", "stopped"]);
    expect(activities.at(-1)).toMatchObject({ detailKind: "stopped", detail: "Stopped" });
  } finally {
    await runtime.stop();
  }
});

test("stopAgent does not report runtime_interrupted when the Agent was idle", async () => {
  const { runtime, activities, emit } = await harness();
  try {
    activities.length = 0;
    emit({ detailKind: "idle", level: "info", detail: "" });
    await runtime.stopAgent("agent-a");
    const kinds = activities.map((activity) => activity.detailKind);
    expect(kinds).not.toContain("runtime_interrupted");
    expect(kinds).toContain("stopped");
  } finally {
    await runtime.stop();
  }
});

test("subagent progress shows each new phase once while the turn is busy, and nothing untracked after it", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    emitEvent({ type: "progress" });
    activities.length = 0;
    const lineage = { subagentType: "general-purpose", parentToolUseId: "toolu_agent" };
    emitEvent({ type: "subagent-progress", phase: "started", ...lineage });
    emitEvent({ type: "subagent-progress", phase: "progress", ...lineage });
    emitEvent({ type: "subagent-progress", phase: "progress", ...lineage });
    emitEvent({ type: "subagent-progress", phase: "notification", ...lineage });
    emitEvent({ type: "subagent-progress", phase: "started" });
    expect(
      activities.map(({ detailKind, level, detail }) => ({ detailKind, level, detail })),
    ).toEqual(
      [
        "Subagent started (general-purpose)",
        "Subagent working (general-purpose)",
        "Subagent update (general-purpose)",
        "Subagent started",
      ].map((detail) => ({ detailKind: "subagent_activity", level: "info", detail })),
    );
    // None of these named a task, so none is outstanding: the turn ends Idle, and a late report
    // about a task the daemon never counted must not wake the idle Agent.
    emitEvent({ type: "completed", status: "completed" });
    expect(activities.at(-1)).toMatchObject({ detailKind: "idle" });
    activities.length = 0;
    emitEvent({ type: "subagent-progress", phase: "notification", ...lineage });
    expect(activities).toHaveLength(0);
  } finally {
    await runtime.stop();
  }
});

/** A provider whose session reports a live turn until the test ends it, as Claude Code does; a
 * notice starts a new turn. */
function liveTurnProvider() {
  const state = { live: true, listener: (_event: AgentRuntimeEvent): void => undefined };
  const notices: string[] = [];
  const provider: CodeAgentProvider = {
    provider: "pi",
    async createAgentSession() {
      state.live = true;
      return {
        ...sessionSpy(),
        get hasLiveTurn() {
          return state.live;
        },
        subscribe(next) {
          state.listener = next;
          return () => undefined;
        },
        async notify(text) {
          notices.push(text);
          state.live = true;
        },
      };
    },
  };
  return {
    provider,
    notices,
    emit(event: AgentRuntimeEvent) {
      state.listener(event);
    },
    /** The provider's turn ends; with `completed: false` it reports no outcome. */
    endTurn({ completed = true }: { completed?: boolean } = {}) {
      state.live = false;
      if (completed) state.listener({ type: "completed", status: "completed" });
    },
  };
}

const shown = (activities: AgentActivity[]) =>
  activities.map(({ detailKind, detail }) => `${detailKind}: ${detail}`);

const explore = { subagentType: "Explore", parentToolUseId: "toolu_explore" };

/** Starts a turn that leaves one background subagent task running. */
function startTaskTurn(live: ReturnType<typeof liveTurnProvider>, taskId = "task-1") {
  live.emit({ type: "progress" });
  live.emit({ type: "subagent-progress", phase: "started", taskId, ...explore });
}

test("a turn that ends with background tasks outstanding stays working until the last one finishes", async () => {
  const live = liveTurnProvider();
  const { runtime, activities } = await harness(live.provider);
  try {
    // task-1 is a subagent; task-2 a background command, which gets its rows too.
    startTaskTurn(live);
    live.emit({
      type: "subagent-progress",
      phase: "started",
      taskId: "task-2",
      parentToolUseId: "toolu_bash",
    });
    activities.length = 0;
    live.endTurn();
    expect(shown(activities)).toEqual(["subagent_activity: Waiting for 2 background tasks"]);
    activities.length = 0;
    // A waiting Agent still shows what its tasks report.
    live.emit({ type: "subagent-progress", phase: "progress", taskId: "task-1", ...explore });
    live.emit({
      type: "subagent-progress",
      phase: "notification",
      taskId: "task-1",
      taskStatus: "completed",
      ...explore,
    });
    expect(shown(activities)).toEqual([
      "subagent_activity: Subagent working (Explore)",
      "subagent_activity: Subagent completed (Explore)",
      "subagent_activity: Waiting for 1 background task",
    ]);
    activities.length = 0;
    live.emit({
      type: "subagent-progress",
      phase: "notification",
      taskId: "task-2",
      taskStatus: "failed",
      parentToolUseId: "toolu_bash",
    });
    expect(shown(activities)).toEqual(["subagent_activity: Subagent failed", "idle: Idle"]);
    expect(runtime.busyAgents()).toEqual([]);
  } finally {
    await runtime.stop();
  }
});

test("only a terminal notification ends a background task", async () => {
  const live = liveTurnProvider();
  const { runtime, activities } = await harness(live.provider);
  jest.useFakeTimers();
  try {
    startTaskTurn(live);
    live.endTurn();
    activities.length = 0;
    live.emit({ type: "subagent-progress", phase: "notification", taskId: "task-1", ...explore });
    // The next heartbeat finds the task still running and shows the wait again.
    jest.advanceTimersByTime(60_000);
    expect(shown(activities)).toEqual([
      "subagent_activity: Subagent update (Explore)",
      "subagent_activity: Waiting for 1 background task",
    ]);
  } finally {
    await runtime.stop();
  }
});

test("the busy heartbeat keeps a background-task wait warm after the turn has ended", async () => {
  const live = liveTurnProvider();
  const { runtime, activities } = await harness(live.provider);
  jest.useFakeTimers();
  try {
    // A repeated start for the same task (a resumed subagent) is still one task.
    startTaskTurn(live);
    live.emit({ type: "subagent-progress", phase: "started", taskId: "task-1", ...explore });
    live.endTurn();
    activities.length = 0;
    jest.advanceTimersByTime(60_000);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "subagent_activity",
      detail: "Waiting for 1 background task",
      isHeartbeat: true,
    });
    // A restart's runner hold waits for it like any busy Agent.
    expect(runtime.busyAgents()).toMatchObject([
      { agentId: "agent-a", detailKind: "subagent_activity" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a turn found over without an outcome shows its wait for background tasks, not Idle", async () => {
  const live = liveTurnProvider();
  const { runtime, activities } = await harness(live.provider);
  jest.useFakeTimers();
  try {
    startTaskTurn(live);
    live.endTurn({ completed: false });
    activities.length = 0;
    jest.advanceTimersByTime(60_000);
    expect(shown(activities)).toEqual(["subagent_activity: Waiting for 1 background task"]);
    activities.length = 0;
    jest.advanceTimersByTime(60_000);
    expect(activities).toMatchObject([
      { detail: "Waiting for 1 background task", isHeartbeat: true },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("an activity probe during a background-task wait replays the wait", async () => {
  const live = liveTurnProvider();
  const { runtime, activities } = await harness(live.provider);
  try {
    startTaskTurn(live);
    live.endTurn();
    activities.length = 0;
    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      probeId: "probe-1",
    });
    expect(activities).toMatchObject([
      {
        detailKind: "subagent_activity",
        detail: "Waiting for 1 background task",
        probeId: "probe-1",
      },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a message during a background-task wait starts a new turn, which ends waiting again", async () => {
  const live = liveTurnProvider();
  const { runtime, activities } = await harness(live.provider);
  try {
    startTaskTurn(live);
    live.endTurn();
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "request",
      messageId: "message",
      deliveryId: "delivery",
      sequence: 1,
      workspaceId: connection.workspaceId,
      conversationId: "conversation",
      agentId: "agent-a",
      body: "hello",
      method: "agent:v1:message:deliver",
      target: "@agent",
    });
    // Delivered as a notice now, not held for the wait to end.
    expect(live.notices).toHaveLength(1);
    expect(live.notices[0]).toContain("@agent  new: 1 message");
    expect(activities.at(-1)).toMatchObject({ detailKind: "message_received" });
    live.emit({ type: "progress" });
    activities.length = 0;
    live.endTurn();
    expect(shown(activities)).toEqual(["subagent_activity: Waiting for 1 background task"]);
  } finally {
    await runtime.stop();
  }
});

test("a new launch forgets the previous launch's outstanding background tasks", async () => {
  const live = liveTurnProvider();
  const { runtime, activities } = await harness(live.provider);
  try {
    startTaskTurn(live);
    live.endTurn();
    expect(activities.at(-1)).toMatchObject({ detail: "Waiting for 1 background task" });
    await runtime.stopAgent("agent-a");
    await runtime.startAgent("agent-a", config);
    live.emit({ type: "progress" });
    activities.length = 0;
    live.endTurn();
    expect(shown(activities)).toEqual(["idle: Idle"]);
  } finally {
    await runtime.stop();
  }
});

/** The real Claude Code adapter over the stream-json fixture, which writes the records `feed`
 * hands it after the launch's startup input. */
function claudeOverFeed() {
  const feed = claudeEventFeed();
  const claude = claudeFixtureProvider();
  const provider: CodeAgentProvider = {
    provider: "claude-code",
    async createAgentSession(options) {
      const session = await claude.createAgentSession({
        ...options,
        instructions: "Test Agent instructions.",
        environment: { ...options.environment, ...feed.environment },
      });
      feed.attach(session);
      return session;
    },
  };
  return { provider, feed };
}

test(
  "a Claude turn started by a finished background task that starts another ends waiting, not Idle",
  async () => {
    const { provider, feed } = claudeOverFeed();
    const { runtime, activities } = await harness(provider);
    try {
      // The launch's startup turn leaves a background command running.
      await feed.emit(...backgroundBash("first"), { type: "result", subtype: "success" });
      expect(activities.at(-1)).toMatchObject({ detail: "Waiting for 1 background task" });
      await feed.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-first",
        tool_use_id: "toolu_first",
        status: "completed",
        summary: "Background command completed (exit code 0)",
      });
      expect(activities.at(-1)).toMatchObject({ detailKind: "idle" });
      // Claude Code handles the notification in a turn of its own, which starts another.
      activities.length = 0;
      await feed.emit(
        { type: "system", subtype: "init", session_id: await feed.sessionId() },
        { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } },
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "The task printed done." }] },
        },
        ...backgroundBash("next"),
        {
          type: "result",
          subtype: "success",
          origin: { kind: "task-notification", producer: "session-task", runId: "run-first" },
        },
      );
      expect(
        activities.some((activity) =>
          activity.entries?.some(
            (entry) => entry.kind === "text" && entry.text === "The task printed done.",
          ),
        ),
      ).toBe(true);
      expect(activities.at(-1)).toMatchObject({
        detailKind: "subagent_activity",
        detail: "Waiting for 1 background task",
      });
      expect(runtime.busyAgents()).toMatchObject([{ agentId: "agent-a" }]);
    } finally {
      await runtime.stop();
      feed.stop();
    }
  },
  10_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS + DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS,
);

test("compaction interruptions and subagent progress retain their conversation origin", async () => {
  const { runtime, activities, emitEvent } = await harness();
  const conversation = { conversationId: "conversation-team", target: "#team" };
  try {
    emitEvent({ type: "compaction-started", conversation });
    activities.length = 0;
    emitEvent({ type: "compaction-interrupted", conversation });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "system_message",
      conversationId: "conversation-team",
      conversationTarget: "#team",
    });
    emitEvent({ type: "progress", conversation });
    activities.length = 0;
    emitEvent({ type: "subagent-progress", phase: "started", conversation });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "subagent_activity",
      conversationId: "conversation-team",
      conversationTarget: "#team",
    });
  } finally {
    await runtime.stop();
  }
});

// The reference client 1.0.50 keys a tool's outcome to its start by the provider's call id
// (`toolCallOutcome.ts`), timing the call from the daemon's own start observation.
test("a tool-end reports its outcome, timed from the matching tool-start, keyed by its callId", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-start", id: "call-1", name: "Bash", input: { command: "make" } });
    emitEvent({ type: "tool-end", id: "call-1", isError: true, exitCode: 2 });
    expect(activities).toHaveLength(2);
    expect(activities[0]!.entries).toEqual([
      { kind: "tool_start", toolName: "bash", toolInput: "make", callId: "call-1" },
    ]);
    expect(activities[1]).toMatchObject({
      detailKind: "tool_end",
      detail: "Tool finished",
      // As in the reference client, a known exit code means the call ran: ok, whatever the code.
      toolOutcome: { callId: "call-1", ok: true, exitCode: 2 },
    });
    // Timed by the launch's ledger (tool-call-ledger.test.ts).
    expect(activities[1]!.toolOutcome?.durationMs).toBeGreaterThanOrEqual(0);
  } finally {
    await runtime.stop();
  }
});

test("a call the Web hides (send_message) still reports its outcome", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "call-1",
      name: "bash",
      input: { command: "coforge message send --target '#x' 'hi'" },
    });
    emitEvent({ type: "tool-end", id: "call-1", isError: false });
    expect(activities[0]!.entries).toEqual([
      { kind: "tool_start", toolName: "send_message", toolInput: "#x", callId: "call-1" },
    ]);
    expect(activities[1]!.toolOutcome).toMatchObject({ callId: "call-1", ok: true });
  } finally {
    await runtime.stop();
  }
});

test("a call still open when its turn completes reports no duration at a late end", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    emitEvent({ type: "tool-start", id: "call-1", name: "Read" });
    emitEvent({ type: "completed", status: "interrupted" });
    activities.length = 0;
    emitEvent({ type: "tool-end", id: "call-1", isError: false });
    expect(activities.find((a) => a.detailKind === "tool_end")?.toolOutcome).toEqual({
      callId: "call-1",
      ok: true,
    });
  } finally {
    await runtime.stop();
  }
});

test("a tool-end with no observed start reports its outcome without a duration", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-end", id: "unseen", isError: false });
    expect(activities).toHaveLength(1);
    expect(activities[0]!.toolOutcome).toEqual({ callId: "unseen", ok: true });
  } finally {
    await runtime.stop();
  }
});

test("a failed call with no exit code reports not ok", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-end", id: "call-1", isError: true });
    expect(activities[0]!.toolOutcome).toEqual({ callId: "call-1", ok: false });
  } finally {
    await runtime.stop();
  }
});

test("a provider-measured duration takes precedence over the daemon's own timing", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-start", id: "call-1", name: "Read", input: { path: "a.ts" } });
    await Bun.sleep(60);
    emitEvent({ type: "tool-end", id: "call-1", isError: false, durationMs: 42.4 });
    expect(activities.at(-1)!.toolOutcome).toEqual({ callId: "call-1", ok: true, durationMs: 42 });
  } finally {
    await runtime.stop();
  }
});

test("a call's outcome is reported once: a repeated tool-end has no duration", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-start", id: "call-1", name: "Read" });
    emitEvent({ type: "tool-end", id: "call-1", isError: false });
    emitEvent({ type: "tool-end", id: "call-1", isError: false });
    expect(activities[1]!.toolOutcome).toHaveProperty("durationMs");
    expect(activities[2]!.toolOutcome).toEqual({ callId: "call-1", ok: true });
  } finally {
    await runtime.stop();
  }
});

test("the busy heartbeat after a tool-end does not repeat its outcome", async () => {
  const { runtime, activities, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-start", id: "call-1", name: "Read" });
    emitEvent({ type: "tool-end", id: "call-1", isError: false });
    jest.advanceTimersByTime(60_000);
    const heartbeat = activities.at(-1)!;
    expect(heartbeat).toMatchObject({ detailKind: "tool_end", isHeartbeat: true });
    expect(heartbeat).not.toHaveProperty("toolOutcome");
  } finally {
    await runtime.stop();
  }
});

test("a probe reply after a tool-end does not repeat its outcome", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-start", id: "call-1", name: "Read" });
    emitEvent({ type: "tool-end", id: "call-1", isError: false });
    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request-outcome",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      probeId: "probe-outcome",
    });
    const reply = activities.at(-1)!;
    expect(reply).toMatchObject({ detailKind: "tool_end", probeId: "probe-outcome" });
    expect(reply).not.toHaveProperty("toolOutcome");
  } finally {
    await runtime.stop();
  }
});
