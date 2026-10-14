import type { AgentRuntimeEvent } from "@coforge/agent";
import type { SessionNotification, ToolKind } from "@agentclientprotocol/sdk";

// Kiro's tool_call frames never carry a programmatic name (only a
// human-readable title, e.g. "Run Command", "Read File"), so the ACP `kind`
// field is the only stable source for the canonical tool name. Kinds with no
// canonical CoForge tool fall back to the title.
const TOOL_KIND_NAMES: Readonly<Partial<Record<ToolKind, string>>> = {
  execute: "bash",
  read: "read_file",
  edit: "edit_file",
  search: "grep",
  fetch: "web_fetch",
};

/**
 * The runtime events one Kiro `session/update` reports on its own: message and thought text,
 * tool starts, output and ends, compaction transitions, and content-free progress. The updates
 * that touch session state (`session_info_update`: message ids, steering outcomes, errors) report
 * nothing here and stay with the session.
 */
export function kiroUpdateEvents(update: SessionNotification["update"]): AgentRuntimeEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      if (update.content.type !== "text") return [];
      return [
        {
          type: update.sessionUpdate === "agent_message_chunk" ? "text-delta" : "thinking-delta",
          text: update.content.text,
        },
      ];
    case "tool_call":
      return [
        {
          type: "tool-start",
          id: update.toolCallId,
          name: (update.kind && TOOL_KIND_NAMES[update.kind]) || update.title,
          input: update.rawInput,
        },
      ];
    case "tool_call_update": {
      const events: AgentRuntimeEvent[] = [];
      for (const item of update.content ?? []) {
        if (item.type === "content" && item.content.type === "text" && item.content.text)
          events.push({ type: "tool-output", id: update.toolCallId, text: item.content.text });
      }
      if (update.status === "completed" || update.status === "failed")
        events.push({
          type: "tool-end",
          id: update.toolCallId,
          isError: update.status === "failed",
        });
      // A still-running tool with no new content this notification: content-free liveness.
      if (update.status === "in_progress" && !update.content?.length)
        events.push({ type: "progress", source: "kiro_tool_call_update" });
      return events;
    }
    case "compaction_update":
      // Report the raw CompactionUpdate.status transition every time; the daemon core de-dupes
      // repeated "in_progress" updates into a single reported episode
      // (agent-runtime/compaction-tracker.ts). "failed"/"cancelled" are a provider-observed
      // interruption, distinct from a normal "completed" finish.
      if (update.status === "in_progress") return [{ type: "compaction-started" }];
      if (update.status === "completed") return [{ type: "compaction-finished" }];
      if (update.status === "failed" || update.status === "cancelled")
        return [{ type: "compaction-interrupted" }];
      return [];
    case "plan":
    case "plan_update":
      // Task-plan bookkeeping carries no message content; still shows the turn is live.
      return [{ type: "progress", source: "kiro_plan_update" }];
    case "usage_update":
      return [{ type: "progress", source: "kiro_usage_update" }];
    default:
      return [];
  }
}
