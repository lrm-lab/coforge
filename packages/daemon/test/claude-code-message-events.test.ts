import { describe, expect, test } from "bun:test";
import {
  claudeAssistantEvents,
  claudeToolResults,
} from "#src/code-agent/claude-code/message-events";

const timestamp = "2026-10-11T10:00:00.000Z";
const record = (type: string, content: unknown, parentToolUseId: string | null = null) => ({
  type,
  parent_tool_use_id: parentToolUseId,
  timestamp,
  message: { content },
});

describe("claudeAssistantEvents", () => {
  test("reports each completed block in order and lists every tool_use id", () => {
    expect(
      claudeAssistantEvents(
        record("assistant", [
          { type: "thinking", thinking: "Planning", signature: "sig" },
          { type: "text", text: "Looking" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "toolu_2" },
        ]),
      ),
    ).toEqual({
      ids: ["toolu_1", "toolu_2"],
      events: [
        { type: "thinking-delta", text: "Planning" },
        { type: "text-delta", text: "Looking" },
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

  test("carries a subagent's lineage on each of its blocks", () => {
    const subagent = { parentToolUseId: "toolu_1", subagentType: "Explore" };
    const { events } = claudeAssistantEvents(
      record(
        "assistant",
        [
          { type: "thinking", thinking: "Hmm" },
          { type: "text", text: "Found it" },
          { type: "tool_use", id: "toolu_2", name: "Read", input: {} },
        ],
        "toolu_1",
      ),
      subagent,
    );
    expect(events).toEqual([
      { type: "thinking-delta", text: "Hmm", subagent },
      { type: "text-delta", text: "Found it", subagent },
      expect.objectContaining({ id: "toolu_2", subagent }),
    ]);
  });

  test("skips an empty or non-text block", () => {
    expect(
      claudeAssistantEvents(
        record("assistant", [
          { type: "text", text: "" },
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: 1 },
        ]),
      ),
    ).toEqual({ ids: [], events: [] });
  });

  test("a record with no content array or no id reports nothing", () => {
    expect(claudeAssistantEvents({ type: "assistant", message: { content: "text" } })).toEqual({
      ids: [],
      events: [],
    });
    expect(
      claudeAssistantEvents(record("assistant", [{ type: "tool_use", name: "Bash" }])),
    ).toEqual({
      ids: [],
      events: [],
    });
  });

  test("reports the text of a record Claude Code marks with an API error as that error", () => {
    const message = "API Error: Rate limit reached";
    expect(
      claudeAssistantEvents({
        ...record("assistant", [
          { type: "thinking", thinking: "Planning" },
          { type: "text", text: message },
        ]),
        error: "rate_limit",
      }).events,
    ).toEqual([
      { type: "thinking-delta", text: "Planning" },
      { type: "error", message, providerErrorCode: "rate_limit", occurredAt: timestamp },
    ]);
  });

  test("reports a text block that reads as an API request failure as an error", () => {
    const failures = [
      "API Error: 500 Internal server error. This is a server-side issue.",
      "API Error: 529 Overloaded",
      "API Error: Unable to connect to API (ECONNRESET)",
      "API Error: Request timed out.",
      "  api error: connect ETIMEDOUT 10.0.0.1:443",
    ];
    for (const message of failures)
      expect(claudeAssistantEvents(record("assistant", [{ type: "text", text: message }]))).toEqual(
        { ids: [], events: [{ type: "error", message, occurredAt: timestamp }] },
      );
  });

  test("a subagent's API failure text is an error, without its parent tool call", () => {
    const message = "API Error: 503 Service Unavailable";
    expect(
      claudeAssistantEvents(record("assistant", [{ type: "text", text: message }], "toolu_1"))
        .events,
    ).toEqual([{ type: "error", message, occurredAt: timestamp }]);
  });

  test("keeps text that only resembles an API failure, or that shares a record with a tool call", () => {
    const text = (value: string) => ({ type: "text-delta" as const, text: value });
    expect(
      claudeAssistantEvents(
        record("assistant", [
          { type: "text", text: "API Error: no status or connection failure named" },
          { type: "text", text: "The log said API Error: 500 earlier." },
        ]),
      ).events,
    ).toEqual([
      text("API Error: no status or connection failure named"),
      text("The log said API Error: 500 earlier."),
    ]);
    expect(
      claudeAssistantEvents({
        ...record("assistant", [
          { type: "text", text: "API Error: 500 while I retry" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
        ]),
        error: "server_error",
      }).events,
    ).toEqual([text("API Error: 500 while I retry"), expect.objectContaining({ id: "toolu_1" })]);
    expect(
      claudeAssistantEvents(
        {
          ...record("assistant", [{ type: "text", text: "Subagent answer" }], "toolu_1"),
          error: "rate_limit",
        },
        { parentToolUseId: "toolu_1" },
      ).events,
    ).toEqual([
      { type: "text-delta", text: "Subagent answer", subagent: { parentToolUseId: "toolu_1" } },
    ]);
    // Whether a record is the main session's is the record's own fact, not the caller's.
    for (const scope of [{ parent_tool_use_id: "toolu_1" }, { subagent_type: "Explore" }])
      expect(
        claudeAssistantEvents({
          ...record("assistant", [{ type: "text", text: "Subagent answer" }]),
          ...scope,
          error: "rate_limit",
        }).events,
      ).toEqual([{ type: "text-delta", text: "Subagent answer" }]);
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

  // Claude Code's Bash tool reports a non-zero exit as an error result whose text starts
  // "Exit code N"; the reference client 1.0.50 (`claudeToolResultOutcome`) reads it the same way.
  test("reads an error result's leading `Exit code N` as the call's exit code", () => {
    expect(
      claudeToolResults(
        record("user", [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "Exit code 2\nmake: *** Error",
            is_error: true,
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [{ type: "text", text: "Exit code 127" }],
            is_error: true,
          },
        ]),
      ).events.filter((event) => event.type === "tool-end"),
    ).toEqual([
      { type: "tool-end", id: "toolu_1", isError: true, exitCode: 2 },
      { type: "tool-end", id: "toolu_2", isError: true, exitCode: 127 },
    ]);
  });

  test("reads no exit code from a successful result or other error text", () => {
    expect(
      claudeToolResults(
        record("user", [
          { type: "tool_result", tool_use_id: "toolu_1", content: "Exit code 2" },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: "File not found. Exit code 2",
            is_error: true,
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_3",
            content: "Exit code 12abc",
            is_error: true,
          },
        ]),
      ).events.filter((event) => event.type === "tool-end"),
    ).toEqual([
      { type: "tool-end", id: "toolu_1", isError: false },
      { type: "tool-end", id: "toolu_2", isError: true },
      { type: "tool-end", id: "toolu_3", isError: true },
    ]);
  });

  test("skips a result with no tool_use_id", () => {
    expect(claudeToolResults(record("user", [{ type: "tool_result", content: "x" }]))).toEqual({
      ids: [],
      events: [],
    });
  });
});

test("captured Claude API errors preserve their structured HTTP status", async () => {
  const capture = await Bun.file(
    new URL("./fixtures/runtime-404-capture.json", import.meta.url),
  ).json();
  const { events } = claudeAssistantEvents(capture.claude.record);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "error", httpStatus: 404 });
});
