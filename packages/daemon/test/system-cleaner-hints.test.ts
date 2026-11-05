import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
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
  LOW_DISK,
  MEMORY_ITEM,
  OWNER,
  PLENTY_OF_DISK,
  WEEK_MS,
} from "./fixtures/system-cleaner-harness";

afterEach(cleanupHarnesses);

/** The inbox lists newest first; two mints in the same turn can tie or differ by a millisecond,
 * so an assertion about content sorts instead of pinning that order. */
const byItemId = <T extends { itemId: string }>(items: T[]): T[] =>
  [...items].sort((left, right) => left.itemId.localeCompare(right.itemId));

describe("SystemCleaner Active Context hint", () => {
  test("measures notes/active-context.md against its own limit and hints in its own words", async () => {
    const { cleaner, measured, measuredPaths, wakes, items, period, idle } = await harness();
    cleaner.applyConfig(config());
    measured.memory = 10 * KIB;
    measured.activeContext = 5 * KIB;
    await period();
    await idle();
    // Once in the period, then again at the idle transition for the file that was due.
    expect(measuredPaths).toEqual([
      join("/agents-root", OWNER, "MEMORY.md"),
      join("/agents-root", OWNER, "notes", "active-context.md"),
      join("/agents-root", OWNER, "notes", "active-context.md"),
    ]);
    expect(byItemId(await items())).toEqual([
      expect.objectContaining({
        itemId: ACTIVE_CONTEXT_ITEM,
        appId: "system.cleaner",
        notificationClass: "active_context_size",
        retention: "transient",
        action: { kind: "run_command", commandId: "app.config" },
        title: "notes/active-context.md has grown to 5.0 KiB (limit 4.0 KiB); next check in 1h",
        summary:
          "This is the current state, not a log: overwrite it with the next step, blocker and progress. To allow more, double the limit (or pick a lower value) with coforge app config --app system.cleaner --set active_context_threshold_bytes=8192",
      }),
      expect.objectContaining({ itemId: DISK_ITEM, notificationClass: "disk_space" }),
    ]);
    expect(wakes).toEqual([{ agentId: OWNER, itemId: ACTIVE_CONTEXT_ITEM }]);
  });

  test("the two files are measured, hinted and cleared apart from each other", async () => {
    const { cleaner, measured, items, period, idle } = await harness();
    cleaner.applyConfig(config());
    measured.memory = 70 * KIB;
    measured.activeContext = 5 * KIB;
    await period();
    await idle();
    expect(byItemId(await items()).map((item) => item.itemId)).toEqual([
      ACTIVE_CONTEXT_ITEM,
      DISK_ITEM,
      MEMORY_ITEM,
    ]);

    // The Active Context is trimmed; MEMORY.md's hint must stay.
    measured.activeContext = 4 * KIB;
    await period();
    expect(byItemId(await items()).map((item) => item.itemId)).toEqual([DISK_ITEM, MEMORY_ITEM]);

    // Each file's limit is its own: 5 KiB is over the Active Context's 4 KiB but under
    // MEMORY.md's 64 KiB.
    measured.memory = 5 * KIB;
    measured.activeContext = 5 * KIB;
    await period();
    await idle();
    expect(byItemId(await items()).map((item) => item.itemId)).toEqual([
      ACTIVE_CONTEXT_ITEM,
      DISK_ITEM,
    ]);
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
      command: "coforge manual get workspace-cleanup",
      title:
        "When it's quiet, remove workspace files you know are unused; check with your owner or creator on anything uncertain",
      summary:
        "Only raise files added since your last question, and update .coforgemigrateignore as the workspace changes.",
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
          "Only 10.0 GiB of disk space is left. Only raise files added since your last question, and update .coforgemigrateignore as the workspace changes.",
        command: "coforge manual get workspace-cleanup",
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
