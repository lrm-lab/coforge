import type { RedisClient } from "bun";
import { openRedisClient, subscribeAcrossReconnects } from "#src/server/redis-client.server";

/**
 * The signal a write sends to process-local caches that remember what it changed: drop the entry
 * for this key at once, on this instance and, through a Redis pub/sub channel, on every other web
 * instance. Each cache keeps a TTL only as the backstop. Local forgets are registered once by each
 * cache (`forgetWith`); a notify forgets locally and publishes the key, never blocking the caller
 * on Redis.
 */
export interface CacheInvalidation {
  /** Forget every remembered answer for this key, here and on every other instance. */
  notify(key: string): void;
  /** Register a local cache's forget; a missing key flushes everything (a lost broadcast). */
  forgetWith(forget: (key?: string) => void): void;
}

export class LocalCacheInvalidation implements CacheInvalidation {
  private readonly forgetters = new Set<(key?: string) => void>();

  notify(key: string) {
    this.forget(key);
  }

  forgetWith(forget: (key?: string) => void) {
    this.forgetters.add(forget);
  }

  forget(key?: string) {
    for (const forget of this.forgetters) forget(key);
  }
}

/** Cross-instance invalidation: the write may land on a different web instance. */
export class RedisCacheInvalidation extends LocalCacheInvalidation implements CacheInvalidation {
  private subscription: Promise<void> | undefined;

  constructor(
    private readonly channel: string,
    private readonly publisher: RedisClient,
    private readonly subscriber: () => RedisClient,
  ) {
    super();
  }

  override notify(key: string) {
    this.forget(key);
    // Never block the write on Redis; other instances fall back to their TTL.
    this.publisher.publish(this.channel, key).catch(() => {});
  }

  override forgetWith(forget: (key?: string) => void) {
    super.forgetWith(forget);
    this.subscribe();
  }

  private subscribe() {
    // After a reconnect, a notify published meanwhile is lost: every cache flushes instead.
    this.subscription ??= subscribeAcrossReconnects(
      this.subscriber(),
      this.channel,
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

const signals = new Map<string, CacheInvalidation>();

/** The process's one invalidation for a Redis channel: across instances when `REDIS_URL` is set. */
export function cacheInvalidation(channel: string): CacheInvalidation {
  let signal = signals.get(channel);
  if (!signal) {
    const redisUrl = process.env.REDIS_URL;
    signal = redisUrl
      ? new RedisCacheInvalidation(channel, openRedisClient(redisUrl), () =>
          openRedisClient(redisUrl),
        )
      : new LocalCacheInvalidation();
    signals.set(channel, signal);
  }
  return signal;
}
