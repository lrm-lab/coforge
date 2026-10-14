import { describe, expect, test } from "bun:test";
import { piSessionEvents, type PiSessionEvent } from "#src/code-agent/pi/session-events";

const events = (event: Record<string, unknown>) => piSessionEvents(event as PiSessionEvent);
const messageUpdate = (assistantMessageEvent: Record<string, unknown>) =>
  events({ type: "message_update", assistantMessageEvent });

describe("piSessionEvents", () => {
  test("reports text and thinking deltas", () => {
    expect(messageUpdate({ type: "text_delta", delta: "Hi" })).toEqual([
      { type: "text-delta", text: "Hi" },
    ]);
    expect(messageUpdate({ type: "thinking_delta", delta: "Hmm" })).toEqual([
      { type: "thinking-delta", text: "Hmm" },
    ]);
  });

  test("content-free message and lifecycle frames are progress", () => {
    for (const type of [
      "start",
      "text_start",
      "thinking_start",
      "toolcall_start",
      "toolcall_delta",
    ])
      expect(messageUpdate({ type })).toEqual([{ type: "progress", source: "pi_message_event" }]);
    expect(messageUpdate({ type: "text_end" })).toEqual([]);
    expect(events({ type: "turn_start" })).toEqual([
      { type: "progress", source: "pi_turn_lifecycle" },
    ]);
    expect(events({ type: "message_start" })).toEqual([
      { type: "progress", source: "pi_turn_lifecycle" },
    ]);
  });

  test("reports compaction start, finish and interruption", () => {
    expect(events({ type: "compaction_start" })).toEqual([{ type: "compaction-started" }]);
    expect(events({ type: "compaction_end", aborted: false })).toEqual([
      { type: "compaction-finished" },
    ]);
    expect(events({ type: "compaction_end", aborted: true })).toEqual([
      { type: "compaction-interrupted" },
    ]);
  });

  test("reports a tool's start, text output and end", () => {
    expect(
      events({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "ls" },
      }),
    ).toEqual([{ type: "tool-start", id: "t1", name: "bash", input: { command: "ls" } }]);
    expect(
      events({
        type: "tool_execution_update",
        toolCallId: "t1",
        partialResult: { content: [{ type: "text", text: "out" }] },
      }),
    ).toEqual([{ type: "tool-output", id: "t1", text: "out" }]);
    expect(
      events({ type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [] } }),
    ).toEqual([]);
    expect(events({ type: "tool_execution_end", toolCallId: "t1", isError: true })).toEqual([
      { type: "tool-end", id: "t1", isError: true },
    ]);
  });

  test("events that drive the run's outcome report nothing here", () => {
    expect(events({ type: "agent_start" })).toEqual([]);
    expect(
      events({ type: "message_end", message: { role: "assistant", stopReason: "error" } }),
    ).toEqual([]);
    expect(events({ type: "agent_settled", aborted: false })).toEqual([]);
  });
});
