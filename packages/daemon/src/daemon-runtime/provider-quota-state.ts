import { getLogger } from "@logtape/logtape";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { UsageQuotaLevel, UsageSnapshot, UsageWindow } from "@lrm/coforge-anvil";
import { currentObservedUsage } from "./runtime-usage-observation";
import { rememberUsage } from "./usage-memory";

const logger = getLogger(["coforge", "daemon", "quota"]);

export const QUOTA_STATE_TTL_MS = 6 * 60 * 60 * 1_000;
const WARNING_PERCENT = 75;
const NEAR_EXHAUSTED_PERCENT = 90;

export type QuotaWindowKey = "primary" | "secondary";

export type ActiveQuotaPressure = Readonly<{
  provider: RuntimeProvider;
  window: QuotaWindowKey;
  windowDurationMinutes: number;
  level: Exclude<UsageQuotaLevel, "ok">;
  usedPercent?: number;
  resetsAt?: string;
  observedAtMs: number;
}>;

export type QuotaPressureTransition = Readonly<{
  agentId: string;
  provider: RuntimeProvider;
  window: QuotaWindowKey;
  previousLevel: UsageQuotaLevel;
  level: UsageQuotaLevel;
  usedPercent?: number;
  resetsAt?: string;
}>;

type QuotaEntry = Readonly<{
  provider: RuntimeProvider;
  window: QuotaWindowKey;
  windowDurationMinutes: number;
  level: Exclude<UsageQuotaLevel, "ok">;
  usedPercent?: number;
  resetsAt?: string;
  resetsAtMs?: number;
  observedAtMs: number;
}>;

const SEVERITY: Readonly<Record<UsageQuotaLevel, number>> = {
  ok: 0,
  warning: 1,
  near_exhausted: 2,
  exhausted: 3,
};

function classifyWindow(window: UsageWindow): UsageQuotaLevel {
  if (window.status === "limit_reached" || window.quotaLevel === "exhausted") return "exhausted";
  if (
    window.quotaLevel === "near_exhausted" ||
    (window.usedPercent !== undefined && window.usedPercent >= NEAR_EXHAUSTED_PERCENT)
  )
    return "near_exhausted";
  if (
    window.quotaLevel === "warning" ||
    (window.usedPercent !== undefined && window.usedPercent >= WARNING_PERCENT)
  )
    return "warning";
  return "ok";
}

function isExpired(entry: QuotaEntry, nowMs: number): boolean {
  if (nowMs - entry.observedAtMs > QUOTA_STATE_TTL_MS) return true;
  if (entry.resetsAtMs !== undefined && entry.resetsAtMs <= nowMs) return true;
  return false;
}

function samePressureReading(
  existing: QuotaEntry,
  provider: RuntimeProvider,
  level: Exclude<UsageQuotaLevel, "ok">,
  window: UsageWindow,
): boolean {
  return (
    existing.provider === provider &&
    existing.level === level &&
    existing.usedPercent === window.usedPercent &&
    existing.resetsAt === window.resetsAt &&
    existing.windowDurationMinutes === window.windowDurationMinutes
  );
}

function isMoreSevere(candidate: QuotaEntry, current: ActiveQuotaPressure): boolean {
  const diff = SEVERITY[candidate.level] - SEVERITY[current.level];
  if (diff !== 0) return diff > 0;
  return (candidate.usedPercent ?? -1) > (current.usedPercent ?? -1);
}

export class ProviderQuotaState {
  readonly #now: () => number;
  readonly #onTransition?: (transition: QuotaPressureTransition) => void;
  readonly #observedUsage = new Map<RuntimeProvider, UsageSnapshot>();
  readonly #byAgent = new Map<string, Map<QuotaWindowKey, QuotaEntry>>();

  constructor(
    options: Readonly<{
      now?: () => number;
      onTransition?: (transition: QuotaPressureTransition) => void;
    }> = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#onTransition = options.onTransition;
  }

  observe(agentId: string, snapshot: UsageSnapshot): void {
    const nowMs = this.#now();
    rememberUsage(this.#observedUsage, snapshot, nowMs);
    this.#pruneOtherProvider(agentId, snapshot.provider);
    this.#observeWindow(agentId, snapshot.provider, "primary", snapshot.primary, nowMs);
    this.#observeWindow(agentId, snapshot.provider, "secondary", snapshot.secondary, nowMs);
  }

  observedUsage(provider: RuntimeProvider): UsageSnapshot | undefined {
    return currentObservedUsage(this.#observedUsage, provider, this.#now());
  }

  summaryForAgent(agentId: string, provider?: RuntimeProvider): ActiveQuotaPressure | undefined {
    const windows = this.#byAgent.get(agentId);
    if (!windows) return undefined;
    const nowMs = this.#now();
    let worst: ActiveQuotaPressure | undefined;
    for (const [key, entry] of windows) {
      if (isExpired(entry, nowMs)) {
        windows.delete(key);
        continue;
      }
      if (provider !== undefined && entry.provider !== provider) continue;
      if (!worst || isMoreSevere(entry, worst)) {
        worst = {
          provider: entry.provider,
          window: entry.window,
          windowDurationMinutes: entry.windowDurationMinutes,
          level: entry.level,
          ...(entry.usedPercent !== undefined ? { usedPercent: entry.usedPercent } : {}),
          ...(entry.resetsAt ? { resetsAt: entry.resetsAt } : {}),
          observedAtMs: entry.observedAtMs,
        };
      }
    }
    if (windows.size === 0) this.#byAgent.delete(agentId);
    return worst;
  }

  forgetAgent(agentId: string): void {
    this.#byAgent.delete(agentId);
  }

  #pruneOtherProvider(agentId: string, provider: RuntimeProvider): void {
    const windows = this.#byAgent.get(agentId);
    if (!windows) return;
    for (const [key, entry] of windows) {
      if (entry.provider !== provider) windows.delete(key);
    }
    if (windows.size === 0) this.#byAgent.delete(agentId);
  }

  #pruneExpiredAll(nowMs: number): void {
    for (const [agentId, windows] of this.#byAgent) {
      for (const [key, entry] of windows) {
        if (isExpired(entry, nowMs)) windows.delete(key);
      }
      if (windows.size === 0) this.#byAgent.delete(agentId);
    }
  }

  #observeWindow(
    agentId: string,
    provider: RuntimeProvider,
    windowKey: QuotaWindowKey,
    window: UsageWindow | undefined,
    nowMs: number,
  ): void {
    if (!window) return;
    const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : undefined;
    const validResetMs =
      resetsAtMs !== undefined && Number.isFinite(resetsAtMs) ? resetsAtMs : undefined;
    if (validResetMs !== undefined && validResetMs <= nowMs) return;

    const existingMap = this.#byAgent.get(agentId);
    const rawExisting = existingMap?.get(windowKey);
    const existing = rawExisting && !isExpired(rawExisting, nowMs) ? rawExisting : undefined;
    if (rawExisting && !existing && existingMap) {
      existingMap.delete(windowKey);
      if (existingMap.size === 0) this.#byAgent.delete(agentId);
    }
    const previousLevel: UsageQuotaLevel = existing ? existing.level : "ok";
    const level = classifyWindow(window);

    if (level === "ok") {
      if (!existing) return;
      if (existingMap) {
        existingMap.delete(windowKey);
        if (existingMap.size === 0) this.#byAgent.delete(agentId);
      }
      this.#emitTransition({
        agentId,
        provider,
        window: windowKey,
        previousLevel,
        level: "ok",
        ...(window.usedPercent !== undefined ? { usedPercent: window.usedPercent } : {}),
        ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
      });
      return;
    }

    if (existing && samePressureReading(existing, provider, level, window)) return;

    this.#pruneExpiredAll(nowMs);
    let windows = this.#byAgent.get(agentId);
    if (!windows) {
      windows = new Map();
      this.#byAgent.set(agentId, windows);
    }
    windows.set(windowKey, {
      provider,
      window: windowKey,
      windowDurationMinutes: window.windowDurationMinutes,
      level,
      ...(window.usedPercent !== undefined ? { usedPercent: window.usedPercent } : {}),
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
      ...(validResetMs !== undefined ? { resetsAtMs: validResetMs } : {}),
      observedAtMs: nowMs,
    });

    if (previousLevel === level) return;
    this.#emitTransition({
      agentId,
      provider,
      window: windowKey,
      previousLevel,
      level,
      ...(window.usedPercent !== undefined ? { usedPercent: window.usedPercent } : {}),
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
    });
  }

  #emitTransition(transition: QuotaPressureTransition): void {
    this.#onTransition?.(transition);
    if (transition.level === "ok") {
      logger.info("Provider quota pressure cleared", {
        event: "agent_runtime:provider_quota_recovered",
        agent_id: transition.agentId,
        provider: transition.provider,
        window: transition.window,
        previous_level: transition.previousLevel,
      });
    } else {
      logger.warning("Provider quota pressure observed", {
        event: "agent_runtime:provider_quota_pressure",
        agent_id: transition.agentId,
        provider: transition.provider,
        window: transition.window,
        previous_level: transition.previousLevel,
        level: transition.level,
        ...(transition.usedPercent !== undefined ? { used_percent: transition.usedPercent } : {}),
        ...(transition.resetsAt ? { resets_at: transition.resetsAt } : {}),
      });
    }
  }
}
