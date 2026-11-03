import { PRESENCE_ONLINE_TTL_MS, type ComputerActivity } from "./notification-rules.server";

/**
 * Whether a person is at a computer (task #467): the visible, focused CoForge page of a computer
 * browser reports its last input every 60 seconds, input or not, and the report lives in Redis for
 * 150 seconds (`PRESENCE_ONLINE_TTL_MS`). Only input on a CoForge page counts. Short-lived and
 * rebuildable, like the Agent and Computer status keys: losing it only lets one phone notification
 * ring at once. The value is `lastInputMs|reportedMs`.
 */
export const computerActivityKey = (userId: string) => `coforge:computer-activity:v1:${userId}`;

export interface ComputerActivityReader {
  read(userIds: readonly string[]): Promise<Map<string, ComputerActivity>>;
}

type Redis = {
  eval(script: string, keys: number, ...args: Array<string | number>): Promise<unknown>;
  mget(...keys: string[]): Promise<Array<string | null>>;
};

/** Writes a report keeping the newer of the stored and the reported input (two computers, or a
 * focus moving between windows, never move it back): ARGV = input ms, reported ms, TTL ms. */
const REPORT = `local input = tonumber(ARGV[1])
local old = redis.call("GET", KEYS[1])
if old then
  local stored = tonumber(string.match(old, "^(%d+)|"))
  if stored and stored > input then input = stored end
end
redis.call("SET", KEYS[1], string.format("%d|%s", input, ARGV[2]), "PX", ARGV[3])
return 1
`;

export class RedisComputerActivity implements ComputerActivityReader {
  constructor(private readonly redis: Redis) {}

  /** Records a report made at `now`. An input time from the future is now; one older than the
   * active window is kept as it is (it says the person stopped), but never older than a day. */
  async report(userId: string, lastInputAt: Date, now: Date): Promise<void> {
    const input = Math.max(
      Math.min(lastInputAt.getTime(), now.getTime()),
      now.getTime() - 24 * 3_600_000,
    );
    await this.redis.eval(
      REPORT,
      1,
      computerActivityKey(userId),
      input,
      now.getTime(),
      PRESENCE_ONLINE_TTL_MS,
    );
  }

  async read(userIds: readonly string[]): Promise<Map<string, ComputerActivity>> {
    if (userIds.length === 0) return new Map();
    const values = await this.redis.mget(...userIds.map(computerActivityKey));
    const activity = new Map<string, ComputerActivity>();
    userIds.forEach((userId, index) => {
      const parsed = parse(values[index]);
      if (parsed) activity.set(userId, parsed);
    });
    return activity;
  }
}

function parse(value: string | null | undefined): ComputerActivity | undefined {
  const match = value?.match(/^(\d+)\|(\d+)$/);
  if (!match) return undefined;
  return { lastInputAt: new Date(Number(match[1])), reportedAt: new Date(Number(match[2])) };
}
