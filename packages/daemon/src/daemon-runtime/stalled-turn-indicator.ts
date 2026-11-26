import type { AgentRuntimeEvent } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  redactCredentials,
  truncateCodePointsWithEllipsis,
} from "@lrm/coforge-sdk/internal";
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
  /** The last event that showed work — provider bookkeeping does not count. */
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
  deadlineAtMs: number;
  scheduledForMs: number | undefined;
  watchdog: ReturnType<typeof setTimeout> | undefined;
  warned: boolean;
  rearms: number;
  lastRearmAtMs: number | undefined;
};

type LaunchProgress = Readonly<{ lastEventAtMs: number; lastWorkAtMs?: number }>;

export type StalledTurnLaunch = Readonly<{
  progress?: LaunchProgress;
  toolCalls?: {
    oldestOpenToolStartedAtMs(): number | undefined;
    readonly hasOpenToolCall: boolean;
  };
}>;

export function stalledTurnObservation(launch: StalledTurnLaunch): StalledTurnObservation {
  return {
    turnBusy: true,
    lastEventAtMs: launch.progress?.lastWorkAtMs ?? launch.progress?.lastEventAtMs ?? Date.now(),
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

export function isTurnNeutralEvent(event: Readonly<{ type: string }>): boolean {
  switch (event.type) {
    case "session":
    case "usage":
    case "context-usage":
    case "token-usage":
    case "service-tier":
      return true;
    default:
      return false;
  }
}

export function endsStalledTurn(event: AgentRuntimeEvent, hasLiveTurn: boolean | undefined) {
  if (event.type === "completed") return true;
  if (event.type === "activity") {
    const { detailKind } = event.activity;
    if (TURN_ENDING_DETAIL_KINDS.has(detailKind)) return true;
    if (isBusyActivityDetailKind(detailKind)) return false;
  } else if (showsTurnWork(event) || isTurnNeutralEvent(event)) return false;
  return hasLiveTurn === false;
}

export function stalledTurnSilenceStartAtMs(observation: StalledTurnObservation): number {
  return Math.max(observation.lastEventAtMs, observation.oldestToolStartedAtMs ?? 0);
}

export class StalledTurnTracker {
  readonly #states = new Map<string, StalledTurnState>();

  constructor(
    private readonly onStalled: (agentId: string, indicator: StalledTurnIndicator) => void,
    private readonly silenceMs = STALLED_TURN_SILENCE_MS,
    private readonly now: () => number = Date.now,
    private readonly modelSilenceMs = STALLED_TURN_MODEL_SILENCE_MS,
  ) {}

  observe(agentId: string, observation: StalledTurnObservation): void {
    if (!observation.turnBusy) {
      this.finish(agentId, "turn_not_busy");
      return;
    }
    const window = observation.hasOpenToolCall ? "tool" : "model";
    const thresholdMs = this.#thresholdMs(window);
    if (thresholdMs <= 0) {
      this.finish(agentId, "window_disabled");
      return;
    }
    const startAtMs = stalledTurnSilenceStartAtMs(observation);
    const current = this.#states.get(agentId);
    if (current?.warned && current.startAtMs === startAtMs) return;
    this.#arm(agentId, startAtMs, thresholdMs, window);
  }

  start(agentId: string, observation: StalledTurnObservation): void {
    this.finish(agentId, "new_turn");
    const window = observation.hasOpenToolCall ? "tool" : "model";
    const thresholdMs = this.#thresholdMs(window);
    if (thresholdMs > 0) this.observe(agentId, observation);
    else if (this.silenceMs <= 0 && this.modelSilenceMs <= 0)
      logger.info("Agent runtime turn silence clock disabled", {
        event: "agent_runtime:turn_stalled_disabled",
        agent_id: agentId,
        stalled_window: window,
        threshold_ms: thresholdMs,
        outcome: "disabled",
      });
  }

  finish(agentId: string, reason = "unspecified"): void {
    const state = this.#states.get(agentId);
    if (!state) return;
    if (state.watchdog !== undefined) clearTimeout(state.watchdog);
    this.#states.delete(agentId);
    logger.info("Agent runtime turn silence clock finished", {
      event: "agent_runtime:turn_stalled_finished",
      agent_id: agentId,
      stalled_window: state.window,
      threshold_ms: state.thresholdMs,
      silence_started_at: state.startAtMs,
      fired: state.warned,
      rearms: state.rearms,
      ...(state.lastRearmAtMs === undefined ? {} : { last_rearm_at: state.lastRearmAtMs }),
      reason,
      outcome: "finished",
    });
  }

  #thresholdMs(window: "tool" | "model"): number {
    return window === "tool" ? this.silenceMs : this.modelSilenceMs;
  }

  dispose(agentId: string): void {
    this.finish(agentId, "disposed");
  }

  disposeAll(): void {
    for (const agentId of this.#states.keys()) this.finish(agentId, "disposed");
  }

  #arm(agentId: string, startAtMs: number, thresholdMs: number, window: "tool" | "model"): void {
    const current = this.#states.get(agentId);
    const now = this.now();
    if (
      current !== undefined &&
      !current.warned &&
      current.startAtMs === startAtMs &&
      current.window === window &&
      current.thresholdMs === thresholdMs
    ) {
      current.rearms += 1;
      current.lastRearmAtMs = now;
      return;
    }
    const deadlineAtMs = startAtMs + thresholdMs;
    const delayMs = Math.max(0, deadlineAtMs - now);
    if (current !== undefined && !current.warned) {
      const previousStartedAt = current.startAtMs;
      const previousWindow = current.window;
      current.startAtMs = startAtMs;
      current.thresholdMs = thresholdMs;
      current.window = window;
      current.deadlineAtMs = deadlineAtMs;
      current.rearms += 1;
      current.lastRearmAtMs = now;
      if (
        current.watchdog === undefined ||
        current.scheduledForMs === undefined ||
        deadlineAtMs < current.scheduledForMs
      ) {
        if (current.watchdog !== undefined) clearTimeout(current.watchdog);
        this.#scheduleWatchdog(agentId, current, now, delayMs);
      }
      if (logger.isEnabledFor("debug"))
        logger.debug("Agent runtime turn silence clock moved", {
          event: "agent_runtime:turn_stalled_rearmed",
          agent_id: agentId,
          stalled_window: window,
          threshold_ms: thresholdMs,
          silence_started_at: startAtMs,
          fires_in_ms: delayMs,
          previous_started_at: previousStartedAt,
          previous_window: previousWindow,
          window_changed: previousWindow !== window,
          rearms: current.rearms,
          outcome: "rearmed",
        });
      return;
    }
    if (current?.watchdog !== undefined) clearTimeout(current.watchdog);
    const state: StalledTurnState = {
      startAtMs,
      thresholdMs,
      window,
      deadlineAtMs,
      scheduledForMs: undefined,
      warned: false,
      watchdog: undefined,
      rearms: current === undefined ? 0 : current.rearms + 1,
      lastRearmAtMs: current === undefined ? undefined : now,
    };
    this.#scheduleWatchdog(agentId, state, now, delayMs);
    this.#states.set(agentId, state);
    logger.info("Agent runtime turn silence clock armed", {
      event: "agent_runtime:turn_stalled_armed",
      agent_id: agentId,
      stalled_window: window,
      threshold_ms: thresholdMs,
      silence_started_at: startAtMs,
      fires_in_ms: delayMs,
      outcome: "armed",
    });
  }

  #scheduleWatchdog(agentId: string, state: StalledTurnState, now: number, delayMs: number): void {
    state.scheduledForMs = now + delayMs;
    const timer = setTimeout(() => this.#onWatchdog(agentId), delayMs);
    timer?.unref?.();
    state.watchdog = timer;
  }

  #onWatchdog(agentId: string): void {
    const state = this.#states.get(agentId);
    if (!state || state.warned) return;
    const now = this.now();
    const remaining = state.deadlineAtMs - now;
    if (remaining > 0) {
      this.#scheduleWatchdog(agentId, state, now, Math.min(remaining, state.thresholdMs));
      return;
    }
    state.watchdog = undefined;
    state.scheduledForMs = undefined;
    state.warned = true;
    this.onStalled(agentId, {
      silentForMs: Math.max(0, now - state.startAtMs),
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
    // The line goes first: publishing is what a reader sees on the Agent's page, and a page that
    // failed to update must not be the reason the log is silent about a stalled turn (task #41).
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
    try {
      host.publish(agentId, formatStalledTurnDetail(minutes, openTool?.name));
    } catch (error) {
      logger.error("Agent runtime stall notice failed to publish", {
        event: "agent_runtime:turn_stalled_publish_failed",
        agent_id: agentId,
        launch_id: launch.launchId,
        stalled_window: indicator.window,
        error: error instanceof Error ? error.message : String(error),
        outcome: "failed",
      });
    }
  };
}

function sanitizeStalledToolName(name: string | undefined): string {
  if (!name) return "";
  const redacted = redactCredentials(name);
  let out = "";
  for (let i = 0; i < redacted.length; i += 1) {
    const code = redacted.charCodeAt(i);
    out += code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f) ? " " : redacted[i]!;
  }
  const collapsed = out.replace(/\s+/g, " ").trim();
  return truncateCodePointsWithEllipsis(collapsed, 80);
}

export function formatStalledTurnDetail(minutes: number, openToolName?: string): string {
  const tool = sanitizeStalledToolName(openToolName);
  return tool
    ? `Agent runtime has produced no progress for ${minutes} minutes (stuck on ${tool}).`
    : `Agent runtime has produced no progress for ${minutes} minutes.`;
}
