import { getLogger } from "@logtape/logtape";
import type { AgentTurnTokenUsage } from "@lrm/coforge-anvil";
import {
  diagnosticErrorCode,
  type AgentServiceTierObserved,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { PublishedActivityLaunch } from "./agent-activity-publisher";

const logger = getLogger(["coforge", "daemon", "runtime"]);

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
  readonly #pendingTurnTokens = new Map<string, Map<string, PendingTurnTokens>>();
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
    const observedAtMs = observedAt(occurredAt);
    const last = this.#lastContextUsage.get(agentId);
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

  lastContextUsage(
    agentId: string,
  ): { usedTokens: number; windowTokens: number; observedAtMs: number } | undefined {
    return this.#lastContextUsage.get(agentId);
  }

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

  recordTokenUsage(agentId: string, usage: AgentTurnTokenUsage, conversationId?: string): void {
    const buckets = this.#pendingTurnTokens.get(agentId) ?? new Map<string, PendingTurnTokens>();
    const key = conversationId ?? "";
    const current = buckets.get(key) ?? {
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
    buckets.set(key, current);
    this.#pendingTurnTokens.set(agentId, buckets);
  }

  flushTokenUsage(
    agentId: string,
    launch: PublishedActivityLaunch,
    provider: RuntimeProvider,
    fallbackModel?: string,
    conversationId?: string,
  ): boolean {
    const buckets = this.#pendingTurnTokens.get(agentId);
    if (!buckets) return false;
    const key = conversationId ?? "";
    const pending = buckets.get(key);
    if (!pending) return false;
    buckets.delete(key);
    if (buckets.size === 0) this.#pendingTurnTokens.delete(agentId);
    return this.#flushBucket(agentId, launch, provider, pending, fallbackModel, key === "");
  }

  flushAllTokenUsage(
    agentId: string,
    launch: PublishedActivityLaunch,
    provider: RuntimeProvider,
    fallbackModel?: string,
  ): number {
    const buckets = this.#pendingTurnTokens.get(agentId);
    if (!buckets || buckets.size === 0) return 0;
    this.#pendingTurnTokens.delete(agentId);
    let flushed = 0;
    for (const [key, pending] of buckets) {
      if (this.#flushBucket(agentId, launch, provider, pending, fallbackModel, key === ""))
        flushed += 1;
    }
    return flushed;
  }

  #flushBucket(
    agentId: string,
    launch: PublishedActivityLaunch,
    provider: RuntimeProvider,
    pending: PendingTurnTokens,
    fallbackModel: string | undefined,
    isMainConversation: boolean,
  ): boolean {
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
    const lastContext = isMainConversation ? this.#lastContextUsage.get(agentId) : undefined;
    const contextUsedTokens = sanitizeNonNegativeInt(
      pending.contextUsedTokens ?? lastContext?.usedTokens,
    );
    const contextWindowTokens = sanitizePositiveInt(
      pending.contextWindowTokens ?? lastContext?.windowTokens,
    );
    const envelope = this.#ports.envelope();
    try {
      this.#report(agentId, launch, (clientSeq) =>
        this.#ports.sendTokenUsage?.({
          ...envelope,
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
    } catch (error) {
      logger.warning("Agent token usage could not be sent", {
        event: "agent_token_usage:encode_failed",
        request_id: envelope.requestId,
        workspace_id: envelope.workspaceId,
        computer_id: envelope.computerId,
        agent_id: agentId,
        launch_id: launch.launchId,
        turn_seq: turnSeq,
        provider,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      return false;
    }
  }

  forget(agentId: string): void {
    this.#lastContextUsage.delete(agentId);
    this.#lastServiceTier.delete(agentId);
    this.#pendingTurnTokens.delete(agentId);
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
