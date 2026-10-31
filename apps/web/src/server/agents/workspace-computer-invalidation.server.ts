import type { RedisClient } from "bun";
import {
  cacheInvalidation,
  LocalCacheInvalidation,
  RedisCacheInvalidation,
  type CacheInvalidation,
} from "#src/server/cache-invalidation.server";

const CHANNEL = "coforge:workspace-computer:v1";

/**
 * The signal a `workspaceComputer` ownership write sends: an entry a process-local cache
 * (`workspace-computer-cache`) must drop at once — on this instance and, through a Redis
 * pub/sub channel, on every other web instance. A Computer detached or deleted must not keep
 * relaying Activity under its old Workspace on a cached positive; the 30 s TTL is only the
 * backstop. The key is the Computer id (`cache-invalidation`).
 */
export type WorkspaceComputerInvalidation = CacheInvalidation;

export class LocalWorkspaceComputerInvalidation extends LocalCacheInvalidation {}

/** Cross-instance invalidation: the ownership write may land on a different web instance. */
export class RedisWorkspaceComputerInvalidation extends RedisCacheInvalidation {
  constructor(publisher: RedisClient, subscriber: () => RedisClient) {
    super(CHANNEL, publisher, subscriber);
  }
}

export function getWorkspaceComputerInvalidation(): WorkspaceComputerInvalidation {
  return cacheInvalidation(CHANNEL);
}
