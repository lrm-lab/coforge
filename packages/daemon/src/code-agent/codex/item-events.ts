import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import {
  asRecord,
  eventTime,
  integerField,
  nonEmptyString,
  type JsonRecord,
} from "#src/code-agent/json-record";

/**
 * Maps one Codex app-server thread's turn, item and delta notifications to normalized runtime
 * events, after the session has already dropped the ones for another thread or turn. The mapping
 * follows the reference Computer 1.0.50. Per-turn bookkeeping is kept here, so the session calls
 * `reset` when its turn ends.
 */
export class CodexItemEvents {
  /** Agent message and reasoning items that streamed deltas, so their completion repeats none. */
  readonly #streamed = new Set<string>();
  /** Each agent message's answer kind (Codex's `MessagePhase`) from its start: deltas do not
   * carry one in the official schema. */
  readonly #answerKinds = new Map<string, unknown>();
  /** The files each file change reported at its start, so its completion ends those same tool
   * calls: `item/fileChange/patchUpdated` can replace the change list in between. */
  readonly #fileChangeCounts = new Map<string, number>();

  /**
   * Agent message text, a readable reasoning summary, or, for raw reasoning text, a content-free
   * progress signal (the raw reasoning itself is never shown, but a busy Agent stays visibly busy).
   * A message that is not a final answer (commentary, a partial answer) is progress only.
   * `undefined` when the record is not a delta.
   */
  delta(record: JsonRecord, params: JsonRecord | undefined): AgentRuntimeEvent[] | undefined {
    const method = record.method;
    if (
      method !== "item/agentMessage/delta" &&
      method !== "item/reasoning/summaryTextDelta" &&
      method !== "item/reasoning/textDelta"
    )
      return undefined;
    const delta = params?.delta;
    if (typeof delta !== "string") return [];
    const itemId = nonEmptyString(params?.itemId);
    if (itemId && method !== "item/reasoning/textDelta") this.#streamed.add(itemId);
    // An empty delta says nothing, and must not open a text or thinking run on its own.
    if (!delta) return [];
    if (method === "item/reasoning/textDelta")
      return [
        { type: "progress", source: "codex_reasoning_text_delta", occurredAt: eventTime(record) },
      ];
    if (method === "item/reasoning/summaryTextDelta")
      return [{ type: "thinking-delta", text: delta }];
    return [messageEvent(itemId && this.#answerKinds.get(itemId), delta, record)];
  }

  /** A started turn, or a started or completed item. A started turn also starts its bookkeeping
   * afresh, so a turn whose completion was lost leaves nothing behind. */
  accept(record: JsonRecord, params: JsonRecord | undefined): AgentRuntimeEvent[] {
    if (record.method === "turn/started") {
      this.reset();
      return [{ type: "thinking-delta", text: "" }];
    }
    const item = asRecord(params?.item);
    if (!item) return [];
    if (record.method === "item/started") return this.#itemStarted(item, record);
    if (record.method === "item/completed") return this.#itemCompleted(item, record);
    return [];
  }

  reset(): void {
    this.#streamed.clear();
    this.#answerKinds.clear();
    this.#fileChangeCounts.clear();
  }

  #itemStarted(item: JsonRecord, record: JsonRecord): AgentRuntimeEvent[] {
    const occurredAt = eventTime(record);
    const id = nonEmptyString(item.id);
    if (item.type === "agentMessage") {
      if (id) this.#answerKinds.set(id, item.phase);
      return [];
    }
    if (item.type === "contextCompaction") return [{ type: "compaction-started", occurredAt }];
    if (item.type === "enteredReviewMode") return [{ type: "review-started", occurredAt }];
    const tool = ONE_CALL_TOOLS.get(item.type);
    if (tool) return id ? [{ type: "tool-start", id, ...tool.start(item), occurredAt }] : [];
    if (item.type === "fileChange") {
      const itemId = id ?? "file-change";
      const changes = fileChanges(item);
      this.#fileChangeCounts.set(itemId, changes.length);
      return changes.map((change, index) => ({
        type: "tool-start",
        id: `${itemId}:${index}`,
        name: change.kind === "add" ? "write_file" : "edit_file",
        input: { file_path: change.path },
        occurredAt,
      }));
    }
    return [];
  }

  #itemCompleted(item: JsonRecord, record: JsonRecord): AgentRuntimeEvent[] {
    const id = nonEmptyString(item.id);
    if (item.type === "reasoning" && id) {
      // Only the readable summary, never the raw reasoning `content`.
      const summary = Array.isArray(item.summary)
        ? item.summary
            .filter((part) => typeof part === "string")
            .join("\n")
            .trim()
        : "";
      return this.#streamed.delete(id) || !summary
        ? []
        : [{ type: "thinking-delta", text: summary }];
    }
    if (item.type === "agentMessage" && id) {
      this.#answerKinds.delete(id);
      const text = nonEmptyString(item.text);
      return this.#streamed.delete(id) || !text ? [] : [messageEvent(item.phase, text, record)];
    }
    const occurredAt = eventTime(record);
    if (item.type === "contextCompaction") return [{ type: "compaction-finished", occurredAt }];
    if (item.type === "exitedReviewMode") return [{ type: "review-finished", occurredAt }];
    const tool = ONE_CALL_TOOLS.get(item.type);
    if (tool) {
      if (!id) return [];
      // A command's `exitCode`, and a command's or MCP call's `durationMs` (v2 `ThreadItem`);
      // `null` until the call finishes or when it never ran.
      return [
        {
          type: "tool-end",
          id,
          isError: tool.failed(item),
          exitCode: integerField(item.exitCode),
          durationMs: integerField(item.durationMs),
        },
      ];
    }
    if (item.type === "fileChange") {
      const itemId = id ?? "file-change";
      const count = this.#fileChangeCounts.get(itemId) ?? fileChanges(item).length;
      this.#fileChangeCounts.delete(itemId);
      const failed = item.status === "failed" || item.status === "declined";
      return Array.from({ length: count }, (_, index) => ({
        type: "tool-end",
        id: `${itemId}:${index}`,
        isError: failed,
      }));
    }
    return [];
  }
}

type OneCallTool = {
  start(item: JsonRecord): { name: string; input: unknown };
  failed(item: JsonRecord): boolean;
};

/**
 * Each item type that is one tool call: the name and raw input it starts with, and whether its
 * completion failed. A command is a raw "bash" call, as every provider reports it, so the daemon
 * core's `toolActivity` resolves a `coforge …` command to its hidden tool (e.g. `send_message`).
 * An MCP tool is named like Claude Code's (`mcp__<server>__<tool>`), so the shared tool label
 * strips the prefix the same way, or `mcp__<tool>` without a server. A collaboration call reports only which tool it used: its
 * prompt is not Activity.
 */
const ONE_CALL_TOOLS: ReadonlyMap<unknown, OneCallTool> = new Map<string, OneCallTool>([
  [
    "commandExecution",
    {
      start: (item) => ({
        name: "bash",
        input: { command: typeof item.command === "string" ? item.command : "command" },
      }),
      failed: (item) => item.exitCode !== 0,
    },
  ],
  [
    "mcpToolCall",
    {
      start: (item) => {
        const tool = nonEmptyString(item.tool) ?? "unknown";
        const server = nonEmptyString(item.server);
        // Always prefixed, so a server-less tool name never reads as a built-in or CoForge tool.
        return { name: server ? `mcp__${server}__${tool}` : `mcp__${tool}`, input: item.arguments };
      },
      failed: (item) =>
        item.status === "failed" || (item.error !== null && item.error !== undefined),
    },
  ],
  [
    "webSearch",
    {
      start: (item) => ({ name: "web_search", input: { query: webSearchQuery(item) } }),
      failed: () => false,
    },
  ],
  [
    "collabAgentToolCall",
    {
      start: (item) => ({ name: "collab_tool_call", input: { tool: item.tool } }),
      failed: (item) => item.status === "failed" || item.status === "interrupted",
    },
  ],
]);

function webSearchQuery(item: JsonRecord): string | undefined {
  const action = asRecord(item.action);
  const queries = Array.isArray(action?.queries) ? action.queries : [];
  return (
    nonEmptyString(item.query) ??
    nonEmptyString(action?.query) ??
    nonEmptyString(queries[0]) ??
    nonEmptyString(action?.url)
  );
}

/**
 * Agent message text as the answer's text, or as progress when the message is not the answer.
 * Codex documents a missing `MessagePhase` as unknown, shown as before (an empty one too, as the
 * reference Computer reads it); of the known ones only `final_answer` is the answer, never
 * `commentary` or a `partial_answer`.
 */
function messageEvent(answerKind: unknown, text: string, record: JsonRecord): AgentRuntimeEvent {
  const kind = nonEmptyString(answerKind);
  return kind === undefined || kind === "final_answer"
    ? { type: "text-delta", text }
    : { type: "progress", source: "codex_agent_message_non_final", occurredAt: eventTime(record) };
}

/** Each changed file with its kind: the official `{ type }` object, or a legacy kind string. */
function fileChanges(item: JsonRecord): Array<{ kind: string | undefined; path: string }> {
  const changes = Array.isArray(item.changes) ? item.changes : [item];
  return changes.flatMap((value) => {
    const change = asRecord(value);
    if (!change || typeof change.path !== "string") return [];
    const kind = typeof change.kind === "string" ? change.kind : asRecord(change.kind)?.type;
    return [{ kind: typeof kind === "string" ? kind : undefined, path: change.path }];
  });
}
