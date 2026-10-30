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
