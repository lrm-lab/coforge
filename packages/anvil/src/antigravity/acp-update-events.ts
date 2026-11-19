import type { AgentRuntimeEvent } from "@coforge/agent";
import { acpContextUsage } from "#src/acp-context-usage";
import { acpToolOutput, acpToolUpdateEnded } from "#src/acp-tool-output";
import { asRecord, nonEmptyString } from "#src/json-record";
import type { AntigravityAcpRuntimeHost } from "./acp-host";
import { parseAntigravityInBandQuota } from "./quota";

function antigravityToolInput(raw: unknown) {
  const rawInput = asRecord(raw);
  if (!rawInput) return raw;
  const { CommandLine: command, Path: path } = rawInput;
  return {
    ...rawInput,
    ...(typeof command === "string" ? { command } : {}),
    ...(typeof path === "string" ? { file_path: path } : {}),
  };
}

function antigravityToolCall(update: Readonly<Record<string, unknown>>) {
  const name = nonEmptyString(update.name) ?? nonEmptyString(update.title);
  if (!name) return undefined;
  return { name, input: antigravityToolInput(update.rawInput) };
}

function hasToolInput(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "string") return raw.length > 0;
  const record = asRecord(raw);
  return record ? Object.keys(record).length > 0 : true;
}

function rawOutputText(rawOutput: unknown): string | undefined {
  if (typeof rawOutput === "string") return rawOutput.length > 0 ? rawOutput : undefined;
  const record = asRecord(rawOutput);
  if (typeof record?.output === "string" && record.output.length > 0) return record.output;
  return undefined;
}

const IN_BAND_ERROR = /^\s*⚠\s*(\S[^\n]*\(code \d{3}\):[^\n]*)\s*$/;

export class AntigravityAcpTurnEvents {
  #message = "";
  #hadTurnActivity = false;
  readonly #started = new Set<string>();
  readonly #ended = new Set<string>();
  readonly #shellCalls = new Set<string>();
  readonly #scannedShellCalls = new Set<string>();
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
        if (update.sessionUpdate === "agent_thought_chunk") this.#hadTurnActivity = true;
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
        this.#hadTurnActivity = true;
        const id = nonEmptyString(update.toolCallId);
        const call = antigravityToolCall(update);
        if (!id || !call || this.#started.has(id)) return [];
        this.#started.add(id);
        const events: AgentRuntimeEvent[] = [
          { type: "tool-start", id, name: call.name, input: call.input },
        ];
        if (this.host.isShellToolName(call.name)) {
          this.#shellCalls.add(id);
          if (hasToolInput(call.input)) {
            this.#scannedShellCalls.add(id);
            const intent = this.#scanner.feed({ callId: id, fragment: JSON.stringify(call.input) });
            if (intent) events.push(intent);
          }
        }
        if (acpToolUpdateEnded(update.status)) events.push(...this.#progress(id, update));
        return events;
      }
      case "tool_call_update": {
        this.#hadTurnActivity = true;
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
    if (
      this.#shellCalls.has(id) &&
      !this.#scannedShellCalls.has(id) &&
      hasToolInput(update.rawInput)
    ) {
      this.#scannedShellCalls.add(id);
      const input = antigravityToolInput(update.rawInput);
      const intent = this.#scanner.feed({ callId: id, fragment: JSON.stringify(input) });
      if (intent) events.push(intent);
    }
    const output = acpToolOutput(this.#output.get(id) ?? "", update.content);
    if (output) {
      if (output.text) events.push({ type: "tool-output", id, text: output.text });
      this.#output.set(id, output.full);
    }
    if (acpToolUpdateEnded(update.status)) {
      if (!this.#output.get(id)?.length) {
        const fallback = rawOutputText(update.rawOutput);
        if (fallback) events.push({ type: "tool-output", id, text: fallback });
      }
      this.#ended.add(id);
      this.#output.delete(id);
      this.#shellCalls.delete(id);
      this.#scannedShellCalls.delete(id);
      this.#scanner.complete(id);
      events.push({ type: "tool-end", id, isError: update.status !== "completed" });
    }
    return events;
  }
  inBandFailure(
    answer: Readonly<Record<string, unknown>>,
  ): string | Extract<AgentRuntimeEvent, { type: "error" }> | undefined {
    if (answer.usage !== undefined) return undefined;
    const errorLine = IN_BAND_ERROR.exec(this.#message)?.[1]?.trim();
    if (errorLine) return errorLine;
    if (this.#hadTurnActivity) return undefined;
    return parseAntigravityInBandQuota(this.#message);
  }
  end(): AgentRuntimeEvent[] {
    return this.#scanner.reset().map((id) => ({ type: "reply-intent-retracted", id }));
  }
}
