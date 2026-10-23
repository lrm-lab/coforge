import { APP_REGISTRATION_NOTICE_CAPABILITY } from "@lrm/coforge-sdk/internal/app-registration-notice";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";

let lease: RedisComputerCapabilityLease | undefined;

/** Whether a Computer's daemon takes the private app registration notice. */
export function getAppRegistrationNoticeCapabilityLease() {
  lease ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("app registration notice capability leases")),
    APP_REGISTRATION_NOTICE_CAPABILITY,
    "app-registration-notice-capability",
  );
  return lease;
}
