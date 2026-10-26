import { expect, test } from "bun:test";
import {
  ActivityTrajectory,
  TRAJECTORY_QUIET_WINDOW_MS,
} from "#src/agent-runtime/activity-trajectory";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { controlledClaude } from "./fixtures/claude-feed";

test("Claude Code shows each completed text and thinking block as one Activity row", async () => {
  // Pauses longer than the trajectory's quiet window used to split a streamed block into rows.
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const activities: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => {
    if (event.type === "activity") activities.push(event);
  });
  session.subscribe((event) => {
    if (event.type !== "text-delta" || event.text !== "fixture-input-observed")
      trajectory.accept(event);
  });
  const pause = () => Bun.sleep(TRAJECTORY_QUIET_WINDOW_MS + 50);
  const delta = (value: Record<string, unknown>) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: value },
  });
  const stop = { type: "stream_event", event: { type: "content_block_stop" } };
  try {
    await session.sendMessage("wait");
    await emit(
      {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "thinking", thinking: "" } },
      },
      delta({ type: "thinking_delta", thinking: "Let me " }),
    );
    await pause();
    await emit(
      delta({ type: "thinking_delta", thinking: "think." }),
      {
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "Let me think." }] },
      },
      stop,
      {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "text", text: "" } },
      },
      delta({ type: "text_delta", text: "Hel" }),
    );
    await pause();
    await emit(
      delta({ type: "text_delta", text: "lo" }),
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
      stop,
      { type: "result", subtype: "success" },
    );
    expect(
      activities.map((event) =>
        event.type === "activity" ? [event.activity.detailKind, event.activity.entries] : [],
      ),
    ).toEqual([
      // Run-start markers still flip the status as soon as each block starts.
      ["thinking_started", undefined],
      ["thinking_started", [{ kind: "thinking", text: "Let me think." }]],
      ["thinking_end", undefined],
      ["model_response_started", undefined],
      ["model_response_started", [{ kind: "text", text: "Hello" }]],
    ]);
  } finally {
    trajectory.dispose();
    await fixture.dispose();
  }
});
