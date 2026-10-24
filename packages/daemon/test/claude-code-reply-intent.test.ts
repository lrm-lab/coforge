import { expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { controlledClaude } from "./fixtures/claude-feed";

// Claude Code started with `--include-partial-messages` streams a tool call's arguments as
// `input_json_delta` fragments of a `stream_event`, before the `assistant` record that holds the
// finished call.
const streamEvent = (event: Record<string, unknown>) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event,
});
const fragments = ['{"command": "coforge message send --tar', "get #general ", '--content hi"}'];

test("a session reports the Agent's send target while the call streams, before the call itself", async () => {
  const fixture = await controlledClaude();
  const events: AgentRuntimeEvent[] = [];
  fixture.session.subscribe((event) => events.push(event));
  try {
    await fixture.session.sendMessage("go");
    await fixture.emit(
      streamEvent({ type: "message_start" }),
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_send", name: "Bash", input: {} },
      }),
      ...fragments.map((partial_json) =>
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json },
        }),
      ),
      streamEvent({ type: "content_block_stop", index: 0 }),
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_send",
              name: "Bash",
              input: { command: "coforge message send --target #general --content hi" },
            },
          ],
        },
      },
    );
    const relevant = events.filter(
      (event) => event.type === "reply-intent" || event.type === "tool-start",
    );
    expect(relevant.map((event) => event.type)).toEqual(["reply-intent", "tool-start"]);
    expect(relevant[0]).toEqual({ type: "reply-intent", id: "toolu_send", target: "#general" });
    // Each fragment still shows the turn is live.
    expect(events.filter((event) => event.type === "progress").length).toBeGreaterThanOrEqual(
      fragments.length,
    );
  } finally {
    await fixture.dispose();
  }
});
