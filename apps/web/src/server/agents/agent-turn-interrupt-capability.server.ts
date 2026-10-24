import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { AGENT_TURN_INTERRUPT_CAPABILITY } from "@lrm/coforge-sdk/internal";

let singleton: RedisComputerCapabilityLease | undefined;

export function getAgentTurnInterruptCapabilityLease() {
  return (singleton ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Agent turn interrupt capability leases")),
    AGENT_TURN_INTERRUPT_CAPABILITY,
    "agent-turn-interrupt-capability",
  ));
}
