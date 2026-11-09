import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  claudeRequestDigest,
  restoreClaudeSession,
} from "#src/agent-context-view/claude-session-restore";
import { assistantRecord, toolResultRecord } from "./claude-transcript-fixtures";

test("reconstructs Claude base/keep/tail chains and verifies session identity", () => {
  const userHash = createHash("sha256").update('{"content":"hello","role":"user"}').digest("hex");
  const records = [
    { type: "api-request-shape", shapeHash: "shape-1", shape: { system: "system" } },
    { type: "api-request-blob", hash: userHash, message: { role: "user", content: "hello" } },
    {
      type: "api-request",
      id: "r1",
      sessionId: "s1",
      keep: 0,
      tail: [userHash],
      params: { model: "x", shapeHash: "shape-1" },
    },
    {
      type: "assistant",
      requestRef: "r1",
      sessionId: "s1",
      message: { role: "assistant", content: "world" },
    },
    {
      type: "api-request",
      id: "r2",
      sessionId: "s1",
      base: "r1",
      keep: 1,
      tail: [userHash],
      params: { model: "x", shapeHash: "shape-1" },
    },
  ];
  const buffer = Buffer.from(records.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const result = restoreClaudeSession({
    buffer,
    offset: buffer.length,
    sessionId: "s1",
    messageId: "m1",
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.messages.map((message) => message.role)).toEqual(["user", "user"]);
  expect(
    restoreClaudeSession({ buffer, offset: buffer.length, sessionId: "other", messageId: "m1" }),
  ).toEqual({ ok: false, failure: "context_mismatch" });
});

test("uses only records before the offset and finds the message send trigger", () => {
  const userHash = createHash("sha256").update('{"content":"hello","role":"user"}').digest("hex");
  const before = [
    { type: "api-request-blob", hash: userHash, message: { role: "user", content: "hello" } },
    { type: "api-request", id: "r1", sessionId: "s1", keep: 0, tail: [userHash], params: {} },
    {
      type: "user",
      sessionId: "s1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Message ID: m1" }],
      },
    },
    {
      type: "assistant",
      requestRef: "r1",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    },
  ];
  const after = {
    type: "api-request",
    id: "future",
    sessionId: "other",
    keep: 0,
    tail: [],
    params: {},
  };
  const beforeBuffer = Buffer.from(before.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const buffer = Buffer.from(`${beforeBuffer.toString("utf8")}${JSON.stringify(after)}\n`);
  const result = restoreClaudeSession({
    buffer,
    offset: beforeBuffer.length,
    sessionId: "s1",
    messageId: "m1",
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.trigger).toEqual({ toolUseId: "tool-1" });
});

test("projects shape, compaction, usage, and verifies the canonical request digest", () => {
  const shape = { system: [{ text: "system" }], tools: [{ name: "send", description: "send" }] };
  const user = { role: "user", content: "hello" };
  const params = { model: "x" };
  const digest = claudeRequestDigest(params, shape, [user]);
  const records = [
    { type: "api-request-shape", shapeHash: "shape-1", shape },
    {
      type: "api-request-blob",
      hash: createHash("sha256").update('{"content":"hello","role":"user"}').digest("hex"),
      message: user,
    },
    { type: "system", subtype: "compact_boundary", sessionId: "s1" },
    {
      type: "api-request",
      id: "r1",
      sessionId: "s1",
      keep: 0,
      tail: [createHash("sha256").update('{"content":"hello","role":"user"}').digest("hex")],
      params,
      shapeHash: "shape-1",
      requestDigest: digest,
    },
    {
      type: "assistant",
      requestRef: "r1",
      sessionId: "s1",
      message: { role: "assistant", content: "world", usage: { input_tokens: 10 } },
    },
  ];
  const buffer = Buffer.from(records.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const result = restoreClaudeSession({
    buffer,
    offset: buffer.length,
    sessionId: "s1",
    messageId: "m1",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.digestMatch).toBe(true);
    expect(result.system).toEqual([{ text: "system" }]);
    expect(result.tools[0]?.name).toBe("send");
    expect(result.compaction.happened).toBe(true);
    expect(result.usage).toEqual({ input_tokens: 10 });
  }
});

test("accepts the observed Claude Code assistant and tool_result record shapes", () => {
  const userHash = createHash("sha256").update('{"content":"hello","role":"user"}').digest("hex");
  const lines =
    [
      JSON.stringify({
        type: "api-request-blob",
        hash: userHash,
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "api-request",
        id: "r1",
        sessionId: "s1",
        keep: 0,
        tail: [userHash],
        params: {},
      }),
      JSON.stringify({
        ...JSON.parse(
          assistantRecord({
            timestamp: "2026-01-01T00:00:00.000Z",
            usage: { input: 10, cacheRead: 2, cacheCreate: 1 },
            content: [{ type: "tool_use", id: "tool-1", name: "raft", input: {} }],
          }),
        ),
        requestRef: "r1",
      }),
      toolResultRecord("2026-01-01T00:00:01.000Z", "tool-1", "Message ID: m-native"),
    ].join("\n") + "\n";
  const buffer = Buffer.from(lines, "utf8");
  const result = restoreClaudeSession({
    buffer,
    offset: buffer.length,
    sessionId: "s1",
    messageId: "m-native",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.responseFound).toBe(true);
    expect(result.trigger).toEqual({ toolUseId: "tool-1" });
  }
});

test("accepts repository Claude transcript fixture shapes for assistant and tool results", () => {
  const user = { role: "user", content: "hello" };
  const userHash = createHash("sha256").update('{"content":"hello","role":"user"}').digest("hex");
  const assistant = JSON.parse(
    assistantRecord({
      timestamp: "2026-01-01T00:00:00.000Z",
      usage: { input: 10, cacheRead: 2, cacheCreate: 1 },
    }),
  ) as Record<string, unknown>;
  assistant.requestRef = "r1";
  assistant.sessionId = "s1";
  const toolResult = JSON.parse(
    toolResultRecord("2026-01-01T00:00:01.000Z", "tool-1", "Message ID: m1"),
  ) as Record<string, unknown>;
  toolResult.sessionId = "s1";
  const records = [
    { type: "api-request-blob", hash: userHash, message: user },
    { type: "api-request", id: "r1", sessionId: "s1", keep: 0, tail: [userHash], params: {} },
    assistant,
    toolResult,
  ];
  const buffer = Buffer.from(records.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const result = restoreClaudeSession({
    buffer,
    offset: buffer.length,
    sessionId: "s1",
    messageId: "m1",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.responseFound).toBe(true);
    expect(result.usage).toEqual({
      input_tokens: 10,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    });
    expect(result.trigger).toEqual({ toolUseId: "tool-1" });
  }
});

test("fails closed for a missing request shape and malformed request fields", () => {
  const userHash = createHash("sha256").update('{"content":"hello","role":"user"}').digest("hex");
  const missingShape = Buffer.from(
    [
      { type: "api-request-blob", hash: userHash, message: { role: "user", content: "hello" } },
      {
        type: "api-request",
        id: "r1",
        sessionId: "s1",
        shapeHash: "missing",
        keep: 0,
        tail: [userHash],
        params: {},
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  expect(
    restoreClaudeSession({
      buffer: missingShape,
      offset: missingShape.length,
      sessionId: "s1",
      messageId: "m",
    }),
  ).toEqual({ ok: false, failure: "read_failed" });
  const malformed = Buffer.from(
    JSON.stringify({ type: "api-request", id: "r1", keep: -1, tail: "bad", params: {} }) + "\n",
  );
  expect(
    restoreClaudeSession({
      buffer: malformed,
      offset: malformed.length,
      sessionId: "s1",
      messageId: "m",
    }),
  ).toEqual({ ok: false, failure: "read_failed" });
});

test("keeps unresolved Claude messages as Raft placeholders", () => {
  const missing = "missing-message-hash";
  const records = [
    { type: "api-request-shape", shapeHash: "shape-1", shape: { system: "system" } },
    { type: "api-request", id: "r1", sessionId: "s1", keep: 0, tail: [missing], params: {} },
  ];
  const buffer = Buffer.from(records.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const result = restoreClaudeSession({
    buffer,
    offset: buffer.length,
    sessionId: "s1",
    messageId: "m1",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.unresolvedMessages).toBe(1);
    expect(result.digestMatch).toBe(null);
    expect(result.messages[0]?.content).toBe(
      "[This message is not in the session file and could not be restored.]",
    );
  }
});
