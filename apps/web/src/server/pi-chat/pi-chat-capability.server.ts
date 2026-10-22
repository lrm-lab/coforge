import { PI_CHAT_CAPABILITY } from "@lrm/coforge-sdk/internal/pi-chat-wire";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";

let lease: RedisComputerCapabilityLease | undefined;
export function getPiChatCapabilityLease() {
  return (lease ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Pi chat capability leases")),
    PI_CHAT_CAPABILITY,
    "pi-chat-capability",
  ));
}
