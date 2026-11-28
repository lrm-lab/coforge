import { COMPUTER_TERMINAL_CAPABILITY } from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "./computer-capability-lease.server";

let singleton: RedisComputerCapabilityLease | undefined;

export function getComputerTerminalCapabilityLease() {
  return (singleton ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Computer terminal capability leases")),
    COMPUTER_TERMINAL_CAPABILITY,
    "computer-terminal-capability",
  ));
}
