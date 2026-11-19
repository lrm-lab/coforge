import { AGENT_SIDE_ASK_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "./computer-capability-lease.server";

let singleton: RedisComputerCapabilityLease | undefined;

export function getAgentSideAskCapabilityLease() {
  return (singleton ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Agent side ask capability leases")),
    AGENT_SIDE_ASK_CAPABILITY,
    "agent-side-ask-capability",
  ));
}
