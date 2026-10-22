import { openRedisClient } from "#src/server/redis-client.server";
import { AGENT_MIGRATION_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { redisUrlFor } from "#src/server/redis-url.server";

let lease: RedisComputerCapabilityLease | undefined;

/** Whether a Computer's daemon runs Agent migrations (`agent-migration:v1`, since #315). */
export function getAgentMigrationCapabilityLease() {
  lease ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("agent migration capability leases")),
    AGENT_MIGRATION_CAPABILITY,
    "agent-migration-capability",
  );
  return lease;
}
