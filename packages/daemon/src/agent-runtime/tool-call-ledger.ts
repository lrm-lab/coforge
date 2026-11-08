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
  /** Whether this call's own start made it into the log; its end is written only if it did. */
  logged?: boolean;
};

export const TOOL_CALL_LEDGER_MAX = 256;

/** How many tool calls one launch writes to the log. Tool calls are frequent — a working turn
 * makes dozens — so a launch that loops cannot push the rest of the daemon's day out of the
 * files the rotating sink keeps; past this the first dropped call writes one line saying so
 * (task #698). */
export const TOOL_CALLS_LOGGED_PER_LAUNCH = 2_000;

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
 * Each call's start and end is one log line — the tool's name, never its arguments or output —
 * so a later reader can tell a silent turn that was running a build from one that was hung.
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
      const previous = this.#calls.get(event.id);
      if (!previous && this.#calls.size >= TOOL_CALL_LEDGER_MAX) return;
      // A provider that repeats a start for a known id is the same call: it keeps the line its
      // first start wrote, and its end still pairs with that line.
      const logged = previous?.logged ?? this.#logStarted(event.id, event.name);
      this.#calls.set(event.id, {
        name: event.name,
        startedAtMs: this.clock(),
        startedAtWallMs: this.wallClock(),
        startedAtProcessClockMs: this.processClock(),
        ...(logged ? { logged } : {}),
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

  /** The start of the oldest open call on the host process clock, for the turn-scoped kill. */
  oldestOpenToolStartedProcessClockMs(): number | undefined {
    return this.#oldestOpenTool()?.startedAtProcessClockMs;
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
    // The log line is keyed by the same call id, so a call whose id cannot go on the wire is
    // neither published nor logged.
    const published = isActivityToolOutcome(outcome) ? outcome : undefined;
    this.#logFinished(call, published);
    return published;
  }

  /** Whether this call may write its own lines yet; the first call past the cap says so once. */
  #logStarted(id: string, name: string): boolean {
    const identity = this.#identity;
    if (!identity) return false;
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
      return false;
    }
    this.#loggedCalls += 1;
    logger.info("Tool call started", {
      event: "agent_runtime:tool_started",
      agent_id: identity.agentId,
      launch_id: identity.launchId,
      call_id: id,
      tool: name,
    });
    return true;
  }

  #logFinished(call: ToolCall | undefined, outcome: ActivityToolOutcome | undefined): void {
    const identity = this.#identity;
    // The line is keyed by the call id the published outcome carries, so a call with neither
    // writes nothing — the same rule `finish` applies to publishing it.
    if (!identity || !call?.logged || !outcome) return;
    logger.info("Tool call finished", {
      event: "agent_runtime:tool_finished",
      agent_id: identity.agentId,
      launch_id: identity.launchId,
      call_id: outcome.callId,
      tool: call.name,
      ...(outcome.durationMs !== undefined ? { duration_ms: outcome.durationMs } : {}),
      ...(outcome.exitCode !== undefined ? { exit_code: outcome.exitCode } : {}),
      ok: outcome.ok,
    });
  }
}

function wholeMs(value: number | undefined): number | undefined {
  if (value === undefined || value < 0) return undefined;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) ? rounded : undefined;
}
