import { AGENT_CONTEXT_VIEW_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "./computer-capability-lease.server";

let singleton: RedisComputerCapabilityLease | undefined;

export function getAgentContextViewCapabilityLease() {
  return (singleton ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Agent context view capability leases")),
    AGENT_CONTEXT_VIEW_CAPABILITY,
    "agent-context-view-capability",
  ));
}
