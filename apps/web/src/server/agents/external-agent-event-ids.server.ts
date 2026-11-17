import { workspaceRedisKey } from "#src/server/redis-keys.server";

export const EXTERNAL_EVENT_ID_TTL_SECONDS = 24 * 60 * 60;

export type EventIdRedis = {
  set(key: string, value: string, ...options: Array<string | number>): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

const keyOf = (agent: { workspaceId: string; agentId: string }, eventId: string) =>
  workspaceRedisKey({
    workspaceId: agent.workspaceId,
    agentId: agent.agentId,
    name: `activity-event:${eventId}`,
    version: "v1",
  });

export async function claimExternalEventIds(
  redis: Pick<EventIdRedis, "set">,
  agent: { workspaceId: string; agentId: string },
  eventIds: readonly string[],
): Promise<Set<string>> {
  const results = await Promise.all(
    eventIds.map((eventId) =>
      redis
        .set(keyOf(agent, eventId), "1", "NX", "EX", EXTERNAL_EVENT_ID_TTL_SECONDS)
        .then((reply) => reply === "OK")
        .catch(() => true),
    ),
  );
  return new Set(eventIds.filter((_, index) => results[index]));
}

export async function releaseExternalEventIds(
  redis: Pick<EventIdRedis, "del">,
  agent: { workspaceId: string; agentId: string },
  eventIds: readonly string[],
): Promise<void> {
  await Promise.all(eventIds.map((eventId) => redis.del(keyOf(agent, eventId))));
}
