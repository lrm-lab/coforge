import { afterEach, describe, expect, test } from "bun:test";

import { RedisAgentStatusCache } from "#src/server/agents/agent-status.server";
import { RedisComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  getPresenceObserver,
  setPresenceObserver,
  type PresenceObserver,
} from "#src/server/app-notifications/presence-observer";
import { PresenceSweep } from "#src/server/app-notifications/presence-sweep.server";

function observer(enabled: boolean) {
  const calls = { agent: [] as unknown[], computer: [] as unknown[] };
  const subject: PresenceObserver = {
    enabled: () => enabled,
    agentStatus: (change) => void calls.agent.push(change),
    computerPresence: (change) => void calls.computer.push(change),
  };
  return { calls, subject };
}

describe("PresenceSweep", () => {
  const agentMember = "coforge:workspace:w1:computer:c1:agent:a%201:status:v2";
  const computerMember = "coforge:workspace:w1:computer:c1:status:v1";

  /** `due` is what the DUE script returns after Redis's own `now_ms`. */
  function sweep(options: {
    due?: Array<string | number>;
    redisNow?: number;
    claims?: Record<string, number>;
    lock?: boolean;
    possible?: boolean;
  }) {
    const presence = observer(true);
    const lists: unknown[][] = [];
    const claimed: string[] = [];
    const subject = new PresenceSweep({
      redis: {
        eval: async (_script, keys, ...args) => {
          if (keys === 1)
            return (lists.push(args), [options.redisNow ?? 100_000, ...(options.due ?? [])]);
          claimed.push(String(args[0]));
          return options.claims?.[String(args[0])] ?? 1;
        },
      },
      lock: { acquire: async () => options.lock ?? true },
      observer: presence.subject,
      possible: () => options.possible ?? true,
      expiryKey: "expiry",
      batchLimit: 7,
    });
    return { subject, presence: { calls: presence.calls }, lists, claimed };
  }

  test("emits active to inactive and offline at the expiry time, ids from the score", async () => {
    const { subject, presence, lists } = sweep({
      due: [agentMember, "95000", computerMember, "96000"],
    });
    await subject.tick();
    expect(lists).toEqual([["expiry", 7]]);
    expect(presence.calls.agent).toEqual([
      {
        workspaceId: "w1",
        agentId: "a 1",
        from: "active",
        to: "inactive",
        observedAtMs: 95_000,
        idSeed: `${agentMember}:expired:95000`,
      },
    ]);
    expect(presence.calls.computer).toEqual([
      {
        workspaceId: "w1",
        computerId: "c1",
        from: "online",
        to: "offline",
        observedAtMs: 96_000,
        idSeed: `${computerMember}:expired:96000`,
      },
    ]);
  });

  test("a member whose key came back (claim 0) emits nothing", async () => {
    const { subject, presence, claimed } = sweep({
      due: [computerMember, "96000"],
      claims: { [computerMember]: 0 },
    });
    await subject.tick();
    expect(claimed).toEqual([computerMember]);
    expect(presence.calls.computer).toEqual([]);
  });

  test("a lapse of any age is still emitted, with its true expiry time", async () => {
    const { subject, presence } = sweep({
      due: [computerMember, "1000"],
      redisNow: 100_000_000,
    });
    await subject.tick();
    expect(presence.calls.computer).toEqual([
      expect.objectContaining({ from: "online", to: "offline", observedAtMs: 1_000 }),
    ]);
  });

  test("the lock decides, and `possible` is the one switch for a feature that is off", async () => {
    const locked = sweep({ lock: false, due: [computerMember, "96000"] });
    await locked.subject.tick();
    expect(locked.lists).toEqual([]);
    const off = sweep({ possible: false, due: [computerMember, "96000"] });
    await off.subject.tick();
    expect(off.lists).toEqual([]);
    const on = sweep({});
    await on.subject.tick();
    expect(on.lists[0]).toEqual(["expiry", 7]);
  });

  test("a redis failure never rejects the tick; a malformed member is dropped", async () => {
    const failing = new PresenceSweep({
      redis: { eval: async () => Promise.reject(new Error("down")) },
      lock: { acquire: async () => true },
      observer: observer(true).subject,
      possible: () => true,
    });
    const error = console.error;
    console.error = () => {};
    try {
      await failing.tick();
    } finally {
      console.error = error;
    }
    const { subject, claimed } = sweep({ due: ["not-a-status-key", "1"] });
    await subject.tick();
    expect(claimed).toEqual(["not-a-status-key"]);
  });
});

describe("the presence observer holder", () => {
  afterEach(() => setPresenceObserver(noop()));
  const noop = () => observer(false).subject;

  test("the default observer is a never-enabled no-op", () => {
    const fresh = getPresenceObserver();
    expect(fresh.enabled()).toBe(false);
    expect(() => {
      fresh.agentStatus({
        workspaceId: "w",
        agentId: "a",
        from: "inactive",
        to: "active",
        observedAtMs: 1,
        idSeed: "s",
      });
      fresh.computerPresence({
        workspaceId: "w",
        computerId: "c",
        from: "offline",
        to: "online",
        observedAtMs: 1,
        idSeed: "s",
      });
    }).not.toThrow();
  });

  test("the caches report to the observer set at the composition root", async () => {
    const { calls, subject } = observer(true);
    setPresenceObserver(subject);
    const computers = new RedisComputerStatusCache(
      { set: async () => {}, get: async () => null, mget: async () => [] },
      "90",
      { redis: { eval: async () => ["", 5_000, 1] } },
    );
    await computers.put({ workspaceId: "w", computerId: "c" }, true);
    expect(calls.computer).toHaveLength(1);
    const agents = new RedisAgentStatusCache({
      eval: async () => [1, "inactive"],
      get: async () => null,
      ttl: async () => -2,
    });
    await agents.put({
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      status: "active",
      daemonInstanceId: "d",
      clientSeq: 1,
      observedAtMs: 1,
    });
    expect(calls.agent).toHaveLength(1);
  });

  test("the status caches import neither the queue nor the database", async () => {
    for (const file of [
      "../src/server/agents/agent-status.server.ts",
      "../src/server/centrifugo/computer-status.server.ts",
    ]) {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      expect(source).not.toMatch(
        /app-notification-presence\.server|app-notifications\.server|db\/client/,
      );
    }
  });
});

test("the flag-off Agent put is byte-for-byte the script origin/main ran", async () => {
  const scripts: string[] = [];
  const cache = new RedisAgentStatusCache({
    eval: async (script) => (scripts.push(script), 1),
    get: async () => null,
    ttl: async () => -2,
  });
  await cache.put({
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    status: "active",
    daemonInstanceId: "d",
    clientSeq: 1,
    observedAtMs: 1,
  });
  expect(scripts).toEqual([ORIGINAL_PUT_AGENT_STATUS]);
});

/** `PUT_AGENT_STATUS` as origin/main (98964a66) had it. */
const ORIGINAL_PUT_AGENT_STATUS = `
local raw = redis.call("GET", KEYS[1])
if raw then
  local decoded, current = pcall(cjson.decode, raw)
  if decoded and type(current) == "table" then
    local same_instance = current.daemonInstanceId == ARGV[2]
    local accepted = false
    if same_instance then
      local current_seq = tonumber(current.clientSeq)
      local next_seq = tonumber(ARGV[3])
      accepted = current_seq and (
        next_seq > current_seq or
        (next_seq == current_seq and current.status == ARGV[5] and
          tonumber(current.observedAtMs) == tonumber(ARGV[4]))
      )
    else
      accepted = tonumber(current.observedAtMs) and
        tonumber(ARGV[4]) > tonumber(current.observedAtMs)
    end
    if not accepted then return 0 end
  end
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[6])
return 1
`;
