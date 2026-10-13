import { RedisClient } from "bun";
import { redisUrlFor } from "#src/server/redis-url.server";
import {
  decodeAgentSkillsListResult,
  encodeAgentSkillsListResult,
  type AgentSkillsListRequest,
  type AgentSkillsListResult,
} from "@lrm/coforge-sdk/internal";
import {
  sameSkillsScope,
  type AgentSkillsResults,
  type PendingSkills,
} from "#src/server/agents/agent-skills.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import { RedisPendingResults } from "./redis-pending-results.server";

export class RedisAgentSkillsResults
  extends RedisPendingResults<AgentSkillsListRequest, AgentSkillsListResult, PendingSkills>
  implements AgentSkillsResults
{
  constructor(redis: Pick<RedisClient, "get" | "set" | "send">) {
    super(redis, {
      prefix: "coforge:agent-skills:v1",
      encode: encodeAgentSkillsListResult,
      decode: decodeAgentSkillsListResult,
      sameScope: sameSkillsScope,
    });
  }
}

let singleton: RedisAgentSkillsResults | undefined;
export function getAgentSkillsResults() {
  if (!singleton) {
    singleton = new RedisAgentSkillsResults(new RedisClient(redisUrlFor("Skills queries")));
  }
  return singleton;
}

export function createAgentSkillsListResultMethod(
  results?: Pick<RedisAgentSkillsResults, "accept">,
): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    const result = decodeAgentSkillsListResult(payload);
    if (
      !principal.userId ||
      principal.agentId ||
      principal.workspaceId !== result.workspaceId ||
      principal.computerId !== result.computerId
    )
      return { code: 403, message: "Skills result scope is not authorized" };
    await (results ?? getAgentSkillsResults()).accept(result);
    return new Uint8Array();
  };
}
