import { expect, jest, test } from "bun:test";
import { STALLED_TURN_SILENCE_MS } from "#src/daemon-runtime/stalled-turn-indicator";
import { activityHarness } from "./fixtures/activity-runtime";

// A command that never ends is reported stuck even when a file change finished beside it: only
// a call's own `tool-end` closes it (Raft 1.0.59 / oar 0.76, task #339).

const connection = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: `/tmp/coforge-stalled-open-command-${crypto.randomUUID()}`,
};

test("a never-ending command beside a finished file change still reads as stalled", async () => {
  const { runtime, activities, emitEvent } = await activityHarness(connection);
  jest.useFakeTimers();
  try {
    emitEvent({ type: "tool-start", id: "cmd-1", name: "bash", input: { command: "npm run dev" } });
    emitEvent({
      type: "tool-start",
      id: "fc-1:0",
      name: "edit_file",
      input: { file_path: "a.ts" },
    });
    emitEvent({ type: "tool-end", id: "fc-1:0", isError: false });
    emitEvent({ type: "tool-end", id: "file-change:0", isError: false });
    activities.length = 0;
    jest.advanceTimersByTime(STALLED_TURN_SILENCE_MS);
    expect(activities.filter((activity) => activity.detailKind === "runtime_stalled")).toEqual([
      expect.objectContaining({ detailKind: "runtime_stalled", level: "error" }),
    ]);
  } finally {
    jest.useRealTimers();
    await runtime.stop();
  }
});
