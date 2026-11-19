import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAppInbox } from "#src/agent-app-inbox/agent-app-inbox";
import { APP_INBOX_PREVIEW_MAX_CHARS } from "#src/agent-app-inbox/registry";
import { AGENT_MIGRATION_IGNORE_FILE } from "#src/agent-migration/selection-rules";
import { SystemCleaner } from "#src/system-cleaner/system-cleaner";
import {
  buildDiskCleanupTip,
  DISK_HINT_SUMMARY_MAX_CHARS,
  scanWorkspaceHeavyPaths,
  type WorkspaceHeavyPathsMeasurement,
} from "#src/system-cleaner/workspace-heavy-paths";
import { captureDaemonLogs } from "./log-capture";
import {
  config,
  DAY_MS,
  DISK_ITEM,
  GIB,
  HOUR_MS,
  LOW_DISK,
  ManualClock,
  OWNER,
  PLENTY_OF_DISK,
  WEEK_MS,
} from "./fixtures/system-cleaner-harness";

const KIB = 1024;
const MIB = 1024 ** 2;

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function writeSizedFile(path: string, bytes: number): Promise<void> {
  await writeFile(path, Buffer.alloc(bytes));
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await chmod(root, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

describe("scanWorkspaceHeavyPaths", () => {
  test("ranks top carried paths while skipping ignored, regenerable, runtime, secret, and symlinked entries", async () => {
    const workspace = await makeTempDir("coforge-heavy-paths-");
    const outside = await makeTempDir("coforge-heavy-outside-");

    await writeFile(
      join(workspace, AGENT_MIGRATION_IGNORE_FILE),
      "# ignore repos and one nested dump\ncode\nwork/ignored-dump\n",
    );
    await writeSizedFile(join(workspace, "MEMORY.md"), 60 * KIB);

    await mkdir(join(workspace, "archive"), { recursive: true });
    await writeSizedFile(join(workspace, "archive", "bundle.bin"), 40 * KIB);
    await writeSizedFile(join(workspace, "archive", "notes.bin"), 15 * KIB);

    await mkdir(join(workspace, "work", "ignored-dump"), { recursive: true });
    await writeSizedFile(join(workspace, "work", "ignored-dump", "huge.bin"), 200 * KIB);
    await writeSizedFile(join(workspace, "work", "kept.bin"), 30 * KIB);

    await writeSizedFile(join(workspace, "dataset.bin"), 20 * KIB);
    await writeSizedFile(join(workspace, "tiny.txt"), 512);

    await mkdir(join(workspace, "code"), { recursive: true });
    await writeSizedFile(join(workspace, "code", "repo.pack"), 300 * KIB);

    await mkdir(join(workspace, "work", "node_modules", "pkg"), { recursive: true });
    await writeSizedFile(join(workspace, "work", "node_modules", "pkg", "index.js"), 250 * KIB);

    await mkdir(join(workspace, "target"), { recursive: true });
    await writeSizedFile(join(workspace, "target", "artifact.bin"), 250 * KIB);

    await mkdir(join(workspace, ".coforge-migration"), { recursive: true });
    await writeSizedFile(join(workspace, ".coforge-migration", "state.bin"), 250 * KIB);

    await mkdir(join(workspace, ".builtin-runtime"), { recursive: true });
    await writeSizedFile(join(workspace, ".builtin-runtime", "cache.bin"), 250 * KIB);

    await mkdir(join(workspace, ".ssh"), { recursive: true });
    await writeSizedFile(join(workspace, ".ssh", "id_rsa"), 250 * KIB);
    await writeSizedFile(join(workspace, ".env.production"), 250 * KIB);
    await writeSizedFile(join(workspace, "api-token.json"), 250 * KIB);

    await writeSizedFile(join(outside, "external.bin"), 400 * KIB);
    await symlink(outside, join(workspace, "linked-outside"));
    await symlink(join(workspace, "archive"), join(workspace, "archive", "loop"));

    const result = await scanWorkspaceHeavyPaths(workspace, {
      minEntryBytes: 10 * KIB,
      topN: 3,
    });

    expect(result.kind).toBe("measured");
    if (result.kind !== "measured") return;
    expect(result.incomplete).toBe(false);
    expect(result.ignoredCount).toBe(2);
    expect(result.topCarried).toEqual([
      { path: "archive", bytes: 55 * KIB, kind: "directory" },
      { path: "work", bytes: 30 * KIB, kind: "directory" },
      { path: "dataset.bin", bytes: 20 * KIB, kind: "file" },
    ]);
    expect(result.totalCarriedBytes).toBeGreaterThanOrEqual(
      60 * KIB + 55 * KIB + 30 * KIB + 20 * KIB + 512,
    );
    expect(result.totalCarriedBytes).toBeLessThan(200 * KIB);
  });

  test("marks incomplete when entry, depth, or time budget is exceeded", async () => {
    const workspace = await makeTempDir("coforge-heavy-budgets-");
    await mkdir(join(workspace, "deep", "a", "b", "c", "d"), { recursive: true });
    await writeSizedFile(join(workspace, "deep", "a", "b", "c", "d", "leaf.bin"), 4 * KIB);
    for (let index = 0; index < 12; index += 1)
      await writeSizedFile(join(workspace, `file-${index}.bin`), 1024);

    const entryLimited = await scanWorkspaceHeavyPaths(workspace, {
      maxEntries: 5,
      minEntryBytes: 1,
    });
    expect(entryLimited).toMatchObject({ kind: "measured", incomplete: true });

    const depthLimited = await scanWorkspaceHeavyPaths(workspace, {
      maxDepth: 2,
      minEntryBytes: 1,
    });
    expect(depthLimited).toMatchObject({ kind: "measured", incomplete: true });

    let fakeNow = 1_000;
    const timeLimited = await scanWorkspaceHeavyPaths(workspace, {
      timeBudgetMs: 10,
      minEntryBytes: 1,
      nowMs: () => {
        fakeNow += 15;
        return fakeNow;
      },
    });
    expect(timeLimited).toMatchObject({ kind: "measured", incomplete: true });
  });

  test("reports not_established for missing workspace, non-directory, or unreadable ignore file", async () => {
    const missing = await scanWorkspaceHeavyPaths(join(tmpdir(), `missing-${Date.now()}`));
    expect(missing).toEqual({ kind: "not_established", reason: "missing" });

    const root = await makeTempDir("coforge-heavy-notdir-");
    const filePath = join(root, "plain-file");
    await writeFile(filePath, "hello");
    expect(await scanWorkspaceHeavyPaths(filePath)).toEqual({
      kind: "not_established",
      reason: "not_directory",
    });

    const targetDir = await makeTempDir("coforge-heavy-symtarget-");
    const symlinkRoot = join(root, "linked-workspace");
    await symlink(targetDir, symlinkRoot);
    expect(await scanWorkspaceHeavyPaths(symlinkRoot)).toEqual({
      kind: "not_established",
      reason: "not_directory",
    });

    const symlinkIgnoreWs = await makeTempDir("coforge-heavy-symignore-");
    const externalIgnore = join(root, "ext-ignore");
    await writeFile(externalIgnore, "archive\n");
    await symlink(externalIgnore, join(symlinkIgnoreWs, AGENT_MIGRATION_IGNORE_FILE));
    await mkdir(join(symlinkIgnoreWs, "archive"), { recursive: true });
    await writeSizedFile(join(symlinkIgnoreWs, "archive", "kept.bin"), 16 * KIB);
    const symIgnoreResult = await scanWorkspaceHeavyPaths(symlinkIgnoreWs, {
      minEntryBytes: 8 * KIB,
      maxEntries: Number.NaN,
      maxDepth: Number.NaN,
    });
    expect(symIgnoreResult).toMatchObject({
      kind: "measured",
      ignoredCount: 0,
      topCarried: [{ path: "archive", bytes: 16 * KIB, kind: "directory" }],
    });

    if (process.getuid?.() !== 0) {
      const workspace = await makeTempDir("coforge-heavy-ignore-perm-");
      const ignorePath = join(workspace, AGENT_MIGRATION_IGNORE_FILE);
      await writeFile(ignorePath, "archive\n");
      await chmod(ignorePath, 0o000);
      try {
        expect(await scanWorkspaceHeavyPaths(workspace)).toEqual({
          kind: "not_established",
          reason: "ignore_file_unreadable",
        });
      } finally {
        await chmod(ignorePath, 0o644);
      }
    }
  });

  test("walks top-level directories breadth-first so a noisy deep tree does not starve sibling heavy dirs", async () => {
    const workspace = await makeTempDir("coforge-heavy-bfs-");
    await mkdir(join(workspace, "a-noisy", "sub"), { recursive: true });
    for (let index = 0; index < 20; index += 1)
      await writeSizedFile(join(workspace, "a-noisy", "sub", `tiny-${index}.txt`), 16);
    await mkdir(join(workspace, "z-heavy"), { recursive: true });
    await writeSizedFile(join(workspace, "z-heavy", "big.bin"), 64 * KIB);

    const result = await scanWorkspaceHeavyPaths(workspace, {
      maxEntries: 10,
      minEntryBytes: 32 * KIB,
    });
    expect(result.kind).toBe("measured");
    if (result.kind !== "measured") return;
    expect(result.incomplete).toBe(true);
    expect(result.topCarried).toEqual([{ path: "z-heavy", bytes: 64 * KIB, kind: "directory" }]);
  });
});

describe("buildDiskCleanupTip", () => {
  test("preserves default wording when no heavy paths are available", () => {
    const weekly = buildDiskCleanupTip({ workspaceThresholdBytes: 5 * GIB });
    expect(weekly.summary).toBe(
      "Only raise files added since your last question, and update .coforgemigrateignore as the workspace changes.",
    );

    const lowDisk = buildDiskCleanupTip({
      availableBytes: 10 * GIB,
      workspaceThresholdBytes: 5 * GIB,
    });
    expect(lowDisk.summary).toBe(
      "Only 10.0 GiB of disk space is left. Only raise files added since your last question, and update .coforgemigrateignore as the workspace changes.",
    );
  });

  test("formats bounded single-line summaries with top carried paths and sanitizes control characters", () => {
    const longName = `${"very-long-workspace-folder-name-".repeat(4)}end`;
    const workspace: Extract<WorkspaceHeavyPathsMeasurement, { kind: "measured" }> = {
      kind: "measured",
      totalCarriedBytes: 6 * GIB,
      topCarried: [
        { path: "archive", bytes: 3 * GIB, kind: "directory" },
        { path: `bad\nname\t${longName}`, bytes: 2 * GIB, kind: "directory" },
        { path: "dump.bin", bytes: 500 * MIB, kind: "file" },
      ],
      ignoredCount: 1,
      incomplete: true,
    };

    const heavyOnly = buildDiskCleanupTip({
      workspace,
      workspaceThresholdBytes: 5 * GIB,
    });
    expect(heavyOnly.title.length).toBeLessThanOrEqual(APP_INBOX_PREVIEW_MAX_CHARS);
    expect(heavyOnly.summary.length).toBeLessThanOrEqual(DISK_HINT_SUMMARY_MAX_CHARS);
    expect(heavyOnly.title).toContain("at least 6.0 GiB");
    expect(heavyOnly.title).toContain(AGENT_MIGRATION_IGNORE_FILE);
    expect(heavyOnly.summary).toContain("archive/ (3.0 GiB)");
    expect(heavyOnly.summary).toContain(AGENT_MIGRATION_IGNORE_FILE);
    const hasControlChar = (value: string) =>
      [...value].some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127);
    expect(hasControlChar(heavyOnly.title)).toBe(false);
    expect(hasControlChar(heavyOnly.summary)).toBe(false);

    const lowDiskAndHeavy = buildDiskCleanupTip({
      availableBytes: 8 * GIB,
      workspace,
      workspaceThresholdBytes: 5 * GIB,
    });
    expect(lowDiskAndHeavy.title.length).toBeLessThanOrEqual(APP_INBOX_PREVIEW_MAX_CHARS);
    expect(lowDiskAndHeavy.summary.length).toBeLessThanOrEqual(DISK_HINT_SUMMARY_MAX_CHARS);
    expect(lowDiskAndHeavy.summary).toContain("Only 8.0 GiB of disk space is left.");
    expect(lowDiskAndHeavy.summary).toContain("archive/ (3.0 GiB)");

    const controlOnlyFirst = buildDiskCleanupTip({
      availableBytes: 8 * GIB,
      workspace: {
        kind: "measured",
        totalCarriedBytes: 2 * GIB,
        topCarried: [
          { path: "\n\t\r", bytes: 1.5 * GIB, kind: "directory" },
          { path: "backup", bytes: 500 * MIB, kind: "directory" },
        ],
        ignoredCount: 0,
        incomplete: false,
      },
      workspaceThresholdBytes: 5 * GIB,
    });
    expect(controlOnlyFirst.summary).toContain("backup/ (500.0 MiB)");
  });
});

describe("SystemCleaner workspace heavy-path integration", () => {
  async function createCleanerHarness(options?: {
    workspaceThresholdBytes?: number;
    scanWorkspaceHeavyPaths?: (dir: string) => Promise<WorkspaceHeavyPathsMeasurement>;
  }) {
    const stateDirectory = await makeTempDir("coforge-cleaner-heavy-state-");
    const agentsDirectory = await makeTempDir("coforge-cleaner-heavy-agents-");
    const agentWorkspace = join(agentsDirectory, OWNER);
    await mkdir(agentWorkspace, { recursive: true });
    const clock = new ManualClock();
    const inbox = await AgentAppInbox.open(stateDirectory, "workspace-a", OWNER);
    let disk = PLENTY_OF_DISK;
    const wakes: { agentId: string; itemId: string }[] = [];
    const cleaner = new SystemCleaner({
      agentsDirectory,
      clock,
      workspaceHeavyThresholdBytes: options?.workspaceThresholdBytes ?? 64 * KIB,
      measureMemoryFile: async () => ({ kind: "measured", bytes: 0 }),
      measureKnowledgeSize: async () => ({ kind: "measured", bytes: 0 }),
      measureDiskSpace: async () => disk,
      ...(options?.scanWorkspaceHeavyPaths
        ? { scanWorkspaceHeavyPaths: options.scanWorkspaceHeavyPaths }
        : {}),
      inbox: {
        upsert: async (_agentId, item) => inbox.upsert(item),
        remove: async (_agentId, itemId) => inbox.remove(itemId),
      },
      wake: async (agentId, itemId) => {
        wakes.push({ agentId, itemId });
      },
    });
    const period = async (ms = HOUR_MS) => {
      for (let remaining = ms; remaining > 0; remaining -= HOUR_MS) {
        clock.advance(Math.min(HOUR_MS, remaining));
        await cleaner.settled();
      }
    };
    const idle = async () => {
      cleaner.onAgentWorkingToIdle(OWNER);
      await cleaner.settled();
    };
    return {
      cleaner,
      clock,
      inbox,
      agentWorkspace,
      wakes,
      period,
      idle,
      setDisk: (next: typeof disk) => {
        disk = next;
      },
    };
  }

  test("mints a concrete heavy-workspace hint at idle and skips when fixed in .coforgemigrateignore before idle", async () => {
    const { cleaner, inbox, agentWorkspace, wakes, period, idle } = await createCleanerHarness({
      workspaceThresholdBytes: 40 * KIB,
      scanWorkspaceHeavyPaths: (dir) =>
        scanWorkspaceHeavyPaths(dir, { minEntryBytes: 10 * KIB, topN: 3 }),
    });
    cleaner.applyConfig(config());
    await mkdir(join(agentWorkspace, "datasets"), { recursive: true });
    await writeSizedFile(join(agentWorkspace, "datasets", "train.bin"), 60 * KIB);

    await period();
    expect(inbox.list()).toEqual([]);

    await writeFile(join(agentWorkspace, AGENT_MIGRATION_IGNORE_FILE), "datasets\n");
    await idle();
    expect(inbox.list()).toEqual([]);
    expect(wakes).toEqual([]);

    await writeFile(join(agentWorkspace, AGENT_MIGRATION_IGNORE_FILE), "");
    const { records } = await captureDaemonLogs(async () => {
      await period();
      await idle();
    });

    const items = inbox.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      itemId: DISK_ITEM,
      notificationClass: "disk_space",
      command: "coforge manual get workspace-cleanup",
    });
    expect(items[0]?.title).toContain("60.0 KiB");
    expect(items[0]?.summary).toContain("datasets/ (60.0 KiB)");
    expect(items[0]?.summary).toContain(AGENT_MIGRATION_IGNORE_FILE);
    expect(wakes).toEqual([{ agentId: OWNER, itemId: DISK_ITEM }]);

    const periodLog = records.find((r) => r.properties.event === "system_cleaner:period");
    expect(periodLog?.properties).toMatchObject({
      workspace: {
        carried_bytes: 60 * KIB,
        threshold_bytes: 40 * KIB,
        due: "first",
      },
    });
    const presentedLog = records.find((r) => r.properties.event === "system_cleaner:presented");
    expect(presentedLog?.properties).toMatchObject({
      workspace_heavy: true,
    });
  });

  test("does not trigger on incomplete scan below threshold and enforces weekly / 25% growth cooldown", async () => {
    let measurement: WorkspaceHeavyPathsMeasurement = {
      kind: "measured",
      totalCarriedBytes: 30 * KIB,
      topCarried: [{ path: "datasets", bytes: 30 * KIB, kind: "directory" }],
      ignoredCount: 0,
      incomplete: true,
    };
    const { cleaner, wakes, period, idle } = await createCleanerHarness({
      workspaceThresholdBytes: 40 * KIB,
      scanWorkspaceHeavyPaths: async () => measurement,
    });
    cleaner.applyConfig(config());

    await period();
    await idle();
    expect(wakes).toEqual([]);

    measurement = {
      kind: "measured",
      totalCarriedBytes: 80 * KIB,
      topCarried: [{ path: "datasets", bytes: 80 * KIB, kind: "directory" }],
      ignoredCount: 0,
      incomplete: false,
    };
    await period();
    await idle();
    expect(wakes).toHaveLength(1);

    measurement = {
      kind: "measured",
      totalCarriedBytes: 95 * KIB,
      topCarried: [{ path: "datasets", bytes: 95 * KIB, kind: "directory" }],
      ignoredCount: 0,
      incomplete: false,
    };
    await period(DAY_MS);
    await idle();
    expect(wakes).toHaveLength(1);

    measurement = {
      kind: "measured",
      totalCarriedBytes: 100 * KIB,
      topCarried: [{ path: "datasets", bytes: 100 * KIB, kind: "directory" }],
      ignoredCount: 0,
      incomplete: false,
    };
    await period();
    await idle();
    expect(wakes).toHaveLength(2);

    await period(WEEK_MS - HOUR_MS);
    await idle();
    expect(wakes).toHaveLength(2);
    await period(HOUR_MS);
    await idle();
    expect(wakes).toHaveLength(3);
  });

  test("enriches low-disk hint with concrete top carried paths", async () => {
    const { cleaner, inbox, wakes, period, idle, setDisk } = await createCleanerHarness({
      workspaceThresholdBytes: 5 * GIB,
      scanWorkspaceHeavyPaths: async () => ({
        kind: "measured",
        totalCarriedBytes: 2 * GIB,
        topCarried: [
          { path: "archive", bytes: 1.5 * GIB, kind: "directory" },
          { path: "dump.bin", bytes: 500 * MIB, kind: "file" },
        ],
        ignoredCount: 0,
        incomplete: false,
      }),
    });
    cleaner.applyConfig(config());
    setDisk(LOW_DISK);

    await period();
    await idle();

    expect(wakes).toEqual([{ agentId: OWNER, itemId: DISK_ITEM }]);
    expect(inbox.list()[0]?.summary).toContain("Only 10.0 GiB of disk space is left.");
    expect(inbox.list()[0]?.summary).toContain("archive/ (1.5 GiB)");
    expect(inbox.list()[0]?.summary).toContain("dump.bin (500.0 MiB)");
  });
});
