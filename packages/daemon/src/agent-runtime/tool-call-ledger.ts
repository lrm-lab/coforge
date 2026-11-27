import type { AgentRuntimeEvent } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import { processClockMs } from "#src/platform/process-tree";
import {
  isActivityExitCode,
  isActivityToolOutcome,
  type ActivityToolOutcome,
} from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime"]);

type ToolEnd = Extract<AgentRuntimeEvent, { type: "tool-end" }>;
type ToolCall = {
  name: string;
  startedAtMs: number;
  startedAtWallMs: number;
  startedAtProcessClockMs: number;
  endedAtMs?: number;
};

export const TOOL_CALL_LEDGER_MAX = 256;

/** Calls at least this long are written to the log; shorter ones are not. A stall is judged in
 * minutes, so a call that ends inside five seconds cannot explain one — and logging every call
 * spends the daemon log's whole retention window on noise: across 104,966 measured calls, the
 * median call lasts 0.2 s and 89% end inside five seconds (task #698). */
export const TOOL_CALL_LOG_MIN_MS = 5_000;

/** How many tool calls one launch writes to the log. Only calls past `TOOL_CALL_LOG_MIN_MS` are
 * written, so a healthy launch writes a few; this bounds one that loops, whose lines would
 * otherwise push the rest of the daemon's day out of the files the rotating sink keeps. At the
 * measured 454 bytes a line a full cap costs 0.13 MiB: added to the median hour's 1.10 MiB that
 * is still a 48.8-hour window, so one runaway launch cannot by itself take the log below the
 * 48 hours a day-over-day comparison needs. Below ~310 lines the busiest legitimate launches
 * would truncate (11% of 104,966 measured calls reach five seconds, and a p99 turn makes ~200 of
 * them), which is why the cap is not tighter. The first dropped line says so once (task #698). */
export const TOOL_CALLS_LOGGED_PER_LAUNCH = 300;

/** Whose tool calls a ledger holds: every line it writes names the Agent and the launch. */
export type ToolCallLogIdentity = Readonly<{ agentId: string; launchId: string }>;

type ToolCallLedgerOptions = {
  /** Absent for a ledger outside a daemon launch (a test): nothing is logged then. */
  identity?: ToolCallLogIdentity;
  trackUnfinishedCommands?: boolean;
};

/**
 * One launch's tool calls from the provider's raw events: which are still open (stalled recovery
 * never restarts over one) and how long each ran, for the outcome its `tool_end` reports.
 *
 * A call lasting `TOOL_CALL_LOG_MIN_MS` or more is one log line — the tool's name and how long it
 * ran, never its arguments or output — so a later reader can tell a silent turn that was running
 * a build from one that was hung. The line is written when the call finishes, when its turn
 * completes still holding it, or when its process exits (`logAbandoned()`): every call that long
 * is written once, however its turn ends.
 */
export class ToolCallLedger {
  readonly #calls = new Map<string, ToolCall>();
  readonly #identity: ToolCallLogIdentity | undefined;
  #openCount = 0;
  #oldestOpen: ToolCall | undefined;
  #oldestOpenId: string | undefined;
  #loggedCalls = 0;
  #reportedTruncation = false;
  #unfinishedCommandStartedAtMs: number | undefined;

  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly wallClock: () => number = Date.now,
    private readonly processClock: () => number = processClockMs,
    private readonly options: ToolCallLedgerOptions = {},
  ) {
    this.#identity = options.identity;
  }

  observe(event: AgentRuntimeEvent): void {
    if (event.type === "tool-start") {
      const previous = this.#calls.get(event.id);
      if (!previous && this.#calls.size >= TOOL_CALL_LEDGER_MAX) return;
      const call: ToolCall = {
        name: event.name,
        startedAtMs: this.clock(),
        startedAtWallMs: this.wallClock(),
        startedAtProcessClockMs: this.processClock(),
      };
      if (previous === undefined || previous.endedAtMs !== undefined) this.#openCount += 1;
      this.#calls.set(event.id, call);
      if (this.#oldestOpenId === event.id) this.#recomputeOldestOpen();
      else if (this.#oldestOpen === undefined || call.startedAtMs < this.#oldestOpen.startedAtMs) {
        this.#oldestOpen = call;
        this.#oldestOpenId = event.id;
      }
    } else if (event.type === "tool-end") {
      const call = this.#calls.get(event.id);
      if (call && call.endedAtMs === undefined) {
        call.endedAtMs = this.clock();
        this.#openCount -= 1;
        if (this.#oldestOpenId === event.id) this.#recomputeOldestOpen();
      }
    } else if (event.type === "completed") {
      for (const [id, call] of this.#calls) {
        if (
          this.options.trackUnfinishedCommands &&
          event.status === "completed" &&
          call.name === "run_command" &&
          call.endedAtMs === undefined
        )
          this.#unfinishedCommandStartedAtMs = Math.min(
            this.#unfinishedCommandStartedAtMs ?? call.startedAtProcessClockMs,
            call.startedAtProcessClockMs,
          );
        this.#logCall(
          id,
          call,
          call.endedAtMs === undefined
            ? "agent_runtime:tool_unfinished"
            : "agent_runtime:tool_finished",
        );
      }
      this.#clearCalls();
    }
  }

  get hasOpenToolCall(): boolean {
    return this.#openCount > 0;
  }

  get unfinishedCommandStartedAtMs(): number | undefined {
    return this.#unfinishedCommandStartedAtMs;
  }

  clearUnfinishedCommand(startedAtMs: number): void {
    if (this.#unfinishedCommandStartedAtMs === startedAtMs)
      this.#unfinishedCommandStartedAtMs = undefined;
  }

  oldestOpenTool(): { name: string; silentForMs: number } | undefined {
    const oldest = this.#oldestOpen;
    return oldest
      ? {
          name: oldest.name,
          silentForMs: Math.max(0, Math.round(this.clock() - oldest.startedAtMs)),
        }
      : undefined;
  }

  oldestOpenToolStartedAtMs(): number | undefined {
    return this.#oldestOpen?.startedAtWallMs;
  }

  oldestOpenToolStartedProcessClockMs(): number | undefined {
    return this.#oldestOpen?.startedAtProcessClockMs;
  }

  logAbandoned(): void {
    for (const [id, call] of this.#calls) this.#logCall(id, call, "agent_runtime:tool_unfinished");
    this.#clearCalls();
  }

  #clearCalls(): void {
    this.#calls.clear();
    this.#openCount = 0;
    this.#oldestOpen = undefined;
    this.#oldestOpenId = undefined;
  }

  #recomputeOldestOpen(): void {
    let oldestId: string | undefined;
    let oldestCall: ToolCall | undefined;
    for (const [id, call] of this.#calls) {
      if (call.endedAtMs !== undefined) continue;
      if (!oldestCall || call.startedAtMs < oldestCall.startedAtMs) {
        oldestId = id;
        oldestCall = call;
      }
    }
    this.#oldestOpenId = oldestId;
    this.#oldestOpen = oldestCall;
  }

  finish(end: ToolEnd): ActivityToolOutcome | undefined {
    const call = this.#calls.get(end.id);
    this.#calls.delete(end.id);
    if (call && call.endedAtMs === undefined) {
      this.#openCount -= 1;
      if (this.#oldestOpenId === end.id) this.#recomputeOldestOpen();
    }
    const measured = call && (call.endedAtMs ?? this.clock()) - call.startedAtMs;
    const durationMs = wholeMs(end.durationMs ?? measured);
    const exitCode = isActivityExitCode(end.exitCode) ? end.exitCode : undefined;
    const outcome = {
      callId: end.id,
      ok: exitCode !== undefined || !end.isError,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
    const published = isActivityToolOutcome(outcome) ? outcome : undefined;
    this.#logCall(end.id, call, "agent_runtime:tool_finished", published);
    return published;
  }

  /** Writes one line for a call the ledger itself timed at `TOOL_CALL_LOG_MIN_MS` or more, or
   * nothing: the line is what a later reader pairs with a silent turn, and shorter calls cannot
   * explain one. The duration is this ledger's window from the start event to the end, which is
   * the time the provider reported nothing — not the provider's own measure of the tool, which
   * can cover a second of a nine-minute silence. */
  #logCall(
    callId: string,
    call: ToolCall | undefined,
    event: "agent_runtime:tool_finished" | "agent_runtime:tool_unfinished",
    outcome?: ActivityToolOutcome,
  ): void {
    const identity = this.#identity;
    if (!identity || !call) return;
    const durationMs = wholeMs((call.endedAtMs ?? this.clock()) - call.startedAtMs);
    if (durationMs === undefined || durationMs < TOOL_CALL_LOG_MIN_MS) return;
    if (this.#loggedCalls >= TOOL_CALLS_LOGGED_PER_LAUNCH) {
      if (!this.#reportedTruncation) {
        this.#reportedTruncation = true;
        logger.warning("Stopped logging this launch's tool calls", {
          event: "agent_runtime:tool_log_truncated",
          agent_id: identity.agentId,
          launch_id: identity.launchId,
          logged: this.#loggedCalls,
        });
      }
      return;
    }
    this.#loggedCalls += 1;
    logger.info(
      event === "agent_runtime:tool_finished"
        ? "Tool call finished"
        : "Tool call never reported its end",
      {
        event,
        agent_id: identity.agentId,
        launch_id: identity.launchId,
        call_id: callId,
        tool: call.name,
        // The call started at this line's own timestamp minus this duration.
        duration_ms: durationMs,
        ...(outcome?.exitCode !== undefined ? { exit_code: outcome.exitCode } : {}),
        ...(outcome ? { ok: outcome.ok } : {}),
      },
    );
  }
}

function wholeMs(value: number | undefined): number | undefined {
  if (value === undefined || value < 0) return undefined;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) ? rounded : undefined;
}
