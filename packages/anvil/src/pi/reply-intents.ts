import type { AgentRuntimeEvent } from "@coforge/agent";
import { asRecord, nonEmptyString } from "#src/json-record";
import type { PiSessionHost, PiReplyIntentScanner } from "./host";
import type { PiSessionEvent } from "./session-events";

/**
 * The Agent's own message send, found in a Pi session's streamed tool-call arguments. The SDK's
 * `toolcall_delta` carries a fragment of the call's JSON arguments and names the call only through
 * the message being built (`partial.content[contentIndex]`, a `ToolCall`), so the id and tool name
 * are read from there. A new turn forgets any call still in flight, and retracts the ones it had
 * announced.
 */
export class PiReplyIntents {
  readonly #scanner: PiReplyIntentScanner;

  constructor(private readonly host: PiSessionHost) {
    this.#scanner = host.createReplyIntentScanner();
  }

  read(event: PiSessionEvent): AgentRuntimeEvent[] {
    if (event.type === "turn_start")
      return this.#scanner.reset().map((id) => ({ type: "reply-intent-retracted", id }));
    if (event.type !== "message_update") return [];
    const message = event.assistantMessageEvent;
    if (message.type === "toolcall_end") {
      this.#scanner.complete(message.toolCall.id);
      return [];
    }
    if (message.type !== "toolcall_delta") return [];
    const call = asRecord(message.partial?.content?.[message.contentIndex]);
    const callId = nonEmptyString(call?.id);
    const toolName = nonEmptyString(call?.name);
    if (!callId || !toolName || !this.host.isShellToolName(toolName)) return [];
    const replyIntent = this.#scanner.feed({ callId, fragment: message.delta });
    return replyIntent ? [replyIntent] : [];
  }
}
