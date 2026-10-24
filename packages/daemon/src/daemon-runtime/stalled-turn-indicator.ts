import type { AgentRuntimeEvent } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** Default silence window before a busy turn gets a visible stalled indicator. */
export const STALLED_TURN_SILENCE_MS = 10 * 60_000;
export const STALLED_TURN_SILENCE_ENV = "COFORGE_STALLED_TURN_SILENCE_MS";

/** Resolves the per-launch silence window; an explicit zero disables the indicator. */
export function stalledTurnSilenceMs(
  launchEnv: Readonly<Record<string, string>> | undefined,
  daemonEnv: Readonly<Record<string, string | undefined>> = Bun.env,
): number {
  const raw = launchEnv?.[STALLED_TURN_SILENCE_ENV] ?? daemonEnv[STALLED_TURN_SILENCE_ENV];
  if (raw === undefined || raw.trim() === "") return STALLED_TURN_SILENCE_MS;
  if (!/^\d+$/.test(raw.trim())) return STALLED_TURN_SILENCE_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : STALLED_TURN_SILENCE_MS;
}

export type StalledTurnObservation = Readonly<{
  /** The provider still reports a live turn. */
  turnBusy: boolean;
  /** The last raw provider event observed by the daemon. */
  lastEventAtMs: number;
  /** The oldest open tool's start time, when a tool is still running. */
  oldestToolStartedAtMs?: number;
  /** At least one tool call remains open; model-only silence is not a stalled tool. */
  hasOpenToolCall: boolean;
}>;

export type StalledTurnIndicator = Readonly<{
  silentForMs: number;
}>;

type StalledTurnState = {
  startAtMs: number;
  watchdog: ReturnType<typeof setTimeout> | undefined;
  warned: boolean;
};

/** The slice of a launch the silence clock reads. */
export type StalledTurnLaunch = Readonly<{
  progress?: { readonly lastEventAtMs: number };
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

/** Whether this provider event, or a session that no longer holds a live turn, ends the turn. */
export function endsStalledTurn(event: AgentRuntimeEvent, hasLiveTurn: boolean | undefined) {
  return (
    event.type === "completed" ||
    hasLiveTurn === false ||
    (event.type === "activity" && TURN_ENDING_DETAIL_KINDS.has(event.activity.detailKind))
  );
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
  ) {}

  /** Starts or resets the current turn's silence clock after a raw provider event. */
  observe(agentId: string, observation: StalledTurnObservation): void {
    if (this.silenceMs <= 0 || !observation.turnBusy || !observation.hasOpenToolCall) {
      this.finish(agentId);
      return;
    }
    const startAtMs = stalledTurnSilenceStartAtMs(observation);
    const current = this.#states.get(agentId);
    if (current?.warned && current.startAtMs === startAtMs) return;
    this.#arm(agentId, startAtMs);
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

  #arm(agentId: string, startAtMs: number): void {
    const current = this.#states.get(agentId);
    if (current?.watchdog !== undefined) clearTimeout(current.watchdog);
    const delayMs = Math.max(0, startAtMs + this.silenceMs - this.now());
    const state: StalledTurnState = {
      startAtMs,
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
    this.onStalled(agentId, { silentForMs: Math.max(0, this.now() - startAtMs) });
  }
}

/**
 * The tracker callback for one launch: shows the stalled turn as an error Activity and logs it,
 * unless the launch is no longer the current one or is stopping.
 */
export function stalledTurnNotice(
  launch: Readonly<{ launchId: string; stopping?: boolean }>,
  host: Readonly<{
    isCurrent(agentId: string): boolean;
    publish(agentId: string, detail: string): void;
  }>,
): (agentId: string, indicator: StalledTurnIndicator) => void {
  return (agentId, indicator) => {
    if (!host.isCurrent(agentId) || launch.stopping) return;
    const minutes = Math.max(1, Math.round(indicator.silentForMs / 60_000));
    host.publish(agentId, `Agent runtime has produced no progress for ${minutes} minutes.`);
    logger.warning("Agent runtime turn has stalled", {
      event: "agent_runtime:turn_stalled",
      agent_id: agentId,
      launch_id: launch.launchId,
      silent_for_ms: indicator.silentForMs,
      outcome: "indicator",
    });
  };
}
