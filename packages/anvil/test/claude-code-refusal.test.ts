import { expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { controlledClaude } from "./fixtures/claude-feed";

test.each(["assistant", "stream", "result", "all three records"])(
  "Claude Code reports refusal from %s once and accepts the next turn",
  async (source) => {
    const { session, emit, dispose } = await controlledClaude();
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => {
      if (event.type === "error" || event.type === "completed") events.push(event);
    });
    const assistant = { type: "assistant", message: { stop_reason: "refusal", content: [] } };
    const stream = {
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "refusal" } },
    };
    const result = { type: "result", subtype: "success", is_error: false };
    try {
      await session.sendMessage("first");
      if (source === "stream" || source === "all three records") await emit(stream);
      if (source === "assistant" || source === "all three records") await emit(assistant);
      await emit(
        source === "result" || source === "all three records"
          ? { ...result, stop_reason: "refusal" }
          : result,
      );
      await session.sendMessage("next");
      await emit(
        { ...assistant, parent_tool_use_id: "child" },
        { ...assistant, subagent_type: "Explore" },
        { ...stream, parent_tool_use_id: "child" },
        { ...result, stop_reason: "refusal", parent_tool_use_id: "child" },
        { type: "result", subtype: "success" },
      );
      expect(events).toEqual([
        {
          type: "error",
          message: "The model declined to respond to this request (refusal).",
          providerErrorReason: "model_refusal",
          occurredAt: expect.any(String),
        },
        { type: "completed", status: "failed" },
        { type: "completed", status: "completed" },
      ]);
    } finally {
      await dispose();
    }
  },
);

test("Claude Code suppresses the refusal API wrapper and preserves assistant text", async () => {
  const { session, emit, dispose } = await controlledClaude();
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => {
    if (
      event.type === "error" ||
      event.type === "completed" ||
      (event.type === "text-delta" && event.text !== "fixture-input-observed")
    )
      events.push(event);
  });
  try {
    await session.sendMessage("first");
    await emit(
      {
        type: "assistant",
        error: "overloaded",
        message: {
          stop_reason: "refusal",
          content: [{ type: "text", text: "API Error: 529 Overloaded" }],
        },
      },
      {
        type: "assistant",
        is_api_error_message: true,
        message: {
          stop_reason: "refusal",
          content: [{ type: "text", text: "Request declined by model policy." }],
        },
      },
      {
        type: "assistant",
        message: {
          stop_reason: "refusal",
          content: [{ type: "text", text: "The part I can answer." }],
        },
      },
      { type: "result", subtype: "success", stop_reason: "refusal" },
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "error", providerErrorReason: "model_refusal" }),
      { type: "text-delta", text: "The part I can answer." },
      { type: "completed", status: "failed" },
    ]);
  } finally {
    await dispose();
  }
});
