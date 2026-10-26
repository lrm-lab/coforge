import { claudeRuntimeHost } from "#src/code-agent/claude-code/host";
import { describe, expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { claudeStreamEvents, ClaudeStreamEvents } from "@lrm/coforge-anvil/claude-code";

const timestamp = "2026-10-11T10:00:00.000Z";
const streamEvent = (event: unknown, parentToolUseId: string | null = null) => ({
  type: "stream_event",
  parent_tool_use_id: parentToolUseId,
  timestamp,
  event,
});
const delta = (value: Record<string, unknown>) => ({ type: "content_block_delta", delta: value });
const progress = {
  type: "progress",
  source: "claude_stream_event",
  occurredAt: timestamp,
} as const;

describe("claudeStreamEvents", () => {
  // Text and thinking reach Activity once per completed content block, from the `assistant`
  // record (message-events.ts). A delta only shows the turn is live, so no text is shown twice.
  test("reports a text or thinking delta as progress, without its text", () => {
    expect(claudeStreamEvents(streamEvent(delta({ type: "text_delta", text: "Hi" })))).toEqual([
      progress,
    ]);
    expect(
      claudeStreamEvents(streamEvent(delta({ type: "thinking_delta", thinking: "Hmm" }))),
    ).toEqual([progress]);
  });

  test("opens a text or thinking run, with no text, when its content block starts", () => {
    expect(
      claudeStreamEvents(
        streamEvent({ type: "content_block_start", content_block: { type: "text", text: "" } }),
      ),
    ).toEqual([{ type: "text-delta", text: "" }]);
    expect(
      claudeStreamEvents(
        streamEvent({
          type: "content_block_start",
          content_block: { type: "thinking", thinking: "" },
        }),
      ),
    ).toEqual([{ type: "thinking-delta", text: "" }]);
  });

  test("reports any other top-level stream event as progress", () => {
    expect(claudeStreamEvents(streamEvent({ type: "message_start" }))).toEqual([progress]);
    expect(claudeStreamEvents(streamEvent(delta({ type: "input_json_delta" })))).toEqual([
      progress,
    ]);
    expect(
      claudeStreamEvents(
        streamEvent({ type: "content_block_start", content_block: { type: "tool_use" } }),
      ),
    ).toEqual([progress]);
    expect(claudeStreamEvents(streamEvent({ type: "content_block_stop" }))).toEqual([progress]);
  });

  test("reports nothing for a subagent's stream event or an event without a type", () => {
    expect(claudeStreamEvents(streamEvent({ type: "message_start" }, "toolu_1"))).toEqual([]);
    expect(
      claudeStreamEvents(streamEvent(delta({ type: "text_delta", text: "Hi" }), "toolu_1")),
    ).toEqual([]);
    expect(claudeStreamEvents(streamEvent({}))).toEqual([]);
    expect(claudeStreamEvents(streamEvent(undefined))).toEqual([]);
  });
});

// Recorded shapes of Claude Code's `--include-partial-messages` tool_use block: a start naming the
// call, then `input_json_delta` fragments keyed by the block's index only, then a stop.
const toolStart = (index: number, id: string, name: string) => ({
  type: "content_block_start",
  index,
  content_block: { type: "tool_use", id, name, input: {} },
});
const jsonDelta = (index: number, partialJson: string) => ({
  type: "content_block_delta",
  index,
  delta: { type: "input_json_delta", partial_json: partialJson },
});
const replyIntents = (events: readonly AgentRuntimeEvent[]) =>
  events.filter((event) => event.type === "reply-intent");

describe("ClaudeStreamEvents", () => {
  const fragments = ['{"command": "coforge message send --tar', "get #general", ' --content hi"}'];

  test("reports what claudeStreamEvents does, and a tool call's target as its arguments stream", () => {
    const stream = new ClaudeStreamEvents(claudeRuntimeHost);
    expect(stream.read(streamEvent({ type: "message_start" }))).toEqual([progress]);
    expect(stream.read(streamEvent(toolStart(1, "toolu_1", "Bash")))).toEqual([progress]);
    const [first, second, third] = fragments.map((fragment) =>
      stream.read(streamEvent(jsonDelta(1, fragment))),
    );
    // Every delta still shows the turn is live; the target comes with the delta that closes it.
    expect(first).toEqual([progress]);
    expect(second).toEqual([progress]);
    expect(third).toEqual([progress, { type: "reply-intent", id: "toolu_1", target: "#general" }]);
    expect(stream.read(streamEvent({ type: "content_block_stop", index: 1 }))).toEqual([progress]);
  });

  test("keys interleaved tool calls by their block index", () => {
    const stream = new ClaudeStreamEvents(claudeRuntimeHost);
    stream.read(streamEvent({ type: "message_start" }));
    stream.read(streamEvent(toolStart(0, "toolu_a", "Read")));
    stream.read(streamEvent(toolStart(2, "toolu_b", "Bash")));
    stream.read(streamEvent(jsonDelta(0, '{"command": "coforge message send --target #a --x"}')));
    const events = stream.read(
      streamEvent(jsonDelta(2, '{"command": "coforge message send --target #b --x"}')),
    );
    expect(replyIntents(events)).toEqual([{ type: "reply-intent", id: "toolu_b", target: "#b" }]);
  });

  test("a new message forgets the block indexes of the last one", () => {
    const stream = new ClaudeStreamEvents(claudeRuntimeHost);
    stream.read(streamEvent({ type: "message_start" }));
    stream.read(streamEvent(toolStart(1, "toolu_1", "Bash")));
    stream.read(streamEvent({ type: "message_start" }));
    const events = stream.read(streamEvent(jsonDelta(1, fragments.join(""))));
    expect(events).toEqual([progress]);
  });

  test("a new message retracts the announced calls whose arguments never completed", () => {
    const stream = new ClaudeStreamEvents(claudeRuntimeHost);
    stream.read(streamEvent({ type: "message_start" }));
    stream.read(streamEvent(toolStart(0, "toolu_open", "Bash")));
    stream.read(streamEvent(toolStart(1, "toolu_done", "Bash")));
    stream.read(streamEvent(toolStart(2, "toolu_quiet", "Bash")));
    for (const index of [0, 1])
      stream.read(
        streamEvent(jsonDelta(index, '{"command": "coforge message send --target #a --x"}')),
      );
    stream.read(streamEvent({ type: "content_block_stop", index: 1 }));
    // Only the announced call that stayed open is abandoned.
    expect(stream.read(streamEvent({ type: "message_start" }))).toEqual([
      progress,
      { type: "reply-intent-retracted", id: "toolu_open" },
    ]);
    expect(stream.read(streamEvent({ type: "message_start" }))).toEqual([progress]);
  });

  test("a subagent's stream, a delta with no known block and a non-shell tool announce nothing", () => {
    const stream = new ClaudeStreamEvents(claudeRuntimeHost);
    stream.read(streamEvent({ type: "message_start" }));
    stream.read(streamEvent(toolStart(1, "toolu_sub", "Bash"), "toolu_parent"));
    expect(stream.read(streamEvent(jsonDelta(1, fragments.join("")), "toolu_parent"))).toEqual([]);
    expect(stream.read(streamEvent(jsonDelta(5, fragments.join(""))))).toEqual([progress]);
    stream.read(streamEvent(toolStart(3, "toolu_r", "Read")));
    expect(stream.read(streamEvent(jsonDelta(3, fragments.join(""))))).toEqual([progress]);
  });

  test("announces a call once, and not after its block stopped", () => {
    const stream = new ClaudeStreamEvents(claudeRuntimeHost);
    stream.read(streamEvent({ type: "message_start" }));
    stream.read(streamEvent(toolStart(1, "toolu_1", "Bash")));
    const all = fragments.flatMap((fragment) => stream.read(streamEvent(jsonDelta(1, fragment))));
    expect(replyIntents(all)).toHaveLength(1);
    stream.read(streamEvent({ type: "content_block_stop", index: 1 }));
    expect(stream.read(streamEvent(jsonDelta(1, fragments.join(""))))).toEqual([progress]);
  });
});
