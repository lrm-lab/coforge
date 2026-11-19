import type { AgentRuntimeEvent } from "@coforge/agent";
import { acpContextUsage } from "#src/acp-context-usage";
import { acpToolOutput, acpToolUpdateEnded } from "#src/acp-tool-output";
import { asRecord, nonEmptyString } from "#src/json-record";
import type { AntigravityAcpRuntimeHost } from "./acp-host";

function antigravityToolCall(update: Readonly<Record<string, unknown>>) {
  const name = nonEmptyString(update.name) ?? nonEmptyString(update.title);
  if (!name) return undefined;
  const rawInput = asRecord(update.rawInput);
  const { CommandLine: command, Path: path } = rawInput ?? {};
  const input = {
    ...rawInput,
    ...(typeof command === "string" ? { command } : {}),
    ...(typeof path === "string" ? { file_path: path } : {}),
  };
  return { name, input: rawInput ? input : update.rawInput };
}

const IN_BAND_ERROR = /^\s*⚠\s*(\S[^\n]*\(code \d{3}\):[^\n]*)\s*$/;

export class AntigravityAcpTurnEvents {
  #message = "";
  readonly #started = new Set<string>();
  readonly #ended = new Set<string>();
  readonly #output = new Map<string, string>();
  readonly #scanner;
  constructor(private readonly host: AntigravityAcpRuntimeHost) {
    this.#scanner = host.createReplyIntentScanner();
  }
  read(update: Readonly<Record<string, unknown>>): AgentRuntimeEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = asRecord(update.content);
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          content?.type === "text" &&
          typeof content.text === "string"
        )
          this.#message += content.text;
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
        const call = antigravityToolCall(update);
        if (!id || !call || this.#started.has(id)) return [];
        this.#started.add(id);
        const events: AgentRuntimeEvent[] = [
          { type: "tool-start", id, name: call.name, input: call.input },
        ];
        if (this.host.isShellToolName(call.name) && call.input !== undefined) {
          const intent = this.#scanner.feed({ callId: id, fragment: JSON.stringify(call.input) });
          if (intent) events.push(intent);
        }
        if (acpToolUpdateEnded(update.status)) events.push(...this.#progress(id, update));
        return events;
      }
      case "tool_call_update": {
        const id = nonEmptyString(update.toolCallId);
        if (!id || !this.#started.has(id) || this.#ended.has(id)) return [];
        const events = this.#progress(id, update);
        return events.length
          ? events
          : [{ type: "progress", source: "antigravity_tool_call_update" }];
      }
      case "usage_update":
        return acpContextUsage(update);
      case "compaction_update":
        if (update.status === "in_progress") return [{ type: "compaction-started" }];
        if (update.status === "completed") return [{ type: "compaction-finished" }];
        if (update.status === "failed" || update.status === "cancelled")
          return [{ type: "compaction-interrupted" }];
        return [];
      default:
        return [];
    }
  }
  #progress(id: string, update: Readonly<Record<string, unknown>>): AgentRuntimeEvent[] {
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
    return events;
  }
  inBandFailure(answer: Readonly<Record<string, unknown>>): string | undefined {
    if (answer.usage !== undefined) return undefined;
    return IN_BAND_ERROR.exec(this.#message)?.[1]?.trim();
  }
  end(): AgentRuntimeEvent[] {
    return this.#scanner.reset().map((id) => ({ type: "reply-intent-retracted", id }));
  }
}
