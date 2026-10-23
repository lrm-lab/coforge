/**
 * The expiry index behind the presence events. A status key lapses silently after its 90 s lease
 * and Redis tells nobody, so while app notifications are in use every write of an active Agent or
 * an online Computer also files the status key in a sorted set (score: the millisecond its lease
 * ends, member: the status key itself), in the same script as the write. `PresenceSweep` claims
 * the members whose time has passed and whose key is really gone. Inactive Agents and offline
 * Computers are removed from the set, and the set is rebuildable and non-authoritative: losing it
 * loses only the events of the leases it held.
 */
export const PRESENCE_EXPIRY_KEY = "coforge:presence-expiry:v1";

/** How long a Computer's transition counter outlives its last transition; an event id also carries
 * Redis's time, so a counter that restarted after this still names a new transition. */
export const PRESENCE_SEQ_TTL_SECONDS = 7 * 24 * 3600;

/** Redis's own clock in milliseconds, as `now_ms`: the score and the lease it measures share it. */
export const REDIS_NOW_MS_LUA = `
local time = redis.call("TIME")
local now_ms = time[1] * 1000 + math.floor(time[2] / 1000)
`;

/** The scope of a status key, read back from the member: the grammar is `workspaceRedisKey`'s. */
export type PresenceMember =
  | { kind: "agent"; workspaceId: string; computerId: string; agentId: string }
  | { kind: "computer"; workspaceId: string; computerId: string };

const MEMBER = /^coforge:workspace:([^:]+):computer:([^:]+)(?::agent:([^:]+))?:status:v\d+$/;

export function parsePresenceMember(member: string): PresenceMember | undefined {
  const match = MEMBER.exec(member);
  if (!match) return undefined;
  try {
    const [workspaceId, computerId, agentId] = [match[1]!, match[2]!, match[3]].map((part) =>
      part === undefined ? undefined : decodeURIComponent(part),
    ) as [string, string, string | undefined];
    return agentId === undefined
      ? { kind: "computer", workspaceId, computerId }
      : { kind: "agent", workspaceId, computerId, agentId };
  } catch {
    return undefined;
  }
}
