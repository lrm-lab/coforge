import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonDiskJanitor,
  DISK_JANITOR_LOG_RETENTION_MS,
  DISK_JANITOR_STALE_TEMP_AGE_MS,
  sweepDaemonDiskState,
} from "#src/platform/daemon-disk-janitor";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("DaemonDiskJanitor", () => {
  test("removes aged temp files and expired daemon.jsonl rotated logs while preserving active logs, sqlite, and symlinks", async () => {
    const stateDir = await makeTempDir("coforge-disk-janitor-");
    const wsDir = join(stateDir, "workspaces", "ws-1");
    const logsDir = join(stateDir, "logs", "daemon");
    const wsLogsDir = join(wsDir, "logs", "daemon");
    const credsDir = join(stateDir, "credentials");
    const externalDir = await makeTempDir("coforge-disk-janitor-external-");
    const externalDaemonLogs = join(externalDir, "daemon");
    await mkdir(wsLogsDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(credsDir, { recursive: true });
    await mkdir(externalDaemonLogs, { recursive: true });

    const nowMs = Date.now() + 2 * DISK_JANITOR_LOG_RETENTION_MS;
    const oldTempTime = new Date(nowMs - DISK_JANITOR_STALE_TEMP_AGE_MS - 60_000);
    const freshTempTime = new Date(nowMs - 5 * 60_000);
    const oldLogTime = new Date(nowMs - DISK_JANITOR_LOG_RETENTION_MS - 60_000);
    const recentLogTime = new Date(nowMs - 2 * 24 * 60 * 60 * 1000);

    const oldRootTemp = join(stateDir, "bindings.json.abc.tmp");
    const freshRootTemp = join(stateDir, "bindings.json.fresh.tmp");
    const bareTmpDotfile = join(stateDir, ".tmp");
    const oldWsTemp = join(wsDir, "health.json.old.tmp");
    const sqliteTemp = join(wsDir, "workspace-daemon-lock.SQLITE.tmp");
    const credsTemp = join(credsDir, "secret.tmp");
    const keepTarget = join(stateDir, "keep-target.txt");
    const symlinkTemp = join(stateDir, "linked.tmp");
    const activeLog = join(logsDir, "daemon.jsonl");
    const expiredRotatedLog = join(logsDir, "daemon.jsonl.3");
    const recentRotatedLog = join(logsDir, "daemon.jsonl.1");
    const expiredWsRotatedLog = join(wsLogsDir, "daemon.jsonl.2.gz");

    const wsWithSymlinkLogs = join(stateDir, "workspaces", "ws-symlink-logs");
    await mkdir(wsWithSymlinkLogs, { recursive: true });
    await symlink(externalDir, join(wsWithSymlinkLogs, "logs"));
    const externalRotatedLog = join(externalDaemonLogs, "daemon.jsonl.5");

    await writeFile(oldRootTemp, "1234567890");
    await writeFile(freshRootTemp, "fresh");
    await writeFile(bareTmpDotfile, "dot");
    await writeFile(oldWsTemp, "12345");
    await writeFile(sqliteTemp, "sqlite");
    await writeFile(credsTemp, "creds");
    await writeFile(keepTarget, "target");
    await symlink(keepTarget, symlinkTemp);
    await writeFile(activeLog, "active");
    await writeFile(expiredRotatedLog, "rotated-old-log");
    await writeFile(recentRotatedLog, "rotated-recent");
    await writeFile(expiredWsRotatedLog, "ws-old");
    await writeFile(externalRotatedLog, "external-keep");

    await utimes(oldRootTemp, oldTempTime, oldTempTime);
    await utimes(freshRootTemp, freshTempTime, freshTempTime);
    await utimes(bareTmpDotfile, oldTempTime, oldTempTime);
    await utimes(oldWsTemp, oldTempTime, oldTempTime);
    await utimes(sqliteTemp, oldTempTime, oldTempTime);
    await utimes(credsTemp, oldTempTime, oldTempTime);
    await utimes(activeLog, oldLogTime, oldLogTime);
    await utimes(expiredRotatedLog, oldLogTime, oldLogTime);
    await utimes(recentRotatedLog, recentLogTime, recentLogTime);
    await utimes(expiredWsRotatedLog, oldLogTime, oldLogTime);
    await utimes(externalRotatedLog, oldLogTime, oldLogTime);

    const result = await sweepDaemonDiskState({
      stateDirectory: stateDir,
      includeWorkspacesSubdir: true,
      now: () => nowMs,
    });

    expect(result).toEqual({
      tempFilesRemoved: 2,
      rotatedLogsRemoved: 2,
      reclaimedBytes: 10 + 5 + 15 + 6,
      errors: 0,
    });
    expect(await Bun.file(oldRootTemp).exists()).toBe(false);
    expect(await Bun.file(oldWsTemp).exists()).toBe(false);
    expect(await Bun.file(expiredRotatedLog).exists()).toBe(false);
    expect(await Bun.file(expiredWsRotatedLog).exists()).toBe(false);

    expect(await Bun.file(freshRootTemp).exists()).toBe(true);
    expect(await Bun.file(bareTmpDotfile).exists()).toBe(true);
    expect(await Bun.file(sqliteTemp).exists()).toBe(true);
    expect(await Bun.file(credsTemp).exists()).toBe(true);
    expect(await Bun.file(keepTarget).exists()).toBe(true);
    expect((await lstat(symlinkTemp)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(externalRotatedLog).exists()).toBe(true);
    expect(await Bun.file(activeLog).exists()).toBe(true);
    expect(await Bun.file(recentRotatedLog).exists()).toBe(true);
  });

  test("schedules initial delayed sweep and periodic interval, deduplicates concurrent sweeps, and stops cleanly", async () => {
    const stateDir = await makeTempDir("coforge-disk-janitor-schedule-");
    const staleFile = join(stateDir, "stale.json.tmp");
    await writeFile(staleFile, "stale");
    const nowMs = Date.now() + 2 * DISK_JANITOR_STALE_TEMP_AGE_MS;
    const oldTime = new Date(nowMs - DISK_JANITOR_STALE_TEMP_AGE_MS - 1_000);
    await utimes(staleFile, oldTime, oldTime);

    let initialCallback: (() => Promise<void>) | undefined;
    let intervalCallback: (() => void) | undefined;
    let cancelledInitial = false;
    let cancelledInterval = false;

    const janitor = new DaemonDiskJanitor({
      stateDirectory: stateDir,
      now: () => nowMs,
      scheduleInitial: (cb) => {
        initialCallback = cb;
        return () => {
          cancelledInitial = true;
        };
      },
      scheduleInterval: (cb) => {
        intervalCallback = cb;
        return () => {
          cancelledInterval = true;
        };
      },
    });

    const first = janitor.sweepNow();
    const second = janitor.sweepNow();
    expect(second).toBe(first);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({
      tempFilesRemoved: 1,
      rotatedLogsRemoved: 0,
      reclaimedBytes: 5,
      errors: 0,
    });
    expect(secondResult).toBe(firstResult);

    await writeFile(staleFile, "stale-2");
    await utimes(staleFile, oldTime, oldTime);

    janitor.start();
    expect(initialCallback).toBeDefined();
    expect(intervalCallback).toBeDefined();

    await initialCallback!();
    expect(await Bun.file(staleFile).exists()).toBe(false);

    janitor.stop();
    expect(cancelledInitial).toBe(true);
    expect(cancelledInterval).toBe(true);

    const afterStopFile = join(stateDir, "after-stop.tmp");
    await writeFile(afterStopFile, "keep");
    await utimes(afterStopFile, oldTime, oldTime);
    await initialCallback!();
    intervalCallback!();
    expect(await Bun.file(afterStopFile).exists()).toBe(true);
  });
});
