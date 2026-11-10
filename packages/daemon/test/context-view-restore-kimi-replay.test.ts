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

function messagesHash(messages: Array<Record<string, unknown>>): string {
  const hash = createHash("sha256");
  for (const message of messages) {
    hash.update(canonicalJson(message));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function restore(records: unknown[], messageId: string) {
  const source = buffer(records);
  return restoreContextView({
    runtime: "kimi-sdk",
    sessionId: "s1",
    messageId,
    buffer: source,
    offset: source.length,
  });
}

test("folds Kimi step events and synthesizes an interrupted tool result", () => {
  const user = { role: "user", content: [{ type: "text", text: "run" }] };
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "working" }],
    toolCalls: [{ id: "call-1", name: "shell", input: { command: "pwd" } }],
  };
  const completed = buffer([
    { type: "context.append_message", sessionId: "s1", message: user },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "step.begin", uuid: "step-1" },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "content.part", stepUuid: "step-1", part: { type: "text", text: "working" } },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: {
        type: "tool.call",
        stepUuid: "step-1",
        toolCallId: "call-1",
        name: "shell",
        args: { command: "pwd" },
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: {
        type: "tool.result",
        toolCallId: "call-1",
        result: { output: "ok", isError: false },
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "step.end", uuid: "step-1" },
    },
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      message_id: "m1",
      request: {
        toolSelect: true,
        messageCount: 3,
        messagesHash: messagesHash([
          user,
          assistant,
          {
            role: "tool",
            content: [{ type: "text", text: "ok" }],
            toolCallId: "call-1",
            isError: false,
          },
        ]),
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.call", toolCallId: "send", name: "shell", args: {} },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "send", output: "Message ID: m1" },
    },
  ]);
  expect(
    restoreContextView({
      runtime: "kimi-sdk",
      sessionId: "s1",
      messageId: "m1",
      buffer: completed,
      offset: completed.length,
    }),
  ).toMatchObject({ ok: true, view: { verification: "verified" } });

  const interrupted = completed
    .toString("utf8")
    .split("\n")
    .slice(0, 4)
    .concat([
      JSON.stringify({
        type: "llm.request",
        kind: "loop",
        sessionId: "s1",
        message_id: "m2",
        request: {
          toolSelect: true,
          messageCount: 3,
          messagesHash: messagesHash([
            user,
            assistant,
            {
              role: "tool",
              content: [
                {
                  type: "text",
                  text: "Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.",
                },
              ],
              toolCallId: "call-1",
              isError: true,
            },
          ]),
        },
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        sessionId: "s1",
        event: { type: "tool.call", toolCallId: "send", name: "shell", args: {} },
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        sessionId: "s1",
        event: { type: "tool.result", toolCallId: "send", output: "Message ID: m2" },
      }),
      "",
    ])
    .join("\n");
  expect(
    restoreContextView({
      runtime: "kimi-sdk",
      sessionId: "s1",
      messageId: "m2",
      buffer: Buffer.from(interrupted),
      offset: Buffer.byteLength(interrupted),
    }),
  ).toMatchObject({ ok: true, view: { verification: "verified" } });
});

test("pairs reordered Kimi tool results and drops orphan results", () => {
  const user = { role: "user", content: [{ type: "text", text: "run" }] };
  const assistant = {
    role: "assistant",
    content: [],
    toolCalls: [{ id: "call-1", name: "shell", input: {} }],
  };
  const reordered = [
    { type: "context.append_message", sessionId: "s1", message: user },
    { type: "context.append_message", sessionId: "s1", message: assistant },
    {
      type: "context.append_message",
      sessionId: "s1",
      message: { role: "user", content: [{ type: "text", text: "between" }] },
    },
    {
      type: "context.append_message",
      sessionId: "s1",
      message: { role: "tool", content: [{ type: "text", text: "ok" }], toolCallId: "call-1" },
    },
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      message_id: "m1",
      request: {
        toolSelect: true,
        messageCount: 4,
        messagesHash: messagesHash([
          user,
          assistant,
          { role: "tool", content: [{ type: "text", text: "ok" }], toolCallId: "call-1" },
          { role: "user", content: [{ type: "text", text: "between" }] },
        ]),
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.call", toolCallId: "send", name: "shell", args: {} },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "send", output: "Message ID: m1" },
    },
  ];
  const result = restore(reordered, "m1");
  expect(result).toMatchObject({ ok: true, view: { verification: "verified" } });
  if (result.ok) {
    const rendered = JSON.stringify(result.view.messages);
    expect(rendered.indexOf("tool_result")).toBeLessThan(rendered.indexOf("between"));
  }

  const orphan = [
    { type: "context.append_message", sessionId: "s1", message: user },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "orphan", output: "drop" },
    },
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      message_id: "m2",
      request: { toolSelect: true, messageCount: 1, messagesHash: messagesHash([user]) },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.call", toolCallId: "send", name: "shell", args: {} },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "send", output: "Message ID: m2" },
    },
  ];
  const orphanResult = restore(orphan, "m2");
  expect(orphanResult).toMatchObject({ ok: true, view: { verification: "verified" } });
  if (orphanResult.ok) expect(JSON.stringify(orphanResult.view.messages)).not.toContain("drop");
});

test("synthesizes the prior interrupted result for duplicate Kimi tool calls", () => {
  const first = {
    role: "assistant",
    content: [],
    toolCalls: [{ id: "call-1", name: "shell", input: {} }],
  };
  const second = {
    role: "assistant",
    content: [],
    toolCalls: [{ id: "call-1", name: "shell", input: { command: "pwd" } }],
  };
  const records = [
    { type: "context.append_message", sessionId: "s1", message: first },
    { type: "context.append_message", sessionId: "s1", message: second },
    {
      type: "llm.request",
      kind: "loop",
      sessionId: "s1",
      message_id: "m1",
      request: {
        toolSelect: true,
        messageCount: 4,
        messagesHash: messagesHash([
          first,
          {
            role: "tool",
            content: [
              {
                type: "text",
                text: "Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.",
              },
            ],
            toolCallId: "call-1",
            isError: true,
          },
          second,
          {
            role: "tool",
            content: [
              {
                type: "text",
                text: "Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.",
              },
            ],
            toolCallId: "call-1",
            isError: true,
          },
        ]),
      },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.call", toolCallId: "send", name: "shell", args: {} },
    },
    {
      type: "context.append_loop_event",
      sessionId: "s1",
      event: { type: "tool.result", toolCallId: "send", output: "Message ID: m1" },
    },
  ];
  const result = restore(records, "m1");
  expect(result).toMatchObject({ ok: true, view: { verification: "verified" } });
});
