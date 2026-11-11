import type { AgentRuntimeEvent } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { isBusyActivityDetailKind } from "./agent-activity-publisher";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** Default silence window before a busy turn gets a visible stalled indicator. */
export const STALLED_TURN_SILENCE_MS = 10 * 60_000;
export const STALLED_TURN_SILENCE_ENV = "COFORGE_STALLED_TURN_SILENCE_MS";

/** The same window for a busy turn with no tool open: the model itself produced nothing. Longer
 * than the tool window, because a model may legitimately take minutes over a large context while
 * a long tool is at least visible as a tool; zero leaves only the tool window. A turn in this
 * state is indistinguishable from a healthy one on the Agent's page, so a person had no way to
 * stop it (task #41). */
export const STALLED_TURN_MODEL_SILENCE_MS = 20 * 60_000;
export const STALLED_TURN_MODEL_SILENCE_ENV = "COFORGE_STALLED_TURN_MODEL_SILENCE_MS";

/** Resolves the per-launch silence window; an explicit zero disables the indicator. */
export function stalledTurnSilenceMs(
  launchEnv: Readonly<Record<string, string>> | undefined,
  daemonEnv: Readonly<Record<string, string | undefined>> = Bun.env,
): number {
  return windowMs(STALLED_TURN_SILENCE_ENV, STALLED_TURN_SILENCE_MS, launchEnv, daemonEnv);
}

/** Resolves the window for a turn with no tool open; an explicit zero turns that case off. */
export function stalledTurnModelSilenceMs(
  launchEnv: Readonly<Record<string, string>> | undefined,
  daemonEnv: Readonly<Record<string, string | undefined>> = Bun.env,
): number {
  return windowMs(
    STALLED_TURN_MODEL_SILENCE_ENV,
    STALLED_TURN_MODEL_SILENCE_MS,
    launchEnv,
    daemonEnv,
  );
}

function windowMs(
  name: string,
  fallbackMs: number,
  launchEnv: Readonly<Record<string, string>> | undefined,
  daemonEnv: Readonly<Record<string, string | undefined>>,
): number {
  const raw = launchEnv?.[name] ?? daemonEnv[name];
  if (raw === undefined || raw.trim() === "") return fallbackMs;
  if (!/^\d+$/.test(raw.trim())) return fallbackMs;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallbackMs;
}

export type StalledTurnObservation = Readonly<{
  /** The provider still reports a live turn. */
  turnBusy: boolean;
  /** The last raw provider event observed by the daemon. */
  lastEventAtMs: number;
  /** The oldest open tool's start time, when a tool is still running. */
  oldestToolStartedAtMs?: number;
  /** At least one tool call remains open. A turn with none is judged on the longer model window,
   * which is what tells a long build from a model that produced nothing at all. */
  hasOpenToolCall: boolean;
}>;

export type StalledTurnIndicator = Readonly<{
  silentForMs: number;
  /** The tracker's own window, so the notice states the window it fired against. */
  thresholdMs: number;
  /** Which window judged this turn: one with a tool open, or a model that produced nothing. */
  window: "tool" | "model";
}>;

type StalledTurnState = {
  startAtMs: number;
  thresholdMs: number;
  window: "tool" | "model";
  watchdog: ReturnType<typeof setTimeout> | undefined;
  warned: boolean;
};

/** The launch's provider clock, as both the silence clock and the notice's line read it. */
type LaunchProgress = Readonly<{ lastEventAtMs: number }>;

/** The slice of a launch the silence clock reads. */
export type StalledTurnLaunch = Readonly<{
  progress?: LaunchProgress;
  toolCalls?: {
    oldestOpenToolStartedAtMs(): number | undefined;
    readonly hasOpenToolCall: boolean;
  };
}>;

/** What the launch shows now: a busy turn, its last raw provider event and its open tools. */
export function stalledTurnObservation(launch: StalledTurnLaunch): StalledTurnObservation {
  return {
    turnBusy: true,
    lastEventAtMs: launch.progress?.lastEventAtMs ?? Date.now(),
    oldestToolStartedAtMs: launch.toolCalls?.oldestOpenToolStartedAtMs(),
    hasOpenToolCall: launch.toolCalls?.hasOpenToolCall ?? false,
  };
}

const TURN_ENDING_DETAIL_KINDS: ReadonlySet<string> = new Set([
  AGENT_ACTIVITY_DETAIL_KIND.IDLE,
  AGENT_ACTIVITY_DETAIL_KIND.STOPPED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_CRASHED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_INTERRUPTED,
  AGENT_ACTIVITY_DETAIL_KIND.FRESHNESS_HOLD,
]);

/**
 * Events that are themselves evidence the turn is running: model output, a call starting, the model
 * streaming a call's arguments. A session's own `hasLiveTurn` can lag these by a moment — Codex
 * emits a command's `item/started` before it accepts the turn — and that lag is not the turn's end.
 */
export function showsTurnWork(event: AgentRuntimeEvent): boolean {
  switch (event.type) {
    case "text-delta":
    case "thinking-delta":
    case "tool-start":
    case "tool-output":
    case "reply-intent":
    case "progress":
      return true;
    default:
      return false;
  }
}

/** Whether this provider event, or a session that no longer holds a live turn, ends the turn. Work
 * under way is never read as an end, however stale the session's own answer is: only an explicit
 * ending ends a turn (task #41). */
export function endsStalledTurn(event: AgentRuntimeEvent, hasLiveTurn: boolean | undefined) {
  if (event.type === "completed") return true;
  if (event.type === "activity") {
    const { detailKind } = event.activity;
    if (TURN_ENDING_DETAIL_KINDS.has(detailKind)) return true;
    // A frame that shows the Agent working is the turn's own evidence: a turn's model output and
    // tool activity reach the observation as these coalesced frames.
    if (isBusyActivityDetailKind(detailKind)) return false;
  } else if (showsTurnWork(event)) return false;
  return hasLiveTurn === false;
}

/** The silence clock starts at the newer of provider progress and the oldest open tool start. */
export function stalledTurnSilenceStartAtMs(observation: StalledTurnObservation): number {
  return Math.max(observation.lastEventAtMs, observation.oldestToolStartedAtMs ?? 0);
}

/** Tracks one visible stalled notice per live turn. */
export class StalledTurnTracker {
  readonly #states = new Map<string, StalledTurnState>();

  constructor(
    private readonly onStalled: (agentId: string, indicator: StalledTurnIndicator) => void,
    private readonly silenceMs = STALLED_TURN_SILENCE_MS,
    private readonly now: () => number = Date.now,
    private readonly modelSilenceMs = STALLED_TURN_MODEL_SILENCE_MS,
  ) {}

  /** Starts or resets the current turn's silence clock after a raw provider event. */
  observe(agentId: string, observation: StalledTurnObservation): void {
    if (!observation.turnBusy) {
      this.finish(agentId);
      return;
    }
    // A tool still open is judged on the tool window; a turn with none is the model's own silence,
    // judged on the longer one — the state a person otherwise cannot tell from a healthy turn.
    const window = observation.hasOpenToolCall ? "tool" : "model";
    const thresholdMs = window === "tool" ? this.silenceMs : this.modelSilenceMs;
    if (thresholdMs <= 0) {
      this.finish(agentId);
      return;
    }
    const startAtMs = stalledTurnSilenceStartAtMs(observation);
    const current = this.#states.get(agentId);
    if (current?.warned && current.startAtMs === startAtMs) return;
    this.#arm(agentId, startAtMs, thresholdMs, window);
  }

  /** Starts a fresh turn, including one whose first provider event has not arrived yet. */
  start(agentId: string, observation: StalledTurnObservation): void {
    this.finish(agentId);
    this.observe(agentId, observation);
  }

  /** Ends the current turn and cancels its watchdog. */
  finish(agentId: string): void {
    const state = this.#states.get(agentId);
    if (state?.watchdog !== undefined) clearTimeout(state.watchdog);
    this.#states.delete(agentId);
  }

  dispose(agentId: string): void {
    this.finish(agentId);
  }

  disposeAll(): void {
    for (const agentId of this.#states.keys()) this.finish(agentId);
  }

  #arm(agentId: string, startAtMs: number, thresholdMs: number, window: "tool" | "model"): void {
    const current = this.#states.get(agentId);
    if (current?.watchdog !== undefined) clearTimeout(current.watchdog);
    const delayMs = Math.max(0, startAtMs + thresholdMs - this.now());
    const state: StalledTurnState = {
      startAtMs,
      thresholdMs,
      window,
      warned: false,
      watchdog: undefined,
    };
    state.watchdog = setTimeout(() => this.#markStalled(agentId, startAtMs), delayMs);
    this.#states.set(agentId, state);
  }

  #markStalled(agentId: string, startAtMs: number): void {
    const state = this.#states.get(agentId);
    if (!state || state.startAtMs !== startAtMs || state.warned) return;
    state.watchdog = undefined;
    state.warned = true;
    this.onStalled(agentId, {
      silentForMs: Math.max(0, this.now() - startAtMs),
      thresholdMs: state.thresholdMs,
      window: state.window,
    });
  }
}

/** The slice of a launch a notice's log line reads: the silence's start and the tool still open
 * when it fired. */
type NoticingLaunch = Readonly<{
  launchId: string;
  stopping?: boolean;
  progress?: LaunchProgress;
  toolCalls?: {
    oldestOpenTool(): { name: string; silentForMs: number } | undefined;
  };
}>;

/**
 * The tracker callback for one launch: shows the stalled turn as an error Activity and logs it,
 * unless the launch is no longer the current one or is stopping. The line names the window it
 * passed and the tool that was still running, which is what a later reader needs to tell a long
 * build from a hang (task #698).
 */
export function stalledTurnNotice(
  launch: NoticingLaunch,
  host: Readonly<{
    isCurrent(agentId: string): boolean;
    publish(agentId: string, detail: string): void;
  }>,
): (agentId: string, indicator: StalledTurnIndicator) => void {
  return (agentId, indicator) => {
    const current = host.isCurrent(agentId);
    if (!current || launch.stopping) {
      // A watchdog that fired and was dropped here leaves no other trace: without this line a
      // reader cannot tell it apart from one that never fired (task #41). Info, not debug: this is
      // exactly the line a real machine's log has to show.
      logger.info("Agent runtime stall notice dropped", {
        event: "agent_runtime:turn_stalled_dropped",
        agent_id: agentId,
        launch_id: launch.launchId,
        is_current: current,
        stopping: launch.stopping === true,
        stalled_window: indicator.window,
        silent_for_ms: indicator.silentForMs,
        outcome: "dropped",
      });
      return;
    }
    const minutes = Math.max(1, Math.round(indicator.silentForMs / 60_000));
    const openTool = launch.toolCalls?.oldestOpenTool();
    host.publish(agentId, `Agent runtime has produced no progress for ${minutes} minutes.`);
    logger.warning("Agent runtime turn has stalled", {
      event: "agent_runtime:turn_stalled",
      agent_id: agentId,
      launch_id: launch.launchId,
      stalled_window: indicator.window,
      silent_for_ms: indicator.silentForMs,
      threshold_ms: indicator.thresholdMs,
      ...(launch.progress ? { last_event_at: launch.progress.lastEventAtMs } : {}),
      ...(openTool ? { open_tool: openTool.name, open_tool_for_ms: openTool.silentForMs } : {}),
      outcome: "indicator",
    });
  };
}
