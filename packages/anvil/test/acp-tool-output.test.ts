import { expect, test } from "bun:test";
import { DevinTurnEvents } from "#src/devin/update-events";
import { DshTurnEvents } from "#src/dsh/update-events";

const host = {
  createReplyIntentScanner: () => ({
    feed: () => undefined,
    complete: () => undefined,
    reset: () => [],
  }),
  isShellToolName: () => false,
};

for (const [name, create] of [
  ["Devin", () => new DevinTurnEvents(host as never)],
  ["DSH", () => new DshTurnEvents(host as never)],
] as const) {
  test(`${name} joins tool output text items before suppressing a repeated update`, () => {
    const turn = create();
    expect(
      turn.read({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Shell",
      }),
    ).toEqual([{ type: "tool-start", id: "tool-1", name: "Shell" }]);

    expect(
      turn.read({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        content: [
          { type: "content", content: { type: "text", text: "a" } },
          { type: "content", content: { type: "text", text: "b" } },
        ],
      }),
    ).toEqual([{ type: "tool-output", id: "tool-1", text: "a\nb" }]);

    expect(
      turn.read({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        content: [
          { type: "content", content: { type: "text", text: "a" } },
          { type: "content", content: { type: "text", text: "b" } },
        ],
      }),
    ).toEqual([
      {
        type: "progress",
        source: name === "Devin" ? "devin_tool_call_update" : "dsh_tool_call_update",
      },
    ]);
  });
}
