import { describe, expect, test } from "bun:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { kiroUpdateEvents } from "#src/code-agent/kiro/update-events";

type Update = SessionNotification["update"];
const events = (update: Record<string, unknown>) => kiroUpdateEvents(update as Update);

describe("kiroUpdateEvents", () => {
  test("reports message and thought text, and nothing for non-text chunks", () => {
    expect(
      events({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } }),
    ).toEqual([{ type: "text-delta", text: "Hi" }]);
    expect(
      events({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hmm" } }),
    ).toEqual([{ type: "thinking-delta", text: "Hmm" }]);
    expect(
      events({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "", mimeType: "image/png" },
      }),
    ).toEqual([]);
  });

  test("names a tool start from its kind, falling back to its title", () => {
    expect(
      events({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        kind: "execute",
        title: "Run Command",
        rawInput: { command: "ls" },
      }),
    ).toEqual([{ type: "tool-start", id: "t1", name: "bash", input: { command: "ls" } }]);
    expect(
      events({ sessionUpdate: "tool_call", toolCallId: "t2", kind: "think", title: "Thinking" }),
    ).toEqual([{ type: "tool-start", id: "t2", name: "Thinking", input: undefined }]);
  });

  test("reports a tool update's text output before its end", () => {
    expect(
      events({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "failed",
        content: [
          { type: "content", content: { type: "text", text: "boom" } },
          { type: "content", content: { type: "text", text: "" } },
          { type: "diff", path: "a.ts", newText: "x" },
        ],
      }),
    ).toEqual([
      { type: "tool-output", id: "t1", text: "boom" },
      { type: "tool-end", id: "t1", isError: true },
    ]);
    expect(
      events({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
    ).toEqual([{ type: "tool-end", id: "t1", isError: false }]);
  });

  test("a running tool with no new content is progress only", () => {
    expect(
      events({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }),
    ).toEqual([{ type: "progress", source: "kiro_tool_call_update" }]);
    expect(
      events({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "out" } }],
      }),
    ).toEqual([{ type: "tool-output", id: "t1", text: "out" }]);
  });

  test("reports each compaction transition", () => {
    const compaction = (status: string) => events({ sessionUpdate: "compaction_update", status });
    expect(compaction("in_progress")).toEqual([{ type: "compaction-started" }]);
    expect(compaction("completed")).toEqual([{ type: "compaction-finished" }]);
    expect(compaction("failed")).toEqual([{ type: "compaction-interrupted" }]);
    expect(compaction("cancelled")).toEqual([{ type: "compaction-interrupted" }]);
    expect(compaction("unknown")).toEqual([]);
  });

  test("plan and usage updates are progress; session info reports nothing here", () => {
    expect(events({ sessionUpdate: "plan", entries: [] })).toEqual([
      { type: "progress", source: "kiro_plan_update" },
    ]);
    expect(events({ sessionUpdate: "usage_update" })).toEqual([
      { type: "progress", source: "kiro_usage_update" },
    ]);
    expect(
      events({ sessionUpdate: "session_info_update", _meta: { kiro: { kind: "error" } } }),
    ).toEqual([]);
  });
});
