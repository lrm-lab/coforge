import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { asRecord, eventTime, nonEmptyString, type JsonRecord } from "@lrm/coforge-anvil";
import { codexFileChanges, codexOneCallTool } from "./item-events";

/** Raft bounds the unnamed-ended-thread memory so a thread that never gets named cannot grow it. */
const UNNAMED_THREAD_ENDS_LIMIT = 64;

/** `spawnCallId` is the collaboration call that spawned the subagent: the main thread's item
 * id, or a nested `<threadId>:<itemId>` for a subagent's own spawn call. */
type MutableSubagent = { spawnCallId: string; running: boolean; turnId?: string };

/** The thread a notification belongs to: `threadId`, a `thread.id`, or the older `sessionId`. */
export function codexMessageThreadId(
  record: Readonly<Record<string, unknown>>,
): string | undefined {
  const params = asRecord(record.params);
  return (
    nonEmptyString(params?.threadId) ??
    nonEmptyString(asRecord(params?.thread)?.id) ??
    nonEmptyString(params?.sessionId)
  );
}

/**
 * Raft's `CodexEventNormalizer` subagent half: a `collabAgentToolCall` item's
 * `receiverThreadIds` names the threads it spawned, and every later notification carrying one of
 * those thread ids is that subagent's own turn — its items become subagent-scoped content and its
 * turn lifecycle becomes `subagent-progress`. Threads that end before a spawn call names them are
 * remembered briefly so their belated registration does not report a start that already finished.
 */
export class CodexSubagentThreads {
  readonly #subagents = new Map<string, MutableSubagent>();
  /** Insertion-ordered: the oldest unnamed end is evicted first. */
  readonly #unnamedThreadEnds = new Set<string>();

  constructor(private readonly mainThreadId: string) {}

  isSecondaryThreadId(threadId: string | undefined): threadId is string {
    return threadId !== undefined && threadId !== this.mainThreadId;
  }

  /**
   * One notification for a thread other than the main one: normalized subagent events when the
   * thread is a registered subagent, unnamed-turn bookkeeping otherwise. Turn items arrive whole
   * — the reference client does not stream a subagent's deltas either.
   */
  acceptSecondary(
    record: Readonly<Record<string, unknown>>,
    threadId: string,
  ): AgentRuntimeEvent[] {
    const subagent = this.#subagents.get(threadId);
    if (!subagent) {
      this.#noteUnnamedThreadTurn(record.method, threadId);
      return [];
    }
    const events: AgentRuntimeEvent[] = [];
    const params = asRecord(record.params);
    const occurredAt = eventTime(record);
    switch (record.method) {
      case "turn/started": {
        subagent.turnId = nonEmptyString(asRecord(params?.turn)?.id);
        if (!subagent.running) this.#markStarted(threadId, subagent, occurredAt, events);
        return events;
      }
      case "turn/completed": {
        if (subagent.running)
          this.#markEnded(
            threadId,
            subagent,
            codexSubagentTurnStatus(asRecord(params?.turn)?.status),
            occurredAt,
            events,
          );
        return events;
      }
      case "thread/status/changed": {
        const status = codexSubagentThreadStatus(
          params?.status ?? asRecord(params?.thread)?.status,
        );
        if (subagent.running && status)
          this.#markEnded(threadId, subagent, status, occurredAt, events);
        return events;
      }
      case "item/started":
      case "item/completed": {
        const item = asRecord(params?.item);
        if (!item || typeof item.type !== "string") return events;
        const isCompleted = record.method === "item/completed";
        events.push(...this.#subagentItem(item, isCompleted, threadId, subagent, occurredAt));
        if (isCompleted && item.type === "collabAgentToolCall") {
          const spawnCallId = codexSubagentItemId(threadId, item);
          events.push(...this.noteCollabAgentStates(item, spawnCallId, occurredAt));
        }
        return events;
      }
      default:
        return events;
    }
  }

  /**
   * A completed `collabAgentToolCall` item, on the main thread or inside a subagent: registers
   * each `spawnAgent` receiver thread and ends any registered subagent whose collab state reports
   * a terminal status. `spawnCallId` is the item's own id — the lineage every event it produces
   * carries.
   */
  noteCollabAgentStates(
    item: JsonRecord,
    spawnCallId: string | undefined,
    occurredAt: ReturnType<typeof eventTime>,
  ): AgentRuntimeEvent[] {
    const events: AgentRuntimeEvent[] = [];
    const states =
      item.agentsStates && typeof item.agentsStates === "object"
        ? (item.agentsStates as Record<string, unknown>)
        : {};
    if (item.tool === "spawnAgent" && spawnCallId && Array.isArray(item.receiverThreadIds)) {
      for (const threadId of item.receiverThreadIds) {
        if (typeof threadId !== "string" || threadId.length === 0 || this.#subagents.has(threadId))
          continue;
        const subagent: MutableSubagent = { spawnCallId, running: false };
        this.#subagents.set(threadId, subagent);
        const endedAlready =
          this.#unnamedThreadEnds.delete(threadId) ||
          codexCollabTerminalStatus(codexCollabStateStatus(states[threadId])) !== undefined;
        if (!endedAlready) this.#markStarted(threadId, subagent, occurredAt, events);
      }
    }
    for (const [threadId, state] of Object.entries(states)) {
      const subagent = this.#subagents.get(threadId);
      const status = codexCollabTerminalStatus(codexCollabStateStatus(state));
      if (subagent?.running && status)
        this.#markEnded(threadId, subagent, status, occurredAt, events);
    }
    return events;
  }

  /** The thread/turn a per-subagent interrupt targets, while that turn still runs. */
  runningSubagentTurn(threadId: string): { threadId: string; turnId: string } | undefined {
    const subagent = this.#subagents.get(threadId);
    return subagent?.running && subagent.turnId ? { threadId, turnId: subagent.turnId } : undefined;
  }

  #markStarted(
    threadId: string,
    subagent: MutableSubagent,
    occurredAt: string | undefined,
    events: AgentRuntimeEvent[],
  ): void {
    subagent.running = true;
    events.push({
      type: "subagent-progress",
      phase: "started",
      taskId: threadId,
      taskKind: "agent",
      parentToolUseId: subagent.spawnCallId,
      ...(occurredAt ? { occurredAt } : {}),
    });
  }

  #markEnded(
    threadId: string,
    subagent: MutableSubagent,
    taskStatus: "completed" | "failed" | "stopped",
    occurredAt: string | undefined,
    events: AgentRuntimeEvent[],
  ): void {
    subagent.running = false;
    subagent.turnId = undefined;
    events.push({
      type: "subagent-progress",
      phase: "notification",
      taskId: threadId,
      taskStatus,
      taskKind: "agent",
      parentToolUseId: subagent.spawnCallId,
      ...(occurredAt ? { occurredAt } : {}),
    });
  }

  /** A thread that ended before any spawn call named it: remembered so a late registration
   * does not report a start that already finished, bounded so it cannot grow without limit. */
  #noteUnnamedThreadTurn(method: unknown, threadId: string): void {
    if (method === "turn/started") this.#unnamedThreadEnds.delete(threadId);
    else if (method === "turn/completed") {
      this.#unnamedThreadEnds.delete(threadId);
      this.#unnamedThreadEnds.add(threadId);
      if (this.#unnamedThreadEnds.size > UNNAMED_THREAD_ENDS_LIMIT) {
        const oldest = this.#unnamedThreadEnds.values().next().value;
        if (oldest !== undefined) this.#unnamedThreadEnds.delete(oldest);
      }
    }
  }

  #subagentItem(
    item: JsonRecord,
    isCompleted: boolean,
    threadId: string,
    subagent: MutableSubagent,
    occurredAt: string | undefined,
  ): AgentRuntimeEvent[] {
    const lineage = { parentToolUseId: subagent.spawnCallId };
    const itemId = codexSubagentItemId(threadId, item);
    if (item.type === "agentMessage") {
      if (!isCompleted) return [];
      const text = nonEmptyString(item.text);
      return text ? [{ type: "text-delta", text, subagent: lineage }] : [];
    }
    if (item.type === "reasoning") {
      if (!isCompleted) return [];
      const summary = Array.isArray(item.summary)
        ? item.summary
            .filter((part) => typeof part === "string")
            .join("\n")
            .trim()
        : "";
      return summary ? [{ type: "thinking-delta", text: summary, subagent: lineage }] : [];
    }
    if (item.type === "fileChange") {
      if (!isCompleted || !Array.isArray(item.changes) || !itemId) return [];
      const events: AgentRuntimeEvent[] = [];
      codexFileChanges(item).forEach((change, index) => {
        const id = `${itemId}:${index}`;
        const name = change.kind === "add" ? "write_file" : "edit_file";
        events.push(
          { type: "tool-start", id, name, input: { file_path: change.path }, subagent: lineage },
          { type: "tool-end", id, isError: item.status === "failed" || item.status === "declined" },
        );
      });
      return events;
    }
    const tool = codexOneCallTool(item);
    if (!tool || !itemId) return [];
    if (!isCompleted)
      return [
        {
          type: "tool-start",
          id: itemId,
          ...tool.start(item),
          subagent: lineage,
          ...(occurredAt ? { occurredAt } : {}),
        },
      ];
    return [{ type: "tool-end", id: itemId, isError: tool.failed(item) }];
  }
}

/** `<threadId>:<itemId>` — a subagent item's id can never collide with a main-thread one. */
function codexSubagentItemId(threadId: string, item: JsonRecord): string | undefined {
  const id = nonEmptyString(item.id);
  return id ? `${threadId}:${id}` : undefined;
}

/** A subagent thread's `turn/completed` status, in task-status vocabulary. */
function codexSubagentTurnStatus(status: unknown): "completed" | "failed" | "stopped" {
  if (status === "failed") return "failed";
  if (status === "interrupted") return "stopped";
  return "completed";
}

/** A subagent thread's `thread/status/changed` type, in task-status vocabulary. */
function codexSubagentThreadStatus(
  status: unknown,
): "completed" | "failed" | "stopped" | undefined {
  const type =
    status && typeof status === "object" ? (status as Record<string, unknown>).type : undefined;
  if (type === "systemError") return "failed";
  if (type === "notLoaded") return "stopped";
  return undefined;
}

/** A collab state's status, in task-status vocabulary; `undefined` while it still runs. */
function codexCollabTerminalStatus(
  status: unknown,
): "completed" | "failed" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
      return "failed";
    case "interrupted":
    case "shutdown":
    case "notFound":
      return "stopped";
    default:
      return undefined;
  }
}

function codexCollabStateStatus(state: unknown): unknown {
  return state && typeof state === "object" ? (state as Record<string, unknown>).status : undefined;
}
