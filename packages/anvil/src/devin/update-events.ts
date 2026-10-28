import type { AgentRuntimeEvent } from "@coforge/agent";
import { asRecord, nonEmptyString } from "#src/json-record";
import type { DevinRuntimeHost } from "./host";

/**
 * ACP tool calls carry a standard `kind` and a human title. The Activity name comes from the kind
 * where it exists (`read` → `read_file`, `edit` → `edit_file`, `search` → `grep`, `fetch` →
 * `web_fetch`); an execute call with a string `command` is `shell_command`, so reply intent still
 * sees the shell. A title shaped `Label: <argument>` keeps the label only; a bare title stays.
 */
const TOOL_KIND_NAMES: Readonly<Record<string, string>> = {
  read: "read_file",
  edit: "edit_file",
  search: "grep",
  fetch: "web_fetch",
};

function toolActivityName(kind: unknown, title: string): string {
  if (typeof kind === "string") {
    const mapped = TOOL_KIND_NAMES[kind];
    if (mapped) return mapped;
  }
  const colon = title.indexOf(":");
  if (colon === -1) return title;
  const label = title.slice(0, colon).trim();
  return label || "tool";
}

export class DevinTurnEvents {
  readonly #started = new Set<string>();
  readonly #ended = new Set<string>();
  readonly #scanner;
  constructor(private readonly host: DevinRuntimeHost) {
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
        const title = nonEmptyString(update.title);
        if (!id || !title || this.#started.has(id)) return [];
        this.#started.add(id);
        const command = asRecord(update.rawInput)?.command;
        const executeShell = update.kind === "execute" && typeof command === "string";
        const name = executeShell ? "shell_command" : toolActivityName(update.kind, title);
        const events: AgentRuntimeEvent[] = [
          { type: "tool-start", id, name, input: update.rawInput },
        ];
        if ((executeShell || this.host.isShellToolName(name)) && update.rawInput !== undefined) {
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
        if (Array.isArray(update.content))
          for (const value of update.content) {
            const item = asRecord(value);
            const content = asRecord(item?.content);
            if (
              item?.type === "content" &&
              content?.type === "text" &&
              typeof content.text === "string"
            )
              events.push({ type: "tool-output", id, text: content.text });
          }
        if (update.status === "completed" || update.status === "failed") {
          this.#ended.add(id);
          this.#scanner.complete(id);
          events.push({ type: "tool-end", id, isError: update.status === "failed" });
        }
        return events.length ? events : [{ type: "progress", source: "devin_tool_call_update" }];
      }
      default:
        return [];
    }
  }
  end(): AgentRuntimeEvent[] {
    return this.#scanner.reset().map((id) => ({ type: "reply-intent-retracted", id }));
  }
}
