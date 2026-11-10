import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import type { PrismaClient } from "#src/generated/prisma/client";
import { isElevatedServerRole } from "#src/server/workspaces/member-role.server";
import {
  defaultCloudComputerHiddenFromViewer,
  liveComputerWhere,
} from "./computer-list-visibility.server";
import { runtimeVisibleToViewer } from "./computer-runtime-visibility.server";
import type { RuntimeAuthAuthorization } from "./runtime-auth.server";

/**
 * Who may manage a runtime on a Computer: sign it in or out, spend its reset credit, read and scan
 * its usage. Its owner, or an owner or admin of the Workspace, and only while the Computer is
 * connected to that Workspace and not removed. A plain member of the Workspace may not: the account a runtime is
 * signed in to belongs to the Computer's owner. Another member's default cloud Computer is the
 * exception to the admin's reach, as it is off the Computer list
 * (`computer-list-visibility.server.ts`): only its owner manages it, though an admin who holds its
 * id is in the Workspace it is connected to. For a named runtime the viewer must also see it as the
 * Computer page lists it (`runtimeVisibleToViewer`): the Computer owner's always, an admin another
 * member's only once public, so no page-less route reaches a runtime the page never shows. A caller
 * that already holds the runtime row leaves `provider` out and applies `runtimeVisibleToViewer` to
 * that row, which saves this lookup.
 */
export class PrismaRuntimeAuthAuthorization implements RuntimeAuthAuthorization {
  constructor(private readonly db: Pick<PrismaClient, "workspaceComputer" | "computerRuntime">) {}

  async canManage(scope: {
    userId: string;
    workspaceId: string;
    computerId: string;
    provider?: RuntimeProvider;
  }) {
    const connection = await this.db.workspaceComputer.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        computerId: scope.computerId,
        computer: liveComputerWhere,
        workspace: { members: { some: { userId: scope.userId } } },
      },
      select: {
        computer: { select: { ownerId: true, kind: true, cloudSlot: true } },
        workspace: {
          select: {
            members: { where: { userId: scope.userId }, select: { role: true } },
          },
        },
      },
    });
    if (!connection) return false;
    if (defaultCloudComputerHiddenFromViewer(scope.userId, connection.computer)) return false;
    const { ownerId } = connection.computer;
    if (ownerId === scope.userId) return true;
    if (!isElevatedServerRole(connection.workspace.members[0]?.role)) return false;
    if (!scope.provider) return true;
    const runtime = await this.db.computerRuntime.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        computerId: scope.computerId,
        provider: scope.provider,
      },
      select: { isPublic: true },
    });
    if (!runtime) return false;
    return runtimeVisibleToViewer(scope.userId, { ownerId, isPublic: runtime.isPublic });
  }
}
