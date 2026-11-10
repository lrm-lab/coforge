import type { RedisClient } from "bun";
import type { AgentTurnInterruptResult } from "@lrm/coforge-sdk/internal";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";

/** How long a stored result stays readable, so a page that lost the reply can ask again. */
export const AGENT_TURN_INTERRUPT_RESULT_TTL_SECONDS = 60;

type Scope = { workspaceId: string; agentId: string; requestId: string };

/**
 * Where a daemon's turn interrupt result waits for the page that asked. The instance that receives
 * the result is not necessarily the one the page polls.
 */
export interface AgentTurnInterruptResults {
  /** Keeps the first result for a request; a later one for the same request is dropped. */
  put(scope: Scope, result: AgentTurnInterruptResult): Promise<void>;
  /** The stored result of one request, or undefined while none has arrived or after it expired. */
  read(scope: Scope): Promise<AgentTurnInterruptResult | undefined>;
}

/** A result in a key with a TTL. The key names the Agent, so only a result for the Agent a request
 * was made for can be read back by it. */
export class RedisAgentTurnInterruptResults implements AgentTurnInterruptResults {
  constructor(private readonly redis: Pick<RedisClient, "get" | "set">) {}

  async put(scope: Scope, result: AgentTurnInterruptResult) {
    await this.redis.set(
      this.#key(scope),
      JSON.stringify(result),
      "EX",
      String(AGENT_TURN_INTERRUPT_RESULT_TTL_SECONDS),
      "NX",
    );
  }

  async read(scope: Scope) {
    const value = await this.redis.get(this.#key(scope));
    if (!value) return undefined;
    try {
      return JSON.parse(value) as AgentTurnInterruptResult;
    } catch {
      return undefined;
    }
  }

  #key({ workspaceId, agentId, requestId }: Scope) {
    return `${workspaceRedisKey({ workspaceId, agentId, name: "agent-turn-interrupt-result", version: "v1" })}:request:${encodeURIComponent(requestId)}`;
  }
}

let singleton: RedisAgentTurnInterruptResults | undefined;

export function getAgentTurnInterruptResults() {
  return (singleton ??= new RedisAgentTurnInterruptResults(
    openRedisClient(redisUrlFor("Agent turn interrupt results")),
  ));
}
