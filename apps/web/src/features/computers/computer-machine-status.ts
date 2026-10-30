/** What a Computer last reported about itself, as the page reads it. */
export type MachineStatusReading = {
  availableBytes: number;
  totalBytes: number;
  /** ISO timestamp of the report the numbers came from. */
  reportedAt: string;
};

export type MachineStatusView = {
  disk: MachineStatusReading | null;
  memory: MachineStatusReading | null;
};

/** A disk figure is reported hourly: two hours without one means the Computer stopped saying. */
export const DISK_STALE_AFTER_MS = 2 * 60 * 60_000;
/** Memory is reported every five minutes; three missed reports read as "unknown". */
export const MEMORY_STALE_AFTER_MS = 15 * 60_000;

const GIB = 1024 ** 3;
/** A disk is low only when it is both nearly full and nearly out of absolute room. */
export const MACHINE_DISK_LOW_BYTES = 20 * GIB;
export const MACHINE_DISK_LOW_RATIO = 0.1;

/** A disk this full needs attention: under 20 GiB free *and* under 10% of the volume. */
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

/**
 * The readings a page should show, or `null` where the Computer never reported or stopped
 * reporting: a stale figure is worse than "unknown", because a person would act on it.
 */
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

/**
 * "412 GB / 1 TB": used, then total, each in its own unit. Disks count in powers of 1000, as the
 * drive and Finder label them; memory in powers of 1024, so 32 GiB of RAM reads "32 GB".
 */
export function machineUsageLabel(
  reading: { availableBytes: number; totalBytes: number },
  base: 1000 | 1024,
): string {
  return `${capacityLabel(reading.totalBytes - reading.availableBytes, base)} / ${capacityLabel(reading.totalBytes, base)}`;
}

function capacityLabel(bytes: number, base: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  // Round before settling on a unit, so 999.6 GB reads "1 TB", not "1000 GB".
  const round = (n: number) => (n < 10 && unit > 0 ? Math.round(n * 10) / 10 : Math.round(n));
  while (round(value) >= base && unit < units.length - 1) {
    value /= base;
    unit += 1;
  }
  return `${round(value)} ${units[unit]}`;
}
