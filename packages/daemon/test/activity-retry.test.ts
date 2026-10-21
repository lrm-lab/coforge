import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { ActivityTrajectory } from "#src/agent-runtime/activity-trajectory";
import { activityHarness } from "./fixtures/activity-runtime";

const workspaceRoot = join(realpathSync(tmpdir()), `coforge-activity-retry-${crypto.randomUUID()}`);
const connection = { workspaceRoot, workspaceId: "workspace-a", computerId: "computer-a" };
const harness = () => activityHarness(connection);
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
afterEach(() => jest.useRealTimers());

test.each(["text-delta", "thinking-delta"] as const)(
  "a retry interrupts %s and resumed output immediately replaces the reconnecting display",
  (type) => {
    const output: AgentRuntimeEvent[] = [];
    const trajectory = new ActivityTrajectory((event) => output.push(event));
    try {
      trajectory.accept({ type, text: "before retry" });
      trajectory.accept({ type: "reconnecting", attempt: 1, message: "server_busy" });
      const retryIndex = output.findIndex((event) => event.type === "reconnecting");
      expect(output[retryIndex - 1]).toMatchObject({
        type: "activity",
        activity: {
          detailKind: type === "thinking-delta" ? "thinking_end" : "model_response_started",
        },
      });
      trajectory.accept({ type, text: "after retry" });
      expect(output[retryIndex + 1]).toMatchObject({
        type: "activity",
        activity: {
          detailKind: type === "thinking-delta" ? "thinking_started" : "model_response_started",
          detail: "",
        },
      });
    } finally {
      trajectory.dispose();
    }
  },
);

test("flushes pending text before a raw error event, and before a reconnecting event", () => {
  jest.useFakeTimers();
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  const kinds = () =>
    output.map((event) =>
      event.type === "activity"
        ? `${event.activity.detailKind}${event.activity.entries ? ":text" : ""}`
        : event.type,
    );
  trajectory.accept({ type: "text-delta", text: "still writing" });
  trajectory.accept({ type: "error", message: "provider failed" });
  expect(kinds()).toEqual(["model_response_started", "model_response_started:text", "error"]);
  trajectory.accept({ type: "thinking-delta", text: "still thinking" });
  trajectory.accept({ type: "reconnecting", attempt: 1 });
  // A failed request ends its thought before the retry is displayed.
  expect(kinds().slice(3)).toEqual([
    "thinking_started",
    "thinking_started:text",
    "thinking_end",
    "reconnecting",
  ]);
  trajectory.accept({ type: "error", message: "gave up" });
  expect(kinds().slice(7)).toEqual(["error"]);
  trajectory.dispose();
  jest.advanceTimersByTime(1000);
  expect(output).toHaveLength(8);
});

test("a retry replaces stale thinking in the busy heartbeat until the native turn settles", async () => {
  const { runtime, activities, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    emitEvent({ type: "thinking-delta", text: "preparing" });
    emitEvent({
      type: "reconnecting",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 120_000,
      message: "server_busy password=fixture-secret",
    });
    const retry = activities.at(-1)!;
    expect(retry).toMatchObject({
      detailKind: "runtime_reconnecting",
      detail:
        "Retrying provider request (attempt 1/3, backoff 120s): server_busy password=[REDACTED]",
    });
    expect(runtime.busyAgents()).toMatchObject([
      { agentId: "agent-a", detailKind: "runtime_reconnecting" },
    ]);
    jest.advanceTimersByTime(60_000);
    expect(activities.at(-1)).toMatchObject({
      detailKind: "runtime_reconnecting",
      detail: retry.detail,
      isHeartbeat: true,
      entries: [],
    });
    emitEvent({ type: "thinking-delta", text: "recovered" });
    expect(activities.at(-1)).toMatchObject({ detailKind: "thinking_started", detail: "" });
    emitEvent({ type: "completed", status: "completed" });
    expect(activities.at(-1)?.detailKind).toBe("idle");
    expect(runtime.busyAgents()).toEqual([]);
    const settledCount = activities.length;
    jest.advanceTimersByTime(60_000);
    expect(activities).toHaveLength(settledCount);
  } finally {
    await runtime.stop();
  }
});
