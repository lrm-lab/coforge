import type { ActivitySubagent } from "@lrm/coforge-sdk/internal";
import {
  isHttpErrorStatus,
  type AgentRuntimeEvent,
  asRecord,
  eventTime,
  nonEmptyString,
  textContent,
} from "@lrm/coforge-anvil";

/**
 * What one Claude Code `assistant` record reports, block by block in order: a completed `thinking`
 * or `text` block's whole text (once; its partial deltas carry none, see `stream-events.ts`), and
 * for tool calls the id of every `tool_use` block (the calls the turn now waits on) with a
 * `tool-start` for each one that also names its tool. Empty and redacted blocks show nothing.
 * A subagent's block carries its `subagent` lineage. Which ids count as outstanding (top-level
 * only) stays with the session.
 *
 * A text block that reports a failed API request is an `error`, not model text: Claude Code
 * writes such a failure as a synthetic assistant message, flagging a main-session one without
 * tool calls with the record's `error` category (kept as `providerErrorCode`), and any record's
 * text that starts with `API Error:` and names an HTTP status, a connection failure, or a
 * timeout reads as one too. The turn's failed `result` then ends the turn without a second
 * report (the daemon core shows one reason per failed turn).
 */
export function claudeAssistantEvents(
  record: Readonly<Record<string, unknown>>,
  lineage?: ActivitySubagent,
): {
  ids: string[];
  events: AgentRuntimeEvent[];
} {
  const ids: string[] = [];
  const events: AgentRuntimeEvent[] = [];
  const subagent = lineage ? { subagent: lineage } : {};
  const content = messageContent(record);
  const callsTools = content.some((block) => block?.type === "tool_use");
  // A subagent's record names its parent tool call or its subagent type.
  const mainSession =
    nonEmptyString(record.parent_tool_use_id) === undefined &&
    nonEmptyString(record.subagent_type) === undefined;
  const apiError =
    !callsTools && mainSession && typeof record.error === "string" && record.error
      ? record.error
      : undefined;
  for (const block of content) {
    if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      events.push({ type: "thinking-delta", text: block.thinking, ...subagent });
      continue;
    }
    if (block?.type === "text" && typeof block.text === "string" && block.text) {
      if (apiError || (!callsTools && readsAsApiFailure(block.text)))
        events.push({
          type: "error",
          message: block.text,
          ...(isHttpErrorStatus(record.api_error_status)
            ? { httpStatus: record.api_error_status }
            : {}),
          ...(apiError ? { providerErrorCode: apiError } : {}),
          occurredAt: eventTime(record),
        });
      else events.push({ type: "text-delta", text: block.text, ...subagent });
      continue;
    }
    if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
    ids.push(block.id);
    if (typeof block.name !== "string") continue;
    events.push({
      type: "tool-start",
      id: block.id,
      name: block.name,
      input: block.input,
      occurredAt: eventTime(record),
      ...subagent,
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
    const isError = block.is_error === true;
    events.push({
      type: "tool-end",
      id: block.tool_use_id,
      isError,
      exitCode: isError ? bashExitCode(text) : undefined,
    });
  }
  return { ids, events };
}

/** Claude Code's Bash tool reports a non-zero exit as an error result whose text starts
 * `Exit code N`. That is a text convention, not a structured field; the reference client 1.0.50
 * reads it the same way (`claudeToolResultOutcome`). */
function bashExitCode(text: string): number | undefined {
  const match = /^Exit code (\d+)\b/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** Claude Code's own wording for a failed API request (https://code.claude.com/docs/en/errors). */
const API_FAILURE_PREFIX = /^\s*API Error:/i;
const API_FAILURE_CAUSES = [
  /\b[45]\d{2}\b/,
  /\b(?:ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/i,
  /\bUnable to connect to API\b/i,
  /\b(?:timed out|timeout)\b/i,
];

function readsAsApiFailure(text: string): boolean {
  return API_FAILURE_PREFIX.test(text) && API_FAILURE_CAUSES.some((cause) => cause.test(text));
}

function messageContent(
  record: Readonly<Record<string, unknown>>,
): Array<Record<string, unknown> | undefined> {
  const content = asRecord(record.message)?.content;
  return Array.isArray(content) ? content.map(asRecord) : [];
}
