import type { AgentRuntimeEvent } from "#src/code-agent/contract";
import { asRecord, eventTime } from "#src/code-agent/json-record";

/**
 * The runtime events one Claude Code `stream_event` record reports: a text or thinking delta,
 * or, for a top-level event with no renderable text, a progress signal that the turn is live.
 * Turn-state transitions (`message_start` starting a turn) stay with the session.
 */
export function claudeStreamEvents(record: Readonly<Record<string, unknown>>): AgentRuntimeEvent[] {
  const events: AgentRuntimeEvent[] = [];
  const event = asRecord(record.event);
  const delta = asRecord(event?.delta);
  const subagent =
    typeof record.parent_tool_use_id === "string"
      ? { parentToolUseId: record.parent_tool_use_id }
      : undefined;
  let renderedText = false;
  if (
    event?.type === "content_block_delta" &&
    delta?.type === "text_delta" &&
    typeof delta.text === "string"
  ) {
    renderedText = true;
    events.push({
      type: "text-delta",
      text: delta.text,
      ...(subagent ? { subagent } : {}),
    });
  }
  if (
    event?.type === "content_block_delta" &&
    delta?.type === "thinking_delta" &&
    typeof delta.thinking === "string"
  ) {
    renderedText = true;
    events.push({
      type: "thinking-delta",
      text: delta.thinking,
      ...(subagent ? { subagent } : {}),
    });
  }
  // A partial stream event with no renderable text (message/content block
  // start-stop, an input_json_delta, ...) still shows the turn is live.
  if (!renderedText && typeof event?.type === "string" && record.parent_tool_use_id == null) {
    events.push({
      type: "progress",
      source: "claude_stream_event",
      occurredAt: eventTime(record),
    });
  }
  return events;
}
