import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { SessionResumeFacts } from "#src/code-agent/contract";

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
  sweepMs: "COFORGE_WAKE_RECYCLE_SWEEP_MS",
  panelTokens: "COFORGE_WAKE_RECYCLE_PANEL_TOKENS",
  memoryTokens: "COFORGE_WAKE_RECYCLE_MEMORY_TOKENS",
} as const;

const DEFAULT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS = 128_000;
/** The reference client's cold gap: past the longest prompt-cache lifetime it counts on. */
const DEFAULT_WAKE_RECYCLE_MIN_COLD_GAP_MS = 60 * 60_000;
const DEFAULT_WAKE_RECYCLE_SWEEP_MS = 10 * 60_000;
const DEFAULT_WAKE_RECYCLE_PANEL_TOKENS = 8_000;
const DEFAULT_WAKE_RECYCLE_MEMORY_TOKENS = 4_000;

export type WakeRecycleConfig = Readonly<{
  enabled: boolean;
  minContextTokens: number;
  minColdGapMs: number;
  /** Token budget of the provider's briefing. */
  panelTokens: number;
  /** Token budget of the MEMORY.md block. */
  memoryTokens: number;
}>;

/** Roughly four characters (or bytes) to a token, as the reference client estimates. */
export const CHARS_PER_TOKEN = 4;

/** The tokens `size` characters (or bytes) come to, at least one. */
export function estimateTokens(size: number): number {
  return Math.max(1, Math.floor((size + CHARS_PER_TOKEN - 1) / CHARS_PER_TOKEN));
}

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

/**
 * On by default. An Agent's own runtime variables override the daemon's process environment, as
 * the reference client's `pick` does; an unparseable value falls back to the default.
 */
export function resolveWakeRecycleConfig(
  agentEnvVars?: Environment,
  processEnv: Environment = Bun.env,
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
      positiveInteger(pick(WAKE_RECYCLE_ENV.minColdGapMs)) ?? DEFAULT_WAKE_RECYCLE_MIN_COLD_GAP_MS,
    panelTokens:
      positiveInteger(pick(WAKE_RECYCLE_ENV.panelTokens)) ?? DEFAULT_WAKE_RECYCLE_PANEL_TOKENS,
    memoryTokens:
      positiveInteger(pick(WAKE_RECYCLE_ENV.memoryTokens)) ?? DEFAULT_WAKE_RECYCLE_MEMORY_TOKENS,
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
  const { config } = input;
  if (!config.enabled) return { action: "resume", reason: "disabled" };
  if (!input.supported) return { action: "resume", reason: "unsupported" };
  if (!input.sessionId) return { action: "resume", reason: "no_prior_session" };
  // A user's explicit guidance for this launch belongs to the session it was written for.
  if (input.hasResumePrompt) return { action: "resume", reason: "explicit_resume_prompt" };
  const verdict = judgeColdAndLarge(
    config,
    input.nowMs,
    input.facts?.lastActivityAtMs,
    input.facts?.lastContextTokens,
  );
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
  sessionId: string | undefined;
  /** When the runtime last reported an event; the clock from which its silence is measured. */
  lastEventAtMs: number | undefined;
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
  readFacts(view: ColdIdleSweepView, sessionId: string): Promise<SessionResumeFacts | undefined>;
  /** Called once per Agent that is not stopped, with why (a busy reason or a skip reason). */
  onSkip?(agentId: string, reason: string): void;
}>;

/**
 * The Agents whose runtime should be stopped: idle by the daemon's own state, silent for longer
 * than the cold gap by both the runtime's last event and the session's own record, and carrying
 * more than the context threshold. Anything unknown is a skip, never a stop.
 */
export async function selectColdIdleStops(
  views: readonly ColdIdleSweepView[],
  options: ColdIdleSelectionOptions,
): Promise<ColdIdleStop[]> {
  const stops: ColdIdleStop[] = [];
  for (const view of views) {
    const skip = (reason: string) => options.onSkip?.(view.agentId, reason);
    const config = resolveWakeRecycleConfig(view.envVars, options.processEnv);
    if (!config.enabled) skip("disabled");
    else if (view.busyReason !== undefined) skip(view.busyReason);
    else if (!view.supported) skip("unsupported");
    else if (!view.sessionId || view.lastEventAtMs === undefined) skip("no_session");
    else if (options.nowMs - view.lastEventAtMs <= config.minColdGapMs) skip("recent_event");
    else {
      const facts = await options.readFacts(view, view.sessionId).catch(() => undefined);
      const verdict = judgeColdAndLarge(
        config,
        options.nowMs,
        facts?.lastActivityAtMs === undefined
          ? undefined
          : Math.max(facts.lastActivityAtMs, view.lastEventAtMs),
        facts?.lastContextTokens,
      );
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
