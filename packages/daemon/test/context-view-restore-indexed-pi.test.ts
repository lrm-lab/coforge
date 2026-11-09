import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { restoreContextView } from "#src/agent-context-view/context-view-restore";

function buffer(records: unknown[]): Buffer {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

test("verifies and restores Raft indexed Pi shape/blob/request records", () => {
  const shape = { config: { complex: { mode: "x" } } };
  const shapeHash = createHash("sha256").update(JSON.stringify(shape)).digest("hex");
  const messageHash = createHash("sha256").update(JSON.stringify("hello")).digest("hex");
  const digest = createHash("sha256")
    .update(`${shapeHash}\n${JSON.stringify({ config: { temperature: 0.2 } })}\n${messageHash}`)
    .digest("hex");
  const indexed = buffer([
    { type: "shape", hash: shapeHash, messagesKey: "messages", shape },
    { type: "blob", hash: messageHash, message: "hello" },
    {
      type: "request",
      id: "r1",
      sessionId: "s1",
      api: "openai-completions",
      params: { config: { temperature: 0.2 } },
      shapeHash,
      base: null,
      keep: 0,
      tail: [messageHash],
      digest,
    },
    { type: "response", sessionId: "s1", body: "Message ID: m1" },
  ]);
  const result = restoreContextView({
    runtime: "pi",
    sessionId: "s1",
    messageId: "m1",
    buffer: indexed,
    offset: indexed.length,
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.view.source).toEqual({ kind: "captured", format: "raft-request-log" });
    expect(result.view.verification).toBe("verified");
    expect(result.view.responseFound).toBe(true);
  }
});

test("does not match a longer reported message id from a later response", () => {
  const shape = {};
  const shapeHash = createHash("sha256").update("{}").digest("hex");
  const messageHash = createHash("sha256").update(JSON.stringify("hello")).digest("hex");
  const digest = createHash("sha256").update(`${shapeHash}\n{}\n${messageHash}`).digest("hex");
  const indexed = buffer([
    { type: "shape", hash: shapeHash, messagesKey: "messages", shape },
    { type: "blob", hash: messageHash, message: "hello" },
    {
      type: "request",
      id: "r1",
      sessionId: "s1",
      api: "openai-completions",
      params: {},
      shapeHash,
      base: null,
      keep: 0,
      tail: [messageHash],
      digest,
    },
    { type: "response", sessionId: "s1", body: "Message ID: m10" },
  ]);
  expect(
    restoreContextView({
      runtime: "pi",
      sessionId: "s1",
      messageId: "m1",
      buffer: indexed,
      offset: indexed.length,
    }),
  ).toEqual({ ok: false, failure: "not_found" });
});

test("backs up over a request that already holds the send result and restores its continuation", () => {
  const shape = { messages: [] };
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const shapeHash = hash(shape);
  const user = { role: "user", content: "hello" };
  const assistant = {
    role: "assistant",
    content: [
      {
        tool_calls: [
          {
            id: "call-1",
            function: { name: "exec", arguments: '{"command":"raft message send"}' },
          },
        ],
      },
    ],
  };
  const tool = {
    role: "tool",
    content: [{ type: "tool_result", call_id: "call-1", output: "Message ID: m1" }],
  };
  const userHash = hash(user);
  const assistantHash = hash(assistant);
  const toolHash = hash(tool);
  const digest = (params: Record<string, unknown>, hashes: string[]) =>
    createHash("sha256")
      .update(`${shapeHash}\n${JSON.stringify(params)}\n${hashes.join("\n")}`)
      .digest("hex");
  const indexed = buffer([
    { type: "shape", hash: shapeHash, messagesKey: "messages", shape },
    { type: "blob", hash: userHash, message: user },
    { type: "blob", hash: assistantHash, message: assistant },
    { type: "blob", hash: toolHash, message: tool },
    {
      type: "request",
      id: "r1",
      sessionId: "s1",
      api: "openai-completions",
      params: {},
      shapeHash,
      base: null,
      keep: 0,
      tail: [userHash],
      digest: digest({}, [userHash]),
    },
    {
      type: "request",
      id: "r2",
      sessionId: "s1",
      api: "openai-completions",
      params: {},
      shapeHash,
      base: "r1",
      keep: 1,
      tail: [assistantHash, toolHash],
      digest: digest({}, [userHash, assistantHash, toolHash]),
      messageIds: ["m1"],
    },
    { type: "response", sessionId: "s1", body: "late response" },
  ]);
  const secondRequest = indexed.indexOf(Buffer.from('"id":"r2"'));
  const requestOffset = indexed.lastIndexOf(10, secondRequest) + 1;
  const result = restoreContextView({
    runtime: "pi",
    sessionId: "s1",
    messageId: "m1",
    buffer: indexed,
    offset: requestOffset,
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.view.responseFound).toBe(true);
    expect(result.view.trigger).toEqual({ toolUseId: "call-1" });
    expect(JSON.stringify(result.view.messages)).not.toContain("late response");
  }
});

test("keeps a valid Pi view across a non-terminal gap after the indexed request", () => {
  const shape = { messages: [] };
  const shapeHash = createHash("sha256").update(JSON.stringify(shape)).digest("hex");
  const user = { role: "user", content: "hello" };
  const userHash = createHash("sha256").update(JSON.stringify(user)).digest("hex");
  const digest = createHash("sha256").update(`${shapeHash}\n{}\n${userHash}`).digest("hex");
  const indexed = buffer([
    { type: "shape", hash: shapeHash, messagesKey: "messages", shape },
    { type: "blob", hash: userHash, message: user },
    {
      type: "request",
      id: "r1",
      sessionId: "s1",
      api: "openai-completions",
      params: {},
      shapeHash,
      base: null,
      keep: 0,
      tail: [userHash],
      digest,
      messageIds: ["m1"],
    },
    { type: "gap", reason: "rotation" },
  ]);
  const result = restoreContextView({
    runtime: "pi",
    sessionId: "s1",
    messageId: "m1",
    buffer: indexed,
    offset: indexed.length,
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.view.responseFound).toBe(false);
});
