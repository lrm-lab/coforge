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
