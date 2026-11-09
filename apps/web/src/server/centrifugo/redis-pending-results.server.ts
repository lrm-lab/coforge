import type { RedisClient } from "bun";
import { subscribeAcrossReconnects, type RedisSubscriber } from "#src/server/redis-client.server";

// Compare the entire pending value atomically: expiry/cancellation cannot race the result write.
// First valid result wins; duplicates do not extend its TTL.
const ACCEPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3], 'NX') and 1 or 0`;

/** What one kind of Daemon query stores: its key prefix, its protobuf result codec, and the scope
 * rule a result must match against the pending request it answers. */
export type PendingResultsKind<Request extends { requestId: string }, Result> = {
  prefix: string;
  /** Default 30 seconds; longer probes retain their pending scope until their own deadline. */
  pendingTtlSeconds?: number;
  /** Default 30 seconds; private result kinds may retain less. */
  resultTtlSeconds?: number;
  encode(result: Result): Uint8Array;
  decode(bytes: Uint8Array): Result;
  sameScope(pending: Request, result: Result): boolean;
};

/**
 * A browser query the Daemon answers over Centrifugo: `begin` records the pending request for the
 * kind's lifetime (30 seconds by default), `accept` stores the first result whose scope matches it (base64 protobuf, the kind's result TTL, 30 seconds by default), `read` returns that result and `clear` drops both. Keys are
 * `<prefix>:<requestId>:pending` and `<prefix>:<requestId>:result`.
 *
 * The Workspace Files list/read/delete queries and the Skills query each wrote this class out in
 * full; only `PendingResultsKind` differed.
 */
export class RedisPendingResults<
  Request extends { requestId: string },
  Result extends { requestId: string },
  Pending extends { request: Request } = { request: Request; userId: string; revision: string },
> {
  private readonly wakeWaiters = new Map<string, Set<(signaled: boolean) => void>>();
  private wakeSubscription: Promise<void> | undefined;

  constructor(
    private readonly redis: Pick<RedisClient, "get" | "set" | "send">,
    private readonly kind: PendingResultsKind<Request, Result>,
    /** Opt-in wake-up for `wait`: a stored result publishes its requestId on `<prefix>:wake`,
     * locally and to every other web instance. Kinds that do not pass this behave as before. */
    private readonly wake?: { subscribe: () => RedisSubscriber },
  ) {}

  private keys(id: string) {
    return [`${this.kind.prefix}:${id}:pending`, `${this.kind.prefix}:${id}:result`];
  }

  /** Resolves `true` when this request's result was stored, `false` when `timeoutMs` elapsed
   * first. Callers still `read` on every wake: the result itself is the source of truth, so a
   * notification lost to a reconnect gap only delays the read by the caller's next slice. */
  wait(requestId: string, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return Promise.resolve(false);
    this.subscribeWake();
    return new Promise<boolean>((resolve) => {
      let pending = this.wakeWaiters.get(requestId);
      if (!pending) this.wakeWaiters.set(requestId, (pending = new Set()));
      const done = (signaled: boolean) => {
        clearTimeout(timer);
        pending!.delete(done);
        if (pending!.size === 0 && this.wakeWaiters.get(requestId) === pending)
          this.wakeWaiters.delete(requestId);
        resolve(signaled);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      pending.add(done);
    });
  }

  private wakeChannel() {
    return `${this.kind.prefix}:wake`;
  }

  private wakeLocal(requestId: string) {
    const pending = this.wakeWaiters.get(requestId);
    if (!pending) return;
    this.wakeWaiters.delete(requestId);
    for (const done of pending) done(true);
  }

  private wakeAllLocal() {
    for (const requestId of this.wakeWaiters.keys()) this.wakeLocal(requestId);
  }

  private subscribeWake() {
    const wake = this.wake;
    if (!wake) return;
    // After a reconnect, a notification published meanwhile is lost: every waiter re-reads.
    this.wakeSubscription ??= subscribeAcrossReconnects(
      wake.subscribe(),
      this.wakeChannel(),
      (message) => this.wakeLocal(message),
      () => this.wakeAllLocal(),
    ).then(
      () => {},
      () => {
        this.wakeSubscription = undefined;
      },
    );
  }

  async begin(pending: Pending) {
    await this.redis.set(
      this.keys(pending.request.requestId)[0]!,
      JSON.stringify(pending),
      "EX",
      String(this.kind.pendingTtlSeconds ?? 30),
    );
  }

  async read(requestId: string) {
    const value = await this.redis.get(this.keys(requestId)[1]!);
    return value ? this.kind.decode(Buffer.from(value, "base64")) : undefined;
  }

  async clear(requestId: string) {
    await this.redis.send("DEL", this.keys(requestId));
  }

  async accept(result: Result): Promise<boolean> {
    const keys = this.keys(result.requestId);
    const value = await this.redis.get(keys[0]!);
    if (!value) return false;
    const pending = JSON.parse(value) as Pending;
    if (!this.kind.sameScope(pending.request, result)) return false;
    const outcome = await this.redis.send("EVAL", [
      ACCEPT,
      "2",
      ...keys,
      value,
      Buffer.from(this.kind.encode(result)).toString("base64"),
      String(this.kind.resultTtlSeconds ?? 30),
    ]);
    const accepted = outcome === undefined || Number(outcome) === 1;
    if (accepted && this.wake) {
      // Same-process waiters wake at once; the publish reaches waiters on other instances.
      // Never block the result path on Redis.
      this.wakeLocal(result.requestId);
      this.redis.send("PUBLISH", [this.wakeChannel(), result.requestId]).catch(() => {});
    }
    return accepted;
  }
}
