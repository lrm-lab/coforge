import { RUNTIME_MANAGE_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "./computer-capability-lease.server";

let singleton: RedisComputerCapabilityLease | undefined;

export function getRuntimeManageCapabilityLease() {
  return (singleton ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Runtime manage capability leases")),
    RUNTIME_MANAGE_CAPABILITY,
    "runtime-manage-capability",
  ));
}
