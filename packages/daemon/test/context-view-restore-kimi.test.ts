import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { restoreContextView } from "#src/agent-context-view/context-view-restore";

function buffer(records: unknown[]): Buffer {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function messagesHash(messages: Array<Record<string, unknown>>): string {
  const hash = createHash("sha256");
  for (const message of messages) {
    hash.update(canonicalJson(message));
    hash.update("\n");
  }
  return hash.digest("hex");
}

test("projects Kimi wire tool calls and send results after the indexed request offset", () => {
  const kimi = buffer([
    {
      type: "llm.request",
      sessionId: "s1",
      request: { messages: "hello", model: "target-model" },
      message_id: "m1",
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: {
        type: "tool.call",
        toolCallId: "call-1",
        name: "shell",
        args: { command: "raft message send --id m1" },
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "call-1", output: "Message ID: m1" },
    },
    { type: "llm.request", sessionId: "s1", request: { messages: "later", model: "later-model" } },
    { type: "llm.response", sessionId: "s1", content: "later response" },
  ]);
  const requestOffset = kimi.indexOf(Buffer.from("\n")) + 1;
  const result = restoreContextView({
    runtime: "kimi-sdk",
    sessionId: "s1",
    messageId: "m1",
    buffer: kimi,
    offset: requestOffset,
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.view.model).toBe("target-model");
    expect(result.view.responseFound).toBe(true);
    expect(result.view.trigger).toEqual({ toolUseId: "call-1" });
    expect(JSON.stringify(result.view.messages)).toContain("tool_result");
    expect(JSON.stringify(result.view.messages)).not.toContain("later response");
  }
});

test("rejects invalid Kimi offsets before full-buffer restore", () => {
  const kimi = buffer([{ type: "llm.request", sessionId: "s1", request: { messages: "hello" } }]);
  for (const offset of [-1, Number.NaN, kimi.length + 1]) {
    expect(
      restoreContextView({
        runtime: "kimi-sdk",
        sessionId: "s1",
        messageId: "m1",
        buffer: kimi,
        offset,
      }),
    ).toEqual({ ok: false, failure: "read_failed" });
  }
});

test("rebuilds the latest loop request from context messages and compaction", () => {
  const kimi = buffer([
    {
      type: "context.append_message",
      sessionId: "s1",
      message: { role: "user", content: [{ type: "text", text: "before" }] },
    },
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      request: { messages: "old", model: "old-model" },
    },
    { type: "llm.response", sessionId: "s1", content: "old response" },
    { type: "context.apply_compaction", sessionId: "s1", summary: "summary" },
    {
      type: "context.append_message",
      sessionId: "s1",
      message: { id: "m2", role: "user", content: [{ type: "text", text: "target" }] },
    },
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      request: { messages: "ignored", model: "new-model" },
      model: "new-model",
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: {
        type: "tool.call",
        toolCallId: "call-2",
        name: "shell",
        args: { command: "raft message send" },
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "call-2", output: "Message ID: m2" },
    },
  ]);
  const result = restoreContextView({
    runtime: "kimi-sdk",
    sessionId: "s1",
    messageId: "m2",
    buffer: kimi,
    offset: kimi.length,
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.view.model).toBe("new-model");
    expect(JSON.stringify(result.view.messages)).toContain("summary");
    expect(JSON.stringify(result.view.messages)).toContain("target");
  }
});

test("refuses a Kimi request whose recorded system prompt hash does not match", () => {
  const kimi = buffer([
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      request: { messages: "hello", systemPrompt: "actual", systemPromptHash: "wrong" },
      message_id: "m1",
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: {
        type: "tool.call",
        toolCallId: "call-1",
        name: "shell",
        args: { command: "raft message send" },
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "call-1", output: "Message ID: m1" },
    },
  ]);
  expect(
    restoreContextView({
      runtime: "kimi-sdk",
      sessionId: "s1",
      messageId: "m1",
      buffer: kimi,
      offset: kimi.length,
    }),
  ).toEqual({ ok: false, failure: "context_mismatch" });
});

test("refuses a Kimi request whose canonical messages hash does not match", () => {
  const tools = [{ name: "shell", description: "", parameters: { type: "object" } }];
  const kimi = buffer([
    {
      type: "llm.tools_snapshot",
      sessionId: "s1",
      hash: sha256(JSON.stringify(tools)),
      tools,
    },
    {
      type: "context.append_message",
      sessionId: "s1",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      message_id: "m1",
      request: {
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        model: "kimi-k2",
        systemPrompt: "system",
        systemPromptHash: sha256("system"),
        toolsHash: sha256(JSON.stringify(tools)),
        messageCount: 1,
        messagesHash: "wrong",
        toolSelect: true,
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: {
        type: "tool.call",
        toolCallId: "call-1",
        name: "shell",
        args: { command: "raft message send" },
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "call-1", output: "Message ID: m1" },
    },
  ]);
  expect(
    restoreContextView({
      runtime: "kimi-sdk",
      sessionId: "s1",
      messageId: "m1",
      buffer: kimi,
      offset: kimi.length,
    }),
  ).toEqual({ ok: false, failure: "context_mismatch" });
});

test("accepts a Kimi canonical message hash after context.clear", () => {
  const messageValue = { role: "user", content: [{ type: "text", text: "after clear" }] };
  const tools = [{ name: "shell", description: "", parameters: { type: "object" } }];
  const kimi = buffer([
    {
      type: "context.append_message",
      sessionId: "s1",
      message: { role: "user", content: [{ type: "text", text: "before clear" }] },
    },
    { type: "context.clear", sessionId: "s1" },
    { type: "context.append_message", sessionId: "s1", message: messageValue },
    { type: "llm.tools_snapshot", sessionId: "s1", hash: sha256(JSON.stringify(tools)), tools },
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      message_id: "m1",
      request: {
        model: "kimi-k2",
        messages: [messageValue],
        systemPrompt: "system",
        systemPromptHash: sha256("system"),
        toolsHash: sha256(JSON.stringify(tools)),
        messageCount: 1,
        messagesHash: messagesHash([messageValue]),
        toolSelect: true,
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: {
        type: "tool.call",
        toolCallId: "call-1",
        name: "shell",
        args: { command: "raft message send" },
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "call-1", output: "Message ID: m1" },
    },
  ]);
  const result = restoreContextView({
    runtime: "kimi-sdk",
    sessionId: "s1",
    messageId: "m1",
    buffer: kimi,
    offset: kimi.length,
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.view.verification).toBe("verified");
    expect(JSON.stringify(result.view.messages)).toContain("after clear");
    expect(JSON.stringify(result.view.messages)).not.toContain("before clear");
  }
});

test("rejects a newer Kimi wire protocol and media projection", () => {
  const supported = buffer([
    { type: "metadata", protocol_version: "1.5", sessionId: "s1" },
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      message_id: "m1",
      request: { messages: [], messageCount: 0 },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.call", toolCallId: "call-1", name: "shell", args: {} },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "call-1", output: "Message ID: m1" },
    },
  ]);
  expect(
    restoreContextView({
      runtime: "kimi-sdk",
      sessionId: "s1",
      messageId: "m1",
      buffer: supported,
      offset: supported.length,
    }),
  ).toMatchObject({ ok: true });

  const newer = buffer([
    { type: "metadata", protocol_version: "1.6", sessionId: "s1" },
    { type: "llm.request", kind: "loop", sessionId: "s1", message_id: "m1" },
  ]);
  expect(
    restoreContextView({
      runtime: "kimi-sdk",
      sessionId: "s1",
      messageId: "m1",
      buffer: newer,
      offset: newer.length,
    }),
  ).toEqual({ ok: false, failure: "newer_session_format" });

  const media = buffer([
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      message_id: "m1",
      request: { projection: "media-stripped", messageCount: 0 },
    },
  ]);
  expect(
    restoreContextView({
      runtime: "kimi-sdk",
      sessionId: "s1",
      messageId: "m1",
      buffer: media,
      offset: media.length,
    }),
  ).toEqual({ ok: false, failure: "media_removed" });
});

test("matches Kimi toolSelect and strict projection before hashing", () => {
  const dynamicTools = [{ name: "shell", description: "", parameters: {} }];
  const projected = [{ role: "user", content: [{ type: "text", text: "hello" }], toolCalls: [] }];
  const kimi = buffer([
    {
      type: "context.append_message",
      sessionId: "s1",
      message: { role: "system", content: [{ type: "text", text: "system" }] },
    },
    {
      type: "context.append_message",
      sessionId: "s1",
      message: { ...projected[0], tools: dynamicTools },
    },
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      message_id: "m1",
      request: {
        toolSelect: false,
        projection: "strict",
        messageCount: projected.length,
        messagesHash: messagesHash(projected),
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.call", toolCallId: "call-1", name: "shell", args: {} },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "call-1", output: "Message ID: m1" },
    },
  ]);
  const restored = restoreContextView({
    runtime: "kimi-sdk",
    sessionId: "s1",
    messageId: "m1",
    buffer: kimi,
    offset: kimi.length,
  });
  expect(restored).toMatchObject({ ok: true, view: { verification: "verified" } });
  if (restored.ok) {
    const rendered = JSON.stringify(restored.view.messages);
    expect(rendered).toContain("hello");
    expect(rendered).not.toContain("system");
    expect(rendered).not.toContain('"tools"');
  }
});

test("folds Kimi context.undo before rebuilding the latest loop request", () => {
  const retained = { role: "user", content: [{ type: "text", text: "retained" }] };
  const kimi = buffer([
    {
      type: "context.append_message",
      sessionId: "s1",
      message: { role: "user", content: [{ type: "text", text: "removed" }] },
    },
    { type: "context.undo", sessionId: "s1", count: 1 },
    { type: "context.append_message", sessionId: "s1", message: retained },
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      message_id: "m1",
      request: {
        toolSelect: true,
        messageCount: 1,
        messagesHash: messagesHash([retained]),
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.call", toolCallId: "call-1", name: "shell", args: {} },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "call-1", output: "Message ID: m1" },
    },
  ]);
  const result = restoreContextView({
    runtime: "kimi-sdk",
    sessionId: "s1",
    messageId: "m1",
    buffer: kimi,
    offset: kimi.length,
  });
  expect(result).toMatchObject({ ok: true, view: { verification: "verified" } });
  if (result.ok) {
    expect(JSON.stringify(result.view.messages)).toContain("retained");
    expect(JSON.stringify(result.view.messages)).not.toContain("removed");
  }
});

test("rejects a Kimi tools hash without a matching snapshot", () => {
  const kimi = buffer([
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      message_id: "m1",
      request: {
        model: "kimi-k2",
        systemPrompt: "system",
        systemPromptHash: sha256("system"),
        toolsHash: "missing-tools",
        messageCount: 0,
        toolSelect: true,
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: {
        type: "tool.call",
        toolCallId: "call-1",
        name: "shell",
        args: { command: "raft message send" },
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "call-1", output: "Message ID: m1" },
    },
  ]);
  expect(
    restoreContextView({
      runtime: "kimi-sdk",
      sessionId: "s1",
      messageId: "m1",
      buffer: kimi,
      offset: kimi.length,
    }),
  ).toEqual({ ok: false, failure: "context_mismatch" });
});

test("uses a pre-offset target result when the tool command shape is unavailable", () => {
  const kimi = buffer([
    { type: "llm.request", kind: "loop", sessionId: "s1", request: { messages: "hello" } },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.call", toolCallId: "call-1", name: "shell", args: {} },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "call-1", output: "Message ID: m1" },
    },
  ]);
  expect(
    restoreContextView({
      runtime: "kimi-sdk",
      sessionId: "s1",
      messageId: "m1",
      buffer: kimi,
      offset: kimi.length,
    }),
  ).toMatchObject({ ok: true, view: { trigger: { toolUseId: "call-1" } } });
});
