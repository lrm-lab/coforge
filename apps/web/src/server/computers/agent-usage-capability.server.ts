import { DAEMON_AGENT_USAGE_SCAN_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "./computer-capability-lease.server";

let lease: RedisComputerCapabilityLease | undefined;

export function getAgentUsageCapabilityLease() {
  return (lease ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Agent usage capability leases")),
    DAEMON_AGENT_USAGE_SCAN_CAPABILITY,
    "agent-usage-capability",
  ));
}
