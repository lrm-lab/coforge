import { describe, expect, test } from "bun:test";
import { CodexItemEvents } from "@lrm/coforge-anvil/codex";
import { asRecord, type JsonRecord } from "@lrm/coforge-anvil";

// Shapes follow the official app-server v2 schema (`codex app-server generate-ts`, ThreadItem.ts
// and ServerNotification.ts). The mapping follows the reference Computer 1.0.50.
const timestamp = "2026-10-11T11:00:00.000Z";
const started = (item: unknown) => ({
  method: "item/started",
  timestamp,
  params: { threadId: "t", turnId: "u", item },
});
const completed = (item: unknown) => ({
  method: "item/completed",
  timestamp,
  params: { threadId: "t", turnId: "u", item },
});
/** Routes a record the way the session does: a delta first, then a turn or item. */
function feed(events: CodexItemEvents, record: JsonRecord) {
  const params = asRecord(record.params);
  return events.delta(record, params) ?? events.accept(record, params);
}
const delta = (method: string, value: unknown, itemId?: string) => ({
  method,
  timestamp,
  params: { threadId: "t", turnId: "u", ...(itemId ? { itemId } : {}), delta: value },
});

describe("CodexItemEvents: turns", () => {
  test("a started turn opens a thinking run with no text", () => {
    expect(
      feed(new CodexItemEvents(), {
        method: "turn/started",
        params: { threadId: "t", turn: { id: "u" } },
      }),
    ).toEqual([{ type: "thinking-delta", text: "" }]);
  });
});

test("a started turn forgets the bookkeeping of a turn whose completion was lost", () => {
  const events = new CodexItemEvents();
  const turnStarted = { method: "turn/started", params: { threadId: "t", turn: { id: "u2" } } };
  feed(events, started({ type: "agentMessage", id: "m1", text: "", phase: "commentary" }));
  feed(events, delta("item/reasoning/summaryTextDelta", "Plan", "r1"));
  feed(
    events,
    started({
      type: "fileChange",
      id: "f1",
      changes: [
        { kind: { type: "add" }, path: "/w/a.ts", diff: "" },
        { kind: { type: "add" }, path: "/w/b.ts", diff: "" },
      ],
    }),
  );
  feed(events, turnStarted);
  // No phase, no streamed summary, no file count survive into the new turn.
  expect(feed(events, delta("item/agentMessage/delta", "Hi", "m1"))).toEqual([
    { type: "text-delta", text: "Hi" },
  ]);
  expect(feed(events, completed({ type: "reasoning", id: "r1", summary: ["Plan"] }))).toEqual([
    { type: "thinking-delta", text: "Plan" },
  ]);
  expect(
    feed(
      events,
      completed({
        type: "fileChange",
        id: "f1",
        status: "completed",
        changes: [{ kind: { type: "add" }, path: "/w/a.ts", diff: "" }],
      }),
    ),
  ).toEqual([{ type: "tool-end", id: "f1:0", isError: false }]);
});

describe("CodexItemEvents: commands", () => {
  test("reports a command execution as a raw bash tool start and its exit as its end", () => {
    const events = new CodexItemEvents();
    expect(
      feed(events, started({ type: "commandExecution", id: "c1", command: "ls -la" })),
    ).toEqual([
      {
        type: "tool-start",
        id: "c1",
        name: "bash",
        input: { command: "ls -la" },
        occurredAt: timestamp,
      },
    ]);
    // A command without a readable command line is still a tool start.
    expect(feed(events, started({ type: "commandExecution", id: "c2" }))[0]).toMatchObject({
      input: { command: "command" },
    });
    expect(feed(events, completed({ type: "commandExecution", id: "c1", exitCode: 0 }))).toEqual([
      { type: "tool-end", id: "c1", isError: false, exitCode: 0 },
    ]);
    expect(
      feed(events, completed({ type: "commandExecution", id: "c2", exitCode: 2, durationMs: 37 })),
    ).toEqual([{ type: "tool-end", id: "c2", isError: true, exitCode: 2, durationMs: 37 }]);
    // A command that never exited (killed, declined) reports no exit code.
    expect(feed(events, completed({ type: "commandExecution", id: "c3", exitCode: null }))).toEqual(
      [{ type: "tool-end", id: "c3", isError: true }],
    );
  });

  test("reports nothing for a command without an id or an item that is not one", () => {
    const events = new CodexItemEvents();
    expect(feed(events, started({ type: "commandExecution" }))).toEqual([]);
    expect(feed(events, started(undefined))).toEqual([]);
    expect(feed(events, started({ type: "imageView", id: "i1", path: "/w/a.png" }))).toEqual([]);
  });
});

describe("CodexItemEvents: file changes", () => {
  test("reports one write or edit per changed file, read from the official kind object", () => {
    const events = new CodexItemEvents();
    expect(
      feed(
        events,
        started({
          type: "fileChange",
          id: "f1",
          status: "inProgress",
          changes: [
            { kind: { type: "add" }, path: "/w/new.ts", diff: "" },
            { kind: { type: "update", move_path: null }, path: "/w/old.ts", diff: "" },
            { kind: { type: "delete" }, path: "/w/gone.ts", diff: "" },
            // The legacy string kind still reads.
            { kind: "add", path: "/w/legacy.ts" },
            { path: "/w/unknown-kind.ts" },
            { kind: { type: "add" } },
          ],
        }),
      ),
    ).toEqual(
      (
        [
          ["f1:0", "write_file", "/w/new.ts"],
          ["f1:1", "edit_file", "/w/old.ts"],
          ["f1:2", "edit_file", "/w/gone.ts"],
          ["f1:3", "write_file", "/w/legacy.ts"],
          ["f1:4", "edit_file", "/w/unknown-kind.ts"],
        ] as const
      ).map(([id, name, path]) => ({
        type: "tool-start",
        id,
        name,
        input: { file_path: path },
        occurredAt: timestamp,
      })),
    );
    expect(feed(events, completed({ type: "fileChange", id: "f1", status: "completed" }))).toEqual(
      [0, 1, 2, 3, 4].map((index) => ({ type: "tool-end", id: `f1:${index}`, isError: false })),
    );
  });

  test("ends every changed file as failed when the change failed or was declined", () => {
    for (const status of ["failed", "declined"]) {
      const events = new CodexItemEvents();
      const changes = [{ kind: { type: "add" }, path: "/w/a.ts", diff: "" }];
      feed(events, started({ type: "fileChange", id: "f1", status: "inProgress", changes }));
      expect(feed(events, completed({ type: "fileChange", id: "f1", status, changes }))).toEqual([
        { type: "tool-end", id: "f1:0", isError: true },
      ]);
    }
  });

  test("ends the completed change's files when its start was never seen", () => {
    expect(
      feed(
        new CodexItemEvents(),
        completed({
          type: "fileChange",
          id: "f1",
          status: "completed",
          changes: [
            { kind: { type: "add" }, path: "/w/a.ts", diff: "" },
            { kind: { type: "update", move_path: null }, path: "/w/b.ts", diff: "" },
          ],
        }),
      ),
    ).toEqual([
      { type: "tool-end", id: "f1:0", isError: false },
      { type: "tool-end", id: "f1:1", isError: false },
    ]);
  });

  test("reads a legacy file change without a change list as the one changed file", () => {
    expect(
      feed(new CodexItemEvents(), started({ type: "fileChange", kind: "add", path: "/w/a.ts" })),
    ).toEqual([
      {
        type: "tool-start",
        id: "file-change:0",
        name: "write_file",
        input: { file_path: "/w/a.ts" },
        occurredAt: timestamp,
      },
    ]);
  });
});

describe("CodexItemEvents: reasoning", () => {
  test("reports a reasoning summary delta as thinking and raw reasoning only as progress", () => {
    const events = new CodexItemEvents();
    expect(feed(events, delta("item/reasoning/summaryTextDelta", "Plan", "r1"))).toEqual([
      { type: "thinking-delta", text: "Plan" },
    ]);
    expect(feed(events, delta("item/reasoning/textDelta", "secret chain", "r1"))).toEqual([
      { type: "progress", source: "codex_reasoning_text_delta", occurredAt: timestamp },
    ]);
  });

  test("a completed reasoning item that never streamed reports its summary, never its content", () => {
    expect(
      feed(
        new CodexItemEvents(),
        completed({
          type: "reasoning",
          id: "r1",
          summary: ["Read the file", "Then edit it"],
          content: ["raw chain of thought"],
        }),
      ),
    ).toEqual([{ type: "thinking-delta", text: "Read the file\nThen edit it" }]);
  });

  test("a completed reasoning item whose summary streamed, or that has none, reports nothing", () => {
    const events = new CodexItemEvents();
    feed(events, delta("item/reasoning/summaryTextDelta", "Plan", "r1"));
    expect(
      feed(events, completed({ type: "reasoning", id: "r1", summary: ["Plan"], content: [] })),
    ).toEqual([]);
    expect(
      feed(
        events,
        completed({ type: "reasoning", id: "r2", summary: [], content: ["raw chain of thought"] }),
      ),
    ).toEqual([]);
  });
});

describe("CodexItemEvents: agent messages", () => {
  const message = (id: string, phase: unknown, text = "") => ({
    type: "agentMessage",
    id,
    text,
    phase,
    memoryCitation: null,
    delivery: null,
    questions: null,
  });

  test("streams a final answer, or a message with no phase, as text", () => {
    const events = new CodexItemEvents();
    for (const [id, phase] of [
      ["m1", "final_answer"],
      ["m2", null],
      // An empty phase is no phase.
      ["m4", ""],
    ] as const) {
      expect(feed(events, started(message(id, phase)))).toEqual([]);
      expect(feed(events, delta("item/agentMessage/delta", "Hi", id))).toEqual([
        { type: "text-delta", text: "Hi" },
      ]);
      // Already streamed: its completion repeats nothing.
      expect(feed(events, completed(message(id, phase, "Hi")))).toEqual([]);
    }
    // A delta for a message whose start was never seen has no phase.
    expect(feed(events, delta("item/agentMessage/delta", "Hey", "m3"))).toEqual([
      { type: "text-delta", text: "Hey" },
    ]);
  });

  test("reports commentary and a partial answer only as progress", () => {
    for (const phase of ["commentary", "partial_answer"]) {
      const events = new CodexItemEvents();
      feed(events, started(message("m1", phase)));
      expect(feed(events, delta("item/agentMessage/delta", "Looking", "m1"))).toEqual([
        { type: "progress", source: "codex_agent_message_non_final", occurredAt: timestamp },
      ]);
      expect(feed(events, completed(message("m2", phase, "Looked")))).toEqual([
        { type: "progress", source: "codex_agent_message_non_final", occurredAt: timestamp },
      ]);
    }
  });

  test("a completed message that never streamed reports its text once", () => {
    const events = new CodexItemEvents();
    expect(feed(events, completed(message("m1", "final_answer", "Done")))).toEqual([
      { type: "text-delta", text: "Done" },
    ]);
    expect(feed(events, completed(message("m2", null, "")))).toEqual([]);
  });

  test("reports nothing for an empty delta or one that is not a string", () => {
    const events = new CodexItemEvents();
    expect(feed(events, delta("item/agentMessage/delta", "", "m1"))).toEqual([]);
    expect(feed(events, delta("item/reasoning/summaryTextDelta", "", "r1"))).toEqual([]);
    // Even an empty delta means the item streamed: its completion repeats nothing.
    expect(feed(events, completed(message("m1", null, "Hi")))).toEqual([]);
    expect(feed(events, completed({ type: "reasoning", id: "r1", summary: ["Plan"] }))).toEqual([]);
    expect(feed(new CodexItemEvents(), delta("item/agentMessage/delta", 1, "m1"))).toEqual([]);
    expect(feed(new CodexItemEvents(), { method: "item/agentMessage/delta" })).toEqual([]);
  });
});

describe("CodexItemEvents: other tool calls", () => {
  const mcp = (fields: Record<string, unknown>) => ({
    type: "mcpToolCall",
    id: "mcp1",
    server: "docs",
    tool: "search",
    status: "inProgress",
    arguments: { query: "retry policy" },
    result: null,
    error: null,
    ...fields,
  });

  test("reports an MCP tool call under the mcp__<server>__<tool> name with its arguments", () => {
    const events = new CodexItemEvents();
    expect(feed(events, started(mcp({})))).toEqual([
      {
        type: "tool-start",
        id: "mcp1",
        name: "mcp__docs__search",
        input: { query: "retry policy" },
        occurredAt: timestamp,
      },
    ]);
    expect(
      feed(
        events,
        completed(mcp({ status: "completed", result: { content: ["private"] }, durationMs: 8 })),
      ),
    ).toEqual([{ type: "tool-end", id: "mcp1", isError: false, durationMs: 8 }]);
    // Without a server the name keeps its MCP prefix, so it never reads as a built-in or
    // CoForge tool.
    expect(feed(events, started(mcp({ id: "mcp2", server: "" })))[0]).toMatchObject({
      name: "mcp__search",
    });
    expect(
      feed(events, started(mcp({ id: "mcp3", server: null, tool: "send_message" })))[0],
    ).toMatchObject({ name: "mcp__send_message" });
  });

  test("ends an MCP tool call as failed on a failed status or an error", () => {
    const events = new CodexItemEvents();
    expect(feed(events, completed(mcp({ status: "failed" })))).toEqual([
      { type: "tool-end", id: "mcp1", isError: true },
    ]);
    expect(feed(events, completed(mcp({ status: "completed", error: { message: "x" } })))).toEqual([
      { type: "tool-end", id: "mcp1", isError: true },
    ]);
  });

  test("reports a web search with its query, read from the action when the item has none", () => {
    const events = new CodexItemEvents();
    const search = (id: string, query: string, action: unknown) =>
      feed(events, started({ type: "webSearch", id, query, action, results: null }))[0];
    expect(search("w1", "bun test", null)).toEqual({
      type: "tool-start",
      id: "w1",
      name: "web_search",
      input: { query: "bun test" },
      occurredAt: timestamp,
    });
    expect(search("w2", "", { type: "search", query: "from action" })).toMatchObject({
      input: { query: "from action" },
    });
    expect(
      search("w3", "", { type: "search", query: null, queries: ["first", "second"] }),
    ).toMatchObject({ input: { query: "first" } });
    expect(search("w4", "", { type: "openPage", url: "https://example.com" })).toMatchObject({
      input: { query: "https://example.com" },
    });
    expect(feed(events, completed({ type: "webSearch", id: "w1", query: "bun test" }))).toEqual([
      { type: "tool-end", id: "w1", isError: false },
    ]);
  });

  test("reports a collaboration tool call by its tool only, never its prompt", () => {
    const events = new CodexItemEvents();
    const collab = (status: string) => ({
      type: "collabAgentToolCall",
      id: "a1",
      tool: "spawnAgent",
      status,
      senderThreadId: "t",
      receiverThreadIds: ["t2"],
      prompt: "private instructions",
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    });
    expect(feed(events, started(collab("inProgress")))).toEqual([
      {
        type: "tool-start",
        id: "a1",
        name: "collab_tool_call",
        input: { tool: "spawnAgent" },
        occurredAt: timestamp,
      },
    ]);
    expect(feed(events, completed(collab("completed")))).toEqual([
      { type: "tool-end", id: "a1", isError: false },
    ]);
    for (const status of ["failed", "interrupted"])
      expect(feed(events, completed(collab(status)))).toEqual([
        { type: "tool-end", id: "a1", isError: true },
      ]);
  });
});

describe("CodexItemEvents: compaction and review", () => {
  test("reports context compaction's start and finish", () => {
    const events = new CodexItemEvents();
    expect(feed(events, started({ type: "contextCompaction", id: "k1" }))).toEqual([
      { type: "compaction-started", occurredAt: timestamp },
    ]);
    expect(feed(events, completed({ type: "contextCompaction", id: "k1" }))).toEqual([
      { type: "compaction-finished", occurredAt: timestamp },
    ]);
  });

  test("reports review mode entered at its start and exited at its completion", () => {
    const events = new CodexItemEvents();
    const entered = { type: "enteredReviewMode", id: "v1", review: "current changes" };
    const exited = { type: "exitedReviewMode", id: "v2", review: "Looks good" };
    expect(feed(events, started(entered))).toEqual([
      { type: "review-started", occurredAt: timestamp },
    ]);
    expect(feed(events, completed(entered))).toEqual([]);
    expect(feed(events, started(exited))).toEqual([]);
    expect(feed(events, completed(exited))).toEqual([
      { type: "review-finished", occurredAt: timestamp },
    ]);
  });
});
