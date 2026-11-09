import { expect, test } from "bun:test";
import { restoreContextView } from "#src/agent-context-view/context-view-restore";

function buffer(records: unknown[]): Buffer {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

test("projects Kimi wire tool calls and send results", () => {
  const kimi = buffer([
    { type: "llm.request", sessionId: "s1", request: { messages: "hello" }, message_id: "m1" },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: {
        type: "tool.call",
        toolCallId: "call-1",
        name: "shell",
        arguments: '{"command":"raft message send --id m1"}',
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
    expect(result.view.responseFound).toBe(true);
    expect(result.view.trigger).toEqual({ toolUseId: "call-1" });
    expect(JSON.stringify(result.view.messages)).toContain("tool_result");
  }
});
