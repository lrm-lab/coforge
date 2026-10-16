import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureDiskSpace, WorkspaceCleanupTips } from "#src/agent-runtime/workspace-cleanup-tip";

const GIB = 1024 ** 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TIP =
  "When you have time: delete workspace files you are sure are unneeded; ask your owner or creator about unsure ones. Ask only about files new since you last asked. Also keep .coforgemigrateignore up to date.";
const plentyOfDisk = { availableBytes: 200 * GIB, totalBytes: 500 * GIB };

test("an over-limit MEMORY.md brings the workspace cleanup tip; nothing else does", () => {
  const tips = new WorkspaceCleanupTips(() => 0);
  expect(tips.next("agent-1", { memoryOverLimit: false, disk: plentyOfDisk })).toBeUndefined();
  expect(tips.next("agent-1", { memoryOverLimit: true, disk: plentyOfDisk })).toBe(TIP);
});

test("the memory-driven tip comes at most once a week per Agent", () => {
  let nowMs = 0;
  const tips = new WorkspaceCleanupTips(() => nowMs);
  const overLimit = { memoryOverLimit: true, disk: plentyOfDisk };
  expect(tips.next("agent-1", overLimit)).toBe(TIP);
  nowMs = WEEK_MS - 1;
  expect(tips.next("agent-1", overLimit)).toBeUndefined();
  expect(tips.next("agent-2", overLimit)).toBe(TIP);
  nowMs = WEEK_MS;
  expect(tips.next("agent-1", overLimit)).toBe(TIP);
});

test("low disk brings the tip with how much is free, once per low-disk episode and at most weekly", () => {
  let nowMs = 0;
  const tips = new WorkspaceCleanupTips(() => nowMs);
  const lowDisk = {
    memoryOverLimit: false,
    disk: { availableBytes: 10 * GIB, totalBytes: 500 * GIB },
  };
  const lowTip =
    "When you have time: delete workspace files you are sure are unneeded; ask your owner or creator about unsure ones. Disk is low (10.0 GiB free). Ask only about files new since you last asked. Also keep .coforgemigrateignore up to date.";

  expect(tips.next("agent-1", lowDisk)).toBe(lowTip);
  // The disk tip counts as this week's tip for an over-limit MEMORY.md too.
  expect(tips.next("agent-1", { memoryOverLimit: true, disk: lowDisk.disk })).toBeUndefined();
  nowMs = WEEK_MS;
  expect(tips.next("agent-1", lowDisk)).toBeUndefined();

  expect(tips.next("agent-1", { memoryOverLimit: false, disk: plentyOfDisk })).toBeUndefined();
  nowMs = WEEK_MS + 1;
  expect(tips.next("agent-1", lowDisk)).toBe(lowTip);
});

test("disk is low only under both 20 GiB and 10% free", () => {
  const tips = new WorkspaceCleanupTips(() => 0);
  expect(
    tips.next("agent-1", {
      memoryOverLimit: false,
      disk: { availableBytes: 15 * GIB, totalBytes: 100 * GIB },
    }),
  ).toBeUndefined();
  expect(
    tips.next("agent-1", {
      memoryOverLimit: false,
      disk: { availableBytes: 25 * GIB, totalBytes: 1000 * GIB },
    }),
  ).toBeUndefined();
  expect(
    tips.next("agent-1", {
      memoryOverLimit: false,
      disk: { availableBytes: 512 * 1024 ** 2, totalBytes: 100 * GIB },
    }),
  ).toContain("Disk is low (512.0 MiB free).");
});

test("measureDiskSpace reads the free and total space of the workspace's filesystem", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-cleanup-tip-"));
  try {
    const disk = await measureDiskSpace(workspace);
    expect(disk!.totalBytes).toBeGreaterThan(0);
    expect(disk!.availableBytes).toBeGreaterThanOrEqual(0);
    expect(disk!.availableBytes).toBeLessThanOrEqual(disk!.totalBytes);
    expect(await measureDiskSpace(join(workspace, "missing"))).toBeUndefined();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("launchReminder joins the MEMORY.md reminder and the cleanup tip it brings", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-cleanup-tip-"));
  try {
    const tips = new WorkspaceCleanupTips(() => 0);
    expect(await tips.launchReminder("agent-1", workspace)).toBeUndefined();
    await writeFile(join(workspace, "MEMORY.md"), "x".repeat(9 * 1024));
    expect(await tips.launchReminder("agent-1", workspace)).toBe(
      `Your MEMORY.md is 9KB (limit 3KB). Move details into notes/ and keep MEMORY.md as an index.\n\n${TIP}`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
