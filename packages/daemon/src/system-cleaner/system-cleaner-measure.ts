import { lstat } from "node:fs/promises";
import type { ReminderClock } from "#src/agent-reminder/reminder-clock";
import { readVolumeCapacity } from "#src/platform/volume-capacity";

export type MemoryMeasurement =
  | Readonly<{ kind: "measured"; bytes: number; incomplete?: boolean }>
  | Readonly<{ kind: "not_established"; reason: string }>;

export type DiskMeasurement =
  | Readonly<{ kind: "measured"; availableBytes: number; totalBytes: number }>
  | Readonly<{ kind: "not_established"; reason: string }>;

const DISK_LOW_MAX_AVAILABLE_BYTES = 20 * 1024 ** 3;
const DISK_LOW_MAX_AVAILABLE_PERCENT = 10;

export function isValidDiskMeasurement(availableBytes: number, totalBytes: number): boolean {
  return (
    Number.isFinite(availableBytes) &&
    availableBytes >= 0 &&
    Number.isFinite(totalBytes) &&
    totalBytes > 0 &&
    availableBytes <= totalBytes
  );
}

export function isDiskLow(availableBytes: number, totalBytes: number): boolean {
  return (
    availableBytes < DISK_LOW_MAX_AVAILABLE_BYTES &&
    (availableBytes / totalBytes) * 100 < DISK_LOW_MAX_AVAILABLE_PERCENT
  );
}

export function evaluateDiskPeriod(
  measurement: DiskMeasurement,
  lowTipped: boolean,
  lastDiskTipAtMs: number | undefined,
  nowMs: number,
  weekMs: number,
): Readonly<{
  row: Readonly<{
    available_bytes?: number;
    total_bytes?: number;
    low?: boolean;
    due?: boolean;
    not_established?: string;
  }>;
  availableBytes?: number;
  recovered: boolean;
}> {
  if (measurement.kind === "not_established")
    return { row: { not_established: measurement.reason }, recovered: false };
  const { availableBytes, totalBytes } = measurement;
  if (!isValidDiskMeasurement(availableBytes, totalBytes))
    return { row: { not_established: "invalid_measurement" }, recovered: false };
  if (!isDiskLow(availableBytes, totalBytes)) {
    return {
      row: { available_bytes: availableBytes, total_bytes: totalBytes, low: false },
      recovered: true,
    };
  }
  const due = !lowTipped && (lastDiskTipAtMs === undefined || nowMs - lastDiskTipAtMs >= weekMs);
  return {
    row: { available_bytes: availableBytes, total_bytes: totalBytes, low: true, due },
    ...(due ? { availableBytes } : {}),
    recovered: false,
  };
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
  const capacity = await readVolumeCapacity(path);
  if (!capacity) return { kind: "not_established", reason: "read_failed" };
  return {
    kind: "measured",
    availableBytes: capacity.availableBytes,
    totalBytes: capacity.totalBytes,
  };
}
