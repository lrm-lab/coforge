import type { RedisClient } from "bun";
import {
  decodeAgentContextViewResult,
  encodeAgentContextViewResult,
  AGENT_CONTEXT_VIEW_RESULT_METHOD,
  type AgentContextViewRequest,
  type AgentContextViewResult,
} from "@lrm/coforge-sdk/internal";
import {
  sameAgentContextViewScope,
  type AgentContextViewViewer,
} from "#src/server/computers/computer-agent-context-views.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import { RedisPendingResults } from "./redis-pending-results.server";

const PREFIX = "coforge:agent-context-view:v0";
type ResultsRedis = Pick<RedisClient, "get" | "set" | "send">;
type Pending = { request: AgentContextViewRequest; userId: string };

export class RedisAgentContextViewResults extends RedisPendingResults<
  AgentContextViewRequest,
  AgentContextViewResult,
  Pending
> {
  constructor(redis: ResultsRedis) {
    super(redis, {
      prefix: PREFIX,
      pendingTtlSeconds: 35,
      resultTtlSeconds: 35,
      encode: encodeAgentContextViewResult,
      decode: decodeAgentContextViewResult,
      sameScope: sameAgentContextViewScope,
    });
  }
}

let singleton: RedisAgentContextViewResults | undefined;
export function getAgentContextViewResults() {
  return (singleton ??= new RedisAgentContextViewResults(
    openRedisClient(redisUrlFor("Agent context view results")),
  ));
}

function authorized(
  principal: AgentContextViewViewer & { agentId?: string; computerId?: string },
  result: AgentContextViewResult,
) {
  return (
    Boolean(principal.userId) &&
    !principal.agentId &&
    principal.workspaceId === result.workspaceId &&
    principal.computerId === result.computerId
  );
}

export function createAgentContextViewResultMethod(
  results: Pick<RedisAgentContextViewResults, "accept"> = getAgentContextViewResults(),
): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    const result = decodeAgentContextViewResult(payload);
    if (
      !authorized(
        principal as AgentContextViewViewer & { agentId?: string; computerId?: string },
        result,
      )
    )
      return { code: 403, message: "Agent context view result scope is not authorized" };
    await results.accept(result);
    return new Uint8Array();
  };
}

export function agentContextViewResultMethods(enabled = true): Record<string, CentrifugoRpcMethod> {
  return {
    [AGENT_CONTEXT_VIEW_RESULT_METHOD]: enabled
      ? createAgentContextViewResultMethod()
      : () => ({ code: 503, message: "protocol method dependencies are unavailable" }),
  };
}
