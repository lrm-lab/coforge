import type { RedisClient } from "bun";

// Compare the entire pending value atomically: expiry/cancellation cannot race the result write.
// First valid result wins; duplicates do not extend its TTL.
const ACCEPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('SET', KEYS[2], ARGV[2], 'EX', 30, 'NX') and 1 or 0`;

/** What one kind of Daemon query stores: its key prefix, its protobuf result codec, and the scope
 * rule a result must match against the pending request it answers. */
export type PendingResultsKind<Request extends { requestId: string }, Result> = {
  prefix: string;
  encode(result: Result): Uint8Array;
  decode(bytes: Uint8Array): Result;
  sameScope(pending: Request, result: Result): boolean;
};

/**
 * A browser query the Daemon answers over Centrifugo: `begin` records the pending request for 30
 * seconds, `accept` stores the first result whose scope matches it (base64 protobuf, also 30
 * seconds), `read` returns that result and `clear` drops both. Keys are
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
  constructor(
    private readonly redis: Pick<RedisClient, "get" | "set" | "send">,
    private readonly kind: PendingResultsKind<Request, Result>,
  ) {}

  private keys(id: string) {
    return [`${this.kind.prefix}:${id}:pending`, `${this.kind.prefix}:${id}:result`];
  }

  async begin(pending: Pending) {
    await this.redis.set(
      this.keys(pending.request.requestId)[0]!,
      JSON.stringify(pending),
      "EX",
      "30",
    );
  }

  async read(requestId: string) {
    const value = await this.redis.get(this.keys(requestId)[1]!);
    return value ? this.kind.decode(Buffer.from(value, "base64")) : undefined;
  }

  async clear(requestId: string) {
    await this.redis.send("DEL", this.keys(requestId));
  }

  async accept(result: Result) {
    const keys = this.keys(result.requestId);
    const value = await this.redis.get(keys[0]!);
    if (!value) return;
    const pending = JSON.parse(value) as Pending;
    if (!this.kind.sameScope(pending.request, result)) return;
    await this.redis.send("EVAL", [
      ACCEPT,
      "2",
      ...keys,
      value,
      Buffer.from(this.kind.encode(result)).toString("base64"),
    ]);
  }
}
