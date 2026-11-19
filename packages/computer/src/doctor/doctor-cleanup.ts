import { lstat, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireProcessLock, isLockContention, processStartedAt } from "@lrm/coforge-daemon";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import type { LockState } from "#src/status/types";

export type DoctorCleanupKind = "stale_supervisor_lock" | "stale_detached_pid" | "stale_temp_file";

export type DoctorCleanupEntry = {
  path: string;
  kind: DoctorCleanupKind;
};

export type DoctorCleanupSkipped = {
  path: string;
  reason: string;
};

export type DoctorCleanupResult = {
  removed: DoctorCleanupEntry[];
  skipped: DoctorCleanupSkipped[];
};

export type DoctorCleanupOptions = {
  stateDirectory: string;
  coordinatorRunning: boolean;
  machineMutationLock?: LockState;
  platform?: NodeJS.Platform;
  now?: () => number;
  minTempAgeMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  isSupervisorLockHeld?: () => Promise<boolean>;
  readProcessStartedAt?: (pid: number) => Promise<number | null>;
};

export const STALE_TEMP_FILE_MIN_AGE_MS = 10 * 60 * 1000;

const STALE_TEMP_FILE_PATTERN = /\.tmp(?:-[a-zA-Z0-9._-]+)?$/;

export function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

async function defaultIsSupervisorLockHeld(stateDirectory: string): Promise<boolean> {
  const lockPath = join(stateDirectory, "supervisor-lock.sqlite");
  if (!(await Bun.file(lockPath).exists())) return false;
  try {
    const lock = acquireProcessLock(lockPath);
    lock.release();
    return false;
  } catch (error) {
    return isLockContention(error);
  }
}

export async function runDoctorCleanup(
  options: DoctorCleanupOptions,
): Promise<DoctorCleanupResult> {
  const now = options.now ?? Date.now;
  const nowMs = now();
  const minTempAgeMs = options.minTempAgeMs ?? STALE_TEMP_FILE_MIN_AGE_MS;
  const platform = options.platform ?? process.platform;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const isSupervisorLockHeld =
    options.isSupervisorLockHeld ?? (() => defaultIsSupervisorLockHeld(options.stateDirectory));
  const readStartedAt =
    options.readProcessStartedAt ?? (platform === "linux" ? processStartedAt : undefined);
  const mutationLocked =
    options.machineMutationLock !== undefined && options.machineMutationLock !== "free";
  const removed: DoctorCleanupEntry[] = [];
  const skipped: DoctorCleanupSkipped[] = [];

  await cleanupSupervisorLock(
    options.stateDirectory,
    options.coordinatorRunning,
    mutationLocked,
    nowMs,
    minTempAgeMs,
    isProcessAlive,
    isSupervisorLockHeld,
    removed,
    skipped,
  );
  await cleanupDetachedPid(
    options.stateDirectory,
    options.coordinatorRunning,
    mutationLocked,
    nowMs,
    minTempAgeMs,
    isProcessAlive,
    options.isProcessAlive !== undefined ? options.readProcessStartedAt : readStartedAt,
    removed,
    skipped,
  );
  await cleanupStaleTempFilesInDirectory(
    options.stateDirectory,
    nowMs,
    minTempAgeMs,
    removed,
    skipped,
  );
  await cleanupWorkspaceTempFiles(options.stateDirectory, nowMs, minTempAgeMs, removed, skipped);

  return { removed, skipped };
}

async function cleanupSupervisorLock(
  stateDirectory: string,
  coordinatorRunning: boolean,
  mutationLocked: boolean,
  nowMs: number,
  minTempAgeMs: number,
  isProcessAlive: (pid: number) => boolean,
  isSupervisorLockHeld: () => Promise<boolean>,
  removed: DoctorCleanupEntry[],
  skipped: DoctorCleanupSkipped[],
): Promise<void> {
  const lockDir = join(stateDirectory, "supervisor.lock");
  const lockInfo = await safeLstat(lockDir);
  if (!lockInfo || lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) return;
  if (mutationLocked) {
    skipped.push({ path: lockDir, reason: "machine mutation lock is not free" });
    return;
  }
  if (coordinatorRunning) {
    skipped.push({ path: lockDir, reason: "coordinator is running" });
    return;
  }
  if (await isSupervisorLockHeld().catch(() => true)) {
    skipped.push({ path: lockDir, reason: "supervisor process lock is actively held" });
    return;
  }
  const ownerPath = join(lockDir, "owner");
  const ownerInfo = await safeLstat(ownerPath);
  if (ownerInfo?.isSymbolicLink()) {
    skipped.push({ path: lockDir, reason: "lock owner entry is a symlink" });
    return;
  }
  if (ownerInfo?.isFile()) {
    const pid = await readFirstPositivePid(ownerPath);
    if (pid === null) {
      if (nowMs - ownerInfo.mtimeMs < minTempAgeMs) {
        skipped.push({ path: lockDir, reason: "lock owner is unreadable or recently created" });
        return;
      }
    } else if (isProcessAlive(pid)) {
      skipped.push({ path: lockDir, reason: `owning process ${pid} is still running` });
      return;
    }
  } else if (nowMs - lockInfo.mtimeMs < minTempAgeMs) {
    skipped.push({ path: lockDir, reason: "lock directory is missing owner and recently created" });
    return;
  }
  try {
    if (ownerInfo?.isFile()) await rm(ownerPath, { force: true });
    await rmdir(lockDir);
    removed.push({ path: lockDir, kind: "stale_supervisor_lock" });
  } catch (error) {
    skipped.push({ path: lockDir, reason: thrownMessage(error) });
  }
}

async function cleanupDetachedPid(
  stateDirectory: string,
  coordinatorRunning: boolean,
  mutationLocked: boolean,
  nowMs: number,
  minTempAgeMs: number,
  isProcessAlive: (pid: number) => boolean,
  readStartedAt: ((pid: number) => Promise<number | null>) | undefined,
  removed: DoctorCleanupEntry[],
  skipped: DoctorCleanupSkipped[],
): Promise<void> {
  const pidPath = join(stateDirectory, "detached.pid");
  const info = await safeLstat(pidPath);
  if (!info || info.isSymbolicLink() || !info.isFile()) return;
  if (mutationLocked) {
    skipped.push({ path: pidPath, reason: "machine mutation lock is not free" });
    return;
  }
  if (coordinatorRunning) {
    skipped.push({ path: pidPath, reason: "coordinator is running" });
    return;
  }
  const parsed = await readDetachedPidEntry(pidPath);
  if (!parsed) {
    if (nowMs - info.mtimeMs < minTempAgeMs) {
      skipped.push({ path: pidPath, reason: "pid file is unreadable or recently created" });
      return;
    }
  } else if (parsed.startedAt !== null && readStartedAt) {
    const liveStartedAt = await readStartedAt(parsed.pid).catch(() => null);
    if (liveStartedAt === parsed.startedAt) {
      skipped.push({ path: pidPath, reason: `owning process ${parsed.pid} is still running` });
      return;
    }
  } else if (isProcessAlive(parsed.pid)) {
    skipped.push({ path: pidPath, reason: `owning process ${parsed.pid} is still running` });
    return;
  }
  try {
    await rm(pidPath, { force: true });
    removed.push({ path: pidPath, kind: "stale_detached_pid" });
  } catch (error) {
    skipped.push({ path: pidPath, reason: thrownMessage(error) });
  }
}

async function cleanupWorkspaceTempFiles(
  stateDirectory: string,
  nowMs: number,
  minTempAgeMs: number,
  removed: DoctorCleanupEntry[],
  skipped: DoctorCleanupSkipped[],
): Promise<void> {
  const workspacesRoot = join(stateDirectory, "workspaces");
  const rootInfo = await safeLstat(workspacesRoot);
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return;
  let entries: string[];
  try {
    entries = await readdir(workspacesRoot);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    const workspaceDir = join(workspacesRoot, entry);
    const info = await safeLstat(workspaceDir);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    await cleanupStaleTempFilesInDirectory(workspaceDir, nowMs, minTempAgeMs, removed, skipped);
  }
}

async function cleanupStaleTempFilesInDirectory(
  directory: string,
  nowMs: number,
  minTempAgeMs: number,
  removed: DoctorCleanupEntry[],
  skipped: DoctorCleanupSkipped[],
): Promise<void> {
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
    if (nowMs - info.mtimeMs < minTempAgeMs) continue;
    try {
      await rm(candidate, { force: true });
      removed.push({ path: candidate, kind: "stale_temp_file" });
    } catch (error) {
      skipped.push({ path: candidate, reason: thrownMessage(error) });
    }
  }
}

function isStaleTempFileName(name: string): boolean {
  if (!STALE_TEMP_FILE_PATTERN.test(name)) return false;
  if (name.includes(".sqlite") || name.includes(".db")) return false;
  return true;
}

async function readFirstPositivePid(filePath: string): Promise<number | null> {
  try {
    const text = (await readFile(filePath, "utf8")).trim();
    const firstToken = text.split(/\s+/)[0];
    const pid = Number(firstToken);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function readDetachedPidEntry(
  filePath: string,
): Promise<{ pid: number; startedAt: number | null } | null> {
  try {
    const parts = (await readFile(filePath, "utf8")).trim().split(/\s+/);
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const startedAt = parts.length > 1 ? Number(parts[1]) : Number.NaN;
    return { pid, startedAt: Number.isFinite(startedAt) ? startedAt : null };
  } catch {
    return null;
  }
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}
