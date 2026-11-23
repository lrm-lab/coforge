import type { PrismaClient } from "#src/generated/prisma/client";
import { getComputerInstallerRecovery } from "./computer-installer-recovery.server";

export async function readOwnedInstallerRecovery(
  db: Pick<PrismaClient, "workspaceComputer">,
  { workspaceId, computerId, userId }: { workspaceId: string; computerId: string; userId: string },
  read = (scope: { workspaceId: string; computerId: string }) =>
    getComputerInstallerRecovery().read(scope),
) {
  const binding = await db.workspaceComputer.findFirst({
    where: {
      workspaceId,
      computerId,
      computer: { ownerId: userId, kind: "local" },
      workspace: { members: { some: { userId } } },
    },
    select: { id: true },
  });
  if (!binding) return null;
  try {
    return await read({ workspaceId, computerId });
  } catch {
    return null;
  }
}
