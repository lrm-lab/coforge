import type { AgentTurnTokenUsage } from "@lrm/coforge-anvil";
import type { AgentServiceTierObserved, RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { PublishedActivityLaunch } from "./agent-activity-publisher";

type PendingTurnTokens = {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  model?: string;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  occurredAt?: string;
};

export type AgentUsageReportPorts = Readonly<{
  sessionId(agentId: string): string | undefined;
  envelope(): {
    protocolMajor: number;
    requestId: string;
    workspaceId: string;
    computerId: string;
  };
  daemonInstanceId(): string;
  recordClientSeq(agentId: string, clientSeq: number): void;
  sendContextUsage: DaemonConnectionClient["sendAgentContextUsage"];
  sendTokenUsage?: DaemonConnectionClient["sendAgentTokenUsage"];
  sendServiceTier: DaemonConnectionClient["sendAgentServiceTier"];
}>;

export class AgentUsageReport {
  readonly #ports: AgentUsageReportPorts;
  readonly #lastContextUsage = new Map<
    string,
    { usedTokens: number; windowTokens: number; observedAtMs: number }
  >();
  readonly #lastServiceTier = new Map<string, AgentServiceTierObserved>();
  readonly #pendingTurnTokens = new Map<string, PendingTurnTokens>();
  readonly #turnSeqByAgent = new Map<string, { launchId: string; seq: number }>();

  constructor(ports: AgentUsageReportPorts) {
    this.#ports = ports;
  }

  #report(
    agentId: string,
    launch: PublishedActivityLaunch,
    send: (clientSeq: number) => void,
  ): void {
    const clientSeq = ++launch.clientSeq;
    send(clientSeq);
    this.#ports.recordClientSeq(agentId, clientSeq);
  }

  /** A context-usage reading: skipped until the launch's native session id is known. Whether the
   * reading was recorded, so the caller knows a compaction may be waiting for it. */
  contextUsage(
    agentId: string,
    launch: PublishedActivityLaunch,
    provider: RuntimeProvider,
    usedTokens: number,
    windowTokens: number,
    occurredAt?: string,
  ): boolean {
    const sessionId = this.#ports.sessionId(agentId);
    if (!sessionId) return false;
    // When the reading was taken rides along, the runtime's own sampling time when it gave one: a
    // compaction tells a reading it saw before it started from one that arrived after, and the
    // daemon's receipt time would say the second happened whenever it happened to be parsed.
    const observedAtMs = observedAt(occurredAt);
    const last = this.#lastContextUsage.get(agentId);
    // An unchanged count is not re-sent, but it is still a newer sample: the reading on record
    // takes the newer time, so a held compaction line can see that one arrived.
    this.#lastContextUsage.set(agentId, { usedTokens, windowTokens, observedAtMs });
    if (last && last.usedTokens === usedTokens && last.windowTokens === windowTokens) return true;
    this.#report(agentId, launch, (clientSeq) =>
      this.#ports.sendContextUsage?.({
        ...this.#ports.envelope(),
        agentId,
        provider,
        launchId: launch.launchId,
        sessionId,
        usedTokens,
        windowTokens,
        observedAtMs,
        daemonInstanceId: this.#ports.daemonInstanceId(),
        clientSeq,
      }),
    );
    return true;
  }

  /** The last context-usage reading for an Agent, for the compaction log: a compaction's token
   * numbers come from these readings, and a missing one stays missing rather than invented. */
  lastContextUsage(
    agentId: string,
  ): { usedTokens: number; windowTokens: number; observedAtMs: number } | undefined {
    return this.#lastContextUsage.get(agentId);
  }

  /** An observed service-tier reading: the same session-id gate and unchanged-reading skip. */
  serviceTier(
    agentId: string,
    launch: PublishedActivityLaunch,
    provider: RuntimeProvider,
    observed: AgentServiceTierObserved,
  ): void {
    const sessionId = this.#ports.sessionId(agentId);
    if (!sessionId) return;
    if (this.#lastServiceTier.get(agentId) === observed) return;
    this.#lastServiceTier.set(agentId, observed);
    this.#report(agentId, launch, (clientSeq) =>
      this.#ports.sendServiceTier?.({
        ...this.#ports.envelope(),
        agentId,
        provider,
        launchId: launch.launchId,
        sessionId,
        requested: true,
        observed,
        observedAtMs: Date.now(),
        daemonInstanceId: this.#ports.daemonInstanceId(),
        clientSeq,
      }),
    );
  }

  recordTokenUsage(agentId: string, usage: AgentTurnTokenUsage): void {
    const current = this.#pendingTurnTokens.get(agentId) ?? {
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    };
    current.uncachedInputTokens = boundedSum(
      current.uncachedInputTokens,
      usage.uncachedInputTokens,
    );
    current.cacheReadTokens = boundedSum(current.cacheReadTokens, usage.cacheReadTokens);
    current.cacheWriteTokens = boundedSum(current.cacheWriteTokens, usage.cacheWriteTokens);
    current.outputTokens = boundedSum(current.outputTokens, usage.outputTokens);
    const reasoning = sanitizeNonNegativeInt(usage.reasoningOutputTokens);
    if (reasoning !== undefined) {
      current.reasoningOutputTokens = boundedSum(current.reasoningOutputTokens ?? 0, reasoning);
    }
    if (usage.model) current.model = usage.model;
    const contextUsed = sanitizeNonNegativeInt(usage.contextUsedTokens);
    if (contextUsed !== undefined) current.contextUsedTokens = contextUsed;
    const contextWindow = sanitizePositiveInt(usage.contextWindowTokens);
    if (contextWindow !== undefined) current.contextWindowTokens = contextWindow;
    if (usage.occurredAt) current.occurredAt = usage.occurredAt;
    this.#pendingTurnTokens.set(agentId, current);
  }

  flushTokenUsage(
    agentId: string,
    launch: PublishedActivityLaunch,
    provider: RuntimeProvider,
    fallbackModel?: string,
  ): boolean {
    const pending = this.#pendingTurnTokens.get(agentId);
    this.#pendingTurnTokens.delete(agentId);
    if (!pending) return false;
    if (
      pending.uncachedInputTokens +
        pending.cacheReadTokens +
        pending.cacheWriteTokens +
        pending.outputTokens <=
      0
    )
      return false;
    const prev = this.#turnSeqByAgent.get(agentId);
    const turnSeq = prev && prev.launchId === launch.launchId ? prev.seq + 1 : 1;
    this.#turnSeqByAgent.set(agentId, { launchId: launch.launchId, seq: turnSeq });
    const sessionId = this.#ports.sessionId(agentId) ?? launch.launchId;
    const lastContext = this.#lastContextUsage.get(agentId);
    const contextUsedTokens = sanitizeNonNegativeInt(
      pending.contextUsedTokens ?? lastContext?.usedTokens,
    );
    const contextWindowTokens = sanitizePositiveInt(
      pending.contextWindowTokens ?? lastContext?.windowTokens,
    );
    try {
      this.#report(agentId, launch, (clientSeq) =>
        this.#ports.sendTokenUsage?.({
          ...this.#ports.envelope(),
          agentId,
          provider,
          launchId: launch.launchId,
          sessionId,
          turnSeq,
          model: (pending.model ?? fallbackModel ?? "").slice(0, 256),
          uncachedInputTokens: pending.uncachedInputTokens,
          cacheReadTokens: pending.cacheReadTokens,
          cacheWriteTokens: pending.cacheWriteTokens,
          outputTokens: pending.outputTokens,
          ...(pending.reasoningOutputTokens !== undefined
            ? { reasoningOutputTokens: pending.reasoningOutputTokens }
            : {}),
          ...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
          ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
          observedAtMs: observedAt(pending.occurredAt),
          daemonInstanceId: this.#ports.daemonInstanceId(),
          clientSeq,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  forget(agentId: string): void {
    this.#lastContextUsage.delete(agentId);
    this.#lastServiceTier.delete(agentId);
    this.#pendingTurnTokens.delete(agentId);
    this.#turnSeqByAgent.delete(agentId);
  }

  clear(): void {
    this.#lastContextUsage.clear();
    this.#lastServiceTier.clear();
    this.#pendingTurnTokens.clear();
    this.#turnSeqByAgent.clear();
  }
}

function sanitizeNonNegativeInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.round(value), Number.MAX_SAFE_INTEGER);
}

function sanitizePositiveInt(value: number | undefined): number | undefined {
  const sanitized = sanitizeNonNegativeInt(value);
  return sanitized !== undefined && sanitized > 0 ? sanitized : undefined;
}

function boundedSum(base: number, delta: number): number {
  const next = sanitizeNonNegativeInt(delta) ?? 0;
  return Math.min(base + next, Number.MAX_SAFE_INTEGER);
}

function observedAt(occurredAt: string | undefined): number {
  const parsed = occurredAt === undefined ? Number.NaN : Date.parse(occurredAt);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Date.now();
}
