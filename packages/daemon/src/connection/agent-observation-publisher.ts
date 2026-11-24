import type { CentrifugeWorkspaceClient } from "./centrifuge-workspace-client";
import type { DaemonConnectionTiming } from "./daemon-connection-timing";
import { isTemporaryRpcError } from "./temporary-rpc-retry";
import type {
  AgentContextUsage,
  AgentServiceTier,
  AgentTokenUsage,
  AgentContextViewAvailability,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import {
  AGENT_CONTEXT_USAGE_METHOD,
  AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
  AGENT_SERVICE_TIER_METHOD,
  AGENT_TOKEN_USAGE_METHOD,
  diagnosticErrorCode,
  encodeAgentContextUsage,
  encodeAgentServiceTier,
  encodeAgentTokenUsage,
  encodeAgentContextViewAvailability,
} from "@lrm/coforge-sdk/internal";

const DEFAULT_OBSERVATION_METHODS = {
  contextUsage: AGENT_CONTEXT_USAGE_METHOD,
  tokenUsage: AGENT_TOKEN_USAGE_METHOD,
  serviceTier: AGENT_SERVICE_TIER_METHOD,
  contextViewAvailability: AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
} as const;

const logger = getLogger(["coforge", "daemon", "connection"]);
const MAX_PENDING_TOKEN_USAGE_EVENTS = 128;
const ADDITIVE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

const PERMANENT_CENTRIFUGO_CODES = new Set([12, 101, 102, 103, 104, 105, 107, 108]);

type ObservationMethods = {
  contextUsage: string;
  tokenUsage?: string;
  serviceTier: string;
  contextViewAvailability: string;
};

type AdditiveRetryTiming = Pick<DaemonConnectionTiming, "schedule" | "cancel">;

export type AgentObservationPublisherOptions = Readonly<{
  retryDelaysMs?: readonly number[];
  timing?: AdditiveRetryTiming;
}>;

type PendingObservation = {
  agentId: string;
  method: string;
  payload: Uint8Array;
  log: Record<string, unknown>;
};

type PendingAdditiveObservation = PendingObservation & {
  retries: number;
};

const defaultTiming: AdditiveRetryTiming = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  cancel(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

function numericErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { code?: unknown; status?: unknown };
  const raw = record.code ?? record.status;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return undefined;
}

export function isPermanentAdditiveError(error: unknown): boolean {
  if (isTemporaryRpcError(error)) return false;
  const code = numericErrorCode(error);
  if (code === undefined) return false;
  if (code === 408 || code === 429) return false;
  if (code >= 400 && code < 500) return true;
  return PERMANENT_CENTRIFUGO_CODES.has(code);
}

export class AgentObservationPublisher {
  readonly #methods: ObservationMethods;
  readonly #retryDelaysMs: readonly number[];
  readonly #timing: AdditiveRetryTiming;
  readonly #pending = new Map<string, PendingObservation>();
  readonly #pendingAdditive: PendingAdditiveObservation[] = [];
  readonly #loggedUnknownMethod = new Set<string>();
  readonly #inFlight = new Set<string>();
  readonly #queued = new Map<
    string,
    { client: CentrifugeWorkspaceClient; observation: PendingObservation }
  >();
  readonly #additiveInFlight = new Map<string, symbol>();
  readonly #additiveQueued = new Map<string, PendingAdditiveObservation[]>();
  readonly #additiveRetryTimers = new Map<
    string,
    { timer: unknown; observation: PendingAdditiveObservation }
  >();
  readonly #drainWaiters = new Set<() => void>();
  #liveAdditiveClient: CentrifugeWorkspaceClient | undefined;

  constructor(
    methods: ObservationMethods = DEFAULT_OBSERVATION_METHODS,
    options: AgentObservationPublisherOptions = {},
  ) {
    this.#methods = methods;
    this.#retryDelaysMs = options.retryDelaysMs ?? ADDITIVE_RETRY_DELAYS_MS;
    this.#timing = options.timing ?? defaultTiming;
  }

  sendContextUsage(message: AgentContextUsage, client?: CentrifugeWorkspaceClient): void {
    this.#send(
      {
        agentId: message.agentId,
        method: this.#methods.contextUsage,
        payload: encodeAgentContextUsage(message),
        log: {
          event: "agent_context_usage:rejected",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          computer_id: message.computerId,
          agent_id: message.agentId,
          launch_id: message.launchId,
        },
      },
      client,
    );
  }

  sendServiceTier(message: AgentServiceTier, client?: CentrifugeWorkspaceClient): void {
    this.#send(
      {
        agentId: message.agentId,
        method: this.#methods.serviceTier,
        payload: encodeAgentServiceTier(message),
        log: {
          event: "agent_service_tier:rejected",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          computer_id: message.computerId,
          agent_id: message.agentId,
          launch_id: message.launchId,
        },
      },
      client,
    );
  }

  sendContextViewAvailability(
    message: AgentContextViewAvailability,
    client?: CentrifugeWorkspaceClient,
  ): void {
    this.#send(
      {
        agentId: message.agentId,
        method: this.#methods.contextViewAvailability,
        payload: encodeAgentContextViewAvailability(message),
        log: {
          event: "agent_context_view_availability:rejected",
          workspace_id: message.workspaceId,
          computer_id: message.computerId,
          agent_id: message.agentId,
        },
      },
      client,
    );
  }

  sendTokenUsage(message: AgentTokenUsage, client?: CentrifugeWorkspaceClient): void {
    const method = this.#methods.tokenUsage;
    if (!method) return;
    const observation: PendingAdditiveObservation = {
      agentId: message.agentId,
      method,
      payload: encodeAgentTokenUsage(message),
      log: {
        event: "agent_token_usage:rejected",
        request_id: message.requestId,
        workspace_id: message.workspaceId,
        computer_id: message.computerId,
        agent_id: message.agentId,
        launch_id: message.launchId,
        turn_seq: message.turnSeq,
      },
      retries: 0,
    };
    if (!this.#isClientLive(client)) {
      this.#enqueuePendingAdditive(observation);
      return;
    }
    this.#liveAdditiveClient = client;
    if (this.#pendingAdditive.length > 0) {
      const pending = this.#pendingAdditive.splice(0);
      for (const item of pending) this.#publishAdditive(client, item);
    }
    this.#publishAdditive(client, observation);
  }

  flush(client: CentrifugeWorkspaceClient): void {
    this.#liveAdditiveClient = client;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const observation of pending) this.#publish(client, observation);
    this.#flushAdditive(client);
  }

  async drainAdditive(
    client: CentrifugeWorkspaceClient | undefined,
    timeoutMs: number,
  ): Promise<void> {
    if (!this.#isClientLive(client)) return;
    this.#liveAdditiveClient = client;
    this.#flushAdditive(client);
    if (!this.#hasAdditiveWork()) return;
    let timer: unknown;
    let resolveWaiter: (() => void) | undefined;
    try {
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
        this.#drainWaiters.add(resolve);
        timer = this.#timing.schedule(resolve, Math.max(0, timeoutMs));
      });
    } finally {
      if (resolveWaiter) this.#drainWaiters.delete(resolveWaiter);
      if (timer !== undefined) this.#timing.cancel(timer);
    }
  }

  resetConnectionLifetime(): void {
    this.#loggedUnknownMethod.clear();
    this.#liveAdditiveClient = undefined;
    const buffered: PendingAdditiveObservation[] = [];
    for (const [key, entry] of this.#additiveRetryTimers) {
      this.#timing.cancel(entry.timer);
      entry.observation.retries = 0;
      buffered.push(entry.observation, ...this.#takeQueuedForKey(key));
    }
    this.#additiveRetryTimers.clear();
    this.#prependPendingAdditive(buffered);
    this.#notifyDrainWaiters();
  }

  clear(): void {
    for (const entry of this.#additiveRetryTimers.values()) this.#timing.cancel(entry.timer);
    this.#additiveRetryTimers.clear();
    this.#pending.clear();
    this.#queued.clear();
    this.#pendingAdditive.length = 0;
    this.#additiveQueued.clear();
    this.#additiveInFlight.clear();
    this.#liveAdditiveClient = undefined;
    this.#notifyDrainWaiters();
  }

  #isClientLive(
    client: CentrifugeWorkspaceClient | undefined,
  ): client is CentrifugeWorkspaceClient {
    return client !== undefined && (client.state === undefined || client.state === "connected");
  }

  #hasAdditiveWork(): boolean {
    return (
      this.#additiveInFlight.size > 0 ||
      this.#additiveQueued.size > 0 ||
      this.#pendingAdditive.length > 0 ||
      this.#additiveRetryTimers.size > 0
    );
  }

  #notifyDrainWaiters(): void {
    if (this.#hasAdditiveWork() && this.#isClientLive(this.#liveAdditiveClient)) return;
    const waiters = [...this.#drainWaiters];
    this.#drainWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  #enqueuePendingAdditive(observation: PendingAdditiveObservation): void {
    if (this.#pendingAdditive.length >= MAX_PENDING_TOKEN_USAGE_EVENTS)
      this.#pendingAdditive.shift();
    this.#pendingAdditive.push(observation);
  }

  #prependPendingAdditive(items: readonly PendingAdditiveObservation[]): void {
    if (items.length === 0) return;
    const combined = [...items, ...this.#pendingAdditive];
    const overflow = combined.length - MAX_PENDING_TOKEN_USAGE_EVENTS;
    this.#pendingAdditive.splice(
      0,
      this.#pendingAdditive.length,
      ...(overflow > 0 ? combined.slice(overflow) : combined),
    );
  }

  #enqueueAdditiveKey(key: string, observation: PendingAdditiveObservation): void {
    const list = this.#additiveQueued.get(key) ?? [];
    if (list.length >= MAX_PENDING_TOKEN_USAGE_EVENTS) list.shift();
    list.push(observation);
    this.#additiveQueued.set(key, list);
  }

  #takeQueuedForKey(key: string): PendingAdditiveObservation[] {
    const list = this.#additiveQueued.get(key);
    this.#additiveQueued.delete(key);
    return list ?? [];
  }

  #flushAdditive(client: CentrifugeWorkspaceClient): void {
    const retrying: PendingAdditiveObservation[] = [];
    for (const entry of this.#additiveRetryTimers.values()) {
      this.#timing.cancel(entry.timer);
      entry.observation.retries = 0;
      retrying.push(entry.observation);
    }
    this.#additiveRetryTimers.clear();
    const pending = this.#pendingAdditive.splice(0);
    for (const observation of [...retrying, ...pending]) this.#publishAdditive(client, observation);
  }

  #publishAdditive(
    client: CentrifugeWorkspaceClient,
    observation: PendingAdditiveObservation,
  ): void {
    const key = `${observation.method}\0${observation.agentId}`;
    if (this.#additiveInFlight.has(key) || this.#additiveRetryTimers.has(key)) {
      this.#enqueueAdditiveKey(key, observation);
      return;
    }
    const token = Symbol();
    this.#additiveInFlight.set(key, token);
    let requeued = false;
    void client
      .rpc(observation.method, observation.payload)
      .catch((error) => {
        if (this.#additiveInFlight.get(key) !== token) return;
        const errorCode = diagnosticErrorCode(error);
        if (isPermanentAdditiveError(error)) {
          const unknownMethod = errorCode === "404" || errorCode === "104";
          if (unknownMethod && this.#loggedUnknownMethod.has(observation.method)) return;
          if (unknownMethod) this.#loggedUnknownMethod.add(observation.method);
          logger.warning("Agent observation was not accepted", {
            ...observation.log,
            error_code: errorCode,
            outcome: "failed",
          });
          return;
        }
        const liveClient = this.#liveAdditiveClient;
        if (!this.#isClientLive(liveClient)) {
          requeued = true;
          this.#additiveInFlight.delete(key);
          observation.retries = 0;
          this.#prependPendingAdditive([observation, ...this.#takeQueuedForKey(key)]);
          logger.warning("Agent observation buffered after transient disconnect", {
            ...observation.log,
            error_code: errorCode,
            outcome: "requeued",
          });
          return;
        }
        if (liveClient !== client) {
          requeued = true;
          this.#additiveInFlight.delete(key);
          observation.retries = 0;
          this.#publishAdditive(liveClient, observation);
          return;
        }
        if (observation.retries < this.#retryDelaysMs.length) {
          requeued = true;
          const delayMs = this.#retryDelaysMs[observation.retries]!;
          observation.retries += 1;
          this.#additiveInFlight.delete(key);
          logger.warning("Agent observation failed temporarily; retrying", {
            ...observation.log,
            error_code: errorCode,
            attempt: observation.retries,
            delay_ms: delayMs,
            outcome: "retrying",
          });
          const timer = this.#timing.schedule(() => {
            this.#additiveRetryTimers.delete(key);
            if (this.#isClientLive(this.#liveAdditiveClient)) {
              this.#publishAdditive(this.#liveAdditiveClient, observation);
              return;
            }
            observation.retries = 0;
            this.#prependPendingAdditive([observation, ...this.#takeQueuedForKey(key)]);
            this.#notifyDrainWaiters();
          }, delayMs);
          this.#additiveRetryTimers.set(key, { timer, observation });
          return;
        }
        logger.warning("Agent observation was not accepted after retries", {
          ...observation.log,
          error_code: errorCode,
          attempts: observation.retries,
          outcome: "failed",
        });
      })
      .finally(() => {
        if (this.#additiveInFlight.get(key) === token) this.#additiveInFlight.delete(key);
        if (requeued) {
          this.#notifyDrainWaiters();
          return;
        }
        const list = this.#additiveQueued.get(key);
        const next = list?.shift();
        if (!next) {
          this.#additiveQueued.delete(key);
          this.#notifyDrainWaiters();
          return;
        }
        if (list && list.length === 0) this.#additiveQueued.delete(key);
        if (!this.#isClientLive(this.#liveAdditiveClient)) {
          this.#prependPendingAdditive([next, ...this.#takeQueuedForKey(key)]);
          this.#notifyDrainWaiters();
          return;
        }
        this.#publishAdditive(this.#liveAdditiveClient, next);
      });
  }

  #send(observation: PendingObservation, client: CentrifugeWorkspaceClient | undefined): void {
    if (!client) {
      this.#pending.set(`${observation.method}:${observation.agentId}`, observation);
      return;
    }
    this.#publish(client, observation);
  }

  #publish(client: CentrifugeWorkspaceClient, observation: PendingObservation): void {
    const key = `${observation.method}\0${observation.agentId}`;
    if (this.#inFlight.has(key)) {
      this.#queued.set(key, { client, observation });
      return;
    }
    this.#inFlight.add(key);
    void client
      .rpc(observation.method, observation.payload)
      .catch((error) => {
        const errorCode = diagnosticErrorCode(error);
        if (errorCode === "404" && this.#loggedUnknownMethod.has(observation.method)) return;
        if (errorCode === "404") this.#loggedUnknownMethod.add(observation.method);
        logger.warning("Agent observation was not accepted", {
          ...observation.log,
          error_code: errorCode,
          outcome: "failed",
        });
      })
      .finally(() => {
        this.#inFlight.delete(key);
        const next = this.#queued.get(key);
        if (!next) return;
        this.#queued.delete(key);
        this.#publish(next.client, next.observation);
      });
  }
}

export function publishAgentActivity(
  client: CentrifugeWorkspaceClient,
  workspaceId: string,
  frame: Uint8Array,
): void {
  void client.publish?.(`agent:activity:${workspaceId}`, frame).catch(() => {});
}
