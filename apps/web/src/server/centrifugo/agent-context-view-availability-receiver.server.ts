import {
  AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
  decodeAgentContextViewAvailability,
} from "@lrm/coforge-sdk/internal";
import type { AgentContextViewAvailability } from "@lrm/coforge-sdk/internal";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

const TTL_SECONDS = 24 * 60 * 60;
const PREFIX = "coforge:agent-context-view:availability";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
type Redis = Pick<import("bun").RedisClient, "get" | "set">;

export class AgentContextViewAvailabilityStore {
  constructor(private readonly redis: Redis) {}
  async record(value: ReturnType<typeof decodeAgentContextViewAvailability>): Promise<void> {
    await this.redis.set(
      `${PREFIX}:${value.workspaceId}:${value.computerId}:${value.agentId}`,
      JSON.stringify(value),
      "EX",
      String(TTL_SECONDS),
    );
  }
  async read(
    workspaceId: string,
    computerId: string,
    agentId: string,
  ): Promise<AgentContextViewAvailability | undefined> {
    const raw = await this.redis.get(`${PREFIX}:${workspaceId}:${computerId}:${agentId}`);
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as Partial<AgentContextViewAvailability>;
      if (
        value.type === "agent:context_view_availability" &&
        value.protocolMajor === 1 &&
        ID.test(value.workspaceId) &&
        ID.test(value.computerId) &&
        ID.test(value.agentId) &&
        value.workspaceId === workspaceId &&
        value.computerId === computerId &&
        value.agentId === agentId &&
        typeof value.runtime === "string" &&
        value.runtime.length > 0 &&
        typeof value.retentionDays === "number" &&
        Number.isSafeInteger(value.retentionDays) &&
        value.retentionDays >= 1 &&
        value.retentionDays <= 365 &&
        (value.supported ||
          value.unsupportedReason === "unsupported_runtime" ||
          value.unsupportedReason === "no_session") &&
        (value.trigger === undefined ||
          value.trigger === "startup" ||
          value.trigger === "message" ||
          value.trigger === "server_features") &&
        (value.retainedSince === undefined || typeof value.retainedSince === "string") &&
        typeof value.supported === "boolean"
      )
        return value as AgentContextViewAvailability;
    } catch {
      // A malformed or stale availability record is not evidence of support.
    }
    return undefined;
  }
  async supports(workspaceId: string, computerId: string, agentId: string): Promise<boolean> {
    return (await this.read(workspaceId, computerId, agentId))?.supported === true;
  }
}

let singleton: AgentContextViewAvailabilityStore | undefined;
export function getAgentContextViewAvailabilityStore() {
  return (singleton ??= new AgentContextViewAvailabilityStore(
    openRedisClient(redisUrlFor("Agent context view availability")),
  ));
}

export function agentContextViewAvailabilityMethods(
  enabled = true,
  store?: AgentContextViewAvailabilityStore,
): Record<string, CentrifugoRpcMethod> {
  const activeStore = store ?? (enabled ? getAgentContextViewAvailabilityStore() : undefined);
  return {
    [AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD]: enabled
      ? async (payload, { principal }) => {
          const value = decodeAgentContextViewAvailability(payload);
          if (
            principal.agentId ||
            principal.workspaceId !== value.workspaceId ||
            principal.computerId !== value.computerId
          )
            return {
              code: 403,
              message: "Agent context view availability scope is not authorized",
            };
          if (!activeStore)
            return { code: 503, message: "protocol method dependencies are unavailable" };
          await activeStore.record(value);
          return new Uint8Array();
        }
      : () => ({ code: 503, message: "protocol method dependencies are unavailable" }),
  };
}
