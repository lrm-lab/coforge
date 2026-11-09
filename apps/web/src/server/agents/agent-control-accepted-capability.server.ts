import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { AGENT_CONTROL_ACCEPTED_CAPABILITY } from "@lrm/coforge-sdk/internal";

let singleton: RedisComputerCapabilityLease | undefined;

export function getAgentControlAcceptedCapabilityLease() {
  return (singleton ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Agent control accepted capability leases")),
    AGENT_CONTROL_ACCEPTED_CAPABILITY,
    "agent-control-accepted-capability",
  ));
}
