import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "disk-janitor"]);

export const DISK_JANITOR_INITIAL_DELAY_MS = 60_000;
export const DISK_JANITOR_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DISK_JANITOR_STALE_TEMP_AGE_MS = 60 * 60 * 1000;
export const DISK_JANITOR_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const STALE_TEMP_FILE_PATTERN = /^.+\.tmp(?:-[a-zA-Z0-9._-]+)?$/;
const ROTATED_DAEMON_LOG_PATTERN = /^daemon\.(?:jsonl|log)(?:\.\d+(?:\.gz)?|-[a-zA-Z0-9._-]+)$/;

export type DiskJanitorInitialSchedule = (
  callback: () => Promise<void>,
  milliseconds: number,
) => () => void;

export type DiskJanitorIntervalSchedule = (
  callback: () => void,
  milliseconds: number,
) => () => void;

export type DaemonDiskJanitorSweepOptions = {
  stateDirectory: string;
  includeWorkspacesSubdir?: boolean;
  now?: () => number;
  staleTempAgeMs?: number;
  logRetentionMs?: number;
};

export type DaemonDiskJanitorSweepResult = {
  tempFilesRemoved: number;
  rotatedLogsRemoved: number;
  reclaimedBytes: number;
  errors: number;
};

export type DaemonDiskJanitorOptions = DaemonDiskJanitorSweepOptions & {
  initialDelayMs?: number;
  intervalMs?: number;
  scheduleInitial?: DiskJanitorInitialSchedule;
  scheduleInterval?: DiskJanitorIntervalSchedule;
};

const defaultScheduleInitial: DiskJanitorInitialSchedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref?.();
  return () => clearTimeout(timer);
};

const defaultScheduleInterval: DiskJanitorIntervalSchedule = (callback, milliseconds) => {
  const timer = setInterval(callback, milliseconds);
  timer.unref?.();
  return () => clearInterval(timer);
};

export async function sweepDaemonDiskState(
  options: DaemonDiskJanitorSweepOptions,
): Promise<DaemonDiskJanitorSweepResult> {
  const nowMs = (options.now ?? Date.now)();
  const staleTempAgeMs = options.staleTempAgeMs ?? DISK_JANITOR_STALE_TEMP_AGE_MS;
  const logRetentionMs = options.logRetentionMs ?? DISK_JANITOR_LOG_RETENTION_MS;
  const result: DaemonDiskJanitorSweepResult = {
    tempFilesRemoved: 0,
    rotatedLogsRemoved: 0,
    reclaimedBytes: 0,
    errors: 0,
  };

  await sweepDirectoryTempFiles(options.stateDirectory, nowMs, staleTempAgeMs, result);
  await sweepRotatedLogsUnder(options.stateDirectory, nowMs, logRetentionMs, result);

  if (options.includeWorkspacesSubdir) {
    await sweepWorkspaceSubdirectories(
      join(options.stateDirectory, "workspaces"),
      nowMs,
      staleTempAgeMs,
      logRetentionMs,
      result,
    );
  }

  return result;
}

export class DaemonDiskJanitor {
  readonly #options: DaemonDiskJanitorOptions;
  #cancelInitial?: () => void;
  #cancelInterval?: () => void;
  #started = false;
  #running?: Promise<DaemonDiskJanitorSweepResult>;

  constructor(options: DaemonDiskJanitorOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const scheduleInitial = this.#options.scheduleInitial ?? defaultScheduleInitial;
    const scheduleInterval = this.#options.scheduleInterval ?? defaultScheduleInterval;
    const initialDelayMs = this.#options.initialDelayMs ?? DISK_JANITOR_INITIAL_DELAY_MS;
    const intervalMs = this.#options.intervalMs ?? DISK_JANITOR_INTERVAL_MS;

    this.#cancelInitial = scheduleInitial(async () => {
      if (!this.#started) return;
      await this.sweepNow();
    }, initialDelayMs);
    this.#cancelInterval = scheduleInterval(() => {
      if (!this.#started) return;
      void this.sweepNow();
    }, intervalMs);
  }

  stop(): void {
    this.#started = false;
    this.#cancelInitial?.();
    this.#cancelInitial = undefined;
    this.#cancelInterval?.();
    this.#cancelInterval = undefined;
  }

  sweepNow(): Promise<DaemonDiskJanitorSweepResult> {
    if (this.#running) return this.#running;
    const run = sweepDaemonDiskState(this.#options)
      .then((result) => {
        const totalRemoved = result.tempFilesRemoved + result.rotatedLogsRemoved;
        if (totalRemoved > 0) {
          logger.info("Daemon disk janitor reclaimed stale files", {
            event: "daemon_disk_janitor:swept",
            removed_count: totalRemoved,
            temp_files_removed: result.tempFilesRemoved,
            rotated_logs_removed: result.rotatedLogsRemoved,
            reclaimed_bytes: result.reclaimedBytes,
            error_count: result.errors,
            outcome: "ok",
          });
        } else if (result.errors > 0) {
          logger.warning("Daemon disk janitor encountered removal errors", {
            event: "daemon_disk_janitor:sweep_errors",
            error_count: result.errors,
            outcome: "failed",
          });
        }
        return result;
      })
      .catch((error: unknown) => {
        logger.warning("Daemon disk janitor sweep failed", {
          event: "daemon_disk_janitor:sweep_failed",
          error_code: diagnosticErrorCode(error),
          outcome: "failed",
        });
        return { tempFilesRemoved: 0, rotatedLogsRemoved: 0, reclaimedBytes: 0, errors: 1 };
      })
      .finally(() => {
        if (this.#running === run) this.#running = undefined;
      });
    this.#running = run;
    return run;
  }
}

async function sweepWorkspaceSubdirectories(
  workspacesRoot: string,
  nowMs: number,
  staleTempAgeMs: number,
  logRetentionMs: number,
  result: DaemonDiskJanitorSweepResult,
): Promise<void> {
  const rootInfo = await safeLstat(workspacesRoot);
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return;
  let entries;
  try {
    entries = await readdir(workspacesRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  for (const name of directories) {
    const workspaceDir = join(workspacesRoot, name);
    await sweepDirectoryTempFiles(workspaceDir, nowMs, staleTempAgeMs, result);
    await sweepRotatedLogsUnder(workspaceDir, nowMs, logRetentionMs, result);
  }
}

async function sweepDirectoryTempFiles(
  directory: string,
  nowMs: number,
  staleTempAgeMs: number,
  result: DaemonDiskJanitorSweepResult,
): Promise<void> {
  const dirInfo = await safeLstat(directory);
  if (!dirInfo || dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    if (!isStaleTempFileName(name)) continue;
    const candidate = join(directory, name);
    const info = await safeLstat(candidate);
    if (!info || info.isSymbolicLink() || !info.isFile()) continue;
    if (nowMs - info.mtimeMs < staleTempAgeMs) continue;
    const outcome = await unlinkRegularFile(candidate);
    if (outcome === "removed") {
      result.tempFilesRemoved += 1;
      result.reclaimedBytes += info.size;
    } else if (outcome === "error") {
      result.errors += 1;
    }
  }
}

async function sweepRotatedLogsUnder(
  baseDirectory: string,
  nowMs: number,
  logRetentionMs: number,
  result: DaemonDiskJanitorSweepResult,
): Promise<void> {
  const logsRoot = join(baseDirectory, "logs");
  const logsRootInfo = await safeLstat(logsRoot);
  if (!logsRootInfo || logsRootInfo.isSymbolicLink() || !logsRootInfo.isDirectory()) return;
  const daemonLogsDir = join(logsRoot, "daemon");
  const dirInfo = await safeLstat(daemonLogsDir);
  if (!dirInfo || dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return;
  let entries: string[];
  try {
    entries = await readdir(daemonLogsDir);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    if (!ROTATED_DAEMON_LOG_PATTERN.test(name)) continue;
    const candidate = join(daemonLogsDir, name);
    const info = await safeLstat(candidate);
    if (!info || info.isSymbolicLink() || !info.isFile()) continue;
    if (nowMs - info.mtimeMs < logRetentionMs) continue;
    const outcome = await unlinkRegularFile(candidate);
    if (outcome === "removed") {
      result.rotatedLogsRemoved += 1;
      result.reclaimedBytes += info.size;
    } else if (outcome === "error") {
      result.errors += 1;
    }
  }
}

async function unlinkRegularFile(path: string): Promise<"removed" | "missing" | "error"> {
  try {
    await unlink(path);
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "error";
  }
}

function isStaleTempFileName(name: string): boolean {
  if (!STALE_TEMP_FILE_PATTERN.test(name)) return false;
  const lower = name.toLowerCase();
  if (lower.includes(".sqlite") || lower.includes(".db")) return false;
  return true;
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}
