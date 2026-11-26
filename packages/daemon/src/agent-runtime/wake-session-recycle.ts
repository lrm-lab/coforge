import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { PromptCacheTier, SessionResumeFacts } from "@lrm/coforge-anvil";

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
  minColdGap5mTierMs: "COFORGE_WAKE_RECYCLE_MIN_COLD_GAP_5M_TIER_MS",
  minContextTokensPastTier: "COFORGE_WAKE_RECYCLE_MIN_CONTEXT_TOKENS_PAST_TIER",
  warmMinContextTokens: "COFORGE_WAKE_RECYCLE_WARM_MIN_CONTEXT_TOKENS",
  warmQuietMs: "COFORGE_WAKE_RECYCLE_WARM_QUIET_MS",
  immediateContextTokens: "COFORGE_WAKE_RECYCLE_IMMEDIATE_CONTEXT_TOKENS",
  sweepMs: "COFORGE_WAKE_RECYCLE_SWEEP_MS",
  panelTokens: "COFORGE_WAKE_RECYCLE_PANEL_TOKENS",
} as const;

const DEFAULT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS = 128_000;
const DEFAULT_WAKE_RECYCLE_MIN_COLD_GAP_MS = 60 * 60_000;
const DEFAULT_WAKE_RECYCLE_MIN_COLD_GAP_5M_TIER_MS = 12 * 60_000;
const DEFAULT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS_PAST_TIER = 64_000;
export const DEFAULT_WARM_RECYCLE_MIN_CONTEXT_TOKENS = 250_000;
export const DEFAULT_WARM_RECYCLE_QUIET_MS = 2 * 60_000;
export const DEFAULT_IMMEDIATE_RECYCLE_CONTEXT_TOKENS = 500_000;
const DEFAULT_WAKE_RECYCLE_SWEEP_MS = 10 * 60_000;
const DEFAULT_WAKE_RECYCLE_PANEL_TOKENS = 8_000;

export type WakeRecycleConfig = Readonly<{
  enabled: boolean;
  minContextTokens: number;
  minColdGapMs: number;
  minColdGap5mTierMs: number;
  minContextTokensPastTier: number;
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

export function resolveWakeRecycleConfig(
  agentEnvVars?: Environment,
  processEnv: Environment = Bun.env,
  providerMinColdGapMs?: number,
): WakeRecycleConfig {
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
    minColdGap5mTierMs:
      positiveInteger(pick(WAKE_RECYCLE_ENV.minColdGap5mTierMs)) ??
      DEFAULT_WAKE_RECYCLE_MIN_COLD_GAP_5M_TIER_MS,
    minContextTokensPastTier:
      positiveInteger(pick(WAKE_RECYCLE_ENV.minContextTokensPastTier)) ??
      DEFAULT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS_PAST_TIER,
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
  warmConfig?: WarmRecycleConfig;
  supported: boolean;
  sessionId: string | undefined;
  hasResumePrompt: boolean;
  facts: SessionResumeFacts | undefined;
  nowMs: number;
}>;

type ColdLargeBlocker =
  | "session_facts_unavailable"
  | "cache_possibly_warm"
  | "context_below_threshold";

function effectiveColdThresholds(
  config: WakeRecycleConfig,
  cacheTier: PromptCacheTier | undefined,
  idleMs: number,
): Readonly<{ minColdGapMs: number; minContextTokens: number }> {
  if (!cacheTier) {
    return {
      minColdGapMs: config.minColdGapMs,
      minContextTokens: config.minContextTokens,
    };
  }
  return {
    minColdGapMs:
      cacheTier === "5m"
        ? Math.min(config.minColdGap5mTierMs, config.minColdGapMs)
        : config.minColdGapMs,
    minContextTokens:
      idleMs > config.minColdGapMs
        ? Math.min(config.minContextTokensPastTier, config.minContextTokens)
        : config.minContextTokens,
  };
}

function judgeColdAndLarge(
  config: WakeRecycleConfig,
  nowMs: number,
  lastActiveAtMs: number | undefined,
  contextTokens: number | undefined,
  cacheTier: PromptCacheTier | undefined,
): Readonly<{ idleMs: number; contextTokens: number }> | ColdLargeBlocker {
  if (lastActiveAtMs === undefined || contextTokens === undefined)
    return "session_facts_unavailable";
  const idleMs = nowMs - lastActiveAtMs;
  const thresholds = effectiveColdThresholds(config, cacheTier, idleMs);
  if (idleMs <= thresholds.minColdGapMs) return "cache_possibly_warm";
  if (contextTokens <= thresholds.minContextTokens) return "context_below_threshold";
  return { idleMs, contextTokens };
}

export function decideWakeRecycle(input: WakeRecycleInput): WakeRecycleDecision {
  const { config, warmConfig } = input;
  if (!config.enabled) return { action: "resume", reason: "disabled" };
  if (!input.supported) return { action: "resume", reason: "unsupported" };
  if (!input.sessionId) return { action: "resume", reason: "no_prior_session" };
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
  const verdict = judgeColdAndLarge(
    config,
    input.nowMs,
    lastActiveAtMs,
    contextTokens,
    input.facts?.cacheTier,
  );
  if (typeof verdict === "string") return { action: "resume", reason: verdict };
  return {
    action: "recycle",
    priorSessionId: input.sessionId,
    idleMs: verdict.idleMs,
    priorContextTokens: verdict.contextTokens,
  };
}

export function composeWakeSections(...sections: ReadonlyArray<string | undefined>): string {
  return sections.filter((section) => section !== undefined && section.length > 0).join("\n\n");
}

export function describeRecycledSession(idleMs: number, contextTokens: number): string {
  return `idle ${Math.round(idleMs / 60_000)}m, ~${Math.round(contextTokens / 1000)}k context`;
}

export type ColdIdleSweepView = Readonly<{
  agentId: string;
  provider: RuntimeProvider;
  envVars?: Readonly<Record<string, string>>;
  busyReason: string | undefined;
  supported: boolean;
  providerMinColdGapMs?: number;
  sessionId: string | undefined;
  lastEventAtMs: number | undefined;
  lastContextTokens?: number;
  lastCacheTier?: PromptCacheTier;
}>;

export type ColdIdleStop = Readonly<{
  agentId: string;
  sessionId: string;
  idleMs: number;
  priorContextTokens: number;
  reason?: "idle_process";
}>;

type ColdIdleSelectionOptions = Readonly<{
  nowMs: number;
  processEnv?: Environment;
  warmConfig?: boolean | WarmRecycleConfig;
  readFacts(view: ColdIdleSweepView, sessionId: string): Promise<SessionResumeFacts | undefined>;
  onSkip?(agentId: string, reason: string): void;
}>;

const COLD_IDLE_READ_CONCURRENCY = 4;

type ColdIdleCandidate = Readonly<{
  view: ColdIdleSweepView;
  sessionId: string;
  lastEventAtMs: number;
  isCodex: boolean;
  config: WakeRecycleConfig;
  warm: WarmRecycleConfig | undefined;
}>;

export async function selectColdIdleStops(
  views: readonly ColdIdleSweepView[],
  options: ColdIdleSelectionOptions,
): Promise<ColdIdleStop[]> {
  const candidates: ColdIdleCandidate[] = [];
  for (const view of views) {
    const skip = (reason: string) => options.onSkip?.(view.agentId, reason);
    const isCodex = view.provider === RUNTIME_PROVIDER.CODEX;
    const config = resolveWakeRecycleConfig(
      view.envVars,
      options.processEnv,
      view.providerMinColdGapMs,
    );
    const preReadColdGapMs =
      view.lastCacheTier === "5m"
        ? Math.min(config.minColdGap5mTierMs, config.minColdGapMs)
        : config.minColdGapMs;
    const warm =
      options.warmConfig !== undefined && options.warmConfig !== false
        ? typeof options.warmConfig === "object"
          ? options.warmConfig
          : resolveWarmRecycleConfig(view.envVars, options.processEnv)
        : isCodex || view.lastContextTokens !== undefined
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
    else if (!warmImmediate && !warmQuiet && eventIdleMs <= preReadColdGapMs) skip("recent_event");
    else
      candidates.push({
        view,
        sessionId: view.sessionId,
        lastEventAtMs: view.lastEventAtMs,
        isCodex,
        config,
        warm,
      });
  }
  const factsByCandidate = new Map<number, SessionResumeFacts | undefined>();
  if (candidates.length > 0) {
    let nextIndex = 0;
    const workerCount = Math.min(COLD_IDLE_READ_CONCURRENCY, candidates.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < candidates.length) {
          const index = nextIndex++;
          const candidate = candidates[index]!;
          const facts = await options
            .readFacts(candidate.view, candidate.sessionId)
            .catch(() => undefined);
          factsByCandidate.set(index, facts);
        }
      }),
    );
  }
  const stops: ColdIdleStop[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const { view, sessionId, lastEventAtMs, isCodex, config, warm } = candidates[index]!;
    const facts = factsByCandidate.get(index);
    const lastActiveAtMs =
      facts?.lastActivityAtMs === undefined
        ? undefined
        : Math.max(facts.lastActivityAtMs, lastEventAtMs);
    const contextTokens = isCodex
      ? facts?.lastContextTokens
      : facts && (view.lastContextTokens ?? facts.lastContextTokens);
    if (warm && lastActiveAtMs !== undefined && contextTokens !== undefined) {
      const idleMs = options.nowMs - lastActiveAtMs;
      if (
        (idleMs >= 0 && contextTokens > warm.immediateContextTokens) ||
        (idleMs > warm.warmQuietMs && contextTokens > warm.warmMinContextTokens)
      ) {
        stops.push({
          agentId: view.agentId,
          sessionId,
          idleMs,
          priorContextTokens: contextTokens,
        });
        continue;
      }
    }
    const verdict = judgeColdAndLarge(
      config,
      options.nowMs,
      lastActiveAtMs,
      contextTokens,
      facts?.cacheTier ?? view.lastCacheTier,
    );
    if (typeof verdict !== "string") {
      stops.push({
        agentId: view.agentId,
        sessionId,
        idleMs: verdict.idleMs,
        priorContextTokens: verdict.contextTokens,
      });
    } else if (
      verdict === "context_below_threshold" &&
      isCodex &&
      lastActiveAtMs !== undefined &&
      contextTokens !== undefined
    ) {
      stops.push({
        agentId: view.agentId,
        sessionId,
        idleMs: options.nowMs - lastActiveAtMs,
        priorContextTokens: contextTokens,
        reason: "idle_process",
      });
    } else {
      options.onSkip?.(
        view.agentId,
        verdict === "cache_possibly_warm" ? "recent_activity" : verdict,
      );
    }
  }
  return stops;
}
