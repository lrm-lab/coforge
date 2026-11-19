import type { RedisClient } from "bun";
import {
  AGENT_SIDE_ASK_RESULT_METHOD,
  decodeAgentSideAskResult,
  encodeAgentSideAskResult,
  type AgentSideAskRequest,
  type AgentSideAskResult,
} from "@lrm/coforge-sdk/internal";
import {
  sameAgentSideAskScope,
  type AgentSideAskViewer,
} from "#src/server/computers/computer-agent-side-asks.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import { RedisPendingResults } from "./redis-pending-results.server";

const PREFIX = "coforge:agent-side-ask:v1";
const SIDE_ASK_TTL_SECONDS = 75;
type ResultsRedis = Pick<RedisClient, "get" | "set" | "send">;
type Pending = { request: AgentSideAskRequest; userId: string };

export class RedisAgentSideAskResults extends RedisPendingResults<
  AgentSideAskRequest,
  AgentSideAskResult,
  Pending
> {
  constructor(redis: ResultsRedis) {
    super(redis, {
      prefix: PREFIX,
      pendingTtlSeconds: SIDE_ASK_TTL_SECONDS,
      resultTtlSeconds: SIDE_ASK_TTL_SECONDS,
      encode: encodeAgentSideAskResult,
      decode: decodeAgentSideAskResult,
      sameScope: sameAgentSideAskScope,
    });
  }
}

let singleton: RedisAgentSideAskResults | undefined;

export function getAgentSideAskResults() {
  return (singleton ??= new RedisAgentSideAskResults(
    openRedisClient(redisUrlFor("Agent side ask results")),
  ));
}

function isDaemonPrincipal(
  principal: AgentSideAskViewer & { agentId?: string; computerId?: string },
) {
  return Boolean(
    principal.userId && !principal.agentId && principal.workspaceId && principal.computerId,
  );
}

export function createAgentSideAskResultMethod(
  results: Pick<RedisAgentSideAskResults, "accept"> = getAgentSideAskResults(),
): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    const actor = principal as AgentSideAskViewer & { agentId?: string; computerId?: string };
    if (!isDaemonPrincipal(actor))
      return { code: 403, message: "Agent side ask result scope is not authorized" };
    let result: AgentSideAskResult;
    try {
      result = decodeAgentSideAskResult(payload);
    } catch {
      return { code: 400, message: "Invalid agent side ask result" };
    }
    if (actor.workspaceId !== result.workspaceId || actor.computerId !== result.computerId)
      return { code: 403, message: "Agent side ask result scope is not authorized" };
    await results.accept(result);
    return new Uint8Array();
  };
}

export function agentSideAskResultMethods(enabled = true): Record<string, CentrifugoRpcMethod> {
  return {
    [AGENT_SIDE_ASK_RESULT_METHOD]: enabled
      ? createAgentSideAskResultMethod()
      : () => ({ code: 503, message: "protocol method dependencies are unavailable" }),
  };
}
