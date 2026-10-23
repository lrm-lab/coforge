import { describe, expect, test } from "bun:test";

import { RedisAgentStatusCache } from "#src/server/agents/agent-status.server";
import { RedisComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import type { AppNotificationEvent } from "#src/server/app-notifications/app-notification-event";
import { AppNotifications } from "#src/server/app-notifications/app-notifications.server";
import { AppNotificationPresence } from "#src/server/app-notifications/app-notification-presence.server";
import { parsePresenceMember } from "#src/server/app-notifications/presence-expiry.server";
import type { PresenceObserver } from "#src/server/app-notifications/presence-observer";

type Calls = { agent: unknown[]; computer: unknown[] };

function observer(enabled: boolean): PresenceObserver & { calls: Calls } {
  const calls: Calls = { agent: [], computer: [] };
  return {
    calls,
    enabled: () => enabled,
    agentStatus: (change) => void calls.agent.push(change),
    computerPresence: (change) => void calls.computer.push(change),
  };
}

const agentScope = { workspaceId: "w1", computerId: "c1", agentId: "a1" };
const agentStatus = (status: "active" | "inactive", clientSeq = 2) => ({
  ...agentScope,
  status,
  daemonInstanceId: "d1",
  clientSeq,
  observedAtMs: 5_000,
});

describe("Agent status cache", () => {
  test("flag off: the original script, one key, and no observer call", async () => {
    const evals: Array<{ keys: number; args: unknown[] }> = [];
    const presence = observer(false);
    const cache = new RedisAgentStatusCache(
      {
        eval: async (_script, keys, ...args) => (evals.push({ keys, args }), 1),
        get: async () => null,
        ttl: async () => -2,
      },
      { presence },
    );
    expect(await cache.put(agentStatus("active"))).toBe(true);
    expect(evals).toHaveLength(1);
    expect(evals[0]!.keys).toBe(1);
    expect(evals[0]!.args).toHaveLength(7);
    expect(presence.calls).toEqual({ agent: [], computer: [] });
  });

  const table: Array<[string, "active" | "inactive", string, boolean]> = [
    ["absent over active (null to active)", "active", "inactive", true],
    ["heartbeat", "active", "active", false],
    ["inactive over absent", "inactive", "inactive", false],
    ["active to inactive", "inactive", "active", true],
  ];
  for (const [name, status, previous, emits] of table)
    test(`flag on, ${name}: ${emits ? "one" : "no"} event`, async () => {
      const evals: Array<{ keys: number; args: unknown[] }> = [];
      const presence = observer(true);
      const cache = new RedisAgentStatusCache(
        {
          eval: async (_script, keys, ...args) => (evals.push({ keys, args }), [1, previous]),
          get: async () => null,
          ttl: async () => -2,
        },
        { presence, expiryKey: "expiry" },
      );
      expect(await cache.put(agentStatus(status))).toBe(true);
      expect(evals[0]!.keys).toBe(2);
      expect(evals[0]!.args[1]).toBe("expiry");
      expect(presence.calls.agent).toEqual(
        emits
          ? [
              {
                workspaceId: "w1",
                agentId: "a1",
                from: previous,
                to: status,
                observedAtMs: 5_000,
                idSeed: `w1:a1:status:2:d1:${status}`,
              },
            ]
          : [],
      );
    });

  test("flag on, a rejected put reports nothing and is false", async () => {
    const presence = observer(true);
    const cache = new RedisAgentStatusCache(
      { eval: async () => [0, ""], get: async () => null, ttl: async () => -2 },
      { presence },
    );
    expect(await cache.put(agentStatus("active"))).toBe(false);
    expect(presence.calls.agent).toEqual([]);
  });
});

describe("Computer status cache", () => {
  const scope = { workspaceId: "w1", computerId: "c1" };

  test("flag off: the plain SET and no eval", async () => {
    const sets: unknown[][] = [];
    const presence = observer(false);
    const cache = new RedisComputerStatusCache(
      {
        set: async (...args) => void sets.push(args),
        get: async () => null,
        mget: async () => [],
      },
      "90",
      { presence, redis: { eval: async () => Promise.reject(new Error("no eval expected")) } },
    );
    await cache.put(scope, true);
    expect(sets).toEqual([["coforge:workspace:w1:computer:c1:status:v1", "online", "EX", "90"]]);
    expect(presence.calls.computer).toEqual([]);
  });

  const table: Array<[string, boolean, string, boolean]> = [
    ["online over absent", true, "", true],
    ["online over offline", true, "offline", true],
    ["duplicate online", true, "online", false],
    ["offline over online", false, "online", true],
    ["offline over absent", false, "", false],
    ["offline over offline", false, "offline", false],
  ];
  for (const [name, online, previous, emits] of table)
    test(`flag on, ${name}: ${emits ? "one" : "no"} event`, async () => {
      const presence = observer(true);
      const evals: unknown[][] = [];
      const cache = new RedisComputerStatusCache(
        { set: async () => {}, get: async () => null, mget: async () => [] },
        "90",
        {
          presence,
          expiryKey: "expiry",
          redis: { eval: async (...args) => (evals.push(args), [previous, 7_000, 3]) },
        },
      );
      await cache.put(scope, online);
      expect(evals[0]!.slice(1, 3)).toEqual([3, "coforge:workspace:w1:computer:c1:status:v1"]);
      expect(evals[0]![4]).toBe("coforge:workspace:w1:computer:c1:status:v1:presence-seq");
      const to = online ? "online" : "offline";
      expect(presence.calls.computer).toEqual(
        emits
          ? [
              {
                workspaceId: "w1",
                computerId: "c1",
                from: previous === "online" ? "online" : "offline",
                to,
                observedAtMs: 7_000,
                idSeed: `w1:c1:${to}:3:7000`,
              },
            ]
          : [],
      );
    });
});

describe("AppNotificationPresence", () => {
  function recorder(options: { enabled?: boolean; known?: boolean } = {}) {
    const recorded: AppNotificationEvent[] = [];
    let lookups = 0;
    const presence = new AppNotificationPresence({
      possible: () => options.enabled ?? true,
      workspace: async (id) => (lookups++, options.known === false ? undefined : { id, slug: "s" }),
      record: async (_workspace, event) => void recorded.push(event),
    });
    return { presence, recorded, lookups: () => lookups };
  }
  const change = {
    workspaceId: "w1",
    agentId: "a1",
    from: "inactive",
    to: "active",
    observedAtMs: Date.UTC(2026, 9, 23),
    idSeed: "seed",
  } as const;

  test("an Agent change is a snake_case agent.status_changed with a stable id", async () => {
    const first = recorder();
    first.presence.agentStatus(change);
    first.presence.agentStatus(change);
    await Bun.sleep(10);
    expect(first.recorded).toHaveLength(2);
    expect(first.recorded[0]).toMatchObject({
      type: "agent.status_changed",
      workspaceId: "w1",
      timestamp: "2026-10-23T00:00:00.000Z",
      data: {
        agent_id: "a1",
        from: "inactive",
        to: "active",
        observed_at: "2026-10-23T00:00:00.000Z",
      },
    });
    expect(first.recorded[0]!.id).toBe(first.recorded[1]!.id);
    const other = recorder();
    other.presence.agentStatus({ ...change, idSeed: "other" });
    await Bun.sleep(10);
    expect(other.recorded[0]!.id).not.toBe(first.recorded[0]!.id);
    expect(first.recorded[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a Computer change is computer.online or computer.offline", async () => {
    const { presence, recorded } = recorder();
    const base = { workspaceId: "w1", computerId: "c1", observedAtMs: 1_000, idSeed: "x" };
    presence.computerPresence({ ...base, from: "offline", to: "online" });
    presence.computerPresence({ ...base, from: "online", to: "offline", idSeed: "y" });
    await Bun.sleep(10);
    expect(recorded.map((event) => [event.type, event.data])).toEqual([
      [
        "computer.online",
        {
          computer_id: "c1",
          from: "offline",
          to: "online",
          observed_at: "1970-01-01T00:00:01.000Z",
        },
      ],
      [
        "computer.offline",
        {
          computer_id: "c1",
          from: "online",
          to: "offline",
          observed_at: "1970-01-01T00:00:01.000Z",
        },
      ],
    ]);
  });

  test("looks the Workspace up once for repeated changes and not at all while off", async () => {
    const on = recorder();
    on.presence.agentStatus(change);
    await Bun.sleep(10);
    on.presence.agentStatus({ ...change, idSeed: "b" });
    await Bun.sleep(10);
    expect(on.lookups()).toBe(1);
    const off = recorder({ enabled: false });
    expect(off.presence.enabled()).toBe(false);
    off.presence.agentStatus(change);
    await Bun.sleep(10);
    expect(off.lookups()).toBe(0);
    expect(off.recorded).toEqual([]);
  });

  test("an unknown Workspace or a failing record is swallowed", async () => {
    const unknown = recorder({ known: false });
    unknown.presence.agentStatus(change);
    const failing = new AppNotificationPresence({
      possible: () => true,
      workspace: async () => Promise.reject(new Error("db down")),
      record: async () => Promise.reject(new Error("never")),
    });
    expect(() => failing.agentStatus(change)).not.toThrow();
    await Bun.sleep(10);
    expect(unknown.recorded).toEqual([]);
  });
});

describe("AppNotifications.recordDetached", () => {
  const event = {
    id: "e1",
    type: "channel.archived",
    timestamp: "2026-10-23T00:00:00.000Z",
    workspaceId: "w1",
    data: { channel_id: "c" },
  } satisfies AppNotificationEvent;
  const workspace = { id: "w1", slug: "s" };
  const quietly = async <T>(work: () => Promise<T>) => {
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (line: string) => void lines.push(line);
    try {
      return { result: await work(), lines };
    } finally {
      console.warn = warn;
    }
  };

  test("sends with the event id and no transaction", async () => {
    const sent: unknown[][] = [];
    await AppNotifications.recordDetached(workspace, event, {
      enabled: async () => true,
      queue: () => ({ send: async (...args: unknown[]) => void sent.push(args) }) as never,
    });
    expect(sent).toEqual([["app-notification-event", event, { id: "e1" }]]);
  });

  test("flag off sends nothing; queue down and a failing send are logged, never thrown", async () => {
    const sent: unknown[] = [];
    const send = async (...args: unknown[]) => void sent.push(args);
    await AppNotifications.recordDetached(workspace, event, {
      enabled: async () => false,
      queue: () => ({ send }) as never,
    });
    expect(sent).toEqual([]);
    const down = await quietly(() =>
      AppNotifications.recordDetached(workspace, event, {
        enabled: async () => true,
        queue: () => undefined,
      }),
    );
    expect(down.lines.join()).toContain("queue_not_started");
    const failed = await quietly(() =>
      AppNotifications.recordDetached(workspace, event, {
        enabled: async () => true,
        queue: () => ({ send: async () => Promise.reject(new Error("boom")) }) as never,
      }),
    );
    expect(failed.lines.join()).toContain("send_failed");
    const broken = await quietly(() =>
      AppNotifications.recordDetached(workspace, event, {
        enabled: async () => Promise.reject(new Error("flag")),
        queue: () => undefined,
      }),
    );
    expect(broken.lines.join()).toContain("send_failed");
  });
});

test("parsePresenceMember reads the scope back from a status key", () => {
  expect(parsePresenceMember("coforge:workspace:w:computer:c:agent:a:status:v2")).toEqual({
    kind: "agent",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
  });
  expect(parsePresenceMember("coforge:workspace:w:computer:c:status:v1")).toEqual({
    kind: "computer",
    workspaceId: "w",
    computerId: "c",
  });
  expect(parsePresenceMember("coforge:workspace:w:display:v1")).toBeUndefined();
});
