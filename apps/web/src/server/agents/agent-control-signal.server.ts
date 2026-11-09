import type { RedisClient } from "bun";
import { openRedisClient, subscribeAcrossReconnects } from "#src/server/redis-client.server";

/**
 * Wakes a control waiter when an Agent's control state changes, so `drive()`
 * does not have to poll PostgreSQL every 100ms. Waiters still fall back to a
 * slow re-read, so a lost signal only delays completion.
 */
export interface AgentControlSignal {
  notify(agentId: string): Promise<void>;
  /** Resolves `true` when `notify(agentId)` fires, `false` when `timeoutMs` elapses first. */
  wait(agentId: string, timeoutMs: number): Promise<boolean>;
  /** Leaves a TTL'd record that `key` fired, for a notification that must still be seen by a
   * waiter which registers only afterwards; `remembered(key)` answers whether it was. */
  remember(key: string): Promise<void>;
  remembered(key: string): Promise<boolean>;
}

/** How long a `remember`ed key stays visible to late waiters; far past any `execute()` wait. */
const REMEMBERED_TTL_MS = 5 * 60_000;
/** A remembered-marker read answers well under the client's 2s command timeout; past this the
 * wait degrades to the pre-marker behaviour rather than spending the acknowledgement bound. */
const REMEMBERED_READ_MS = 250;

/** Same-process waiters; the Redis implementation fans out to these. */
export class LocalAgentControlSignal implements AgentControlSignal {
  private readonly waiters = new Map<string, Set<(signaled: boolean) => void>>();
  private readonly rememberedKeys = new Map<string, number>();

  async notify(agentId: string) {
    this.wake(agentId);
  }

  async remember(key: string) {
    this.rememberedKeys.set(key, Date.now() + REMEMBERED_TTL_MS);
  }

  async remembered(key: string) {
    const expiresAt = this.rememberedKeys.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.rememberedKeys.delete(key);
      return false;
    }
    return true;
  }

  wakeAll() {
    for (const agentId of [...this.waiters.keys()]) this.wake(agentId);
  }

  wake(agentId: string) {
    const pending = this.waiters.get(agentId);
    if (!pending) return;
    this.waiters.delete(agentId);
    for (const resolve of pending) resolve(true);
  }

  wait(agentId: string, timeoutMs: number) {
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let pending = this.waiters.get(agentId);
      if (!pending) this.waiters.set(agentId, (pending = new Set()));
      const done = (signaled: boolean) => {
        clearTimeout(timer);
        pending!.delete(done);
        if (pending!.size === 0 && this.waiters.get(agentId) === pending)
          this.waiters.delete(agentId);
        resolve(signaled);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      pending.add(done);
    });
  }
}

const CHANNEL = "coforge:agent-control:v1";
const REMEMBERED_PREFIX = "coforge:agent-control:remembered:";

/** Cross-instance wake-ups: the RPC ACK may land on a different web instance than the waiter. */
export class RedisAgentControlSignal implements AgentControlSignal {
  private readonly local = new LocalAgentControlSignal();
  private subscription: Promise<void> | undefined;

  constructor(
    private readonly publisher: RedisClient,
    private readonly subscriber: () => RedisClient,
  ) {}

  async notify(agentId: string) {
    this.local.wake(agentId);
    // Never block the ACK path on Redis; waiters elsewhere fall back to their slow re-read.
    this.publisher.publish(CHANNEL, agentId).catch(() => {});
  }

  async remember(key: string) {
    // The marker must outlive the pub/sub hop: the receiver writes it before notifying, so a
    // waiter that registers after the notification still finds it. A failed write degrades to
    // the pre-marker behaviour — the bounded wait simply runs out.
    await this.publisher
      .set(`${REMEMBERED_PREFIX}${key}`, "1", "EX", REMEMBERED_TTL_MS / 1_000)
      .catch(() => {});
  }

  async remembered(key: string) {
    try {
      return await Promise.race([
        this.publisher.get(`${REMEMBERED_PREFIX}${key}`).then((value) => value !== null),
        Bun.sleep(REMEMBERED_READ_MS).then(() => false),
      ]);
    } catch {
      return false;
    }
  }

  wait(agentId: string, timeoutMs: number) {
    if (timeoutMs <= 0) return Promise.resolve(false);
    this.subscribe();
    // The fallback timeout bounds the wait even while the subscription is still connecting.
    return this.local.wait(agentId, timeoutMs);
  }

  private subscribe() {
    // After a reconnect, a wake-up published meanwhile is lost: every waiter re-reads instead.
    this.subscription ??= subscribeAcrossReconnects(
      this.subscriber(),
      CHANNEL,
      (message) => this.local.wake(message),
      () => this.local.wakeAll(),
    ).then(
      () => {},
      () => {
        this.subscription = undefined;
      },
    );
  }
}

let singleton: AgentControlSignal | undefined;

export function getAgentControlSignal(): AgentControlSignal {
  if (singleton) return singleton;
  const redisUrl = process.env.REDIS_URL;
  return (singleton = redisUrl
    ? new RedisAgentControlSignal(openRedisClient(redisUrl), () => openRedisClient(redisUrl))
    : new LocalAgentControlSignal());
}
