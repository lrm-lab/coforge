import { describe, expect, test } from "bun:test";
import { claudeToolResults, claudeToolUses } from "#src/code-agent/claude-code/tool-events";

const timestamp = "2026-10-11T10:00:00.000Z";
const record = (type: string, content: unknown, parentToolUseId: string | null = null) => ({
  type,
  parent_tool_use_id: parentToolUseId,
  timestamp,
  message: { content },
});

describe("claudeToolUses", () => {
  test("starts each named tool call and lists every tool_use id", () => {
    expect(
      claudeToolUses(
        record("assistant", [
          { type: "text", text: "Looking" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "toolu_2" },
        ]),
      ),
    ).toEqual({
      ids: ["toolu_1", "toolu_2"],
      events: [
        {
          type: "tool-start",
          id: "toolu_1",
          name: "Bash",
          input: { command: "ls" },
          occurredAt: timestamp,
        },
      ],
    });
  });

  test("names the parent tool call of a subagent's tool call", () => {
    const { events } = claudeToolUses(
      record(
        "assistant",
        [{ type: "tool_use", id: "toolu_2", name: "Read", input: {} }],
        "toolu_1",
      ),
    );
    expect(events).toEqual([
      expect.objectContaining({ id: "toolu_2", subagent: { parentToolUseId: "toolu_1" } }),
    ]);
  });

  test("a record with no content array or no id reports nothing", () => {
    expect(claudeToolUses({ type: "assistant", message: { content: "text" } })).toEqual({
      ids: [],
      events: [],
    });
    expect(claudeToolUses(record("assistant", [{ type: "tool_use", name: "Bash" }]))).toEqual({
      ids: [],
      events: [],
    });
  });
});

describe("claudeToolResults", () => {
  test("reports each result's output before its end, with its error flag", () => {
    expect(
      claudeToolResults(
        record("user", [
          { type: "tool_result", tool_use_id: "toolu_1", content: "file.txt" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "", is_error: true },
          { type: "text", text: "ignored" },
        ]),
      ),
    ).toEqual({
      ids: ["toolu_1", "toolu_2"],
      events: [
        { type: "tool-output", id: "toolu_1", text: "file.txt" },
        { type: "tool-end", id: "toolu_1", isError: false },
        { type: "tool-end", id: "toolu_2", isError: true },
      ],
    });
  });

  test("skips a result with no tool_use_id", () => {
    expect(claudeToolResults(record("user", [{ type: "tool_result", content: "x" }]))).toEqual({
      ids: [],
      events: [],
    });
  });
});
