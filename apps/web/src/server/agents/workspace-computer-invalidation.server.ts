import type { RedisClient } from "bun";
import { openRedisClient, subscribeAcrossReconnects } from "#src/server/redis-client.server";

const CHANNEL = "coforge:workspace-computer:v1";

/**
 * The signal a `workspaceComputer` ownership write sends: an entry a process-local cache
 * (`workspace-computer-cache`) must drop at once — on this instance and, through a Redis
 * pub/sub channel, on every other web instance. A Computer detached or deleted must not keep
 * relaying Activity under its old Workspace on a cached positive; the 30 s TTL is only the
 * backstop. Local forgets are registered once by each cache (`forgetWith`); a notify forgets
 * locally and publishes the Computer id, never blocking the caller on Redis.
 */
export interface WorkspaceComputerInvalidation {
  /** Forget every remembered answer for this Computer, here and on every other instance. */
  notify(computerId: string): void;
  /** Register a local cache's forget; a missing id flushes everything (a lost broadcast). */
  forgetWith(forget: (computerId?: string) => void): void;
}

export class LocalWorkspaceComputerInvalidation implements WorkspaceComputerInvalidation {
  private readonly forgetters = new Set<(computerId?: string) => void>();

  notify(computerId: string) {
    this.forget(computerId);
  }

  forgetWith(forget: (computerId?: string) => void) {
    this.forgetters.add(forget);
  }

  forget(computerId?: string) {
    for (const forget of this.forgetters) forget(computerId);
  }
}

/** Cross-instance invalidation: the ownership write may land on a different web instance. */
export class RedisWorkspaceComputerInvalidation
  extends LocalWorkspaceComputerInvalidation
  implements WorkspaceComputerInvalidation
{
  private subscription: Promise<void> | undefined;

  constructor(
    private readonly publisher: RedisClient,
    private readonly subscriber: () => RedisClient,
  ) {
    super();
  }

  override notify(computerId: string) {
    this.forget(computerId);
    // Never block the ownership write on Redis; other instances fall back to their TTL.
    this.publisher.publish(CHANNEL, computerId).catch(() => {});
  }

  override forgetWith(forget: (computerId?: string) => void) {
    super.forgetWith(forget);
    this.subscribe();
  }

  private subscribe() {
    // After a reconnect, a notify published meanwhile is lost: every cache flushes instead.
    this.subscription ??= subscribeAcrossReconnects(
      this.subscriber(),
      CHANNEL,
      (message) => this.forget(message),
      () => this.forget(),
    ).then(
      () => {},
      () => {
        this.subscription = undefined;
      },
    );
  }
}

let singleton: WorkspaceComputerInvalidation | undefined;

export function getWorkspaceComputerInvalidation(): WorkspaceComputerInvalidation {
  if (singleton) return singleton;
  const redisUrl = process.env.REDIS_URL;
  return (singleton = redisUrl
    ? new RedisWorkspaceComputerInvalidation(openRedisClient(redisUrl), () =>
        openRedisClient(redisUrl),
      )
    : new LocalWorkspaceComputerInvalidation());
}
