import { expect, jest, test } from "bun:test";
import type { CodeAgentProvider } from "@lrm/coforge-anvil";
import type { AgentTurnInterruptResult } from "@lrm/coforge-sdk/internal";
import {
  formatStalledTurnDetail,
  STALLED_TURN_MODEL_SILENCE_MS,
  STALLED_TURN_SILENCE_MS,
} from "#src/daemon-runtime/stalled-turn-indicator";
import { activityHarness } from "./fixtures/activity-runtime";

const connection = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: `/tmp/coforge-stalled-turn-${crypto.randomUUID()}`,
};

test("formatStalledTurnDetail strips control chars, redacts credentials, and truncates by code points", () => {
  expect(formatStalledTurnDetail(10, "   \n\t\u009b  ")).toBe(
    "Agent runtime has produced no progress for 10 minutes.",
  );
  expect(formatStalledTurnDetail(12, "Bash\u001b[31m\u009b run")).toBe(
    "Agent runtime has produced no progress for 12 minutes (stuck on Bash [31m run).",
  );
  const longEmoji = "🔧".repeat(85);
  const formatted = formatStalledTurnDetail(15, longEmoji);
  expect(formatted).toContain("stuck on ");
  expect([...formatted]).not.toContain("\uFFFD");
  expect(
    formatStalledTurnDetail(10, "Bearer sk-ant-api03-1234567890abcdefghijklmnop"),
  ).not.toContain("sk-ant-api03-1234567890");
});

test("a silent busy turn emits one stalled indicator and stays heartbeat-busy", async () => {
  const { runtime, activities, emitEvent } = await activityHarness(connection);
  jest.useFakeTimers();
  try {
    emitEvent({ type: "tool-start", id: "tool-1", name: "Bash", input: {} });
    emitEvent({ type: "progress" });
    activities.length = 0;
    jest.advanceTimersByTime(STALLED_TURN_SILENCE_MS);
    expect(activities.filter((activity) => activity.detailKind === "runtime_stalled")).toEqual([
      expect.objectContaining({
        detailKind: "runtime_stalled",
        level: "error",
        detail: "Agent runtime has produced no progress for 10 minutes (stuck on Bash).",
      }),
    ]);
    jest.advanceTimersByTime(STALLED_TURN_SILENCE_MS);
    expect(
      activities.filter(
        (activity) => activity.detailKind === "runtime_stalled" && !activity.isHeartbeat,
      ),
    ).toHaveLength(1);
    emitEvent({ type: "completed", status: "completed" });
    expect(activities.at(-1)?.detailKind).toBe("idle");
  } finally {
    jest.useRealTimers();
    await runtime.stop();
  }
});

test("a silent busy turn without an open tool keeps the generic stalled detail", async () => {
  const { runtime, activities, emitEvent } = await activityHarness(connection);
  jest.useFakeTimers();
  try {
    emitEvent({ type: "tool-start", id: "tool-1", name: "Bash", input: {} });
    emitEvent({ type: "tool-end", id: "tool-1", isError: false });
    emitEvent({ type: "progress" });
    activities.length = 0;
    jest.advanceTimersByTime(STALLED_TURN_MODEL_SILENCE_MS);
    expect(activities.filter((activity) => activity.detailKind === "runtime_stalled")).toEqual([
      expect.objectContaining({
        detailKind: "runtime_stalled",
        level: "error",
        detail: "Agent runtime has produced no progress for 20 minutes.",
      }),
    ]);
  } finally {
    jest.useRealTimers();
    await runtime.stop();
  }
});

test("stopping a turn whose runtime must restart says so, then reports the restart", async () => {
  const results: AgentTurnInterruptResult[] = [];
  const provider: CodeAgentProvider = {
    provider: "pi",
    async createAgentSession() {
      return {
        hasLiveTurn: true,
        async sendMessage() {},
        subscribe: () => () => undefined,
        async interrupt() {
          throw new Error("provider ignored the interrupt");
        },
        onExit: () => () => undefined,
        async dispose() {},
      };
    },
  };
  const { runtime, activities } = await activityHarness(connection, provider, {
    async sendAgentTurnInterruptResult(result: AgentTurnInterruptResult) {
      results.push(result);
    },
  });
  try {
    const launchId = activities.find((activity) => activity.launchId)?.launchId;
    expect(launchId).toBeDefined();
    activities.length = 0;
    await runtime.handleAgentTurnInterrupt({
      protocolMajor: 1,
      requestId: "interrupt-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi",
      epoch: 1,
      launchId: launchId!,
    });
    expect(activities.map((activity) => activity.detail)).toContain(
      "Stopping this turn: restarting the runtime",
    );
    expect(results).toEqual([expect.objectContaining({ status: "restarted", agentId: "agent-a" })]);
  } finally {
    await runtime.stop();
  }
});
