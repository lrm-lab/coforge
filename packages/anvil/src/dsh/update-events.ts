import type { AgentRuntimeEvent } from "@coforge/agent";
import { acpToolOutput } from "#src/acp-tool-output";
import { asRecord, nonEmptyString } from "#src/json-record";
import type { DshRuntimeHost } from "./host";

/** DSH 0.2.1-rc.2 uses native tool names as ACP titles and sends complete tool arguments. */
export class DshTurnEvents {
  readonly #started = new Set<string>();
  readonly #ended = new Set<string>();
  /** The output text already emitted per tool call: ACP resends the whole content each update. */
  readonly #output = new Map<string, string>();
  readonly #scanner;
  constructor(private readonly host: DshRuntimeHost) {
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
        if (update.status === "completed" || update.status === "failed") {
          this.#ended.add(id);
          this.#output.delete(id);
          this.#scanner.complete(id);
          events.push({ type: "tool-end", id, isError: update.status === "failed" });
        }
        return events.length ? events : [{ type: "progress", source: "dsh_tool_call_update" }];
      }
      default:
        return [];
    }
  }
  end(): AgentRuntimeEvent[] {
    return this.#scanner.reset().map((id) => ({ type: "reply-intent-retracted", id }));
  }
}
