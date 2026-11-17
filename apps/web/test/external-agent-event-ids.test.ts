import { expect, test } from "bun:test";
import {
  EXTERNAL_EVENT_ID_TTL_SECONDS,
  claimExternalEventIds,
  releaseExternalEventIds,
} from "#src/server/agents/external-agent-event-ids.server";

const AGENT = { workspaceId: "ws", agentId: "agent" };

function memoryRedis() {
  const keys = new Map<string, number>();
  return {
    keys,
    set: async (key: string, _value: string, ...options: Array<string | number>) => {
      if (options[0] === "NX" && keys.has(key)) return null;
      keys.set(key, Number(options[2]));
      return "OK";
    },
    del: async (key: string) => keys.delete(key),
  };
}

test("an event id is claimed once for a day, and a released one can be claimed again", async () => {
  const redis = memoryRedis();
  expect([...(await claimExternalEventIds(redis, AGENT, ["a", "b"]))]).toEqual(["a", "b"]);
  expect([...(await claimExternalEventIds(redis, AGENT, ["b", "c"]))]).toEqual(["c"]);
  expect([...redis.keys.values()]).toEqual(Array(3).fill(EXTERNAL_EVENT_ID_TTL_SECONDS));
  await releaseExternalEventIds(redis, AGENT, ["b"]);
  expect([...(await claimExternalEventIds(redis, AGENT, ["b"]))]).toEqual(["b"]);
});

test("another Agent's event ids do not collide", async () => {
  const redis = memoryRedis();
  await claimExternalEventIds(redis, AGENT, ["a"]);
  expect([...(await claimExternalEventIds(redis, { ...AGENT, agentId: "other" }, ["a"]))]).toEqual([
    "a",
  ]);
});

test("an unreachable store does not hide events: they are treated as new", async () => {
  const redis = {
    set: async () => {
      throw new Error("down");
    },
  };
  expect([...(await claimExternalEventIds(redis, AGENT, ["a"]))]).toEqual(["a"]);
});
