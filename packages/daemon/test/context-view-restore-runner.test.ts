import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  encodeContextViewRestoreChildResult,
  decodeContextViewRestoreChildResult,
  runContextViewRestoreInChild,
} from "#src/agent-context-view/context-view-restore-runner";

test("round trips bounded child result framing", () => {
  const result = {
    ok: true as const,
    view: {
      runtime: "codex" as const,
      sessionId: "s1",
      messageId: "m1",
      messages: [],
      source: { kind: "native" as const, format: "codex-rollout" },
      redactions: { media: 0, diagnostic: 0 },
    },
  };
  expect(decodeContextViewRestoreChildResult(encodeContextViewRestoreChildResult(result))).toEqual(
    result,
  );
});

test("preserves the Raft too-large cause in child framing", () => {
  const result = {
    ok: false as const,
    failure: "too_large" as const,
    tooLargeCause: "restore_limit" as const,
  };
  expect(decodeContextViewRestoreChildResult(encodeContextViewRestoreChildResult(result))).toEqual(
    result,
  );
});

test("runs the real restore mode in a Bun child", async () => {
  const buffer = Buffer.from(
    [
      { type: "response_item", session_id: "s1", item: { type: "additional_tools", tools: [] } },
      { type: "user_message", session_id: "s1", message: "hello" },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
    "utf8",
  );
  const result = await runContextViewRestoreInChild(
    { runtime: "codex", sessionId: "s1", messageId: "m1", buffer, offset: buffer.length },
    {
      command: [
        process.execPath,
        join(import.meta.dir, "../../../packages/computer/src/main.ts"),
        "__restore-context-view",
      ],
    },
  );
  expect(result.ok).toBe(true);
});

test("maps a restore timeout to a bounded refusal", async () => {
  const result = await runContextViewRestoreInChild(
    {
      runtime: "codex",
      sessionId: "s1",
      messageId: "m1",
      buffer: Buffer.from("", "utf8"),
      offset: 0,
    },
    { command: ["sh", "-c", "sleep 1"], timeoutMs: 10 },
  );
  expect(result).toEqual({ ok: false, failure: "read_failed" });
});

test("rejects oversized child headers and payloads", () => {
  const header = `${"x".repeat(64 * 1024 + 1)}\n{}`;
  expect(decodeContextViewRestoreChildResult(header)).toEqual({
    ok: false,
    failure: "read_failed",
  });
});
