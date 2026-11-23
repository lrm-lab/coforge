/**
 * Phone notifications waiting for a person to stop using the computer (task #467), per person:
 * one sorted set says when each person is next looked at, and each person's hash holds the
 * messages waiting for them with when each first waited. Looking at a person costs their settings
 * and activity only; their messages are read once, when they leave the computer. The sweep takes
 * due people atomically, so of several web instances only one handles each. Rebuildable: losing it
 * costs at most phone notifications for messages the computer already showed.
 */
export const DEFERRED_MOBILE_PUSH_KEY = "coforge:deferred-mobile-push:v2";
/** A phone notification still waiting this long after it first waited is dropped. */
export const SCOPED_DEFERRED_MOBILE_PUSH_KEY = "coforge:deferred-mobile-push:v3";
export const MAX_DEFER_MS = 12 * 3_600_000;

export type DeferredPush = {
  messageId: string;
  userId: string;
  firstQueuedAt: Date;
  routes?: string[];
};

export interface DeferredPushQueue {
  /** Adds a message to the person's waiting ones (keeping when it first waited) and looks at the
   * person again at `dueAt`. */
  defer(entry: DeferredPush, dueAt: Date): Promise<void>;
  /** Looks at the person again at `dueAt`; their messages stay. */
  reschedule(userId: string, dueAt: Date): Promise<void>;
  /** Removes and returns everything waiting for the person. */
  takeMessages(userId: string): Promise<DeferredPush[]>;
}

type Redis = {
  eval(script: string, keys: number, ...args: Array<string | number>): Promise<unknown>;
};

/** KEYS = due set, the person's hash; ARGV = userId, messageId, firstQueuedMs, dueMs, hash TTL ms. */
const DEFER = `redis.call("HSETNX", KEYS[2], ARGV[2], ARGV[3])
redis.call("PEXPIRE", KEYS[2], ARGV[5])
redis.call("ZADD", KEYS[1], ARGV[4], ARGV[1])
return 1
`;

/** KEYS = the person's hash: its entries, removed. */
const TAKE_MESSAGES = `local entries = redis.call("HGETALL", KEYS[1])
redis.call("DEL", KEYS[1])
return entries
`;

/** KEYS = due set; ARGV = limit, now ms (the clock that scored them): the people due, removed. */
const TAKE_DUE = `local due = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[2], "LIMIT", 0, ARGV[1])
if #due > 0 then redis.call("ZREM", KEYS[1], unpack(due)) end
return due
`;

export class RedisDeferredPushes implements DeferredPushQueue {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = DEFERRED_MOBILE_PUSH_KEY,
    private readonly scoped = false,
  ) {}

  private dueKey() {
    return `${this.prefix}:due`;
  }

  private personKey(userId: string) {
    return `${this.prefix}:person:${userId}`;
  }

  async defer(entry: DeferredPush, dueAt: Date): Promise<void> {
    if (this.scoped && !entry.routes?.length) throw new Error("missing deferred Push routes");
    const queuedAt = entry.firstQueuedAt.getTime();
    const stored = this.scoped ? JSON.stringify({ queuedAt, routes: entry.routes }) : queuedAt;
    await this.redis.eval(
      DEFER,
      2,
      this.dueKey(),
      this.personKey(entry.userId),
      entry.userId,
      entry.messageId,
      stored,
      dueAt.getTime(),
      MAX_DEFER_MS + 3_600_000,
    );
  }

  async reschedule(userId: string, dueAt: Date): Promise<void> {
    await this.redis.eval(
      `redis.call("ZADD", KEYS[1], ARGV[1], ARGV[2]) return 1`,
      1,
      this.dueKey(),
      dueAt.getTime(),
      userId,
    );
  }

  async takeMessages(userId: string): Promise<DeferredPush[]> {
    const flat = (await this.redis.eval(TAKE_MESSAGES, 1, this.personKey(userId))) as string[];
    const entries: DeferredPush[] = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
      const messageId = flat[index]!;
      const value = flat[index + 1]!;
      const entry = this.scoped ? parseScopedPush(value) : { queuedAt: Number(value) };
      if (messageId && entry && Number.isFinite(entry.queuedAt))
        entries.push({
          messageId,
          userId,
          firstQueuedAt: new Date(entry.queuedAt),
          ...("routes" in entry ? { routes: entry.routes } : {}),
        });
    }
    return entries;
  }

  /** The people due by `now`, at most `limit`, each taken by this caller alone. */
  async takeDuePeople(limit: number, now: Date): Promise<string[]> {
    return (await this.redis.eval(TAKE_DUE, 1, this.dueKey(), limit, now.getTime())) as string[];
  }
}

function parseScopedPush(value: string): { queuedAt: number; routes: string[] } | null {
  try {
    const { queuedAt, routes } = JSON.parse(value) ?? {};
    if (
      typeof queuedAt !== "number" ||
      !Array.isArray(routes) ||
      routes.length === 0 ||
      !routes.every((route) => typeof route === "string")
    )
      return null;
    return { queuedAt, routes };
  } catch {
    return null;
  }
}
