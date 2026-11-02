import { LOCAL_SESSION_HANDOFF_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "./computer-capability-lease.server";

let singleton: RedisComputerCapabilityLease | undefined;

/** Whether this Computer can answer bounded local Session handoff queries. */
export function getLocalSessionHandoffCapabilityLease() {
  return (singleton ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Local session handoff capability leases")),
    LOCAL_SESSION_HANDOFF_CAPABILITY,
    "local-session-handoff-capability",
  ));
}
