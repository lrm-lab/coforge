import { describe, expect, test } from "bun:test";
import { claudeStreamEvents } from "#src/code-agent/claude-code/stream-events";

const timestamp = "2026-10-11T10:00:00.000Z";
const streamEvent = (event: unknown, parentToolUseId: string | null = null) => ({
  type: "stream_event",
  parent_tool_use_id: parentToolUseId,
  timestamp,
  event,
});
const delta = (value: Record<string, unknown>) => ({ type: "content_block_delta", delta: value });

describe("claudeStreamEvents", () => {
  test("renders text and thinking deltas", () => {
    expect(claudeStreamEvents(streamEvent(delta({ type: "text_delta", text: "Hi" })))).toEqual([
      { type: "text-delta", text: "Hi" },
    ]);
    expect(
      claudeStreamEvents(streamEvent(delta({ type: "thinking_delta", thinking: "Hmm" }))),
    ).toEqual([{ type: "thinking-delta", text: "Hmm" }]);
  });

  test("names the parent tool call of a subagent's deltas", () => {
    expect(
      claudeStreamEvents(streamEvent(delta({ type: "text_delta", text: "Hi" }), "toolu_1")),
    ).toEqual([{ type: "text-delta", text: "Hi", subagent: { parentToolUseId: "toolu_1" } }]);
  });

  test("reports any other top-level stream event as progress", () => {
    const progress = {
      type: "progress",
      source: "claude_stream_event",
      occurredAt: timestamp,
    } as const;
    expect(claudeStreamEvents(streamEvent({ type: "message_start" }))).toEqual([progress]);
    expect(claudeStreamEvents(streamEvent(delta({ type: "input_json_delta" })))).toEqual([
      progress,
    ]);
    // A delta whose text is not a string renders nothing, so it too only shows the turn is live.
    expect(claudeStreamEvents(streamEvent(delta({ type: "text_delta", text: 1 })))).toEqual([
      progress,
    ]);
  });

  test("reports nothing for a subagent's non-text event or an event without a type", () => {
    expect(claudeStreamEvents(streamEvent({ type: "message_start" }, "toolu_1"))).toEqual([]);
    expect(claudeStreamEvents(streamEvent({}))).toEqual([]);
    expect(claudeStreamEvents(streamEvent(undefined))).toEqual([]);
  });
});
