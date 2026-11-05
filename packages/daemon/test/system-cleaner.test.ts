import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemCleaner, type MemoryMeasurement } from "#src/system-cleaner/system-cleaner";
import {
  ACTIVE_CONTEXT_ITEM,
  cleanupHarnesses,
  config,
  DAY_MS,
  DISK_ITEM,
  GIB,
  harness,
  HOUR_MS,
  KIB,
  ManualClock,
  MEMORY_ITEM,
  OWNER,
  PLENTY_OF_DISK,
  trackRoot,
  WEEK_MS,
} from "./fixtures/system-cleaner-harness";

afterEach(cleanupHarnesses);

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
    expect(invalid(config({ activeContextThresholdBytes: 999 }))).toEqual({
      kind: "invalid",
      reason: "active_context_threshold_bytes_invalid",
    });
    expect(invalid(config({ activeContextThresholdBytes: 4 * GIB + 1 }))).toEqual({
      kind: "invalid",
      reason: "active_context_threshold_bytes_invalid",
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
    expect(
      cleaner.applyConfig(
        config({
          thresholdBytes: 4096,
          activeContextThresholdBytes: 1_000,
          intervalMs: 900_000,
        }),
      ),
    ).toEqual({ kind: "applied", activeSchedules: 1 });
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
    expect(measuredPaths).toEqual([
      join("/agents-root", OWNER, "MEMORY.md"),
      join("/agents-root", OWNER, "notes", "active-context.md"),
    ]);
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
          "Merge duplicate facts, drop stale ones, and move long material to notes/<topic>.md behind a pointer. To allow more, double the limit (or pick a lower value) with coforge app config --app system.cleaner --set threshold_bytes=131072",
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
      "Merge duplicate facts, drop stale ones, and move long material to notes/<topic>.md behind a pointer. To allow more, raise the limit to its maximum (or pick a lower value) with coforge app config --app system.cleaner --set threshold_bytes=1073741824",
    );

    cleaner.applyConfig(config({ revision: 2, thresholdBytes: GIB }));
    measured.memory = GIB + 1;
    await period();
    await idle();
    expect((await items()).find((item) => item.itemId === MEMORY_ITEM)?.summary).toBe(
      "Merge duplicate facts, drop stale ones, and move long material to notes/<topic>.md behind a pointer. The limit is at its maximum; view or lower it with coforge app config --app system.cleaner",
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
    trackRoot(stateDirectory);
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
