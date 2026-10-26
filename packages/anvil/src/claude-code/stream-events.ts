import type { ClaudeTurnHost, ClaudeReplyIntentScanner } from "./host";
import { type AgentRuntimeEvent } from "#src/contract";
import { asRecord, eventTime, nonEmptyString } from "#src/json-record";

/**
 * The runtime events one Claude Code `stream_event` record (`--include-partial-messages`)
 * reports. Text and thinking reach Activity once per completed content block, from the
 * `assistant` record Claude Code emits for that block (`message-events.ts`), so a partial
 * delta never carries text here: it only shows the turn is live. A text or thinking
 * `content_block_start` opens its run with an empty delta, so the trajectory announces
 * thinking or a model response at once rather than when the block completes.
 * Turn-state transitions (`message_start` starting a turn) stay with the session.
 * Stream events are main-session only; a record naming a parent tool call reports nothing.
 */
export function claudeStreamEvents(record: Readonly<Record<string, unknown>>): AgentRuntimeEvent[] {
  const event = asRecord(record.event);
  if (typeof event?.type !== "string" || record.parent_tool_use_id != null) return [];
  if (event.type === "content_block_start") {
    const blockType = asRecord(event.content_block)?.type;
    if (blockType === "text") return [{ type: "text-delta", text: "" }];
    if (blockType === "thinking") return [{ type: "thinking-delta", text: "" }];
  }
  return [{ type: "progress", source: "claude_stream_event", occurredAt: eventTime(record) }];
}

/**
 * One session's `stream_event` records: what `claudeStreamEvents` reports, plus the target of the
 * Agent's own message send as soon as a shell `tool_use` block's argument fragments
 * (`input_json_delta`) close it. A fragment names its block by `index` alone, so the block's start
 * (`content_block_start`: the call's id) is remembered until the block stops or the next message
 * starts; a call announced and still open then was abandoned, which is reported.
 */
export class ClaudeStreamEvents {
  readonly #scanner: ClaudeReplyIntentScanner;
  /** The shell tool_use blocks of the current message, by block index, to their call ids. */
  readonly #blocks = new Map<number, string>();

  constructor(private readonly host: ClaudeTurnHost) {
    this.#scanner = host.createReplyIntentScanner();
  }

  read(record: Readonly<Record<string, unknown>>): AgentRuntimeEvent[] {
    const events = claudeStreamEvents(record);
    // Stream events are main-session only (`claudeStreamEvents`), like the Agent's own sends.
    const event = events.length > 0 ? asRecord(record.event) : undefined;
    const index = event?.index;
    if (event?.type === "message_start") {
      this.#blocks.clear();
      for (const id of this.#scanner.reset()) events.push({ type: "reply-intent-retracted", id });
    } else if (typeof index !== "number") {
      return events;
    } else if (event?.type === "content_block_start") {
      const block = asRecord(event.content_block);
      const id = nonEmptyString(block?.id);
      const name = nonEmptyString(block?.name);
      if (block?.type === "tool_use" && id && name && this.host.isShellToolName(name))
        this.#blocks.set(index, id);
    } else if (event?.type === "content_block_stop") {
      const callId = this.#blocks.get(index);
      if (callId) this.#scanner.complete(callId);
      this.#blocks.delete(index);
    } else if (event?.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      const callId = this.#blocks.get(index);
      if (callId && delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const replyIntent = this.#scanner.feed({ callId, fragment: delta.partial_json });
        if (replyIntent) events.push(replyIntent);
      }
    }
    return events;
  }
}
