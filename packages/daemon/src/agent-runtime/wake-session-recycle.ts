import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { SessionResumeFacts } from "@lrm/coforge-anvil";

/**
 * Idle recycle of a long, cold native session, as the reference client does at wake
 * (`wakeSessionRecycle`, 1.0.51): a session that has been idle past the prompt-cache window and
 * carries a large context is not resumed, since resuming re-reads all of it at full price. The
 * Agent starts a fresh session instead, whose first input is a briefing. This module is
 * provider-neutral: the session facts come from the provider seam (`readSessionResumeFacts`).
 */

const WAKE_RECYCLE_ENV = {
  enabled: "COFORGE_WAKE_RECYCLE",
  minContextTokens: "COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS",
  minColdGapMs: "COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_MS",
  warmMinContextTokens: "COFORGE_WAKE_RECYCLE_WARM_MIN_CONTEXT_TOKENS",
  warmQuietMs: "COFORGE_WAKE_RECYCLE_WARM_QUIET_MS",
  immediateContextTokens: "COFORGE_WAKE_RECYCLE_IMMEDIATE_CONTEXT_TOKENS",
  sweepMs: "COFORGE_WAKE_RECYCLE_SWEEP_MS",
  panelTokens: "COFORGE_WAKE_RECYCLE_PANEL_TOKENS",
} as const;

const DEFAULT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS = 128_000;
/** The reference client's cold gap: past the longest prompt-cache lifetime it counts on. */
const DEFAULT_WAKE_RECYCLE_MIN_COLD_GAP_MS = 60 * 60_000;
export const DEFAULT_WARM_RECYCLE_MIN_CONTEXT_TOKENS = 250_000;
export const DEFAULT_WARM_RECYCLE_QUIET_MS = 2 * 60_000;
export const DEFAULT_IMMEDIATE_RECYCLE_CONTEXT_TOKENS = 500_000;
const DEFAULT_WAKE_RECYCLE_SWEEP_MS = 10 * 60_000;
const DEFAULT_WAKE_RECYCLE_PANEL_TOKENS = 8_000;

export type WakeRecycleConfig = Readonly<{
  enabled: boolean;
  minContextTokens: number;
  minColdGapMs: number;
  /** Token budget of the provider's briefing. The memory block's two shares are the same for
   * every fresh session (`STARTUP_MEMORY_BUDGET_TOKENS` and
   * `STARTUP_ACTIVE_CONTEXT_BUDGET_TOKENS`), never a recycle-only setting. */
  panelTokens: number;
}>;

export type WarmRecycleConfig = Readonly<{
  warmMinContextTokens: number;
  warmQuietMs: number;
  immediateContextTokens: number;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function disabledFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}

function positiveGap(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * On by default. An Agent's own runtime variables override the daemon's process environment, as
 * the reference client's `pick` does; an unparseable value falls back to the default. The cold
 * gap falls through to the provider's declared prompt-cache lifetime, then to 60 minutes.
 */
export function resolveWakeRecycleConfig(
  agentEnvVars?: Environment,
  processEnv: Environment = Bun.env,
  providerMinColdGapMs?: number,
): WakeRecycleConfig {
  // An empty value counts as unset, at either level.
  const set = (value: string | undefined) => (value?.trim() ? value : undefined);
  const pick = (key: string) => set(agentEnvVars?.[key]) ?? set(processEnv[key]);
  return {
    enabled: !disabledFlag(pick(WAKE_RECYCLE_ENV.enabled)),
    minContextTokens:
      positiveInteger(pick(WAKE_RECYCLE_ENV.minContextTokens)) ??
      DEFAULT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS,
    minColdGapMs:
      positiveInteger(pick(WAKE_RECYCLE_ENV.minColdGapMs)) ??
      positiveGap(providerMinColdGapMs) ??
      DEFAULT_WAKE_RECYCLE_MIN_COLD_GAP_MS,
    panelTokens:
      positiveInteger(pick(WAKE_RECYCLE_ENV.panelTokens)) ?? DEFAULT_WAKE_RECYCLE_PANEL_TOKENS,
  };
}

export function resolveWarmRecycleConfig(
  agentEnvVars?: Environment,
  processEnv: Environment = Bun.env,
): WarmRecycleConfig {
  const set = (value: string | undefined) => (value?.trim() ? value : undefined);
  const pick = (key: string) => set(agentEnvVars?.[key]) ?? set(processEnv[key]);
  return {
    warmMinContextTokens:
      positiveInteger(pick(WAKE_RECYCLE_ENV.warmMinContextTokens)) ??
      DEFAULT_WARM_RECYCLE_MIN_CONTEXT_TOKENS,
    warmQuietMs:
      positiveInteger(pick(WAKE_RECYCLE_ENV.warmQuietMs)) ?? DEFAULT_WARM_RECYCLE_QUIET_MS,
    immediateContextTokens:
      positiveInteger(pick(WAKE_RECYCLE_ENV.immediateContextTokens)) ??
      DEFAULT_IMMEDIATE_RECYCLE_CONTEXT_TOKENS,
  };
}

/** The sweep period belongs to the daemon, not to one Agent: the process environment only. */
export function resolveWakeRecycleSweepMs(processEnv: Environment = Bun.env): number {
  return positiveInteger(processEnv[WAKE_RECYCLE_ENV.sweepMs]) ?? DEFAULT_WAKE_RECYCLE_SWEEP_MS;
}

export type WakeResumeReason =
  | "disabled"
  | "unsupported"
  | "no_prior_session"
  | "explicit_resume_prompt"
  | "session_facts_unavailable"
  | "cache_possibly_warm"
  | "context_below_threshold";

type WakeRecycleDecision =
  | Readonly<{ action: "resume"; reason: WakeResumeReason }>
  | Readonly<{
      action: "recycle";
      priorSessionId: string;
      idleMs: number;
      priorContextTokens: number;
    }>;

export type WakeRecycleInput = Readonly<{
  config: WakeRecycleConfig;
  /** Optional warm/immediate bloat thresholds (>250k after 2m quiet, >500k immediate). */
  warmConfig?: WarmRecycleConfig;
  /** The provider can read a session's facts and build a briefing. */
  supported: boolean;
  /** The session the launch would resume. */
  sessionId: string | undefined;
  hasResumePrompt: boolean;
  /** `undefined` when the provider could not read the session at all. */
  facts: SessionResumeFacts | undefined;
  nowMs: number;
}>;

/** Why a session is not cold and large: the facts are missing, or it is not idle long enough, or
 * its context is not big enough. */
type ColdLargeBlocker =
  | "session_facts_unavailable"
  | "cache_possibly_warm"
  | "context_below_threshold";

/**
 * The one policy of both the wake and the sweep: a session is cold and large when it has been idle
 * for more than the cold gap and its last context is above the threshold. Facts that are missing
 * are never cold and large. Returns the idle time and context, or what blocks it.
 */
function judgeColdAndLarge(
  config: WakeRecycleConfig,
  nowMs: number,
  lastActiveAtMs: number | undefined,
  contextTokens: number | undefined,
): Readonly<{ idleMs: number; contextTokens: number }> | ColdLargeBlocker {
  if (lastActiveAtMs === undefined || contextTokens === undefined)
    return "session_facts_unavailable";
  const idleMs = nowMs - lastActiveAtMs;
  if (idleMs <= config.minColdGapMs) return "cache_possibly_warm";
  if (contextTokens <= config.minContextTokens) return "context_below_threshold";
  return { idleMs, contextTokens };
}

/** Resume the session, or start a fresh one with a briefing: the reference client's one decision. */
export function decideWakeRecycle(input: WakeRecycleInput): WakeRecycleDecision {
  const { config, warmConfig } = input;
  if (!config.enabled) return { action: "resume", reason: "disabled" };
  if (!input.supported) return { action: "resume", reason: "unsupported" };
  if (!input.sessionId) return { action: "resume", reason: "no_prior_session" };
  // A user's explicit guidance for this launch belongs to the session it was written for.
  if (input.hasResumePrompt) return { action: "resume", reason: "explicit_resume_prompt" };
  const lastActiveAtMs = input.facts?.lastActivityAtMs;
  const contextTokens = input.facts?.lastContextTokens;
  if (warmConfig && lastActiveAtMs !== undefined && contextTokens !== undefined) {
    const idleMs = input.nowMs - lastActiveAtMs;
    if (
      (idleMs >= 0 && contextTokens > warmConfig.immediateContextTokens) ||
      (idleMs > warmConfig.warmQuietMs && contextTokens > warmConfig.warmMinContextTokens)
    ) {
      return {
        action: "recycle",
        priorSessionId: input.sessionId,
        idleMs,
        priorContextTokens: contextTokens,
      };
    }
  }
  const verdict = judgeColdAndLarge(config, input.nowMs, lastActiveAtMs, contextTokens);
  if (typeof verdict === "string") return { action: "resume", reason: verdict };
  return {
    action: "recycle",
    priorSessionId: input.sessionId,
    idleMs: verdict.idleMs,
    priorContextTokens: verdict.contextTokens,
  };
}

/** Joins the non-empty sections of a wake input with a blank line, as the reference client does. */
export function composeWakeSections(...sections: ReadonlyArray<string | undefined>): string {
  return sections.filter((section) => section !== undefined && section.length > 0).join("\n\n");
}

/** "73m" or "~412k": how a recycle names the idle time and the context it retires. */
export function describeRecycledSession(idleMs: number, contextTokens: number): string {
  return `idle ${Math.round(idleMs / 60_000)}m, ~${Math.round(contextTokens / 1000)}k context`;
}

/** One live Agent as a sweep sees it. */
export type ColdIdleSweepView = Readonly<{
  agentId: string;
  provider: RuntimeProvider;
  envVars?: Readonly<Record<string, string>>;
  /** Why the daemon cannot call the Agent idle, or `undefined` when it can. */
  busyReason: string | undefined;
  /** The provider can read a session's facts. */
  supported: boolean;
  /** The provider's prompt-cache lifetime, when it declares one. */
  providerMinColdGapMs?: number;
  sessionId: string | undefined;
  /** When the runtime last reported an event; the clock from which its silence is measured. */
  lastEventAtMs: number | undefined;
  /** Live context tokens observed on the running session, enabling warm/immediate recycle stops. */
  lastContextTokens?: number;
}>;

export type ColdIdleStop = Readonly<{
  agentId: string;
  sessionId: string;
  idleMs: number;
  priorContextTokens: number;
}>;

type ColdIdleSelectionOptions = Readonly<{
  nowMs: number;
  processEnv?: Environment;
  warmConfig?: boolean | WarmRecycleConfig;
  readFacts(view: ColdIdleSweepView, sessionId: string): Promise<SessionResumeFacts | undefined>;
  /** Called once per Agent that is not stopped, with why (a busy reason or a skip reason). */
  onSkip?(agentId: string, reason: string): void;
}>;

/**
 * The Agents whose runtime should be stopped: idle by the daemon's own state, silent for longer
 * than the cold gap (or eligible for warm/immediate bloat recycle when live context tokens exceed
 * threshold), and carrying more than the context threshold. Anything unknown is a skip, never a stop.
 */
export async function selectColdIdleStops(
  views: readonly ColdIdleSweepView[],
  options: ColdIdleSelectionOptions,
): Promise<ColdIdleStop[]> {
  const stops: ColdIdleStop[] = [];
  for (const view of views) {
    const skip = (reason: string) => options.onSkip?.(view.agentId, reason);
    const config = resolveWakeRecycleConfig(
      view.envVars,
      options.processEnv,
      view.providerMinColdGapMs,
    );
    const warm =
      options.warmConfig !== undefined && options.warmConfig !== false
        ? typeof options.warmConfig === "object"
          ? options.warmConfig
          : resolveWarmRecycleConfig(view.envVars, options.processEnv)
        : view.lastContextTokens !== undefined
          ? resolveWarmRecycleConfig(view.envVars, options.processEnv)
          : undefined;
    const eventIdleMs =
      view.lastEventAtMs === undefined ? undefined : options.nowMs - view.lastEventAtMs;
    const warmImmediate =
      warm !== undefined &&
      view.lastContextTokens !== undefined &&
      view.lastContextTokens > warm.immediateContextTokens &&
      eventIdleMs !== undefined &&
      eventIdleMs >= 0;
    const warmQuiet =
      warm !== undefined &&
      eventIdleMs !== undefined &&
      eventIdleMs > warm.warmQuietMs &&
      (options.warmConfig !== undefined && options.warmConfig !== false
        ? view.lastContextTokens === undefined || view.lastContextTokens > warm.warmMinContextTokens
        : view.lastContextTokens !== undefined &&
          view.lastContextTokens > warm.warmMinContextTokens);
    if (!config.enabled) skip("disabled");
    else if (view.busyReason !== undefined) skip(view.busyReason);
    else if (!view.supported) skip("unsupported");
    else if (!view.sessionId || view.lastEventAtMs === undefined || eventIdleMs === undefined)
      skip("no_session");
    else if (!warmImmediate && !warmQuiet && eventIdleMs <= config.minColdGapMs)
      skip("recent_event");
    else {
      const facts = await options.readFacts(view, view.sessionId).catch(() => undefined);
      const lastActiveAtMs =
        facts?.lastActivityAtMs === undefined
          ? undefined
          : Math.max(facts.lastActivityAtMs, view.lastEventAtMs);
      const contextTokens =
        facts === undefined ? undefined : (view.lastContextTokens ?? facts.lastContextTokens);
      if (warm && lastActiveAtMs !== undefined && contextTokens !== undefined) {
        const idleMs = options.nowMs - lastActiveAtMs;
        if (
          (idleMs >= 0 && contextTokens > warm.immediateContextTokens) ||
          (idleMs > warm.warmQuietMs && contextTokens > warm.warmMinContextTokens)
        ) {
          stops.push({
            agentId: view.agentId,
            sessionId: view.sessionId,
            idleMs,
            priorContextTokens: contextTokens,
          });
          continue;
        }
      }
      const verdict = judgeColdAndLarge(config, options.nowMs, lastActiveAtMs, contextTokens);
      if (typeof verdict === "string")
        skip(verdict === "cache_possibly_warm" ? "recent_activity" : verdict);
      else
        stops.push({
          agentId: view.agentId,
          sessionId: view.sessionId,
          idleMs: verdict.idleMs,
          priorContextTokens: verdict.contextTokens,
        });
    }
  }
  return stops;
}
