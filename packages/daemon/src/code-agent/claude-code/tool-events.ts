import type { AgentRuntimeEvent } from "#src/code-agent/contract";
import { asRecord, eventTime, textContent } from "#src/code-agent/json-record";

/**
 * What one Claude Code `assistant` record says about tool calls: the id of every `tool_use` block
 * (the calls the turn now waits on) and a `tool-start` for each one that also names its tool. A
 * subagent's call carries its parent tool call. Which ids count as outstanding (top-level only)
 * stays with the session.
 */
export function claudeToolUses(record: Readonly<Record<string, unknown>>): {
  ids: string[];
  events: AgentRuntimeEvent[];
} {
  const ids: string[] = [];
  const events: AgentRuntimeEvent[] = [];
  for (const block of messageContent(record)) {
    if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
    ids.push(block.id);
    if (typeof block.name !== "string") continue;
    events.push({
      type: "tool-start",
      id: block.id,
      name: block.name,
      input: block.input,
      occurredAt: eventTime(record),
      ...(typeof record.parent_tool_use_id === "string"
        ? { subagent: { parentToolUseId: record.parent_tool_use_id } }
        : {}),
    });
  }
  return { ids, events };
}

/**
 * What one Claude Code `user` record says about tool calls: the `tool_use_id` of every
 * `tool_result` block, and for each one its text output (when it has any) followed by its
 * `tool-end`.
 */
export function claudeToolResults(record: Readonly<Record<string, unknown>>): {
  ids: string[];
  events: AgentRuntimeEvent[];
} {
  const ids: string[] = [];
  const events: AgentRuntimeEvent[] = [];
  for (const block of messageContent(record)) {
    if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    ids.push(block.tool_use_id);
    const text = textContent(block.content);
    if (text) events.push({ type: "tool-output", id: block.tool_use_id, text });
    events.push({ type: "tool-end", id: block.tool_use_id, isError: block.is_error === true });
  }
  return { ids, events };
}

function messageContent(
  record: Readonly<Record<string, unknown>>,
): Array<Record<string, unknown> | undefined> {
  const content = asRecord(record.message)?.content;
  return Array.isArray(content) ? content.map(asRecord) : [];
}
