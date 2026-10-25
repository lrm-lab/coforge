import type { CentrifugeWorkspaceClient } from "./centrifuge-workspace-client";
import type { AgentContextUsage, AgentServiceTier } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { encodeAgentContextUsage, encodeAgentServiceTier } from "@lrm/coforge-sdk/internal";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "connection"]);

/** One buffered observation, with the RPC method and encoder it goes out on. */
type PendingObservation = {
  agentId: string;
  method: string;
  payload: Uint8Array;
  log: Record<string, unknown>;
};

/**
 * The daemon's per-launch observations (a context-window reading, the applied service tier):
 * fire-and-forget, buffered latest-per-agent while disconnected, flushed on reconnect, and never
 * retried or surfaced to a caller. A rejection from an old server that does not know the RPC is
 * logged once per connection lifetime rather than on every send.
 */
export class AgentObservationPublisher {
  readonly #methods: { contextUsage: string; serviceTier: string };
  readonly #pending = new Map<string, PendingObservation>();
  readonly #loggedUnknownMethod = new Set<string>();

  constructor(methods: { contextUsage: string; serviceTier: string }) {
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

  flush(client: CentrifugeWorkspaceClient): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const observation of pending) this.#publish(client, observation);
  }

  /** A new connection lifetime starts with its own unknown-method suppression. */
  resetConnectionLifetime(): void {
    this.#loggedUnknownMethod.clear();
  }

  /** Drops buffered observations; used when the connection is torn down for good. */
  clear(): void {
    this.#pending.clear();
  }

  #send(observation: PendingObservation, client: CentrifugeWorkspaceClient | undefined): void {
    if (!client) {
      this.#pending.set(observation.agentId, observation);
      return;
    }
    this.#publish(client, observation);
  }

  #publish(client: CentrifugeWorkspaceClient, observation: PendingObservation): void {
    void client.rpc(observation.method, observation.payload).catch((error) => {
      const errorCode = diagnosticErrorCode(error);
      if (errorCode === "404" && this.#loggedUnknownMethod.has(observation.method)) return;
      if (errorCode === "404") this.#loggedUnknownMethod.add(observation.method);
      logger.warning("Agent observation was not accepted", {
        ...observation.log,
        error_code: errorCode,
        outcome: "failed",
      });
    });
  }
}
