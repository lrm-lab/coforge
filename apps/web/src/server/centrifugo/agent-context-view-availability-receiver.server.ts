import {
  AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
  decodeAgentContextViewAvailability,
} from "@lrm/coforge-sdk/internal";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

const TTL_SECONDS = 24 * 60 * 60;
const PREFIX = "coforge:agent-context-view:availability";
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
  async supports(workspaceId: string, computerId: string, agentId: string): Promise<boolean> {
    const raw = await this.redis.get(`${PREFIX}:${workspaceId}:${computerId}:${agentId}`);
    if (!raw) return false;
    try {
      const value = JSON.parse(raw) as { supported?: unknown };
      return value.supported === true;
    } catch {
      return false;
    }
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
