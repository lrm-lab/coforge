export type MachineStatusReading = {
  availableBytes: number;
  totalBytes: number;
  reportedAt: string;
};

export type MachineStatusView = {
  disk: MachineStatusReading | null;
  memory: MachineStatusReading | null;
};

export const DISK_STALE_AFTER_MS = 2 * 60 * 60_000;
export const MEMORY_STALE_AFTER_MS = 15 * 60_000;

const GIB = 1024 ** 3;
export const MACHINE_DISK_LOW_BYTES = 20 * GIB;
export const MACHINE_DISK_LOW_RATIO = 0.1;

export function isMachineDiskLow(reading: { availableBytes: number; totalBytes: number }): boolean {
  return (
    reading.availableBytes < MACHINE_DISK_LOW_BYTES &&
    reading.totalBytes > 0 &&
    reading.availableBytes / reading.totalBytes < MACHINE_DISK_LOW_RATIO
  );
}

type MachineStatusRow = {
  diskAvailableBytes: bigint | null;
  diskTotalBytes: bigint | null;
  diskReportedAt: Date | null;
  memoryAvailableBytes: bigint | null;
  memoryTotalBytes: bigint | null;
  memoryReportedAt: Date | null;
};

export function machineStatusView(row: MachineStatusRow, now = Date.now()): MachineStatusView {
  return {
    disk: reading(
      row.diskAvailableBytes,
      row.diskTotalBytes,
      row.diskReportedAt,
      DISK_STALE_AFTER_MS,
      now,
    ),
    memory: reading(
      row.memoryAvailableBytes,
      row.memoryTotalBytes,
      row.memoryReportedAt,
      MEMORY_STALE_AFTER_MS,
      now,
    ),
  };
}

function reading(
  available: bigint | null,
  total: bigint | null,
  reportedAt: Date | null,
  staleAfterMs: number,
  now: number,
): MachineStatusReading | null {
  if (available === null || total === null || reportedAt === null) return null;
  if (now - reportedAt.getTime() > staleAfterMs) return null;
  const value = { availableBytes: Number(available), totalBytes: Number(total) };
  if (
    !Number.isSafeInteger(value.availableBytes) ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes <= 0 ||
    value.availableBytes < 0 ||
    value.availableBytes > value.totalBytes
  )
    return null;
  return { ...value, reportedAt: reportedAt.toISOString() };
}

export function machineUsageLabel(
  reading: { availableBytes: number; totalBytes: number },
  base: 1000 | 1024,
): string {
  return `${capacityLabel(reading.totalBytes - reading.availableBytes, base)} / ${capacityLabel(reading.totalBytes, base)}`;
}

export function machineAvailableLabel(
  reading: { availableBytes: number },
  base: 1000 | 1024,
): string {
  return capacityLabel(reading.availableBytes, base);
}

export function machineUsedPercent(reading: {
  availableBytes: number;
  totalBytes: number;
}): number {
  if (reading.totalBytes <= 0) return 0;
  return Math.round(((reading.totalBytes - reading.availableBytes) / reading.totalBytes) * 100);
}

function capacityLabel(bytes: number, base: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  const round = (n: number) => (n < 10 && unit > 0 ? Math.round(n * 10) / 10 : Math.round(n));
  while (round(value) >= base && unit < units.length - 1) {
    value /= base;
    unit += 1;
  }
  return `${round(value)} ${units[unit]}`;
}
