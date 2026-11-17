import { lstat, statfs } from "node:fs/promises";
import type { ReminderClock } from "#src/agent-reminder/reminder-clock";

export type MemoryMeasurement =
  | Readonly<{ kind: "measured"; bytes: number; incomplete?: boolean }>
  | Readonly<{ kind: "not_established"; reason: string }>;

export type DiskMeasurement =
  | Readonly<{ kind: "measured"; availableBytes: number; totalBytes: number }>
  | Readonly<{ kind: "not_established"; reason: string }>;

const DISK_LOW_MAX_AVAILABLE_BYTES = 20 * 1024 ** 3;
const DISK_LOW_MAX_AVAILABLE_PERCENT = 10;

export function isDiskLow(availableBytes: number, totalBytes: number): boolean {
  return (
    availableBytes < DISK_LOW_MAX_AVAILABLE_BYTES &&
    (availableBytes / totalBytes) * 100 < DISK_LOW_MAX_AVAILABLE_PERCENT
  );
}

export function withMeasurementTimeout<T extends { kind: string }>(
  clock: ReminderClock,
  timeoutMs: number,
  measure: () => Promise<T>,
): Promise<T | Readonly<{ kind: "not_established"; reason: string }>> {
  return new Promise((resolve) => {
    const finish = (result: T | Readonly<{ kind: "not_established"; reason: string }>) => {
      clock.cancel(timer);
      resolve(result);
    };
    const timer = clock.schedule(
      () => finish({ kind: "not_established", reason: "timeout" }),
      timeoutMs,
    );
    Promise.resolve()
      .then(measure)
      .then(finish, () => finish({ kind: "not_established", reason: "read_failed" }));
  });
}

export async function measureMemoryFile(path: string): Promise<MemoryMeasurement> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { kind: "not_established", reason: "not_regular_file" };
    return { kind: "measured", bytes: info.size };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { kind: "not_established", reason: "missing" };
    if (code === "EACCES" || code === "EPERM")
      return { kind: "not_established", reason: "permission_denied" };
    return { kind: "not_established", reason: "read_failed" };
  }
}

export async function measureDiskSpace(path: string): Promise<DiskMeasurement> {
  try {
    const info = await statfs(path);
    return {
      kind: "measured",
      availableBytes: info.bavail * info.bsize,
      totalBytes: info.blocks * info.bsize,
    };
  } catch {
    return { kind: "not_established", reason: "read_failed" };
  }
}
