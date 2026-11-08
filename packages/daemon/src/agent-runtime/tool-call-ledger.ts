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
};

/**
 * One launch's tool calls from the provider's raw events: which are still open (stalled recovery
 * never restarts over one) and how long each ran, for the outcome its `tool_end` reports. A
 * completed turn forgets every call, so a call that never ends (an interrupted turn, a crash)
 * reports nothing and is not kept.
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
  #loggedCalls = 0;
  #reportedTruncation = false;

  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly wallClock: () => number = Date.now,
    private readonly processClock: () => number = processClockMs,
    options: ToolCallLedgerOptions = {},
  ) {
    this.#identity = options.identity;
  }

  observe(event: AgentRuntimeEvent): void {
    if (event.type === "tool-start") {
      const known = this.#calls.has(event.id);
      if (!known && this.#calls.size >= TOOL_CALL_LEDGER_MAX) return;
      // A repeated start for a known id re-starts that call: it takes fresh clocks and is open
      // again, as before this ledger logged anything. Its line is written once, when the turn
      // ends or the call finishes.
      this.#calls.set(event.id, {
        name: event.name,
        startedAtMs: this.clock(),
        startedAtWallMs: this.wallClock(),
        startedAtProcessClockMs: this.processClock(),
      });
    } else if (event.type === "tool-end") {
      const call = this.#calls.get(event.id);
      if (call && call.endedAtMs === undefined) call.endedAtMs = this.clock();
    } else if (event.type === "completed") {
      // The turn is over, so no call left in the ledger will reach `finish()`: write the line for
      // each one now, in start order, saying whether its end was ever seen.
      for (const [id, call] of this.#calls)
        this.#logCall(
          id,
          call,
          call.endedAtMs === undefined
            ? "agent_runtime:tool_unfinished"
            : "agent_runtime:tool_finished",
        );
      this.#calls.clear();
    }
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

  /** The start of the oldest open call on the host process clock, for the turn-scoped kill. */
  oldestOpenToolStartedProcessClockMs(): number | undefined {
    return this.#oldestOpenTool()?.startedAtProcessClockMs;
  }

  /** Writes the line for every call this launch was still holding when its process ended — the
   * turn-scoped kill, a shutdown, an unexpected exit — and forgets them. Such a call never
   * reaches `finish()` and its turn never completes, so without this the one thing worth knowing
   * about an Agent that went silent mid-command would be the only thing missing from the log. */
  logAbandoned(): void {
    for (const [id, call] of this.#calls) this.#logCall(id, call, "agent_runtime:tool_unfinished");
    this.#calls.clear();
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
    // The line carries the call id the outcome does, so the two can be read together. An id the
    // activity wire rejects still names a real call, so it is logged even when not published.
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
