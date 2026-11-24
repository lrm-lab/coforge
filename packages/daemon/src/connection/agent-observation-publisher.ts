import type { CentrifugeWorkspaceClient } from "./centrifuge-workspace-client";
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

type PendingObservation = {
  agentId: string;
  method: string;
  payload: Uint8Array;
  log: Record<string, unknown>;
};

export class AgentObservationPublisher {
  readonly #methods: {
    contextUsage: string;
    tokenUsage?: string;
    serviceTier: string;
    contextViewAvailability: string;
  };
  readonly #pending = new Map<string, PendingObservation>();
  readonly #pendingAdditive: PendingObservation[] = [];
  readonly #loggedUnknownMethod = new Set<string>();
  readonly #inFlight = new Set<string>();
  readonly #queued = new Map<
    string,
    { client: CentrifugeWorkspaceClient; observation: PendingObservation }
  >();
  readonly #additiveInFlight = new Set<string>();
  readonly #additiveQueued = new Map<string, PendingObservation[]>();
  #liveAdditiveClient: CentrifugeWorkspaceClient | undefined;

  constructor(
    methods: {
      contextUsage: string;
      tokenUsage?: string;
      serviceTier: string;
      contextViewAvailability: string;
    } = DEFAULT_OBSERVATION_METHODS,
  ) {
    this.#methods = methods;
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
    const observation: PendingObservation = {
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
    };
    if (!client) {
      if (this.#pendingAdditive.length >= MAX_PENDING_TOKEN_USAGE_EVENTS)
        this.#pendingAdditive.shift();
      this.#pendingAdditive.push(observation);
      return;
    }
    this.#liveAdditiveClient = client;
    this.#publishAdditive(client, observation);
  }

  flush(client: CentrifugeWorkspaceClient): void {
    this.#liveAdditiveClient = client;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const observation of pending) this.#publish(client, observation);
    const additive = this.#pendingAdditive.splice(0);
    for (const observation of additive) this.#publishAdditive(client, observation);
  }

  resetConnectionLifetime(): void {
    this.#loggedUnknownMethod.clear();
    this.#liveAdditiveClient = undefined;
  }

  clear(): void {
    this.#pending.clear();
    this.#queued.clear();
    this.#pendingAdditive.length = 0;
    this.#additiveQueued.clear();
    this.#liveAdditiveClient = undefined;
  }

  #publishAdditive(client: CentrifugeWorkspaceClient, observation: PendingObservation): void {
    const key = `${observation.method}\0${observation.agentId}`;
    if (this.#additiveInFlight.has(key)) {
      const list = this.#additiveQueued.get(key) ?? [];
      if (list.length >= MAX_PENDING_TOKEN_USAGE_EVENTS) list.shift();
      list.push(observation);
      this.#additiveQueued.set(key, list);
      return;
    }
    this.#additiveInFlight.add(key);
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
        this.#additiveInFlight.delete(key);
        const list = this.#additiveQueued.get(key);
        const next = list?.shift();
        if (!next) {
          this.#additiveQueued.delete(key);
          return;
        }
        if (list && list.length === 0) this.#additiveQueued.delete(key);
        if (!this.#liveAdditiveClient) {
          if (this.#pendingAdditive.length >= MAX_PENDING_TOKEN_USAGE_EVENTS)
            this.#pendingAdditive.shift();
          this.#pendingAdditive.push(next);
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

/** Publishes one Activity frame on the Workspace's shared channel, best effort. */
export function publishAgentActivity(
  client: CentrifugeWorkspaceClient,
  workspaceId: string,
  frame: Uint8Array,
): void {
  void client.publish?.(`agent:activity:${workspaceId}`, frame).catch(() => {});
}
