import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAppInbox, type AgentAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import {
  SystemCleaner,
  type CleanerClock,
  type DiskMeasurement,
  type MemoryMeasurement,
} from "#src/system-cleaner/system-cleaner";

const KIB = 1024;
const GIB = 1024 ** 3;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const OWNER = "agent-a";
const MEMORY_ITEM = `cleaner:memory_size:${OWNER}`;
const DISK_ITEM = `cleaner:disk_space:${OWNER}`;
const PLENTY_OF_DISK: DiskMeasurement = {
  kind: "measured",
  availableBytes: 200 * GIB,
  totalBytes: 500 * GIB,
};
const LOW_DISK: DiskMeasurement = {
  kind: "measured",
  availableBytes: 10 * GIB,
  totalBytes: 500 * GIB,
};

/** A manual clock: timers fire only when a test advances time past them. */
class ManualClock implements CleanerClock {
  nowMs = 1_000_000;
  #nextId = 1;
  readonly #timers = new Map<number, { atMs: number; run: () => void }>();

  now() {
    return this.nowMs;
  }
  schedule(run: () => void, delayMs: number) {
    const id = this.#nextId++;
    this.#timers.set(id, { atMs: this.nowMs + delayMs, run });
    return id;
  }
  cancel(handle: unknown) {
    this.#timers.delete(handle as number);
  }
  pending() {
    return this.#timers.size;
  }
  advance(ms: number) {
    const target = this.nowMs + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.atMs <= target)
        .sort((left, right) => left[1].atMs - right[1].atMs)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.nowMs = due[1].atMs;
      due[1].run();
    }
    this.nowMs = target;
  }
}

const roots: string[] = [];
afterEach(() =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

async function harness() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-system-cleaner-"));
  roots.push(stateDirectory);
  const clock = new ManualClock();
  const inboxes = new Map<string, Promise<AgentAppInbox>>();
  const inbox = (agentId: string) => {
    const existing = inboxes.get(agentId);
    if (existing) return existing;
    const opened = AgentAppInbox.open(stateDirectory, "workspace-a", agentId);
    inboxes.set(agentId, opened);
    return opened;
  };
  const measured = { memory: 0 as number | undefined, disk: PLENTY_OF_DISK };
  const measuredPaths: string[] = [];
  const wakes: { agentId: string; itemId: string }[] = [];
  const cleaner = new SystemCleaner({
    agentsDirectory: "/agents-root",
    clock,
    measureMemoryFile: async (path): Promise<MemoryMeasurement> => {
      measuredPaths.push(path);
      return measured.memory === undefined
        ? { kind: "not_established", reason: "missing" }
        : { kind: "measured", bytes: measured.memory };
    },
    measureDiskSpace: async () => measured.disk,
    inbox: {
      upsert: async (agentId, item) => (await inbox(agentId)).upsert(item),
      remove: async (agentId, itemId) => (await inbox(agentId)).remove(itemId),
    },
    wake: async (agentId, itemId) => {
      wakes.push({ agentId, itemId });
    },
  });
  const items = async (agentId = OWNER): Promise<AgentAppItem[]> => (await inbox(agentId)).list();
  /** Advances time an hour (one period) at a time, letting each period's measurements settle
   * before the next, as they do when real periods are an interval apart. */
  const period = async (ms = HOUR_MS) => {
    for (let remaining = ms; remaining > 0; remaining -= HOUR_MS) {
      clock.advance(Math.min(HOUR_MS, remaining));
      await cleaner.settled();
    }
  };
  const idle = async (agentId = OWNER) => {
    cleaner.onAgentWorkingToIdle(agentId);
    await cleaner.settled();
  };
  return { cleaner, clock, measured, measuredPaths, wakes, items, period, idle };
}

const config = (overrides: Record<string, unknown> = {}) => ({
  appId: "system.cleaner",
  ownerAgentId: OWNER,
  enabled: true,
  thresholdBytes: 64 * KIB,
  intervalMs: HOUR_MS,
  revision: 1,
  ...overrides,
});

describe("SystemCleaner config", () => {
  test("validates the config envelope and its bounds", async () => {
    const { cleaner } = await harness();
    const invalid = (raw: unknown) => cleaner.applyConfig(raw);
    expect(invalid(null)).toEqual({ kind: "invalid", reason: "envelope_not_object" });
    expect(invalid({ ...config(), extra: 1 })).toEqual({
      kind: "invalid",
      reason: "envelope_unknown_field",
    });
    expect(invalid(config({ appId: "system.reminder" }))).toEqual({
      kind: "invalid",
      reason: "app_id_mismatch",
    });
    expect(invalid(config({ ownerAgentId: "../x" }))).toEqual({
      kind: "invalid",
      reason: "owner_agent_id_invalid",
    });
    expect(invalid(config({ enabled: "yes" }))).toEqual({
      kind: "invalid",
      reason: "enabled_invalid",
    });
    expect(invalid(config({ thresholdBytes: 4095 }))).toEqual({
      kind: "invalid",
      reason: "threshold_bytes_invalid",
    });
    expect(invalid(config({ thresholdBytes: GIB + 1 }))).toEqual({
      kind: "invalid",
      reason: "threshold_bytes_invalid",
    });
    expect(invalid(config({ intervalMs: 899_999 }))).toEqual({
      kind: "invalid",
      reason: "interval_ms_invalid",
    });
    expect(invalid(config({ intervalMs: 604_800_001 }))).toEqual({
      kind: "invalid",
      reason: "interval_ms_invalid",
    });
    expect(invalid(config({ revision: -1 }))).toEqual({
      kind: "invalid",
      reason: "revision_invalid",
    });
    expect(cleaner.applyConfig(config({ thresholdBytes: 4096, intervalMs: 900_000 }))).toEqual({
      kind: "applied",
      activeSchedules: 1,
    });
  });

  test("orders configs by revision and refuses a conflicting same revision", async () => {
    const { cleaner, clock } = await harness();
    expect(cleaner.applyConfig(config({ revision: 2 }))).toEqual({
      kind: "applied",
      activeSchedules: 1,
    });
    expect(cleaner.applyConfig(config({ revision: 1 }))).toEqual({
      kind: "stale",
      currentRevision: 2,
    });
    expect(cleaner.applyConfig(config({ revision: 2 }))).toEqual({
      kind: "stale",
      currentRevision: 2,
    });
    expect(cleaner.applyConfig(config({ revision: 2, thresholdBytes: 8192 }))).toEqual({
      kind: "invalid",
      reason: "revision_conflict",
    });
    expect(cleaner.applyConfig(config({ revision: 3, enabled: false }))).toEqual({
      kind: "applied",
      activeSchedules: 0,
    });
    expect(clock.pending()).toBe(0);
  });

  test("an owner snapshot must name that owner, and null removes it", async () => {
    const { cleaner, clock } = await harness();
    expect(cleaner.replaceOwnerSnapshot("agent-b", config())).toEqual({
      kind: "invalid",
      reason: "owner_agent_id_mismatch",
    });
    expect(cleaner.replaceOwnerSnapshot("..", null)).toEqual({
      kind: "invalid",
      reason: "owner_agent_id_invalid",
    });
    expect(cleaner.replaceOwnerSnapshot(OWNER, config())).toEqual({
      kind: "applied",
      activeSchedules: 1,
    });
    expect(cleaner.replaceOwnerSnapshot(OWNER, null)).toEqual({
      kind: "removed",
      activeSchedules: 0,
    });
    expect(clock.pending()).toBe(0);
  });
});

describe("SystemCleaner MEMORY.md hint", () => {
  test("is measured each period but presented only at the next Working to Idle transition", async () => {
    const { cleaner, measured, measuredPaths, wakes, items, period, idle } = await harness();
    cleaner.applyConfig(config());
    measured.memory = 70 * KIB;
    await period(HOUR_MS - 1);
    expect(measuredPaths).toEqual([]);
    await period(1);
    expect(measuredPaths).toEqual([join("/agents-root", OWNER, "MEMORY.md")]);
    expect(await items()).toEqual([]);
    expect(wakes).toEqual([]);

    await idle();
    expect(await items()).toEqual([
      expect.objectContaining({ itemId: DISK_ITEM, notificationClass: "disk_space" }),
      expect.objectContaining({
        itemId: MEMORY_ITEM,
        appId: "system.cleaner",
        notificationClass: "memory_size",
        retention: "transient",
        action: { kind: "run_command", commandId: "app.config" },
        title: "MEMORY.md has grown to 70.0 KiB (limit 64.0 KiB); next check in 1h",
        summary:
          "Trim it back to an index: details belong in notes/, and stale entries can go. To allow more, double the limit (or pick a lower value) with coforge app config --app system.cleaner --set threshold_bytes=131072",
      }),
    ]);
    expect(wakes).toEqual([{ agentId: OWNER, itemId: MEMORY_ITEM }]);

    // Presented once: the next idle transition has nothing due.
    await idle();
    expect(wakes).toHaveLength(1);
  });

  test("describes raising to the maximum and being at the maximum", async () => {
    const { cleaner, measured, items, period, idle } = await harness();
    cleaner.applyConfig(config({ thresholdBytes: 600 * 1024 * KIB }));
    measured.memory = GIB;
    await period();
    await idle();
    expect((await items()).find((item) => item.itemId === MEMORY_ITEM)?.summary).toBe(
      "Trim it back to an index: details belong in notes/, and stale entries can go. To allow more, raise the limit to its maximum (or pick a lower value) with coforge app config --app system.cleaner --set threshold_bytes=1073741824",
    );

    cleaner.applyConfig(config({ revision: 2, thresholdBytes: GIB }));
    measured.memory = GIB + 1;
    await period();
    await idle();
    expect((await items()).find((item) => item.itemId === MEMORY_ITEM)?.summary).toBe(
      "Trim it back to an index: details belong in notes/, and stale entries can go. The limit is at its maximum; view or lower it with coforge app config --app system.cleaner",
    );
  });

  test("is dropped when MEMORY.md is back under the threshold or cannot be measured", async () => {
    const { cleaner, measured, items, period, idle } = await harness();
    cleaner.applyConfig(config());
    measured.memory = 70 * KIB;
    await period();
    await idle();
    expect((await items()).map((item) => item.itemId)).toContain(MEMORY_ITEM);

    measured.memory = 64 * KIB;
    await period();
    expect((await items()).map((item) => item.itemId)).not.toContain(MEMORY_ITEM);

    measured.memory = 70 * KIB;
    await period();
    await idle();
    expect((await items()).map((item) => item.itemId)).toContain(MEMORY_ITEM);
    measured.memory = undefined;
    await period();
    expect((await items()).map((item) => item.itemId)).not.toContain(MEMORY_ITEM);
  });

  test("remeasures at the idle transition and presents nothing once it was trimmed", async () => {
    const { cleaner, measured, wakes, items, period, idle } = await harness();
    cleaner.applyConfig(config());
    measured.memory = 70 * KIB;
    await period();
    measured.memory = 10 * KIB;
    await idle();
    expect(await items()).toEqual([]);
    expect(wakes).toEqual([]);
  });

  test("re-presents after 24 hours, or sooner once it grew by a quarter", async () => {
    const { cleaner, measured, wakes, period, idle } = await harness();
    cleaner.applyConfig(config());
    measured.memory = 80 * KIB;
    await period();
    await idle();
    expect(wakes).toHaveLength(1);

    // Still over, not grown enough, within 24 hours: cooldown.
    measured.memory = 99 * KIB;
    await period();
    await idle();
    expect(wakes).toHaveLength(1);

    measured.memory = 100 * KIB;
    await period();
    await idle();
    expect(wakes).toHaveLength(2);

    // Not grown since the last hint: only the 24-hour cooldown brings it back.
    await period(DAY_MS - HOUR_MS);
    await idle();
    expect(wakes).toHaveLength(2);
    await period();
    await idle();
    expect(wakes).toHaveLength(3);
  });
});

describe("SystemCleaner workspace cleanup tip", () => {
  test("accompanies the first memory hint, then at most once a week", async () => {
    const { cleaner, measured, items, period, idle } = await harness();
    cleaner.applyConfig(config());
    measured.memory = 70 * KIB;
    await period();
    await idle();
    expect((await items()).find((item) => item.itemId === DISK_ITEM)).toMatchObject({
      retention: "transient",
      action: { kind: "run_command", commandId: "manual.workspace_cleanup" },
      title:
        "When it's quiet, remove workspace files you know are unused; check with your owner or creator on anything uncertain",
      summary:
        "Only raise files added since your last question, and update .coforgemigrateignore as the workspace changes. Guide: coforge manual get workspace-cleanup",
    });
  });

  test("is not repeated within a week of the last one", async () => {
    const { cleaner, measured, wakes, items, period, idle } = await harness();
    cleaner.applyConfig(config());
    measured.memory = 70 * KIB;
    await period();
    await idle();
    expect(wakes).toHaveLength(1);
    // Simulate the Agent clearing the tip: a new config drops both items.
    cleaner.applyConfig(config({ revision: 2 }));
    await cleaner.settled();
    await period(DAY_MS);
    await idle();
    expect((await items()).map((item) => item.itemId)).toEqual([MEMORY_ITEM]);
  });

  test("low disk brings the tip with how much is free, once per low-disk episode and weekly at most", async () => {
    const { cleaner, measured, wakes, items, period, idle } = await harness();
    cleaner.applyConfig(config());
    measured.disk = LOW_DISK;
    await period();
    await idle();
    expect(await items()).toEqual([
      expect.objectContaining({
        itemId: DISK_ITEM,
        summary:
          "Only 10.0 GiB of disk space is left. Only raise files added since your last question, and update .coforgemigrateignore as the workspace changes. Guide: coforge manual get workspace-cleanup",
      }),
    ]);
    expect(wakes).toEqual([{ agentId: OWNER, itemId: DISK_ITEM }]);

    // Same low-disk episode: no new tip even after a week.
    await period(WEEK_MS);
    await idle();
    expect(wakes).toHaveLength(1);

    // Disk recovers, then is low again: a new episode tips once the week has passed.
    measured.disk = PLENTY_OF_DISK;
    await period();
    measured.disk = LOW_DISK;
    await period();
    await idle();
    expect(wakes).toHaveLength(2);
  });

  test("disk is low only under both 20 GiB and 10% free, and a bad reading is ignored", async () => {
    const { cleaner, measured, wakes, period, idle } = await harness();
    cleaner.applyConfig(config());
    for (const disk of [
      { availableBytes: 15 * GIB, totalBytes: 100 * GIB },
      { availableBytes: 25 * GIB, totalBytes: 500 * GIB },
      { availableBytes: 5 * GIB, totalBytes: 0 },
      { availableBytes: 10 * GIB, totalBytes: 5 * GIB },
      { availableBytes: Number.NaN, totalBytes: 500 * GIB },
    ]) {
      measured.disk = { kind: "measured", ...disk };
      await period();
      await idle();
    }
    expect(wakes).toEqual([]);
  });
});

describe("SystemCleaner lifecycle", () => {
  test("a disabled config, a new config, or removing the owner drops its items", async () => {
    const { cleaner, measured, items, period, idle } = await harness();
    cleaner.applyConfig(config());
    measured.memory = 70 * KIB;
    await period();
    await idle();
    expect(await items()).toHaveLength(2);

    cleaner.applyConfig(config({ revision: 2, enabled: false }));
    await cleaner.settled();
    expect(await items()).toEqual([]);
    await period(WEEK_MS);
    await idle();
    expect(await items()).toEqual([]);

    cleaner.applyConfig(config({ revision: 3 }));
    await period();
    await idle();
    expect(await items()).toHaveLength(2);
    cleaner.replaceOwnerSnapshot(OWNER, null);
    await cleaner.settled();
    expect(await items()).toEqual([]);
  });

  test("a due hint is dropped when its config changes before the idle transition", async () => {
    const { cleaner, measured, wakes, period, idle } = await harness();
    cleaner.applyConfig(config());
    measured.memory = 70 * KIB;
    await period();
    cleaner.applyConfig(config({ revision: 2, enabled: false }));
    await idle();
    expect(wakes).toEqual([]);
  });

  test("clear cancels every schedule and drops every item", async () => {
    const { cleaner, clock, measured, items, period, idle } = await harness();
    cleaner.applyConfig(config());
    measured.memory = 70 * KIB;
    await period();
    await idle();
    cleaner.clear();
    await cleaner.settled();
    expect(clock.pending()).toBe(0);
    expect(await items()).toEqual([]);
  });

  test("a measurement that does not answer in time counts as not measurable", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-system-cleaner-"));
    roots.push(stateDirectory);
    const clock = new ManualClock();
    const wakes: string[] = [];
    const cleaner = new SystemCleaner({
      agentsDirectory: "/agents-root",
      clock,
      measureMemoryFile: () => new Promise<MemoryMeasurement>(() => {}),
      measureDiskSpace: async () => PLENTY_OF_DISK,
      inbox: {
        upsert: async () => {
          throw new Error("must not mint");
        },
        remove: async () => false,
      },
      wake: async (_agentId, itemId) => {
        wakes.push(itemId);
      },
    });
    cleaner.applyConfig(config());
    clock.advance(HOUR_MS);
    clock.advance(10_000);
    await cleaner.settled();
    cleaner.onAgentWorkingToIdle(OWNER);
    await cleaner.settled();
    expect(wakes).toEqual([]);
  });
});
