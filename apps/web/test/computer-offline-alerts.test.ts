import { describe, expect, test } from "bun:test";

import {
  ComputerOfflineAlertSweep,
  ComputerOfflineAlerts,
  COMPUTER_OFFLINE_ALERT_AFTER_MS,
  type ComputerOfflineAlertTarget,
  type ComputerOfflineRedis,
} from "#src/server/computers/computer-offline-alerts.server";
import {
  fanOutPresenceObservers,
  type PresenceObserver,
} from "#src/server/app-notifications/presence-observer";

const COMPUTER_ID = "computer-1";
const OFFLINE_AT = 1_000_000;

/**
 * A Redis stand-in for the module's commands. `eval` understands the two scripts the module
 * sends: the episode write (two keys, then computerId/observedAtMs/direction) and the sweep's
 * once-a-tick clock read (no keys). Everything else is a plain string map and string sets.
 */
function fakeRedis(nowMs = OFFLINE_AT + COMPUTER_OFFLINE_ALERT_AFTER_MS) {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const calls: string[] = [];
  const redis: ComputerOfflineRedis = {
    eval: async (_script, keys, ...args) => {
      calls.push(`eval ${args.join(" ")}`);
      if (keys === 0) return nowMs;
      const [markerKey, index, ...rest] = args as string[];
      if (rest.length === 2) {
        // END_COMPUTER_OFFLINE_EPISODE: expected marker value, computerId.
        const [expected, computerId] = rest;
        const current = strings.get(markerKey);
        if (current !== undefined && current === expected) strings.delete(markerKey);
        if (!strings.has(markerKey)) sets.get(index)?.delete(computerId);
        return 1;
      }
      const [computerId, observedAtMs, to] = rest;
      if (to === "offline") {
        const members = sets.get(index) ?? new Set<string>();
        members.add(computerId);
        sets.set(index, members);
        if (!strings.has(markerKey)) strings.set(markerKey, observedAtMs);
        return "OK";
      }
      strings.delete(markerKey);
      sets.get(index)?.delete(computerId);
      return 1;
    },
    get: async (key) => {
      calls.push(`get ${key}`);
      return strings.get(key) ?? null;
    },
    mget: async (...keys) => keys.map((key) => strings.get(key) ?? null),
    del: async (...keys) => {
      calls.push(`del ${keys.join(" ")}`);
      let count = 0;
      for (const key of keys) {
        if (strings.delete(key)) count++;
        sets.delete(key);
      }
      return count;
    },
    smembers: async (key) => {
      calls.push(`smembers ${key}`);
      return [...(sets.get(key) ?? [])];
    },
    send: async (command, args) => {
      calls.push(`send ${command} ${args.join(" ")}`);
      if (command === "SET") {
        if (args.includes("NX") && strings.has(args[0]!)) return null;
        strings.set(args[0]!, args[1]!);
        return "OK";
      }
      return null;
    },
  };
  return { redis, strings, sets, calls };
}

const episodeKey = `coforge:computer-offline:v1:${COMPUTER_ID}`;
const indexKey = "coforge:computer-offline:v1:index";
const claimKey = `coforge:computer-offline-alert:v1:${COMPUTER_ID}:${OFFLINE_AT}`;

function presenceChange(to: "online" | "offline", observedAtMs = OFFLINE_AT) {
  return {
    workspaceId: "w1",
    computerId: COMPUTER_ID,
    from: to === "online" ? ("offline" as const) : ("online" as const),
    to,
    observedAtMs,
    idSeed: `seed-${to}`,
  };
}

describe("ComputerOfflineAlerts", () => {
  test("an offline report marks the episode once, however many bindings report it", async () => {
    const { redis, strings, sets } = fakeRedis();
    const alerts = new ComputerOfflineAlerts({ possible: () => true, redis: () => redis });
    alerts.computerPresence(presenceChange("offline"));
    alerts.computerPresence({ ...presenceChange("offline", OFFLINE_AT + 1), workspaceId: "w2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(strings.get(episodeKey)).toBe(String(OFFLINE_AT));
    expect(sets.get(indexKey)?.has(COMPUTER_ID)).toBe(true);
  });

  test("an online report ends the episode", async () => {
    const { redis, strings, sets } = fakeRedis();
    const alerts = new ComputerOfflineAlerts({ possible: () => true, redis: () => redis });
    alerts.computerPresence(presenceChange("offline"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    alerts.computerPresence(presenceChange("online"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(strings.has(episodeKey)).toBe(false);
    expect(sets.get(indexKey)?.has(COMPUTER_ID) ?? false).toBe(false);
  });

  test("a later episode restarts the clock", async () => {
    const { redis, strings } = fakeRedis();
    const alerts = new ComputerOfflineAlerts({ possible: () => true, redis: () => redis });
    alerts.computerPresence(presenceChange("offline"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    alerts.computerPresence(presenceChange("online"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    alerts.computerPresence(presenceChange("offline", OFFLINE_AT + 60_000));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(strings.get(episodeKey)).toBe(String(OFFLINE_AT + 60_000));
  });

  test("a failed episode write is logged and swallowed", async () => {
    const { redis, strings } = fakeRedis();
    const failing: ComputerOfflineRedis = {
      ...redis,
      eval: async () => {
        throw new Error("redis down");
      },
    };
    const alerts = new ComputerOfflineAlerts({ possible: () => true, redis: () => failing });
    alerts.computerPresence(presenceChange("offline"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(strings.has(episodeKey)).toBe(false);
  });

  test("does nothing while the flag is off", async () => {
    const { redis, calls } = fakeRedis();
    const alerts = new ComputerOfflineAlerts({ possible: () => false, redis: () => redis });
    alerts.computerPresence(presenceChange("offline"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(0);
    expect(alerts.enabled()).toBe(false);
  });
});

describe("fanOutPresenceObservers", () => {
  test("enabled while any member is, and every report reaches all members", () => {
    const calls: string[] = [];
    const member = (name: string, enabled: boolean): PresenceObserver => ({
      enabled: () => enabled,
      agentStatus: () => calls.push(`${name}:agent`),
      computerPresence: () => calls.push(`${name}:computer`),
    });
    const fan = fanOutPresenceObservers(member("a", false), member("b", true));
    expect(fan.enabled()).toBe(true);
    fan.agentStatus({
      workspaceId: "w1",
      agentId: "agent-1",
      from: "inactive",
      to: "active",
      observedAtMs: OFFLINE_AT,
      idSeed: "seed",
    });
    fan.computerPresence(presenceChange("offline"));
    expect(calls).toEqual(["a:agent", "b:agent", "a:computer", "b:computer"]);
  });
});

describe("ComputerOfflineAlertSweep", () => {
  const ready: ComputerOfflineAlertTarget = {
    status: "ready",
    workspaceId: "w1",
    ownerId: "u1",
    computerName: "Frank's Mac Studio",
    workspaceSlug: "lab",
    username: "frank",
  };

  function sweep(options: {
    possible?: boolean;
    lock?: boolean;
    members?: string[];
    marker?: string | null;
    resolve?: (computerId: string) => Promise<ComputerOfflineAlertTarget>;
    stillOnline?: (computerId: string) => Promise<boolean>;
    notify?: () => Promise<void>;
    now?: () => number;
  }) {
    const { redis, strings, sets, calls } = fakeRedis();
    if (options.members) sets.set(indexKey, new Set(options.members));
    if (options.marker !== undefined && options.marker !== null)
      strings.set(episodeKey, options.marker);
    const notified: unknown[] = [];
    const resolved: string[] = [];
    const subject = new ComputerOfflineAlertSweep({
      redis: () => redis,
      lock: { acquire: async () => options.lock ?? true },
      possible: () => options.possible ?? true,
      now: options.now ?? (() => OFFLINE_AT + COMPUTER_OFFLINE_ALERT_AFTER_MS),
      resolve: async (computerId) => {
        resolved.push(computerId);
        return (options.resolve ?? (async () => ({ status: "no_workspace" as const })))(computerId);
      },
      stillOnline: options.stillOnline ?? (async () => false),
      notify: async (input) => {
        await options.notify?.();
        notified.push(input);
      },
    });
    return { subject, notified, resolved, strings, sets, calls };
  }

  test("does nothing while the flag is off", async () => {
    const { subject, calls } = sweep({
      possible: false,
      members: [COMPUTER_ID],
      marker: String(OFFLINE_AT),
    });
    await subject.tick();
    expect(calls).toHaveLength(0);
  });

  test("waits out the threshold", async () => {
    const { subject, resolved } = sweep({
      members: [COMPUTER_ID],
      marker: String(OFFLINE_AT),
      now: () => OFFLINE_AT + COMPUTER_OFFLINE_ALERT_AFTER_MS - 1,
      resolve: async () => ready,
    });
    await subject.tick();
    expect(resolved).toHaveLength(0);
  });

  test("alerts once per episode after the threshold, then cleans its keys", async () => {
    const { subject, notified, resolved, strings, sets } = sweep({
      members: [COMPUTER_ID],
      marker: String(OFFLINE_AT),
      resolve: async () => ready,
    });
    await subject.tick();
    await subject.tick();
    expect(resolved).toHaveLength(1);
    expect(notified).toHaveLength(1);
    expect((notified[0] as { offlineAtMs: number }).offlineAtMs).toBe(OFFLINE_AT);
    expect((notified[0] as { offlineForMs: number }).offlineForMs).toBe(
      COMPUTER_OFFLINE_ALERT_AFTER_MS,
    );
    expect(strings.has(episodeKey)).toBe(false);
    expect(strings.has(claimKey)).toBe(false);
    expect(sets.get(indexKey)?.has(COMPUTER_ID) ?? false).toBe(false);
  });

  test("the claim carries a TTL so a lost send cannot hold the episode", async () => {
    const { subject, calls } = sweep({
      members: [COMPUTER_ID],
      marker: String(OFFLINE_AT),
      resolve: async () => ready,
    });
    await subject.tick();
    expect(calls).toContain(`send SET ${claimKey} 1 NX PX 600000`);
  });

  test("a second episode alerts again", async () => {
    const secondOfflineAt = OFFLINE_AT + 120_000;
    let now = OFFLINE_AT + COMPUTER_OFFLINE_ALERT_AFTER_MS;
    const { subject, notified, resolved, strings, sets } = sweep({
      members: [COMPUTER_ID],
      marker: String(OFFLINE_AT),
      now: () => now,
      resolve: async () => ready,
    });
    await subject.tick();
    // The first alert consumed its episode keys; a new outage files a fresh marker and index entry.
    strings.set(episodeKey, String(secondOfflineAt));
    sets.set(indexKey, new Set([COMPUTER_ID]));
    now = secondOfflineAt + COMPUTER_OFFLINE_ALERT_AFTER_MS;
    await subject.tick();
    expect(resolved).toHaveLength(2);
    expect(notified).toHaveLength(2);
    expect((notified[1] as { offlineAtMs: number }).offlineAtMs).toBe(secondOfflineAt);
  });

  test("a stale marker reconciles against a live online status", async () => {
    const { subject, notified, resolved, strings, sets } = sweep({
      members: [COMPUTER_ID],
      marker: String(OFFLINE_AT),
      resolve: async () => ready,
      stillOnline: async () => true,
    });
    await subject.tick();
    await subject.tick();
    expect(resolved).toHaveLength(0);
    expect(notified).toHaveLength(0);
    expect(strings.has(episodeKey)).toBe(false);
    expect(sets.get(indexKey)?.has(COMPUTER_ID) ?? false).toBe(false);
  });

  test("retries a failed send on the next tick", async () => {
    let fail = true;
    const { subject, notified, strings } = sweep({
      members: [COMPUTER_ID],
      marker: String(OFFLINE_AT),
      resolve: async () => ready,
      notify: async () => {
        if (fail) {
          fail = false;
          throw new Error("send failed");
        }
      },
    });
    await subject.tick();
    expect(notified).toHaveLength(0);
    expect(strings.has(claimKey)).toBe(false);
    await subject.tick();
    expect(notified).toHaveLength(1);
  });

  test("consumes the episode without a message when no Workspace can take it", async () => {
    const { subject, notified, resolved, strings, sets } = sweep({
      members: [COMPUTER_ID],
      marker: String(OFFLINE_AT),
      resolve: async () => ({ status: "no_workspace" as const }),
    });
    await subject.tick();
    await subject.tick();
    expect(resolved).toHaveLength(1);
    expect(notified).toHaveLength(0);
    expect(strings.has(episodeKey)).toBe(false);
    expect(strings.has(claimKey)).toBe(false);
    expect(sets.get(indexKey)?.has(COMPUTER_ID) ?? false).toBe(false);
  });

  test("cleans the episode of a gone Computer", async () => {
    const { subject, sets, strings } = sweep({
      members: [COMPUTER_ID],
      marker: String(OFFLINE_AT),
      resolve: async () => ({ status: "gone" as const }),
    });
    await subject.tick();
    expect(strings.has(episodeKey)).toBe(false);
    expect(strings.has(claimKey)).toBe(false);
    expect(sets.get(indexKey)?.has(COMPUTER_ID) ?? false).toBe(false);
  });

  test("drops an index member whose marker is gone", async () => {
    const { subject, sets } = sweep({ members: [COMPUTER_ID], marker: null });
    await subject.tick();
    expect(sets.get(indexKey)?.has(COMPUTER_ID) ?? false).toBe(false);
  });
});
