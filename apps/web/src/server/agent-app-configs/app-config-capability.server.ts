import { RedisClient } from "bun";
import { APP_CONFIG_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { redisUrlFor } from "#src/server/redis-url.server";

let lease: RedisComputerCapabilityLease | undefined;

/** Whether a Computer's daemon mirrors Agent App configuration (`app-config:v1`). */
export function getAppConfigCapabilityLease() {
  lease ??= new RedisComputerCapabilityLease(
    new RedisClient(redisUrlFor("app config capability leases")),
    APP_CONFIG_CAPABILITY,
    "app-config-capability",
  );
  return lease;
}
