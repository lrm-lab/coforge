import { RUNTIME_AUTH_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";

let singleton: RedisComputerCapabilityLease | undefined;

export function getRuntimeAuthCapabilityLease() {
  return (singleton ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Runtime auth capability leases")),
    RUNTIME_AUTH_CAPABILITY,
    "runtime-auth-capability",
  ));
}
