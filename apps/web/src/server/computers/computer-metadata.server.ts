import { recordComputerVersionChanged } from "#src/server/app-notifications/computer-events.server";
import { z } from "zod";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  appNotificationsPossible,
  attemptAppNotification,
} from "#src/server/app-notifications/app-notifications.server";

export const computerObservationSchema = z.object({
  computerVersion: z.string().trim().max(200).optional(),
  platform: z.enum(["", "darwin", "linux", "win32"]).optional(),
  osVersion: z.string().trim().max(200).optional(),
  startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export type ComputerObservation = z.infer<typeof computerObservationSchema>;

export async function recordComputerObservation(
  db: PrismaClient,
  scope: { workspaceId: string; computerId: string },
  observation: ComputerObservation,
) {
  // Missing fields from older executables must not erase previously observed data.
  const data = {
    ...(observation.computerVersion ? { computerVersion: observation.computerVersion } : {}),
    ...(observation.platform ? { platform: observation.platform } : {}),
    ...(observation.osVersion ? { osVersion: observation.osVersion } : {}),
  };
  if (!Object.keys(data).length) return;
  const startedAt = BigInt(observation.startedAt);
  const where = {
    id: scope.computerId,
    workspaces: { some: { workspaceId: scope.workspaceId } },
    OR: [{ metadataStartedAt: null }, { metadataStartedAt: { lte: startedAt } }],
  };
  const write = { ...data, metadataStartedAt: startedAt };
  const version = observation.computerVersion;
  // Only a reported version can change what apps are told, and only where they can be told: any
  // other observation is the single write it always was.
  if (!version || !appNotificationsPossible()) {
    await db.computer.updateMany({ where, data: write });
    return;
  }
  await db.$transaction(async (tx) => {
    const previous = await attemptAppNotification(tx, () => lockedVersion(tx, scope));
    const { count } = await tx.computer.updateMany({ where, data: write });
    if (count > 0 && previous)
      await recordComputerVersionChanged(tx, scope.computerId, { previous, version });
  });
}

/**
 * The version the Computer last reported, read under a row lock so that two Workspaces' daemons
 * reporting the same new version do not both read the old one and tell it twice. Only for a
 * Computer linked to the reporting Workspace; a Computer without one is never locked.
 */
async function lockedVersion(
  tx: Prisma.TransactionClient,
  scope: { workspaceId: string; computerId: string },
) {
  const link = await tx.workspaceComputer.findFirst({
    where: { computerId: scope.computerId, workspaceId: scope.workspaceId },
    select: { id: true },
  });
  if (!link) return null;
  const [row] = await tx.$queryRaw<{ computerVersion: string | null }[]>`
    SELECT "computerVersion" FROM computers WHERE id = ${scope.computerId}::uuid FOR UPDATE`;
  return row?.computerVersion ?? null;
}
