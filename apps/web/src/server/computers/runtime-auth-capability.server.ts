import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal/runtime-provider";
import {
  KIRO_FREE_AUTH_CAPABILITY,
  KIRO_IDENTITY_CENTER_AUTH_CAPABILITY,
  RUNTIME_AUTH_CAPABILITY,
  RUNTIME_AUTH_STATUS_READ_CAPABILITY,
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

/** The daemon takes `status_read`; a Computer without it cannot be asked to read one again. */
let statusRead: RedisComputerCapabilityLease | undefined;
export function getRuntimeAuthStatusReadCapabilityLease() {
  return (statusRead ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Runtime auth status read capability leases")),
    RUNTIME_AUTH_STATUS_READ_CAPABILITY,
    "runtime-auth-status-read-capability",
  ));
}
/** Kiro's free sign-in: a Computer without this lease only ever gets the identity-center form. */
let kiroFree: RedisComputerCapabilityLease | undefined;
export function getKiroFreeCapabilityLease() {
  return (kiroFree ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Kiro free auth capability leases")),
    KIRO_FREE_AUTH_CAPABILITY,
    "kiro-free-auth-capability",
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
  /** Whether this Computer can start Kiro's free sign-in (Builder ID, Google, GitHub). */
  supportsKiroFree(workspaceId: string, computerId: string) {
    return getKiroFreeCapabilityLease().supports(workspaceId, computerId);
  },
  supportsStatusRead(workspaceId: string, computerId: string) {
    return getRuntimeAuthStatusReadCapabilityLease().supports(workspaceId, computerId);
  },
};
