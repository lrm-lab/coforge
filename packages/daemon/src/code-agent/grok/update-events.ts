import type { AgentRuntimeEvent } from "@coforge/agent";
import { asRecord, nonEmptyString } from "#src/code-agent/json-record";
import {
  grokToolEnded,
  grokToolExitCode,
  grokToolFailed,
  grokToolInput,
  grokToolOutputText,
} from "./tool-call";
import { ReplyIntentScanner } from "#src/code-agent/reply-intent-scanner";
import { isShellToolName } from "#src/code-agent/send-command-target";

/** Display state belongs to a native turn, including turns started by background work. */
export class GrokTurnEvents {
  readonly #started = new Set<string>();
  readonly #ended = new Set<string>();
  #compacting = false;
  readonly #scanner = new ReplyIntentScanner();
  readonly #deltaCalls = new Map<number, string>();
  readonly #shellCalls = new Set<string>();

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
      case "tool_call_delta_chunk": {
        const index = update.tool_index;
        const callId =
          nonEmptyString(update.tool_call_id) ??
          (typeof index === "number" ? this.#deltaCalls.get(index) : undefined);
        const name = nonEmptyString(update.name);
        if (callId && name) {
          if (!isShellToolName(name)) return [];
          this.#shellCalls.add(callId);
          if (typeof index === "number") this.#deltaCalls.set(index, callId);
        }
        const fragment =
          typeof update.arguments_delta === "string" ? update.arguments_delta : undefined;
        if (!callId || !fragment || !this.#shellCalls.has(callId)) return [];
        const intent = this.#scanner.feed({ callId, fragment });
        return intent ? [intent] : [];
      }
      case "tool_call_update": {
        const id = nonEmptyString(update.toolCallId);
        if (!id || !this.#started.has(id) || this.#ended.has(id)) return [];
        if (!grokToolEnded(update.status))
          return [{ type: "progress", source: "grok_tool_call_update" }];
        this.#ended.add(id);
        for (const [index, callId] of this.#deltaCalls)
          if (callId === id) this.#deltaCalls.delete(index);
        this.#scanner.complete(id);
        this.#shellCalls.delete(id);
        const text = grokToolOutputText(update.content);
        return [
          ...(text ? [{ type: "tool-output" as const, id, text }] : []),
          {
            type: "tool-end",
            id,
            isError: grokToolFailed(update.status, update.rawOutput),
            exitCode: grokToolExitCode(update.rawOutput),
          },
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
    const retracted = this.#scanner
      .reset()
      .map((id) => ({ type: "reply-intent-retracted" as const, id }));
    this.#deltaCalls.clear();
    this.#shellCalls.clear();
    if (!this.#compacting) return retracted;
    this.#compacting = false;
    return [...retracted, { type: "compaction-interrupted" }];
  }
}
