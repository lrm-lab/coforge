import type { PrismaClient } from "#src/generated/prisma/client";
import type { MachineStatusReport } from "@lrm/coforge-sdk/internal";

export type MachineStatusKind = "disk" | "memory";

/**
 * The newest machine status report per Computer. A report older than the stored one is dropped
 * (a reconnect can deliver a sample taken before one already recorded), and each kind has its own
 * columns so the two timers never overwrite one another.
 */
export class PrismaComputerMachineStatusStore {
  constructor(private readonly db: PrismaClient) {}

  /** Whether this report became the stored one. */
  async record(
    kind: MachineStatusKind,
    computerId: string,
    report: MachineStatusReport,
  ): Promise<boolean> {
    const at = new Date(report.reportedAtMs);
    const available = BigInt(report.availableBytes);
    const total = BigInt(report.totalBytes);
    if (kind === "disk") {
      const { count } = await this.db.computer.updateMany({
        where: { id: computerId, OR: [{ diskReportedAt: null }, { diskReportedAt: { lt: at } }] },
        data: { diskAvailableBytes: available, diskTotalBytes: total, diskReportedAt: at },
      });
      return count > 0;
    }
    const { count } = await this.db.computer.updateMany({
      where: {
        id: computerId,
        OR: [{ memoryReportedAt: null }, { memoryReportedAt: { lt: at } }],
      },
      data: { memoryAvailableBytes: available, memoryTotalBytes: total, memoryReportedAt: at },
    });
    return count > 0;
  }
}
