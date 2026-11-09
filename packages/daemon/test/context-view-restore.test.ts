import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { restoreContextView } from "#src/agent-context-view/context-view-restore";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function buffer(records: unknown[]): Buffer {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

describe("context view provider restore", () => {
  test("rejects session mismatches and unsupported future records", () => {
    const mismatchBuffer = buffer([{ type: "user", sessionId: "s2", message: { content: "x" } }]);
    const mismatch = restoreContextView({
      runtime: "claude",
      sessionId: "s1",
      messageId: "m1",
      buffer: mismatchBuffer,
      offset: mismatchBuffer.length,
    });
    expect(mismatch).toEqual({ ok: false, failure: "context_mismatch" });
    const futureBuffer = buffer([{ type: "unknown_future", sessionId: "s1" }]);
    const future = restoreContextView({
      runtime: "codex",
      sessionId: "s1",
      messageId: "m1",
      buffer: futureBuffer,
      offset: futureBuffer.length,
    });
    expect(future).toEqual({ ok: false, failure: "newer_session_format" });
  });

  test("does not confuse a captured gap with a missing session", () => {
    const gap = buffer([{ type: "gap", sessionId: "s1" }]);
    expect(
      restoreContextView({
        runtime: "pi",
        sessionId: "s1",
        messageId: "m1",
        buffer: gap,
        offset: gap.length,
      }),
    ).toEqual({ ok: false, failure: "not_recorded" });
  });

  test("restores nested Codex rollout records and rejects rollback/hash mismatches", () => {
    const nested = buffer([
      { type: "session_meta", payload: { session_id: "s1" } },
      {
        type: "response_item",
        payload: { session_id: "s1", item: { type: "additional_tools", tools: [] } },
      },
      { type: "user_message", payload: { session_id: "s1", message: "hello", message_id: "m1" } },
      {
        type: "response_item",
        payload: {
          session_id: "s1",
          item: { type: "message", role: "assistant", content: "world" },
        },
      },
    ]);
    const restored = restoreContextView({
      runtime: "codex",
      sessionId: "s1",
      messageId: "m1",
      buffer: nested,
      offset: nested.length,
    });
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.view.verification).toBe("verified");

    const rollback = buffer([
      { type: "event_msg", payload: { type: "thread_rolled_back" }, session_id: "s1" },
    ]);
    expect(
      restoreContextView({
        runtime: "codex",
        sessionId: "s1",
        messageId: "m1",
        buffer: rollback,
        offset: rollback.length,
      }),
    ).toEqual({ ok: false, failure: "context_mismatch" });
    const mismatch = buffer([
      {
        type: "response_item",
        session_id: "s1",
        hash: "a",
        expected_hash: "b",
        item: { type: "message", role: "assistant", content: "x" },
      },
    ]);
    expect(
      restoreContextView({
        runtime: "codex",
        sessionId: "s1",
        messageId: "m1",
        buffer: mismatch,
        offset: mismatch.length,
      }),
    ).toEqual({ ok: false, failure: "context_mismatch" });

    const nestedScopeMismatch = buffer([
      {
        type: "response_item",
        session_id: "s1",
        payload: {
          session_id: "s2",
          item: { type: "message", role: "assistant", content: "x" },
        },
      },
    ]);
    expect(
      restoreContextView({
        runtime: "codex",
        sessionId: "s1",
        messageId: "m1",
        buffer: nestedScopeMismatch,
        offset: nestedScopeMismatch.length,
      }),
    ).toEqual({ ok: false, failure: "context_mismatch" });
  });

  test("does not treat a longer message id as the requested target", () => {
    const rollout = buffer([
      { type: "response_item", session_id: "s1", item: { type: "additional_tools", tools: [] } },
      { type: "user_message", session_id: "s1", message: "m10" },
      {
        type: "response_item",
        session_id: "s1",
        item: { type: "message", role: "assistant", content: "world" },
      },
    ]);
    const result = restoreContextView({
      runtime: "codex",
      sessionId: "s1",
      messageId: "m1",
      buffer: rollout,
      offset: rollout.length,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.view.verification).toBe("count_matched");
  });

  test("restores Codex compacted replacement history and projects additional tools", () => {
    const compacted = buffer([
      {
        type: "compacted",
        session_id: "s1",
        payload: {
          replacement_history: [
            { type: "user_message", session_id: "s1", message: "before", message_id: "m0" },
            {
              type: "response_item",
              session_id: "s1",
              item: { type: "message", role: "assistant", content: "after" },
            },
          ],
        },
      },
      {
        type: "response_item",
        session_id: "s1",
        payload: { type: "additional_tools", tools: [{ name: "shell" }] },
      },
    ]);
    const result = restoreContextView({
      runtime: "codex",
      sessionId: "s1",
      messageId: "m0",
      buffer: compacted,
      offset: compacted.length,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.view.messages).toHaveLength(2);
      expect(result.view.tools).toEqual([{ name: "shell", description: "", inputSchema: null }]);
      expect(result.view.verification).toBe("verified");
    }
  });

  test("bounds Codex output at the target message and reports response/trigger", () => {
    const rollout = buffer([
      { type: "response_item", session_id: "s1", item: { type: "additional_tools", tools: [] } },
      { type: "user_message", session_id: "s1", message: "target", message_id: "m1" },
      {
        type: "response_item",
        session_id: "s1",
        messageId: "m1",
        item: {
          type: "function_call",
          name: "shell",
          call_id: "call-1",
          arguments: '{"command":"raft message send --id m1"}',
        },
      },
      {
        type: "response_item",
        session_id: "s1",
        item: { type: "function_call_output", call_id: "call-1", output: "done" },
      },
      { type: "user_message", session_id: "s1", message: "late", message_id: "m2" },
      {
        type: "response_item",
        session_id: "s1",
        item: { type: "message", role: "assistant", content: "late reply" },
      },
    ]);
    const result = restoreContextView({
      runtime: "codex",
      sessionId: "s1",
      messageId: "m1",
      buffer: rollout,
      offset: rollout.length,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.view.responseFound).toBe(true);
      expect(result.view.trigger).toEqual({ toolUseId: "call-1" });
      expect(result.view.messages).toHaveLength(3);
      expect(
        result.view.messages.some((entry) => JSON.stringify(entry).includes("late reply")),
      ).toBe(false);
      expect(JSON.stringify(result.view.messages)).toContain(
        '"command":"raft message send --id m1"',
      );
    }
  });

  test("bounds Codex output at a response-item user boundary", () => {
    const rollout = buffer([
      { type: "response_item", session_id: "s1", item: { type: "additional_tools", tools: [] } },
      { type: "user_message", session_id: "s1", message: "target", message_id: "m1" },
      {
        type: "response_item",
        session_id: "s1",
        item: { type: "message", role: "assistant", content: "reply" },
      },
      {
        type: "response_item",
        session_id: "s1",
        item: { type: "message", role: "user", content: "next" },
      },
      {
        type: "response_item",
        session_id: "s1",
        item: { type: "message", role: "assistant", content: "late" },
      },
    ]);
    const result = restoreContextView({
      runtime: "codex",
      sessionId: "s1",
      messageId: "m1",
      buffer: rollout,
      offset: rollout.length,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.stringify(result.view.messages)).not.toContain("late");
  });

  test("refuses Codex sessions that have no additional-tools projection", () => {
    const rollout = buffer([
      { type: "turn_context", session_id: "s1", model: "gpt" },
      { type: "user_message", session_id: "s1", message: "hello", message_id: "m1" },
      {
        type: "response_item",
        session_id: "s1",
        item: { type: "message", role: "assistant", content: "world" },
      },
    ]);
    expect(
      restoreContextView({
        runtime: "codex",
        sessionId: "s1",
        messageId: "m1",
        buffer: rollout,
        offset: rollout.length,
      }),
    ).toEqual({ ok: false, failure: "unsupported_runtime" });
  });

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

  test("rejects Kimi orphan responses and broken sequences", () => {
    const orphan = buffer([{ type: "llm.response", sessionId: "s1", content: "late" }]);
    expect(
      restoreContextView({
        runtime: "kimi-sdk",
        sessionId: "s1",
        messageId: "m1",
        buffer: orphan,
        offset: orphan.length,
      }),
    ).toEqual({ ok: false, failure: "context_mismatch" });
    const broken = buffer([
      { type: "llm.request", sessionId: "s1", sequence: 2, request: { messages: "hello" } },
      { type: "llm.response", sessionId: "s1", sequence: 1, content: "world" },
    ]);
    expect(
      restoreContextView({
        runtime: "kimi-sdk",
        sessionId: "s1",
        messageId: "m1",
        buffer: broken,
        offset: broken.length,
      }),
    ).toEqual({ ok: false, failure: "context_mismatch" });
    const orphanToolResult = buffer([
      { type: "llm.request", sessionId: "s1", request: { messages: "hello" } },
      {
        type: "context.append_loop_event",
        sessionId: "s1",
        event: { type: "tool.result", toolCallId: "missing", output: "x" },
      },
    ]);
    expect(
      restoreContextView({
        runtime: "kimi-sdk",
        sessionId: "s1",
        messageId: "m1",
        buffer: orphanToolResult,
        offset: orphanToolResult.length,
      }),
    ).toEqual({ ok: false, failure: "context_mismatch" });
    const unfinished = buffer([
      { type: "llm.request", sessionId: "s1", request: { messages: "hello" } },
      {
        type: "context.append_loop_event",
        sessionId: "s1",
        event: { type: "tool.call", toolCallId: "call-1", name: "shell" },
      },
    ]);
    expect(
      restoreContextView({
        runtime: "kimi-sdk",
        sessionId: "s1",
        messageId: "m1",
        buffer: unfinished,
        offset: unfinished.length,
      }),
    ).toEqual({ ok: false, failure: "context_mismatch" });
  });

  test("rejects native Kimi media and Pi rollback/hash chain failures", () => {
    const kimi = buffer([
      { type: "llm.request", sessionId: "s1", request: { messages: "hello" } },
      { type: "llm.media", sessionId: "s1" },
    ]);
    expect(
      restoreContextView({
        runtime: "kimi-sdk",
        sessionId: "s1",
        messageId: "m1",
        buffer: kimi,
        offset: kimi.length,
      }),
    ).toEqual({ ok: false, failure: "media_removed" });
    const pi = buffer([
      { type: "request", sessionId: "s1", hash: "a", body: { input: "hello" } },
      { type: "response", sessionId: "s1", prevHash: "wrong", hash: "b", body: "world" },
    ]);
    expect(
      restoreContextView({
        runtime: "pi",
        sessionId: "s1",
        messageId: "m1",
        buffer: pi,
        offset: pi.length,
      }),
    ).toEqual({ ok: false, failure: "context_mismatch" });
  });

  test("keeps Kimi model, ISO request time, and normalized usage metadata", () => {
    const records = buffer([
      {
        type: "llm.request",
        sessionId: "s1",
        message_id: "m1",
        time: "2026-11-09T00:00:00.000Z",
        model_name: "kimi-k2",
        request: { messages: [{ role: "user", content: "hello" }] },
      },
      {
        type: "usage.record",
        sessionId: "s1",
        usage: { inputTokens: 7, cache_read_input_tokens: 3 },
      },
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
      { type: "llm.response", sessionId: "s1", content: "world" },
    ]);
    const result = restoreContextView({
      runtime: "kimi-sdk",
      sessionId: "s1",
      messageId: "m1",
      buffer: records,
      offset: records.length,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.view.model).toBe("kimi-k2");
      expect(result.view.requestAt).toBe("2026-11-09T00:00:00.000Z");
      expect(result.view.tokens).toEqual({ input: 7, cacheRead: 3, total: 10 });
    }
  });

  test("projects Pi provider request roles into view parts", () => {
    const records = buffer([
      {
        type: "request",
        sessionId: "s1",
        api: "openai-responses",
        body: {
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          message_id: "m1",
        },
      },
      {
        type: "response",
        sessionId: "s1",
        body: {
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "world" }],
            },
          ],
        },
      },
    ]);
    const result = restoreContextView({
      runtime: "pi",
      sessionId: "s1",
      messageId: "m1",
      buffer: records,
      offset: records.length,
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.view.messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
  });

  test("projects Pi media and compaction placeholders without retaining payloads", () => {
    const records = buffer([
      {
        type: "request",
        sessionId: "s1",
        messageId: "m1",
        api: "openai-completions",
        body: {
          messages: [
            { role: "user", content: [{ type: "media_removed", mediaType: "image/png" }] },
            { role: "user", content: [{ type: "compaction", text: "summary" }] },
          ],
        },
      },
    ]);
    const result = restoreContextView({
      runtime: "pi",
      sessionId: "s1",
      messageId: "m1",
      buffer: records,
      offset: records.length,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result.view.messages);
      expect(serialized).toContain("media removed");
      expect(serialized).toContain("compaction");
      expect(serialized).not.toContain("image/png");
    }
  });

  test("projects OpenAI choices and Google text parts", () => {
    const openai = buffer([
      {
        type: "request",
        sessionId: "s1",
        api: "openai-completions",
        body: { messages: [{ role: "user", content: "hello" }], message_id: "m1" },
      },
      {
        type: "response",
        sessionId: "s1",
        body: { choices: [{ message: { role: "assistant", content: "world" } }] },
      },
    ]);
    const google = buffer([
      {
        type: "request",
        sessionId: "s1",
        api: "google-generative-ai",
        body: { contents: [{ role: "user", parts: [{ text: "hello" }] }], message_id: "m1" },
      },
      {
        type: "response",
        sessionId: "s1",
        body: { contents: [{ role: "model", parts: [{ text: "world" }] }] },
      },
    ]);
    const openaiResult = restoreContextView({
      runtime: "pi",
      sessionId: "s1",
      messageId: "m1",
      buffer: openai,
      offset: openai.length,
    });
    const googleResult = restoreContextView({
      runtime: "pi",
      sessionId: "s1",
      messageId: "m1",
      buffer: google,
      offset: google.length,
    });
    expect(openaiResult.ok).toBe(true);
    expect(googleResult.ok).toBe(true);
    if (openaiResult.ok) expect(JSON.stringify(openaiResult.view.messages)).toContain("world");
    if (googleResult.ok) {
      expect(JSON.stringify(googleResult.view.messages)).toContain("world");
      expect(googleResult.view.messages[0]?.role).toBe("user");
      expect(googleResult.view.messages[1]?.role).toBe("assistant");
    }
    const stream = buffer([
      {
        type: "request",
        sessionId: "s1",
        api: "openai-responses",
        body: { input: "hello", message_id: "m1" },
      },
      {
        type: "response",
        sessionId: "s1",
        body: {
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: "call-1", function: { name: "shell", arguments: '{"cmd":"pwd"}' } },
                ],
              },
            },
          ],
        },
      },
    ]);
    const streamResult = restoreContextView({
      runtime: "pi",
      sessionId: "s1",
      messageId: "m1",
      buffer: stream,
      offset: stream.length,
    });
    expect(streamResult.ok).toBe(true);
    if (streamResult.ok) expect(JSON.stringify(streamResult.view.messages)).toContain("tool_use");
  });

  test("Pi allows known API projections and refuses unknown APIs", () => {
    const supported = buffer([
      {
        type: "request",
        sessionId: "s1",
        api: "azure-openai-responses",
        body: { input: "hello", message_id: "m1" },
      },
      { type: "response", sessionId: "s1", body: "world" },
      { type: "response", sessionId: "s1", body: "late response" },
    ]);
    const restored = restoreContextView({
      runtime: "pi",
      sessionId: "s1",
      messageId: "m1",
      buffer: supported,
      offset: supported.length,
    });
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.view.messages).toHaveLength(2);

    const unsupported = buffer([
      { type: "request", sessionId: "s1", api: "unknown-api", body: { input: "hello" } },
    ]);
    expect(
      restoreContextView({
        runtime: "pi",
        sessionId: "s1",
        messageId: "m1",
        buffer: unsupported,
        offset: unsupported.length,
      }),
    ).toEqual({ ok: false, failure: "unsupported_runtime" });
  });
});
