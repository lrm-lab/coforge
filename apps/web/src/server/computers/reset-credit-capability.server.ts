import { RESET_CREDIT_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";

let singleton: RedisComputerCapabilityLease | undefined;

/** Whether a Computer's daemon takes a request to spend a rate-limit reset credit. */
export function getResetCreditCapabilityLease() {
  return (singleton ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Reset credit capability leases")),
    RESET_CREDIT_CAPABILITY,
    "reset-credit-capability",
  ));
}
