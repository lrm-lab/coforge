import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { restoreContextView } from "#src/agent-context-view/context-view-restore";

function buffer(records: unknown[]): Buffer {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

describe("context view provider restore fixtures", () => {
  test.each([
    ["codex", "codex-rollout.jsonl"],
    ["pi", "pi-request-log.jsonl"],
  ] as const)("restores the native %s fixture", (runtime, file) => {
    const fixture = readFileSync(join(import.meta.dir, "fixtures", "context-view", file));
    const result = restoreContextView({
      runtime,
      sessionId: "s1",
      messageId: "m1",
      buffer: fixture,
      offset: fixture.length,
    });
    expect(result.ok).toBe(true);
  });

  test.each([
    RUNTIME_PROVIDER.CLAUDE_CODE,
    RUNTIME_PROVIDER.CODEX,
    RUNTIME_PROVIDER.PI,
    RUNTIME_PROVIDER.COFORGE,
  ] as const)("restores %s records", (runtime) => {
    const records =
      runtime === RUNTIME_PROVIDER.CLAUDE_CODE
        ? (() => {
            const hash = createHash("sha256")
              .update('{"content":"hello","role":"user"}')
              .digest("hex");
            return [
              { type: "api-request-blob", hash, message: { role: "user", content: "hello" } },
              {
                type: "api-request",
                id: "r1",
                sessionId: "s1",
                keep: 0,
                tail: [hash],
                params: {},
              },
              {
                type: "assistant",
                requestRef: "r1",
                sessionId: "s1",
                message: { role: "assistant", content: "world" },
              },
            ];
          })()
        : runtime === RUNTIME_PROVIDER.CODEX
          ? [
              {
                type: "response_item",
                session_id: "s1",
                item: { type: "additional_tools", tools: [] },
              },
              { type: "user_message", session_id: "s1", message: "hello" },
              {
                type: "response_item",
                session_id: "s1",
                item: { type: "message", role: "assistant", content: "world" },
              },
            ]
          : [
              { type: "request", sessionId: "s1", body: { messages: "hello" } },
              { type: "response", sessionId: "s1", body: "world" },
            ];
    const result = restoreContextView({
      runtime,
      sessionId: "s1",
      messageId: "m1",
      buffer: buffer(records),
      offset: buffer(records).length,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.view.messages.length).toBe(2);
  });
});
