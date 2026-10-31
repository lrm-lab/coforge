import type { PrismaClient } from "#src/generated/prisma/client";
import type { ComputerUpgradeRecovery } from "@lrm/coforge-sdk/internal";

/**
 * The automatic-recovery report a daemon relays for one of its Computer's upgrade operations, as
 * stored in `computers.lastRecovery`: the installer's own fields plus the operation it settled
 * and when the server recorded it.
 */
export type StoredComputerRecovery = ComputerUpgradeRecovery & {
  requestId: string;
  reportedAtMs: number;
};

/**
 * Writes a Computer's newest recovery report, unless the stored one is newer. Recovery is
 * machine state, not request state: it is recorded whether the upgrade request it settled is
 * still open, already settled, or long expired.
 */
export class PrismaComputerRecoveryStore {
  constructor(private readonly db: Pick<PrismaClient, "$executeRaw">) {}

  /** `false` when the stored report is newer (or the Computer is gone), so nothing changed. */
  async record(computerId: string, recovery: StoredComputerRecovery): Promise<boolean> {
    const updated = await this.db.$executeRaw`
      UPDATE "computers" SET "lastRecovery" = ${JSON.stringify(recovery)}::jsonb
      WHERE "id" = ${computerId}::uuid
        AND ("lastRecovery" IS NULL
          OR ("lastRecovery"->>'finishedAtMs')::bigint < ${recovery.finishedAtMs})`;
    return updated > 0;
  }
}
