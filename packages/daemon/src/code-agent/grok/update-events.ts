import type { AgentRuntimeEvent } from "@coforge/agent";
import { asRecord, nonEmptyString } from "#src/code-agent/json-record";
import { grokToolFailed, grokToolInput, grokToolOutputText } from "./tool-call";

/** Display state belongs to a native turn, including turns started by background work. */
export class GrokTurnEvents {
  readonly #started = new Set<string>();
  readonly #ended = new Set<string>();
  #compacting = false;

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
        if (!id || this.#started.has(id)) return [];
        this.#started.add(id);
        const meta = asRecord(asRecord(update._meta)?.["x.ai/tool"]);
        const name = nonEmptyString(meta?.name) ?? nonEmptyString(update.title) ?? "unknown_tool";
        return [{ type: "tool-start", id, name, input: grokToolInput(name, update.rawInput) }];
      }
      case "tool_call_update": {
        const id = nonEmptyString(update.toolCallId);
        if (!id || !this.#started.has(id) || this.#ended.has(id)) return [];
        if (update.status !== "completed" && update.status !== "failed")
          return [{ type: "progress", source: "grok_tool_call_update" }];
        this.#ended.add(id);
        const text = grokToolOutputText(update.content);
        return [
          ...(text ? [{ type: "tool-output" as const, id, text }] : []),
          { type: "tool-end", id, isError: grokToolFailed(update.status, update.rawOutput) },
        ];
      }
      case "auto_compact_started":
        this.#compacting = true;
        return [{ type: "compaction-started" }];
      case "auto_compact_completed":
        this.#compacting = false;
        return [{ type: "compaction-finished" }];
      case "auto_compact_cancelled":
        return this.end();
      case "auto_compact_failed":
        this.#compacting = false;
        return [
          { type: "compaction-interrupted" },
          {
            type: "error",
            message: nonEmptyString(update.error) ?? "Grok compaction failed",
            providerErrorReason: "auto_compact_failed",
          },
        ];
      default:
        return [];
    }
  }

  end(): AgentRuntimeEvent[] {
    if (!this.#compacting) return [];
    this.#compacting = false;
    return [{ type: "compaction-interrupted" }];
  }
}
