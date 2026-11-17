import {
  AGENT_MEMORY_CAPABILITY,
  AGENT_MEMORY_RESULT_METHOD,
  decodeAgentMemoryResult,
  encodeAgentMemoryResult,
  sameAgentMemoryScope,
  type AgentMemoryRequest,
  type AgentMemoryResult,
} from "@lrm/coforge-sdk/internal";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import type { PendingAgentMemory } from "#src/server/agents/agent-memory-management.server";
import { RedisPendingResults } from "./redis-pending-results.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

let results:
  | RedisPendingResults<AgentMemoryRequest, AgentMemoryResult, PendingAgentMemory>
  | undefined;
let capability: RedisComputerCapabilityLease | undefined;
export function getAgentMemoryResults() {
  return (results ??= new RedisPendingResults<
    AgentMemoryRequest,
    AgentMemoryResult,
    PendingAgentMemory
  >(openRedisClient(redisUrlFor("Personal memory replies")), {
    prefix: "coforge:agent-memory:v1",
    pendingTtlSeconds: 15,
    resultTtlSeconds: 5,
    encode: encodeAgentMemoryResult,
    decode: decodeAgentMemoryResult,
    sameScope: sameAgentMemoryScope,
  }));
}
export function getAgentMemoryCapabilityLease() {
  return (capability ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Personal memory capability")),
    AGENT_MEMORY_CAPABILITY,
    "agent-memory-management-capability",
  ));
}
export function agentMemoryResultMethods(enabled = true): Record<string, CentrifugoRpcMethod> {
  return {
    [AGENT_MEMORY_RESULT_METHOD]: enabled
      ? async (payload, { principal }) => {
          const result = decodeAgentMemoryResult(payload);
          if (
            !principal.userId ||
            principal.agentId ||
            principal.workspaceId !== result.workspaceId ||
            principal.computerId !== result.computerId
          )
            return { code: 403, message: "Personal memory result scope is not authorized" };
          await getAgentMemoryResults().accept(result);
          return new Uint8Array();
        }
      : () => ({ code: 503, message: "Personal memory dependencies are unavailable" }),
  };
}
