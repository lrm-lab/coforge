import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal/runtime-provider";
import {
  KIRO_IDENTITY_CENTER_AUTH_CAPABILITY,
  RUNTIME_AUTH_CAPABILITY,
  type RuntimeAuthProvider,
} from "@lrm/coforge-sdk/internal";
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

let kiro: RedisComputerCapabilityLease | undefined;
export function getKiroIdentityCenterCapabilityLease() {
  return (kiro ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Kiro enterprise auth capability leases")),
    KIRO_IDENTITY_CENTER_AUTH_CAPABILITY,
    "kiro-idc-auth-capability",
  ));
}
export const runtimeAuthCapabilitySupport = {
  supports(workspaceId: string, computerId: string, provider?: RuntimeAuthProvider) {
    return (
      provider === RUNTIME_PROVIDER.KIRO
        ? getKiroIdentityCenterCapabilityLease()
        : getRuntimeAuthCapabilityLease()
    ).supports(workspaceId, computerId);
  },
};
