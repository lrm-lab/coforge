import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { AGENT_SESSION_REJECTION_CAPABILITY } from "@lrm/coforge-sdk/internal/agent-session-rejection";

let singleton: RedisComputerCapabilityLease | undefined;

export function getAgentSessionRejectionCapabilityLease() {
  return (singleton ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Agent session rejection capability leases")),
    AGENT_SESSION_REJECTION_CAPABILITY,
    "agent-session-rejection-capability",
  ));
}
