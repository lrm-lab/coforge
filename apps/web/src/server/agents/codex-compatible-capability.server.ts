import { CODEX_COMPATIBLE_PROVIDER_CAPABILITY } from "@lrm/coforge-sdk/internal/codex-compatible-provider";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";

let lease: RedisComputerCapabilityLease | undefined;
export function getCodexCompatibleCapabilityLease() {
  return (lease ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Codex compatible provider capability leases")),
    CODEX_COMPATIBLE_PROVIDER_CAPABILITY,
    "codex-compatible-capability",
  ));
}
