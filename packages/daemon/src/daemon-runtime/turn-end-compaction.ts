import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export const DEFAULT_IDLE_COMPACT_MIN_TOKENS = 250_000;
export const TURN_END_COMPACTION_WAIT_MS = 10 * 60_000;
export const TURN_END_COMPACTION_PROGRESS_MS = 5 * 60_000;
const IDLE_COMPACT_ENV = {
  enabled: "COFORGE_IDLE_COMPACT",
  minTokens: "COFORGE_IDLE_COMPACT_MIN_TOKENS",
} as const;

type Environment = Readonly<Record<string, string | undefined>>;

function isDisabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveIdleCompactionConfig(
  agentEnvVars?: Environment,
  processEnv: Environment = Bun.env,
): { enabled: boolean; minTokens: number } {
  const set = (v: string | undefined) => (v?.trim() ? v : undefined);
  const pick = (k: string) => set(agentEnvVars?.[k]) ?? set(processEnv[k]);
  return {
    enabled: !isDisabled(pick(IDLE_COMPACT_ENV.enabled)),
    minTokens: positiveInt(pick(IDLE_COMPACT_ENV.minTokens)) ?? DEFAULT_IDLE_COMPACT_MIN_TOKENS,
  };
}

export type TurnEndCompactionPorts = Readonly<{
  idle(agentId: string): boolean;
  launchId(agentId: string): string | undefined;
  provider(agentId: string): string | undefined;
  envVars(agentId: string): Environment | undefined;
  contextTokens(agentId: string): number | undefined;
  contextGeneration(agentId: string): number | undefined;
  needsSessionReset(agentId: string): boolean;
  canCompact(agentId: string): boolean;
  compact(agentId: string): Promise<void>;
  onSettled?(agentId: string): void;
  onProgress?(agentId: string): void;
  onUnconfirmed?(agentId: string): void;
  waitMs?: number;
  progressNoticeMs?: number;
  processEnv?: Environment;
}>;

/**
 * Proactively triggers native provider compaction at Working->Idle when input context tokens
 * exceed `minTokens` (default 250,000), preventing mid-turn context-window overflow crashes.
 * Fires at most once per `(launchId, contextGeneration)` while the Agent is genuinely idle.
 */
export class TurnEndCompaction {
  readonly #inFlight = new Set<string>();
  readonly #compactedKey = new Map<string, string>();
  readonly #turnWaiters = new Map<string, () => void>();

  constructor(private readonly ports: TurnEndCompactionPorts) {}

  isCompacting(agentId: string): boolean {
    return this.#inFlight.has(agentId);
  }

  waitForTurnFinish(agentId: string): Promise<void> {
    this.noteTurnFinished(agentId);
    const waiter = Promise.withResolvers<void>();
    this.#turnWaiters.set(agentId, waiter.resolve);
    return waiter.promise;
  }

  noteTurnFinished(agentId: string): void {
    const resolve = this.#turnWaiters.get(agentId);
    if (!resolve) return;
    this.#turnWaiters.delete(agentId);
    resolve();
  }

  disposeAll(): void {
    for (const resolve of this.#turnWaiters.values()) resolve();
    this.#turnWaiters.clear();
  }

  maybeCompact(agentId: string): boolean {
    if (this.#inFlight.has(agentId)) return false;
    if (!this.ports.idle(agentId)) return false;
    if (this.ports.needsSessionReset(agentId)) return false;

    const launchId = this.ports.launchId(agentId);
    if (!launchId) return false;

    const config = resolveIdleCompactionConfig(this.ports.envVars(agentId), this.ports.processEnv);
    if (!config.enabled) return false;

    const usedTokens = this.ports.contextTokens(agentId);
    if (usedTokens === undefined || usedTokens <= config.minTokens) return false;
    if (!this.ports.canCompact(agentId)) return false;

    const generation = this.ports.contextGeneration(agentId) ?? 0;
    const dedupeKey = `${launchId}:${String(generation)}`;
    if (this.#compactedKey.get(agentId) === dedupeKey) return false;

    this.#compactedKey.set(agentId, dedupeKey);
    this.#inFlight.add(agentId);
    const provider = this.ports.provider(agentId);
    logger.info("Starting proactive idle turn-end compaction", {
      event: "agent.runtime.idle_compaction_started",
      agent_id: agentId,
      launch_id: launchId,
      provider,
      used_tokens: usedTokens,
      min_tokens: config.minTokens,
    });
    let settled = false;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => {
      if (progressTimer !== undefined) {
        clearTimeout(progressTimer);
        progressTimer = undefined;
      }
      if (waitTimer !== undefined) {
        clearTimeout(waitTimer);
        waitTimer = undefined;
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      this.#inFlight.delete(agentId);
      const afterGeneration = this.ports.contextGeneration(agentId) ?? 0;
      const postTokens = this.ports.contextTokens(agentId);
      if (
        afterGeneration !== generation &&
        postTokens !== undefined &&
        postTokens > config.minTokens
      ) {
        this.#compactedKey.set(agentId, `${launchId}:${String(afterGeneration)}`);
      }
      this.ports.onSettled?.(agentId);
    };
    const progressMs = this.ports.progressNoticeMs ?? TURN_END_COMPACTION_PROGRESS_MS;
    const waitMs = this.ports.waitMs ?? TURN_END_COMPACTION_WAIT_MS;
    if (progressMs > 0 && progressMs < waitMs) {
      progressTimer = setTimeout(() => {
        progressTimer = undefined;
        if (settled) return;
        logger.info("Proactive idle turn-end compaction still in progress", {
          event: "agent.runtime.idle_compaction_in_progress",
          agent_id: agentId,
          launch_id: launchId,
          provider,
          elapsed_ms: progressMs,
        });
        this.ports.onProgress?.(agentId);
      }, progressMs);
      progressTimer.unref?.();
    }
    waitTimer = setTimeout(() => {
      waitTimer = undefined;
      if (settled) return;
      logger.warn(
        "Proactive idle turn-end compaction timed out; marking unconfirmed and releasing buffered deliveries",
        {
          event: "agent.runtime.idle_compaction_unconfirmed",
          agent_id: agentId,
          launch_id: launchId,
          provider,
          wait_ms: waitMs,
        },
      );
      this.ports.onUnconfirmed?.(agentId);
      finish();
    }, waitMs);
    waitTimer.unref?.();
    void this.ports
      .compact(agentId)
      .catch((error: unknown) => {
        logger.warn("Proactive idle turn-end compaction failed", {
          event: "agent.runtime.idle_compaction_failed",
          agent_id: agentId,
          launch_id: launchId,
          provider,
          error: thrownMessage(error),
        });
      })
      .finally(finish);
    return true;
  }
}
