import { expect, test } from "bun:test";
import { restoreContextView } from "#src/agent-context-view/context-view-restore";

function buffer(records: unknown[]): Buffer {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

test("projects Kimi wire tool calls and send results after the indexed request offset", () => {
  const kimi = buffer([
    { type: "llm.request", sessionId: "s1", request: { messages: "hello" }, message_id: "m1" },
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
    { type: "llm.request", sessionId: "s1", request: { messages: "later" } },
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
