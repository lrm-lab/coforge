import type { AgentRuntimeEvent } from "@coforge/agent";
import {
  isActivityExitCode,
  isActivityToolOutcome,
  type ActivityToolOutcome,
} from "@lrm/coforge-sdk/internal";

type ToolEnd = Extract<AgentRuntimeEvent, { type: "tool-end" }>;
type ToolCall = {
  name: string;
  startedAtMs: number;
  startedAtWallMs: number;
  endedAtMs?: number;
};

export const TOOL_CALL_LEDGER_MAX = 256;

/**
 * One launch's tool calls from the provider's raw events: which are still open (stalled recovery
 * never restarts over one) and how long each ran, for the outcome its `tool_end` reports. A
 * completed turn forgets every call, so a call that never ends (an interrupted turn, a crash)
 * reports nothing and is not kept.
 */
export class ToolCallLedger {
  readonly #calls = new Map<string, ToolCall>();

  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly wallClock: () => number = Date.now,
  ) {}

  observe(event: AgentRuntimeEvent): void {
    if (event.type === "tool-start") {
      if (!this.#calls.has(event.id) && this.#calls.size >= TOOL_CALL_LEDGER_MAX) return;
      this.#calls.set(event.id, {
        name: event.name,
        startedAtMs: this.clock(),
        startedAtWallMs: this.wallClock(),
      });
    } else if (event.type === "tool-end") {
      const call = this.#calls.get(event.id);
      if (call && call.endedAtMs === undefined) call.endedAtMs = this.clock();
    } else if (event.type === "completed") this.#calls.clear();
  }

  get hasOpenToolCall(): boolean {
    for (const call of this.#calls.values()) if (call.endedAtMs === undefined) return true;
    return false;
  }

  /** The oldest open tool, for a turn interrupt result or stalled Activity. */
  oldestOpenTool(): { name: string; silentForMs: number } | undefined {
    const oldest = this.#oldestOpenTool();
    return oldest
      ? {
          name: oldest.name,
          silentForMs: Math.max(0, Math.round(this.clock() - oldest.startedAtMs)),
        }
      : undefined;
  }

  /** The start of the oldest open call, for the stalled-turn silence clock. */
  oldestOpenToolStartedAtMs(): number | undefined {
    return this.#oldestOpenTool()?.startedAtWallMs;
  }

  #oldestOpenTool(): ToolCall | undefined {
    let oldest: ToolCall | undefined;
    for (const call of this.#calls.values()) {
      if (call.endedAtMs !== undefined) continue;
      if (!oldest || call.startedAtMs < oldest.startedAtMs) oldest = call;
    }
    return oldest;
  }

  /** Forgets the ended call and returns its outcome, or `undefined` when its id cannot go on
   * the wire. */
  finish(end: ToolEnd): ActivityToolOutcome | undefined {
    const call = this.#calls.get(end.id);
    this.#calls.delete(end.id);
    const measured = call && (call.endedAtMs ?? this.clock()) - call.startedAtMs;
    const durationMs = wholeMs(end.durationMs ?? measured);
    const exitCode = isActivityExitCode(end.exitCode) ? end.exitCode : undefined;
    const outcome = {
      callId: end.id,
      // As in the reference client 1.0.50, a known exit code means the call ran: `ok` whatever
      // the code, which is reported beside it. Only a call with no exit code is judged by its
      // error flag.
      ok: exitCode !== undefined || !end.isError,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
    return isActivityToolOutcome(outcome) ? outcome : undefined;
  }
}

function wholeMs(value: number | undefined): number | undefined {
  if (value === undefined || value < 0) return undefined;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) ? rounded : undefined;
}
