import { expect, test } from "bun:test";
import { restoreContextView } from "#src/agent-context-view/context-view-restore";

function buffer(records: unknown[]): Buffer {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
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
