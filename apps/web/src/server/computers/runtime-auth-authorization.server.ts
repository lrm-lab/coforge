import type { PrismaClient } from "#src/generated/prisma/client";
import { isElevatedServerRole } from "#src/server/workspaces/member-role.server";
import type { RuntimeAuthAuthorization } from "./runtime-auth.server";

/**
 * Who may sign a runtime in or out on a Computer: its owner, or an owner or admin of the
 * Workspace, and only while the Computer is connected to that Workspace. A plain member of the
 * Workspace may not: the account a runtime is signed in to belongs to the Computer's owner.
 */
export class PrismaRuntimeAuthAuthorization implements RuntimeAuthAuthorization {
  constructor(private readonly db: Pick<PrismaClient, "workspaceComputer">) {}

  async canManage(scope: { userId: string; workspaceId: string; computerId: string }) {
    const connection = await this.db.workspaceComputer.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        computerId: scope.computerId,
        workspace: { members: { some: { userId: scope.userId } } },
      },
      select: {
        computer: { select: { ownerId: true } },
        workspace: {
          select: {
            members: { where: { userId: scope.userId }, select: { role: true } },
          },
        },
      },
    });
    if (!connection) return false;
    return (
      connection.computer.ownerId === scope.userId ||
      isElevatedServerRole(connection.workspace.members[0]?.role)
    );
  }
}
