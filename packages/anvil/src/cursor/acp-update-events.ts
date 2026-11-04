import type { AgentRuntimeEvent } from "@coforge/agent";
import { acpToolOutput, acpToolUpdateEnded } from "#src/acp-tool-output";
import { asRecord, nonEmptyString } from "#src/json-record";
import type { CursorAcpRuntimeHost } from "./acp-host";

/** One turn's ACP `session/update` projection: text and thinking deltas pass through, tool calls
 * announce once and end once, shell tools feed reply-intent, and every call closes its ledger.
 * `session/load` replays the conversation with `user_message_chunk`s and agent chunks — those
 * arrive outside a live turn and never reach this reader. */
export class CursorAcpTurnEvents {
  readonly #started = new Set<string>();
  readonly #ended = new Set<string>();
  /** The output text already emitted per tool call: ACP resends the whole content each update. */
  readonly #output = new Map<string, string>();
  readonly #scanner;
  constructor(private readonly host: CursorAcpRuntimeHost) {
    this.#scanner = host.createReplyIntentScanner();
  }
  read(update: Readonly<Record<string, unknown>>): AgentRuntimeEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = asRecord(update.content);
        return content?.type === "text" && typeof content.text === "string"
          ? [
              {
                type:
                  update.sessionUpdate === "agent_message_chunk" ? "text-delta" : "thinking-delta",
                text: content.text,
              },
            ]
          : [];
      }
      case "tool_call": {
        const id = nonEmptyString(update.toolCallId);
        const name = nonEmptyString(update.title);
        if (!id || !name || this.#started.has(id)) return [];
        this.#started.add(id);
        const events: AgentRuntimeEvent[] = [
          { type: "tool-start", id, name, input: update.rawInput },
        ];
        if (this.host.isShellToolName(name) && update.rawInput !== undefined) {
          const intent = this.#scanner.feed({
            callId: id,
            fragment: JSON.stringify(update.rawInput),
          });
          if (intent) events.push(intent);
        }
        return events;
      }
      case "tool_call_update": {
        const id = nonEmptyString(update.toolCallId);
        if (!id || !this.#started.has(id) || this.#ended.has(id)) return [];
        const events: AgentRuntimeEvent[] = [];
        const output = acpToolOutput(this.#output.get(id) ?? "", update.content);
        if (output) {
          if (output.text) events.push({ type: "tool-output", id, text: output.text });
          this.#output.set(id, output.full);
        }
        if (acpToolUpdateEnded(update.status)) {
          this.#ended.add(id);
          this.#output.delete(id);
          this.#scanner.complete(id);
          events.push({ type: "tool-end", id, isError: update.status !== "completed" });
        }
        return events.length ? events : [{ type: "progress", source: "cursor_tool_call_update" }];
      }
      default:
        return [];
    }
  }
  end(): AgentRuntimeEvent[] {
    return this.#scanner.reset().map((id) => ({ type: "reply-intent-retracted", id }));
  }
}
