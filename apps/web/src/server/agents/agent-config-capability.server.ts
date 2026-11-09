import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { AGENT_CONFIG_CAPABILITY } from "@lrm/coforge-sdk/internal";

let singleton: RedisComputerCapabilityLease | undefined;

export function getAgentConfigCapabilityLease() {
  return (singleton ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Agent config capability leases")),
    AGENT_CONFIG_CAPABILITY,
    "agent-config-capability",
  ));
}
