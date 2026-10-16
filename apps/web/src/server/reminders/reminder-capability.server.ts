import { RedisClient } from "bun";
import { REMINDER_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { redisUrlFor } from "#src/server/redis-url.server";

let lease: RedisComputerCapabilityLease | undefined;

/** Whether a Computer's daemon runs reminders (`reminder:v1`). */
export function getReminderCapabilityLease() {
  lease ??= new RedisComputerCapabilityLease(
    new RedisClient(redisUrlFor("reminder capability leases")),
    REMINDER_CAPABILITY,
    "reminder-capability",
  );
  return lease;
}
