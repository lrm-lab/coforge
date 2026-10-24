import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";

/**
 * Whether the Computer is connected to the Workspace and the User is a member of that Workspace.
 *
 * The membership filter is declared against `Prisma.WorkspaceWhereInput` on its own rather than
 * inlined under `workspace:`: nested relation filters are a union type, where TypeScript does not
 * report an unknown key, so a misspelt relation (`memberships` is the User side; the Workspace
 * side is `members`) compiled and only failed at request time as a Prisma validation error.
 */
export async function isWorkspaceMemberComputer(
  db: Pick<PrismaClient, "workspaceComputer">,
  scope: { userId: string; workspaceId: string; computerId: string },
): Promise<boolean> {
  const hasMember: Prisma.WorkspaceWhereInput = { members: { some: { userId: scope.userId } } };
  const connection = await db.workspaceComputer.findFirst({
    where: { workspaceId: scope.workspaceId, computerId: scope.computerId, workspace: hasMember },
    select: { id: true },
  });
  return Boolean(connection);
}

/** Removes an owner's local Computer from one Workspace while preserving its identity elsewhere. */
export async function removeComputerFromWorkspace(
  db: Pick<PrismaClient, "computer" | "$transaction">,
  scope: { userId: string; workspaceId: string; computerId: string },
  now: Date = new Date(),
): Promise<void> {
  const computer = await db.computer.findFirst({
    where: {
      id: scope.computerId,
      ownerId: scope.userId,
      workspaces: { some: { workspaceId: scope.workspaceId } },
    },
    select: { id: true, kind: true },
  });
  if (!computer) throw new Error("Computer is not available");
  if (computer.kind !== "local") throw new Error("Only local Computers can be removed");

  await db.$transaction(async (tx) => {
    await DaemonCredentialRevocations.recordForComputer(
      tx,
      { workspaceId: scope.workspaceId, computerId: computer.id },
      now,
    );
    await tx.daemonApiKey.updateMany({
      where: { workspaceId: scope.workspaceId, computerId: computer.id, revokedAt: null },
      data: { revokedAt: now },
    });
    const result = await tx.workspaceComputer.deleteMany({
      where: { workspaceId: scope.workspaceId, computerId: computer.id },
    });
    if (result.count !== 1) throw new Error("Computer is not available");
  });
}

/**
 * Takes a person's Computers out of a Workspace they no longer belong to, inside the transaction
 * that ends their membership: records `computer_unlinked` for the live daemon keys they own there,
 * revokes those keys, and removes the links between the Workspace and the Computers they own.
 * Their keys and links for any other Workspace stay. Resolves with the Computers whose daemon
 * connection for this Workspace must reconnect after the commit (`reconnectDaemon`), so the
 * connect proxy refuses it now rather than at its next reconnect.
 */
export async function unlinkDepartingMemberComputers(
  tx: Prisma.TransactionClient,
  scope: { workspaceId: string; userId: string },
  now: Date = new Date(),
): Promise<{ computerIds: string[] }> {
  const liveKeys: Prisma.DaemonApiKeyWhereInput = {
    workspaceId: scope.workspaceId,
    ownerId: scope.userId,
    revokedAt: null,
  };
  const ownLinks: Prisma.WorkspaceComputerWhereInput = {
    workspaceId: scope.workspaceId,
    computer: { ownerId: scope.userId },
  };
  const keyed = await tx.daemonApiKey.findMany({ where: liveKeys, select: { computerId: true } });
  const linked = await tx.workspaceComputer.findMany({
    where: ownLinks,
    select: { computerId: true },
  });
  // Recorded before the revoke: only live keys are recorded.
  const revocations = await DaemonCredentialRevocations.recordForMember(tx, scope, now);
  await tx.daemonApiKey.updateMany({ where: liveKeys, data: { revokedAt: now } });
  await tx.workspaceComputer.deleteMany({ where: ownLinks });
  const computerIds = [...new Set([...keyed, ...linked].map(({ computerId }) => computerId))];
  console.info(
    JSON.stringify({
      event: "workspace_member:computers_unlinked",
      workspace_id: scope.workspaceId,
      computer_count: computerIds.length,
      revocations,
    }),
  );
  return { computerIds };
}
