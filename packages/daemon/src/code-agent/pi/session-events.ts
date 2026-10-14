import type { AgentRuntimeEvent, createSession } from "@coforge/agent";
import { textContent } from "#src/code-agent/json-record";

type PiSession = Awaited<ReturnType<typeof createSession>>["session"];
/** One event the Pi SDK session reports to its subscribers. */
export type PiSessionEvent = Parameters<Parameters<PiSession["subscribe"]>[0]>[0];

/** Assistant stream events that carry no renderable text yet still show the turn is live. */
const CONTENT_FREE_MESSAGE_EVENTS = new Set([
  "start",
  "text_start",
  "thinking_start",
  "toolcall_start",
  "toolcall_delta",
]);

/**
 * The runtime events one Pi session event reports on its own: text and thinking deltas, tools,
 * compaction transitions, and content-free progress. The events that drive the run's outcome
 * (`agent_start` after cancellation, an assistant `message_end`, `agent_settled`) report nothing
 * here and stay with the session.
 */
export function piSessionEvents(event: PiSessionEvent): AgentRuntimeEvent[] {
  switch (event.type) {
    case "message_update": {
      const message = event.assistantMessageEvent;
      if (message.type === "text_delta") return [{ type: "text-delta", text: message.delta }];
      if (message.type === "thinking_delta")
        return [{ type: "thinking-delta", text: message.delta }];
      return CONTENT_FREE_MESSAGE_EVENTS.has(message.type)
        ? [{ type: "progress", source: "pi_message_event" }]
        : [];
    }
    // Content-free lifecycle frames (a new turn or message beginning) still show the turn is live.
    case "turn_start":
    case "message_start":
      return [{ type: "progress", source: "pi_turn_lifecycle" }];
    case "compaction_start":
      return [{ type: "compaction-started" }];
    case "compaction_end":
      return [event.aborted ? { type: "compaction-interrupted" } : { type: "compaction-finished" }];
    case "tool_execution_start":
      return [
        { type: "tool-start", id: event.toolCallId, name: event.toolName, input: event.args },
      ];
    case "tool_execution_update": {
      const text = textContent(event.partialResult.content);
      return text ? [{ type: "tool-output", id: event.toolCallId, text }] : [];
    }
    case "tool_execution_end":
      return [{ type: "tool-end", id: event.toolCallId, isError: event.isError }];
    default:
      return [];
  }
}
