import { describe, expect, test } from "bun:test";
import { PiReplyIntents } from "#src/code-agent/pi/reply-intents";
import type { PiSessionEvent } from "#src/code-agent/pi/session-events";

// The SDK's `toolcall_*` events name the call only through `partial.content[contentIndex]`
// (@earendil-works/pi-ai 1.4.0 `AssistantMessageEvent`, `ToolCall`), and carry the arguments as
// JSON text fragments in `delta`.
const read = (intents: PiReplyIntents, event: Record<string, unknown>) =>
  intents.read(event as PiSessionEvent);
const update = (assistantMessageEvent: Record<string, unknown>) => ({
  type: "message_update",
  assistantMessageEvent,
});
const partial = (...calls: Array<{ id: string; name: string }>) => ({
  content: calls.map((call) => ({ type: "toolCall", arguments: {}, ...call })),
});
const delta = (contentIndex: number, text: string, calls = [{ id: "call_1", name: "bash" }]) =>
  update({ type: "toolcall_delta", contentIndex, delta: text, partial: partial(...calls) });

const fragments = ['{"command":"coforge message ', "send --target #general", ' --content hi"}'];

describe("PiReplyIntents", () => {
  test("announces a shell call's send target while its arguments stream", () => {
    const intents = new PiReplyIntents();
    const calls = [{ id: "call_1", name: "bash" }];
    expect(
      read(
        intents,
        update({ type: "toolcall_start", contentIndex: 0, partial: partial(...calls) }),
      ),
    ).toEqual([]);
    expect(read(intents, delta(0, fragments[0]!))).toEqual([]);
    expect(read(intents, delta(0, fragments[1]!))).toEqual([]);
    expect(read(intents, delta(0, fragments[2]!))).toEqual([
      { type: "reply-intent", id: "call_1", target: "#general" },
    ]);
    // Once only, and the finished call is let go.
    expect(read(intents, delta(0, " "))).toEqual([]);
    expect(
      read(
        intents,
        update({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: calls[0],
          partial: partial(...calls),
        }),
      ),
    ).toEqual([]);
  });

  test("tells calls apart by their content index and ignores other tools", () => {
    const intents = new PiReplyIntents();
    const calls = [
      { id: "call_r", name: "read" },
      { id: "call_b", name: "bash" },
    ];
    expect(read(intents, delta(0, fragments.join(""), calls))).toEqual([]);
    expect(read(intents, delta(1, fragments.join(""), calls))).toEqual([
      { type: "reply-intent", id: "call_b", target: "#general" },
    ]);
  });

  test("announces nothing for a delta whose call the partial message does not name", () => {
    const intents = new PiReplyIntents();
    expect(read(intents, delta(3, fragments.join("")))).toEqual([]);
    expect(read(intents, update({ type: "toolcall_delta", contentIndex: 0, delta: "x" }))).toEqual(
      [],
    );
    expect(read(intents, update({ type: "text_delta", delta: "hi" }))).toEqual([]);
  });

  test("a new turn retracts the call it had announced, once", () => {
    const intents = new PiReplyIntents();
    expect(read(intents, delta(0, fragments.join("")))).toEqual([
      { type: "reply-intent", id: "call_1", target: "#general" },
    ]);
    expect(read(intents, { type: "turn_start" })).toEqual([
      { type: "reply-intent-retracted", id: "call_1" },
    ]);
    expect(read(intents, { type: "turn_start" })).toEqual([]);
  });

  test("a new turn forgets calls in flight", () => {
    const intents = new PiReplyIntents();
    read(intents, delta(0, fragments[0]!));
    read(intents, { type: "turn_start" });
    expect(read(intents, delta(0, fragments.slice(1).join("")))).toEqual([]);
  });
});
