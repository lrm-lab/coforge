import { expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { ActivityTrajectory } from "#src/agent-runtime/activity-trajectory";

/** The rows that carry text: an announcement has no entries, and a separator must produce none. */
const rows = (output: readonly AgentRuntimeEvent[]) =>
  output.filter((event) => event.type === "activity" && event.activity.entries);

test("a whitespace-only segment is no activity row, while text keeps its newlines", () => {
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  try {
    // Providers stream the separators between tool calls as their own chunk.
    for (const text of ["\n\n", " \n ", "\t\n"]) {
      trajectory.accept({ type: "text-delta", text });
      trajectory.flush();
    }
    // The run announces itself at once (the status flips), but a separator chunk is no Output row.
    expect(output.every((event) => event.type !== "activity" || !event.activity.entries)).toBe(
      true,
    );
    // A segment with words keeps them exactly, newlines included.
    trajectory.accept({ type: "text-delta", text: "hello\n\n" });
    trajectory.flush();
    const rows = output.filter((event) => event.type === "activity" && event.activity.entries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      activity: { entries: [{ kind: "text", text: "hello\n\n" }] },
    });
    // Thinking is the same rule.
    output.length = 0;
    trajectory.accept({ type: "thinking-delta", text: "\n" });
    trajectory.flush();
    expect(output.every((event) => event.type !== "activity" || !event.activity.entries)).toBe(
      true,
    );
  } finally {
    trajectory.dispose();
  }
});
