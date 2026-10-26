import type { ActivitySubagent } from "@lrm/coforge-sdk/internal";
import { type AgentRuntimeEvent } from "#src/contract";
import { asRecord } from "#src/json-record";
import { subagentTypeLabel } from "#src/subagent-type";

/** Claude Code's subagent-starting tool, under its current and its earlier name. */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
/** Tool calls remembered at once; the oldest is forgotten past this. */
const REMEMBERED_CALLS = 256;

/**
 * The lineage of a Claude Code record a subagent produced: its `parent_tool_use_id`, and the
 * subagent's type when Claude Code said it — on the record itself (`subagent_type`, which
 * Claude Code 2.1.303 sets on a subagent's `assistant` records), on the `Agent`/`Task` call that
 * started it (`input.subagent_type`), or on that call's `task_started`. Types are kept
 * display-safe (`subagentTypeLabel`).
 */
export class ClaudeSubagentLineage {
  readonly #types = new Map<string, string>();

  /** The record's subagent lineage, or `undefined` for a main-session record. */
  of(record: Readonly<Record<string, unknown>>): ActivitySubagent | undefined {
    const parentToolUseId = record.parent_tool_use_id;
    if (typeof parentToolUseId !== "string") return undefined;
    const subagentType =
      subagentTypeLabel(record.subagent_type) ?? this.#types.get(parentToolUseId);
    return { parentToolUseId, ...(subagentType ? { subagentType } : {}) };
  }

  /** Remembers the type an `Agent`/`Task` call names in its input; other calls name none. */
  rememberCall(event: Extract<AgentRuntimeEvent, { type: "tool-start" }>): void {
    if (SUBAGENT_TOOLS.has(event.name))
      this.remember(event.id, asRecord(event.input)?.subagent_type);
  }

  /** Remembers the subagent type a tool call started. */
  remember(toolUseId: unknown, subagentType: unknown): void {
    const type = subagentTypeLabel(subagentType);
    if (typeof toolUseId !== "string" || !type) return;
    this.#types.delete(toolUseId);
    this.#types.set(toolUseId, type);
    const oldest = this.#types.keys().next().value;
    if (this.#types.size > REMEMBERED_CALLS && oldest !== undefined) this.#types.delete(oldest);
  }

  /** The type remembered for a tool call, if any. */
  typeOf(toolUseId: string | undefined): string | undefined {
    return toolUseId === undefined ? undefined : this.#types.get(toolUseId);
  }

  /** A fresh session's calls share nothing with the old one's. */
  clear(): void {
    this.#types.clear();
  }
}
