import { expect, jest, test } from "bun:test";
import { STALLED_TURN_SILENCE_MS } from "#src/daemon-runtime/stalled-turn-indicator";
import { activityHarness } from "./fixtures/activity-runtime";

const connection = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: `/tmp/coforge-stalled-turn-${crypto.randomUUID()}`,
};

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
        detail: "Agent runtime has produced no progress for 10 minutes.",
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
